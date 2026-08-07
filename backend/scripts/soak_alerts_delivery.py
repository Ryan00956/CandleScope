"""Restart/retry soak for the durable alert webhook outbox.

The harness never opens a network socket. It uses the production facade,
SQLite outbox, worker lifecycle, history receipts, retry scheduling, and
restart recovery with a deterministic sender.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.alerts.facade import AlertFacade  # noqa: E402
from app.alerts.webhook import WebhookDeliveryResult, WebhookSettings  # noqa: E402


class DeterministicSender:
    def __init__(self, failure_every: int) -> None:
        self.failure_every = max(0, int(failure_every))
        self.attempts: dict[str, int] = {}
        self.retryable_failures = 0

    async def send(self, entry: dict) -> WebhookDeliveryResult:
        delivery_id = str(entry.get("deliveryId") or "")
        attempt = self.attempts.get(delivery_id, 0) + 1
        self.attempts[delivery_id] = attempt
        event_id = str((entry.get("payload") or {}).get("eventId") or "")
        try:
            ordinal = int(event_id.rsplit("-", 1)[-1])
        except ValueError:
            ordinal = 0
        if self.failure_every and ordinal % self.failure_every == 0 and attempt == 1:
            self.retryable_failures += 1
            return WebhookDeliveryResult(False, True, "injected_http_503", 503)
        return WebhookDeliveryResult(True, False, "injected_http_204", 204)


def _rule_payload() -> dict:
    return {
        "name": "alert delivery soak",
        "target": {
            "exchange": "binance",
            "marketType": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
        },
        "triggerOn": "bar_update",
        "expression": {
            "left": "close",
            "comparator": ">",
            "right": {"type": "number", "value": 0},
        },
        "actions": [{
            "type": "webhook",
            "enabled": True,
            "config": {"url": "https://hooks.example.com/candlescope-soak"},
        }],
        "cooldownMs": 0,
        "maxTriggers": None,
        "afterTrigger": "keep",
    }


async def _wait_until_drained(facade: AlertFacade, timeout_seconds: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout_seconds
    while True:
        snapshot = facade.status()["outbox"]
        if snapshot["queued"] == 0:
            return snapshot
        if time.monotonic() >= deadline:
            raise TimeoutError(f"outbox did not drain: {snapshot}")
        await asyncio.sleep(0.005)


async def run_soak(args: argparse.Namespace, root: Path) -> dict:
    settings = WebhookSettings(
        enabled=True,
        secret="soak-only-signing-secret",
        require_signature=True,
        allowed_hosts=("hooks.example.com",),
        request_timeout_ms=1_000,
        max_attempts=3,
        base_retry_delay_ms=5,
        max_retry_delay_ms=20,
        poll_interval_ms=5,
        retain_delivered=100_000,
        retain_dead_letter=10_000,
        outbox_path=root / "alerts-outbox.sqlite3",
    )
    sender = DeterministicSender(args.failure_every)
    facade: AlertFacade | None = None
    rule_id = ""
    cycles = 0
    restarts = 0
    max_queued = 0
    started_at = time.monotonic()
    started_wall_ms = int(time.time() * 1000)

    async def restart() -> AlertFacade:
        nonlocal facade, restarts, rule_id
        if facade is not None:
            await facade.stop()
        facade = AlertFacade(
            store_path=root / "alerts.json",
            webhook_settings=settings,
            webhook_sender=sender,  # type: ignore[arg-type]
        )
        await facade.start()
        restarts += 1
        rules = facade.list_rules()
        if rules:
            rule_id = rules[0]["id"]
        else:
            rule_id = facade.save_rule(_rule_payload())["id"]
        return facade

    await restart()
    try:
        while True:
            elapsed = time.monotonic() - started_at
            if args.cycles > 0:
                if cycles >= args.cycles:
                    break
            elif elapsed >= args.duration_seconds:
                break

            cycles += 1
            assert facade is not None
            rule = facade.get_rule(rule_id)
            if rule is None:
                raise RuntimeError("soak alert rule disappeared")
            event = await facade.emit_triggered(
                {
                    "id": f"soak-event-{cycles}",
                    "ruleId": rule_id,
                    "message": f"soak event {cycles}",
                    "values": {"close": cycles},
                    "actions": rule["actions"],
                },
                enforce_limits=False,
            )
            if event is None or event["dispatch"][0]["status"] != "queued":
                raise RuntimeError(f"event was not durably queued: {event}")
            max_queued = max(max_queued, int(facade.status()["outbox"]["queued"]))
            snapshot = await _wait_until_drained(facade)
            if snapshot["deadLetter"]:
                raise RuntimeError(f"unexpected dead letter: {snapshot}")
            if args.restart_every > 0 and cycles % args.restart_every == 0:
                await restart()
    finally:
        if facade is not None:
            await facade.stop()

    final_facade = AlertFacade(
        store_path=root / "alerts.json",
        webhook_settings=settings,
        webhook_sender=sender,  # type: ignore[arg-type]
    )
    final_snapshot = final_facade.status()["outbox"]
    history = final_facade.list_history(limit=min(1_000, max(1, cycles)), rule_id=rule_id)
    delivered_receipts = sum(
        1
        for event in history
        if event.get("dispatch")
        and event["dispatch"][0].get("status") == "delivered"
    )
    passed = (
        final_snapshot["queued"] == 0
        and final_snapshot["deadLetter"] == 0
        and final_snapshot["delivered"] == cycles
        and delivered_receipts == min(cycles, 1_000)
    )
    return {
        "schemaVersion": 1,
        "passed": passed,
        "startedAt": started_wall_ms,
        "durationSeconds": round(time.monotonic() - started_at, 3),
        "cycles": cycles,
        "restarts": restarts,
        "injectedRetryableFailures": sender.retryable_failures,
        "physicalAttempts": sum(sender.attempts.values()),
        "maxQueued": max_queued,
        "finalOutbox": final_snapshot,
        "historyDeliveredReceiptsChecked": delivered_receipts,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration-seconds", type=float, default=60.0)
    parser.add_argument("--cycles", type=int, default=0)
    parser.add_argument("--restart-every", type=int, default=25)
    parser.add_argument("--failure-every", type=int, default=7)
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    with tempfile.TemporaryDirectory(prefix="candlescope-alert-soak-") as temporary:
        report = asyncio.run(run_soak(args, Path(temporary)))
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.report is not None:
        report_path = args.report.resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = report_path.with_suffix(report_path.suffix + ".tmp")
        temporary_path.write_text(rendered + "\n", encoding="utf-8")
        os.replace(temporary_path, report_path)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
