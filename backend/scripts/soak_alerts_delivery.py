"""Release gate for the durable alert webhook outbox.

The harness never opens a network socket. It exercises the production facade,
SQLite outbox, worker lifecycle, history receipts, retry scheduling, retention,
and real process-abort recovery with a deterministic sender.
"""
from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
SCRIPT_PATH = Path(__file__).resolve()
CRASH_EXIT_CODE = 86
CRASH_MODES = ("staged", "processing", "retrying")

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.alerts.facade import AlertFacade  # noqa: E402
from app.alerts.outbox import AlertOutboxStore  # noqa: E402
from app.alerts.store import AlertStore  # noqa: E402
from app.alerts.webhook import WebhookDeliveryResult, WebhookSettings  # noqa: E402


class DeterministicSender:
    """Bounded-memory sender with cumulative process-lifetime counters."""

    def __init__(self, failure_every: int) -> None:
        self.failure_every = max(0, int(failure_every))
        self._active_attempts: dict[str, int] = {}
        self.physical_attempts = 0
        self.successful_responses = 0
        self.retryable_failures = 0

    async def send(self, entry: dict[str, Any]) -> WebhookDeliveryResult:
        delivery_id = str(entry.get("deliveryId") or "")
        attempt = self._active_attempts.get(delivery_id, 0) + 1
        self.physical_attempts += 1
        event_id = str((entry.get("payload") or {}).get("eventId") or "")
        try:
            ordinal = int(event_id.rsplit("-", 1)[-1])
        except ValueError:
            ordinal = 0
        if self.failure_every and ordinal % self.failure_every == 0 and attempt == 1:
            self._active_attempts[delivery_id] = attempt
            self.retryable_failures += 1
            return WebhookDeliveryResult(False, True, "injected_http_503", 503)
        self._active_attempts.pop(delivery_id, None)
        self.successful_responses += 1
        return WebhookDeliveryResult(True, False, "injected_http_204", 204)


def _rule_payload() -> dict[str, Any]:
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


def _settings(root: Path, *, retain_delivered: int) -> WebhookSettings:
    return WebhookSettings(
        enabled=True,
        secret="soak-only-signing-secret",
        require_signature=True,
        allowed_hosts=("hooks.example.com",),
        request_timeout_ms=1_000,
        max_attempts=3,
        base_retry_delay_ms=5,
        max_retry_delay_ms=20,
        poll_interval_ms=5,
        retain_delivered=max(0, int(retain_delivered)),
        retain_dead_letter=10_000,
        outbox_path=root / "alerts-outbox.sqlite3",
    )


def _git_metadata() -> dict[str, Any]:
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=REPO_DIR,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all"],
            cwd=REPO_DIR,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        return {
            "sha": sha,
            "shortSha": sha[:8],
            "dirty": bool(status),
            "dirtyPaths": status.splitlines()[:100],
        }
    except (OSError, subprocess.SubprocessError) as exc:
        return {
            "sha": None,
            "shortSha": None,
            "dirty": None,
            "dirtyPaths": [],
            "error": f"{type(exc).__name__}: {exc}"[:500],
        }


def _rss_bytes() -> int | None:
    if sys.platform == "win32":
        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            psapi = ctypes.WinDLL("psapi", use_last_error=True)
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            psapi.GetProcessMemoryInfo.argtypes = (
                ctypes.c_void_p,
                ctypes.POINTER(ProcessMemoryCounters),
                ctypes.c_ulong,
            )
            psapi.GetProcessMemoryInfo.restype = ctypes.c_int
            process = kernel32.GetCurrentProcess()
            ok = psapi.GetProcessMemoryInfo(
                process,
                ctypes.byref(counters),
                counters.cb,
            )
            return int(counters.WorkingSetSize) if ok else None
        except (AttributeError, OSError):
            return None
    try:
        page_size = int(os.sysconf("SC_PAGE_SIZE"))
        resident_pages = int(Path("/proc/self/statm").read_text(encoding="ascii").split()[1])
        return page_size * resident_pages
    except (AttributeError, IndexError, OSError, ValueError):
        return None


