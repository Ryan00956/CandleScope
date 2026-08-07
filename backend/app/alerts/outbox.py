"""SQLite-backed durable delivery outbox for alert actions."""
from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol

from app.alerts.webhook import WebhookDeliveryResult, WebhookSettings

logger = logging.getLogger("candlescope.alerts.outbox")


class DeliverySender(Protocol):
    async def send(self, entry: dict[str, Any]) -> WebhookDeliveryResult:
        ...


ReceiptCallback = Callable[..., dict[str, Any] | None]


class AlertOutboxStore:
    """Small transactional queue with crash recovery and bounded diagnostics."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _ensure_schema(self) -> None:
        with self._connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS alert_delivery_outbox (
                    delivery_id TEXT PRIMARY KEY,
                    event_id TEXT NOT NULL,
                    rule_id TEXT NOT NULL,
                    action_type TEXT NOT NULL,
                    destination TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at INTEGER NOT NULL,
                    last_error TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    delivered_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_alert_delivery_due
                    ON alert_delivery_outbox(status, next_attempt_at, created_at);
                CREATE INDEX IF NOT EXISTS idx_alert_delivery_event
                    ON alert_delivery_outbox(event_id);
                """
            )

    def stage(self, event: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
        config = action.get("config") if isinstance(action.get("config"), dict) else {}
        destination = str(config.get("url") or "").strip()
        now = int(time.time() * 1000)
        delivery_id = f"webhook-delivery-{uuid.uuid4().hex[:16]}"
        payload = {
            "schemaVersion": 1,
            "deliveryId": delivery_id,
            "eventId": str(event.get("id") or ""),
            "ruleId": str(event.get("ruleId") or ""),
            "eventType": str(event.get("eventType") or "alert.triggered"),
            "target": event.get("target") if isinstance(event.get("target"), dict) else {},
            "message": str(event.get("message") or ""),
            "values": event.get("values") if isinstance(event.get("values"), dict) else {},
            "createdAt": int(event.get("createdAt") or now),
        }
        payload_json = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        )
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO alert_delivery_outbox (
                    delivery_id, event_id, rule_id, action_type, destination,
                    payload_json, status, attempts, next_attempt_at,
                    last_error, created_at, updated_at, delivered_at
                ) VALUES (?, ?, ?, 'webhook', ?, ?, 'staged', 0, ?, NULL, ?, ?, NULL)
                """,
                (
                    delivery_id,
                    payload["eventId"],
                    payload["ruleId"],
                    destination,
                    payload_json,
                    now,
                    now,
                    now,
                ),
            )
        return {
            "deliveryId": delivery_id,
            "eventId": payload["eventId"],
            "ruleId": payload["ruleId"],
            "destination": destination,
            "payload": payload,
            "status": "staged",
            "attempts": 0,
            "nextAttemptAt": now,
            "createdAt": now,
            "updatedAt": now,
        }

    def activate_event(self, event_id: str) -> int:
        now = int(time.time() * 1000)
        with self._connection() as connection:
            cursor = connection.execute(
                """
                UPDATE alert_delivery_outbox
                SET status = 'pending', next_attempt_at = ?, updated_at = ?
                WHERE event_id = ? AND status = 'staged'
                """,
                (now, now, event_id),
            )
            return int(cursor.rowcount)

    def recover_incomplete(self) -> int:
        now = int(time.time() * 1000)
        with self._connection() as connection:
            cursor = connection.execute(
                """
                UPDATE alert_delivery_outbox
                SET status = 'pending', next_attempt_at = MIN(next_attempt_at, ?), updated_at = ?
                WHERE status IN ('staged', 'processing')
                """,
                (now, now),
            )
            return int(cursor.rowcount)

    def claim_due(self, *, now_ms: int | None = None) -> dict[str, Any] | None:
        now = int(time.time() * 1000) if now_ms is None else int(now_ms)
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT * FROM alert_delivery_outbox
                WHERE status IN ('pending', 'retrying') AND next_attempt_at <= ?
                ORDER BY next_attempt_at ASC, created_at ASC
                LIMIT 1
                """,
                (now,),
            ).fetchone()
            if row is None:
                connection.commit()
                return None
            connection.execute(
                """
                UPDATE alert_delivery_outbox
                SET status = 'processing', attempts = attempts + 1, updated_at = ?
                WHERE delivery_id = ?
                """,
                (now, row["delivery_id"]),
            )
            connection.commit()
            item = dict(row)
            item["status"] = "processing"
            item["attempts"] = int(item.get("attempts") or 0) + 1
            item["updated_at"] = now
            return self._decode(item)
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def mark_delivered(self, delivery_id: str, detail: str) -> None:
        now = int(time.time() * 1000)
        self._update_terminal(delivery_id, "delivered", detail, now, delivered_at=now)

    def mark_dead_letter(self, delivery_id: str, detail: str) -> None:
        now = int(time.time() * 1000)
        self._update_terminal(delivery_id, "dead_letter", detail, now)

    def mark_retry(self, delivery_id: str, detail: str, next_attempt_at: int) -> None:
        now = int(time.time() * 1000)
        with self._connection() as connection:
            connection.execute(
                """
                UPDATE alert_delivery_outbox
                SET status = 'retrying', next_attempt_at = ?, last_error = ?, updated_at = ?
                WHERE delivery_id = ?
                """,
                (int(next_attempt_at), self._bounded_detail(detail), now, delivery_id),
            )

    def prune_terminal(self, *, retain_delivered: int, retain_dead_letter: int) -> int:
        removed = 0
        with self._connection() as connection:
            for status, retain in (
                ("delivered", max(0, int(retain_delivered))),
                ("dead_letter", max(0, int(retain_dead_letter))),
            ):
                cursor = connection.execute(
                    """
                    DELETE FROM alert_delivery_outbox
                    WHERE delivery_id IN (
                        SELECT delivery_id FROM alert_delivery_outbox
                        WHERE status = ?
                        ORDER BY updated_at DESC, delivery_id DESC
                        LIMIT -1 OFFSET ?
                    )
                    """,
                    (status, retain),
                )
                removed += int(cursor.rowcount)
        return removed

    def _update_terminal(
        self,
        delivery_id: str,
        status: str,
        detail: str,
        now: int,
        *,
        delivered_at: int | None = None,
    ) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                UPDATE alert_delivery_outbox
                SET status = ?, last_error = ?, updated_at = ?, delivered_at = ?
                WHERE delivery_id = ?
                """,
                (status, self._bounded_detail(detail), now, delivered_at, delivery_id),
            )

    def list_entries(self, *, limit: int = 100) -> list[dict[str, Any]]:
        safe_limit = min(1_000, max(1, int(limit)))
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM alert_delivery_outbox
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
        return [self._decode(dict(row)) for row in rows]

    def snapshot(self) -> dict[str, Any]:
        with self._connection() as connection:
            counts = {
                str(row["status"]): int(row["count"])
                for row in connection.execute(
                    "SELECT status, COUNT(*) AS count FROM alert_delivery_outbox GROUP BY status"
                ).fetchall()
            }
            oldest = connection.execute(
                """
                SELECT MIN(created_at) AS value FROM alert_delivery_outbox
                WHERE status IN ('staged', 'pending', 'processing', 'retrying')
                """
            ).fetchone()
            next_due = connection.execute(
                """
                SELECT MIN(next_attempt_at) AS value FROM alert_delivery_outbox
                WHERE status IN ('pending', 'retrying')
                """
            ).fetchone()
        queued = sum(counts.get(status, 0) for status in ("staged", "pending", "processing", "retrying"))
        return {
            "queued": queued,
            "staged": counts.get("staged", 0),
            "pending": counts.get("pending", 0),
            "processing": counts.get("processing", 0),
            "retrying": counts.get("retrying", 0),
            "delivered": counts.get("delivered", 0),
            "deadLetter": counts.get("dead_letter", 0),
            "oldestQueuedAt": oldest["value"] if oldest is not None else None,
            "nextAttemptAt": next_due["value"] if next_due is not None else None,
        }

    @staticmethod
    def _bounded_detail(detail: str) -> str:
        return str(detail or "")[:500]

    @staticmethod
    def _decode(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "deliveryId": str(row.get("delivery_id") or ""),
            "eventId": str(row.get("event_id") or ""),
            "ruleId": str(row.get("rule_id") or ""),
            "actionType": str(row.get("action_type") or ""),
            "destination": str(row.get("destination") or ""),
            "payload": json.loads(str(row.get("payload_json") or "{}")),
            "status": str(row.get("status") or ""),
            "attempts": int(row.get("attempts") or 0),
            "nextAttemptAt": int(row.get("next_attempt_at") or 0),
            "lastError": row.get("last_error"),
            "createdAt": int(row.get("created_at") or 0),
            "updatedAt": int(row.get("updated_at") or 0),
            "deliveredAt": row.get("delivered_at"),
        }


class AlertOutboxWorker:
    """Drain durable webhook deliveries with capped exponential backoff."""

    def __init__(
        self,
        store: AlertOutboxStore,
        sender: DeliverySender,
        settings: WebhookSettings,
        *,
        receipt_callback: ReceiptCallback | None = None,
    ) -> None:
        self.store = store
        self.sender = sender
        self.settings = settings
        self.receipt_callback = receipt_callback
        self._task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._stop_requested = False
        self._last_error: str | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        if self.running:
            return
        self._stop_requested = False
        await asyncio.to_thread(self.store.recover_incomplete)
        self._task = asyncio.create_task(self._run(), name="alerts:webhook-outbox")
        self._wake.set()

    async def stop(self) -> None:
        task = self._task
        if task is None:
            return
        self._stop_requested = True
        self._wake.set()
        try:
            await task
        finally:
            self._task = None

    async def stage(self, event: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
        entry = await asyncio.to_thread(self.store.stage, event, action)
        return {
            "type": "webhook",
            "status": "queued",
            "dispatchId": entry["deliveryId"],
            "durable": True,
        }

    async def activate_event(self, event_id: str) -> int:
        activated = await asyncio.to_thread(self.store.activate_event, event_id)
        if activated:
            self._wake.set()
        return activated

    async def run_once(self, *, now_ms: int | None = None, limit: int = 32) -> int:
        processed = 0
        while processed < max(1, int(limit)):
            if self._stop_requested:
                break
            entry = await asyncio.to_thread(self.store.claim_due, now_ms=now_ms)
            if entry is None:
                break
            await self._deliver(entry, now_ms=now_ms)
            processed += 1
        return processed

    async def _deliver(self, entry: dict[str, Any], *, now_ms: int | None = None) -> None:
        result = await self.sender.send(entry)
        delivery_id = entry["deliveryId"]
        event_id = entry["eventId"]
        attempts = int(entry.get("attempts") or 0)
        current = int(time.time() * 1000) if now_ms is None else int(now_ms)
        if result.delivered:
            await self._record_receipt(event_id, delivery_id, "delivered", result.detail)
            await asyncio.to_thread(self.store.mark_delivered, delivery_id, result.detail)
            await self._prune_terminal()
            return

        if result.retryable and attempts < self.settings.max_attempts:
            delay = min(
                self.settings.max_retry_delay_ms,
                self.settings.base_retry_delay_ms * (2 ** max(0, attempts - 1)),
            )
            if result.retry_after_ms is not None:
                delay = min(self.settings.max_retry_delay_ms, max(delay, result.retry_after_ms))
            await self._record_receipt(event_id, delivery_id, "retrying", result.detail)
            await asyncio.to_thread(
                self.store.mark_retry,
                delivery_id,
                result.detail,
                current + delay,
            )
            return

        await self._record_receipt(event_id, delivery_id, "error", result.detail)
        await asyncio.to_thread(self.store.mark_dead_letter, delivery_id, result.detail)
        await self._prune_terminal()

    async def _prune_terminal(self) -> None:
        await asyncio.to_thread(
            self.store.prune_terminal,
            retain_delivered=self.settings.retain_delivered,
            retain_dead_letter=self.settings.retain_dead_letter,
        )

    async def _record_receipt(
        self,
        event_id: str,
        delivery_id: str,
        status: str,
        detail: str,
    ) -> None:
        if self.receipt_callback is None:
            return
        await asyncio.to_thread(
            self.receipt_callback,
            event_id,
            delivery_id,
            status=status,
            detail=detail,
        )

    async def _run(self) -> None:
        while not self._stop_requested:
            try:
                processed = await self.run_once()
                self._last_error = None
                if processed and not self._stop_requested:
                    continue
                self._wake.clear()
                if self._stop_requested:
                    break
                try:
                    await asyncio.wait_for(
                        self._wake.wait(),
                        timeout=self.settings.poll_interval_ms / 1000,
                    )
                except TimeoutError:
                    pass
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._last_error = f"{type(exc).__name__}: {exc}"[:500]
                logger.exception("Alert webhook outbox worker failed")
                if self._stop_requested:
                    break
                self._wake.clear()
                try:
                    await asyncio.wait_for(
                        self._wake.wait(),
                        timeout=self.settings.poll_interval_ms / 1000,
                    )
                except TimeoutError:
                    pass

    def snapshot(self) -> dict[str, Any]:
        return {
            **self.store.snapshot(),
            "running": self.running,
            "lastError": self._last_error,
        }


class DurableWebhookChannel:
    action_type = "webhook"

    def __init__(self, worker: AlertOutboxWorker) -> None:
        self.worker = worker

    async def dispatch(self, event: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
        return await self.worker.stage(event, action)