def _database_bytes(path: Path) -> int:
    return sum(
        candidate.stat().st_size
        for candidate in (
            path,
            Path(f"{path}-wal"),
            Path(f"{path}-shm"),
        )
        if candidate.exists()
    )


def _write_report(path: Path | None, report: dict[str, Any]) -> None:
    if path is None:
        return
    report_path = path.resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = report_path.with_suffix(report_path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary_path, report_path)


async def _wait_until_drained(
    facade: AlertFacade,
    *,
    timeout_seconds: float = 10.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    while True:
        snapshot = facade.status()["outbox"]
        if snapshot["queued"] == 0:
            return snapshot
        if time.monotonic() >= deadline:
            raise TimeoutError(f"outbox did not drain: {snapshot}")
        await asyncio.sleep(0.005)


def _run_crash_child(args: argparse.Namespace) -> int:
    """Persist one non-terminal delivery and terminate without cleanup."""
    root = args.root.resolve()
    settings = _settings(root, retain_delivered=args.retain_delivered)
    alert_store = AlertStore(root / "alerts.json", webhook_settings=settings)
    rule = alert_store.get_rule(args.rule_id)
    if rule is None:
        raise RuntimeError(f"crash child could not find rule {args.rule_id}")
    actions = rule.get("actions") if isinstance(rule.get("actions"), list) else []
    if not actions:
        raise RuntimeError("crash child rule has no actions")
    event = alert_store.append_history({
        "id": args.event_id,
        "ruleId": args.rule_id,
        "message": f"crash recovery event in {args.crash_mode}",
        "values": {"crashMode": args.crash_mode},
        "actions": actions,
    })
    outbox = AlertOutboxStore(settings.outbox_path)  # type: ignore[arg-type]
    entry = outbox.stage(event, actions[0])
    alert_store.update_history_dispatch(event["id"], [{
        "type": "webhook",
        "status": "queued",
        "dispatchId": entry["deliveryId"],
        "durable": True,
    }])
    now_ms = int(time.time() * 1000)
    if args.crash_mode in ("processing", "retrying"):
        outbox.activate_event(event["id"])
        claimed = outbox.claim_due(now_ms=now_ms + 1_000)
        if claimed is None or claimed["status"] != "processing":
            raise RuntimeError(f"crash child could not claim delivery: {claimed}")
        if args.crash_mode == "retrying":
            outbox.mark_retry(
                claimed["deliveryId"],
                "injected_pre_crash_retry",
                now_ms,
            )
            alert_store.update_dispatch_receipt(
                event["id"],
                claimed["deliveryId"],
                status="retrying",
                detail="injected_pre_crash_retry",
            )
    os._exit(CRASH_EXIT_CODE)


async def run_soak(args: argparse.Namespace, root: Path) -> dict[str, Any]:
    settings = _settings(root, retain_delivered=args.retain_delivered)
    sender = DeterministicSender(args.failure_every)
    git = _git_metadata()
    facade: AlertFacade | None = None
    rule_id = ""
    cycles = 0
    deliveries_created = 0
    starts = 0
    graceful_restarts = 0
    max_queued = 0
    resource_samples: list[dict[str, Any]] = []
    crash_recovery = {
        mode: {"injected": 0, "recovered": 0}
        for mode in CRASH_MODES
    }
    crash_index = 0
    failure: dict[str, Any] | None = None
    started_at = time.monotonic()
    started_wall_ms = int(time.time() * 1000)
    next_sample_at = 0.0

    def build_report(
        *,
        status: str,
        final_snapshot: dict[str, Any] | None = None,
        delivered_receipts: int | None = None,
        passed: bool | None = None,
    ) -> dict[str, Any]:
        duration = max(0.0, time.monotonic() - started_at)
        rss_values = [
            int(sample["rssBytes"])
            for sample in resource_samples
            if sample.get("rssBytes") is not None
        ]
        database_values = [int(sample["databaseBytes"]) for sample in resource_samples]
        rss_delta = rss_values[-1] - rss_values[0] if len(rss_values) >= 2 else 0
        database_delta = (
            database_values[-1] - database_values[0]
            if len(database_values) >= 2
            else 0
        )
        return {
            "schemaVersion": 2,
            "status": status,
            "passed": passed,
            "startedAt": started_wall_ms,
            "updatedAt": int(time.time() * 1000),
            "durationSeconds": round(duration, 3),
            "git": git,
            "parameters": {
                "durationSeconds": args.duration_seconds,
                "cycles": args.cycles,
                "restartEvery": args.restart_every,
                "crashEvery": args.crash_every,
                "failureEvery": args.failure_every,
                "retainDelivered": args.retain_delivered,
                "sampleEverySeconds": args.sample_every_seconds,
                "requireCleanHead": args.require_clean_head,
                "stateDirectory": str(root.resolve()),
            },
            "cycles": cycles,
            "deliveriesCreated": deliveries_created,
            "starts": starts,
            "gracefulRestarts": graceful_restarts,
            "crashRecovery": crash_recovery,
            "injectedRetryableFailures": sender.retryable_failures,
            "senderPhysicalAttempts": sender.physical_attempts,
            "senderSuccessfulResponses": sender.successful_responses,
            "maxQueued": max_queued,
            "finalOutbox": final_snapshot,
            "historyDeliveredReceiptsChecked": delivered_receipts,
            "resourceSummary": {
                "sampleCount": len(resource_samples),
                "rssStartBytes": rss_values[0] if rss_values else None,
                "rssEndBytes": rss_values[-1] if rss_values else None,
                "rssPeakBytes": max(rss_values) if rss_values else None,
                "rssDeltaBytes": rss_delta if rss_values else None,
                "rssTrendBytesPerHour": (
                    round(rss_delta * 3600 / duration, 3)
                    if rss_values and duration > 0
                    else None
                ),
                "databaseStartBytes": database_values[0] if database_values else None,
                "databaseEndBytes": database_values[-1] if database_values else None,
                "databasePeakBytes": max(database_values) if database_values else None,
                "databaseDeltaBytes": database_delta if database_values else None,
                "databaseTrendBytesPerHour": (
                    round(database_delta * 3600 / duration, 3)
                    if database_values and duration > 0
                    else None
                ),
            },
            "resourceSamples": resource_samples,
            "failure": failure,
        }

    async def record_sample(*, force: bool = False) -> None:
        nonlocal next_sample_at, max_queued
        elapsed = time.monotonic() - started_at
        if not force and elapsed < next_sample_at:
            return
        snapshot = (
            facade.status()["outbox"]
            if facade is not None
            else AlertOutboxStore(settings.outbox_path).snapshot()  # type: ignore[arg-type]
        )
        max_queued = max(max_queued, int(snapshot["queued"]))
        resource_samples.append({
            "capturedAt": int(time.time() * 1000),
            "elapsedSeconds": round(elapsed, 3),
            "cycle": cycles,
            "deliveriesCreated": deliveries_created,
            "rssBytes": _rss_bytes(),
            "databaseBytes": _database_bytes(settings.outbox_path),  # type: ignore[arg-type]
            "outbox": {
                "queued": snapshot["queued"],
                "staged": snapshot["staged"],
                "pending": snapshot["pending"],
                "processing": snapshot["processing"],
                "retrying": snapshot["retrying"],
                "retainedDelivered": snapshot["delivered"],
                "totalAttempts": snapshot["totalAttempts"],
                "totalDelivered": snapshot["totalDelivered"],
                "totalRetryScheduled": snapshot["totalRetryScheduled"],
                "totalDeadLetter": snapshot["totalDeadLetter"],
            },
        })
        next_sample_at = elapsed + max(0.1, float(args.sample_every_seconds))
        _write_report(args.report, build_report(status="running"))
        print(
            "[soak] "
            f"elapsed={elapsed:.1f}s cycles={cycles} deliveries={deliveries_created} "
            f"queued={snapshot['queued']} delivered={snapshot['totalDelivered']} "
            f"retries={snapshot['totalRetryScheduled']} rss={resource_samples[-1]['rssBytes']} "
            f"db={resource_samples[-1]['databaseBytes']}",
            flush=True,
        )

    async def start_facade(*, stop_existing: bool = True) -> AlertFacade:
        nonlocal facade, starts, rule_id
        if facade is not None and stop_existing:
            await facade.stop()
        facade = AlertFacade(
            store_path=root / "alerts.json",
            webhook_settings=settings,
            webhook_sender=sender,  # type: ignore[arg-type]
        )
        await facade.start()
        starts += 1
        rules = facade.list_rules()
        if rules:
            rule_id = rules[0]["id"]
        else:
            rule_id = facade.save_rule(_rule_payload())["id"]
        return facade

    async def inject_crash_recovery(mode: str) -> None:
        nonlocal facade, deliveries_created, crash_index, max_queued
        assert facade is not None
        await facade.stop()
        deliveries_created += 1
        event_id = f"soak-crash-{deliveries_created}"
        command = [
            sys.executable,
            str(SCRIPT_PATH),
            "--crash-child",
            "--crash-mode",
            mode,
            "--root",
            str(root.resolve()),
            "--event-id",
            event_id,
            "--rule-id",
            rule_id,
            "--retain-delivered",
            str(args.retain_delivered),
        ]
        completed = await asyncio.to_thread(
            subprocess.run,
            command,
            cwd=REPO_DIR,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if completed.returncode != CRASH_EXIT_CODE:
            raise RuntimeError(
                "crash child did not abort at the requested boundary: "
                f"mode={mode} exit={completed.returncode} "
                f"stdout={completed.stdout[-500:]} stderr={completed.stderr[-500:]}"
            )
        crash_recovery[mode]["injected"] += 1
        interrupted = AlertOutboxStore(settings.outbox_path).snapshot()  # type: ignore[arg-type]
        if int(interrupted[mode]) < 1:
            raise RuntimeError(
                f"crash child did not persist {mode} state: {interrupted}"
            )
        max_queued = max(max_queued, int(interrupted["queued"]))
        facade = await start_facade(stop_existing=False)
        recovered = await _wait_until_drained(facade)
        if recovered["totalDeadLetter"]:
            raise RuntimeError(f"unexpected dead letter after {mode} recovery: {recovered}")
        crash_recovery[mode]["recovered"] += 1
        crash_index += 1

    if args.require_clean_head and (git.get("dirty") is not False or not git.get("sha")):
        failure = {
            "type": "CleanHeadRequired",
            "message": f"formal soak requires a clean Git HEAD: {git}",
        }
    else:
        try:
            await start_facade()
            await record_sample(force=True)
            while True:
                elapsed = time.monotonic() - started_at
                if args.cycles > 0:
                    if cycles >= args.cycles:
                        break
                elif elapsed >= args.duration_seconds:
                    break

                cycles += 1
                deliveries_created += 1
                assert facade is not None
                rule = facade.get_rule(rule_id)
                if rule is None:
                    raise RuntimeError("soak alert rule disappeared")
                event = await facade.emit_triggered(
                    {
                        "id": f"soak-event-{deliveries_created}",
                        "ruleId": rule_id,
                        "message": f"soak event {deliveries_created}",
                        "values": {"close": deliveries_created},
                        "actions": rule["actions"],
                    },
                    enforce_limits=False,
                )
                if event is None or event["dispatch"][0]["status"] != "queued":
                    raise RuntimeError(f"event was not durably queued: {event}")
                max_queued = max(max_queued, int(facade.status()["outbox"]["queued"]))
                snapshot = await _wait_until_drained(facade)
                if snapshot["totalDeadLetter"]:
                    raise RuntimeError(f"unexpected dead letter: {snapshot}")

                if args.crash_every > 0 and cycles % args.crash_every == 0:
                    mode = CRASH_MODES[crash_index % len(CRASH_MODES)]
                    await inject_crash_recovery(mode)
                elif args.restart_every > 0 and cycles % args.restart_every == 0:
                    await start_facade()
                    graceful_restarts += 1
                await record_sample()
        except Exception as exc:
            failure = {
                "type": type(exc).__name__,
                "message": str(exc)[:2_000],
                "traceback": traceback.format_exc(limit=20)[-10_000:],
            }
        finally:
            if facade is not None:
                try:
                    await facade.stop()
                except Exception as exc:
                    if failure is None:
                        failure = {
                            "type": type(exc).__name__,
                            "message": f"final worker stop failed: {exc}"[:2_000],
                            "traceback": traceback.format_exc(limit=20)[-10_000:],
                        }

    final_snapshot = AlertOutboxStore(settings.outbox_path).snapshot()  # type: ignore[arg-type]
    final_facade = AlertFacade(
        store_path=root / "alerts.json",
        webhook_settings=settings,
        webhook_sender=sender,  # type: ignore[arg-type]
    )
    history = final_facade.list_history(
        limit=min(1_000, max(1, deliveries_created)),
        rule_id=rule_id or None,
    )
    delivered_receipts = sum(
        1
        for event in history
        if event.get("dispatch")
        and event["dispatch"][0].get("status") == "delivered"
    )
    await record_sample(force=True)
    crashes_complete = all(
        counts["injected"] == counts["recovered"]
        and (args.crash_every == 0 or counts["injected"] > 0)
        for counts in crash_recovery.values()
    )
    expected_receipts = min(deliveries_created, 1_000)
    passed = (
        failure is None
        and final_snapshot["queued"] == 0
        and final_snapshot["totalDeadLetter"] == 0
        and final_snapshot["totalDelivered"] == deliveries_created
        and sender.successful_responses == deliveries_created
        and delivered_receipts == expected_receipts
        and crashes_complete
    )
    if not passed and failure is None:
        failure = {
            "type": "GateMismatch",
            "message": (
                f"deliveries={deliveries_created} outbox={final_snapshot} "
                f"senderSuccessful={sender.successful_responses} "
                f"receipts={delivered_receipts}/{expected_receipts} "
                f"crashRecovery={crash_recovery}"
            )[:4_000],
        }
    report = build_report(
        status="passed" if passed else "failed",
        final_snapshot=final_snapshot,
        delivered_receipts=delivered_receipts,
        passed=passed,
    )
    _write_report(args.report, report)
    return report


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration-seconds", type=float, default=60.0)
    parser.add_argument("--cycles", type=int, default=0)
    parser.add_argument("--restart-every", type=int, default=25)
    parser.add_argument("--crash-every", type=int, default=100)
    parser.add_argument("--failure-every", type=int, default=7)
    parser.add_argument("--retain-delivered", type=int, default=100_000)
    parser.add_argument("--sample-every-seconds", type=float, default=30.0)
    parser.add_argument("--require-clean-head", action="store_true")
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--crash-child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--crash-mode", choices=CRASH_MODES, help=argparse.SUPPRESS)
    parser.add_argument("--root", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--event-id", help=argparse.SUPPRESS)
    parser.add_argument("--rule-id", help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.crash_child:
        if not args.root or not args.event_id or not args.rule_id or not args.crash_mode:
            raise SystemExit("crash child requires root, event id, rule id, and mode")
        return _run_crash_child(args)

    if args.cycles < 0 or args.duration_seconds <= 0:
        raise SystemExit("cycles must be non-negative and duration must be positive")
    if args.state_dir is not None:
        root = args.state_dir.resolve()
        root.mkdir(parents=True, exist_ok=True)
        if any(root.iterdir()):
            raise SystemExit(f"state directory must be empty: {root}")
        report = asyncio.run(run_soak(args, root))
    else:
        with tempfile.TemporaryDirectory(prefix="candlescope-alert-soak-") as temporary:
            report = asyncio.run(run_soak(args, Path(temporary)))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
