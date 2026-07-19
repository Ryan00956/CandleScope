"""Runtime memory GC planning for DataManager-owned caches."""
from __future__ import annotations

import time
from dataclasses import dataclass, replace
from typing import Any

from app.data_engine.interval_policy import is_ephemeral_interval

from .models import SeriesKey, StreamStatus

BAR_ESTIMATED_BYTES = 96
DEFAULT_COLD_IDLE_SECONDS = 30 * 60
DEFAULT_MAX_VICTIMS = 50
DEFAULT_PLAN_TTL_MS = 30_000
HARD_PROCESS_RSS_BYTES = 512 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class MemoryGcPolicy:
    """Budget and protection knobs for DataManager memory GC."""

    cold_idle_seconds: int = DEFAULT_COLD_IDLE_SECONDS
    max_total_bars: int | None = None
    max_series: int | None = None
    max_victims: int = DEFAULT_MAX_VICTIMS
    preserve_active: bool = True
    preserve_subscribed: bool = True
    ephemeral_keep_bars: int | None = None

    @classmethod
    def from_mapping(cls, values: dict[str, Any] | None = None) -> "MemoryGcPolicy":
        values = values or {}
        return cls(
            cold_idle_seconds=max(
                0,
                _int_or_default(values.get("cold_idle_seconds"), DEFAULT_COLD_IDLE_SECONDS),
            ),
            max_total_bars=_optional_positive_int(values.get("max_total_bars")),
            max_series=_optional_positive_int(values.get("max_series")),
            max_victims=max(1, _int_or_default(values.get("max_victims"), DEFAULT_MAX_VICTIMS)),
            preserve_active=bool(values.get("preserve_active", True)),
            preserve_subscribed=bool(values.get("preserve_subscribed", True)),
            ephemeral_keep_bars=_optional_positive_int(values.get("ephemeral_keep_bars")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "cold_idle_seconds": self.cold_idle_seconds,
            "max_total_bars": self.max_total_bars,
            "max_series": self.max_series,
            "max_victims": self.max_victims,
            "preserve_active": self.preserve_active,
            "preserve_subscribed": self.preserve_subscribed,
            "ephemeral_keep_bars": self.ephemeral_keep_bars,
        }


def plan_memory_gc(
    data_manager: Any,
    policy: MemoryGcPolicy | dict[str, Any] | None = None,
    *,
    behavior_heat: dict[str, dict[str, Any]] | None = None,
    runtime_pressure: dict[str, Any] | None = None,
    scoring: str = "smart",
) -> dict[str, Any]:
    """Build a dry-run plan for DataManager memory cache cleanup."""
    effective_policy = policy if isinstance(policy, MemoryGcPolicy) else MemoryGcPolicy.from_mapping(policy)
    if effective_policy.ephemeral_keep_bars is None:
        effective_policy = replace(
            effective_policy,
            ephemeral_keep_bars=int(data_manager.cache.get_ephemeral_limit()),
        )
    cache_snapshot = data_manager.cache.snapshot()
    now_ms = int(time.time() * 1000)
    active_keys = _active_keys(data_manager)
    subscribed_keys = _subscribed_keys(data_manager)
    leased_consumers = _leased_consumers(data_manager)
    total_bars = int(cache_snapshot.get("total_bars", 0) or 0)
    total_series = int(cache_snapshot.get("total_series", 0) or 0)
    max_total_bars = effective_policy.max_total_bars
    if max_total_bars is None:
        max_total_bars = max(0, int(cache_snapshot.get("max_bars_per_series", 0) or 0)) * max(
            1,
            int(cache_snapshot.get("max_series", 0) or 0),
        )
    max_series = effective_policy.max_series or int(cache_snapshot.get("max_series", 0) or 0) or None
    runtime_hard_pressure = _runtime_hard_memory_pressure(runtime_pressure)
    pressure = {
        "total_bars": total_bars,
        "max_total_bars": max_total_bars,
        "over_total_bars": max(0, total_bars - max_total_bars) if max_total_bars else 0,
        "total_series": total_series,
        "max_series": max_series,
        "over_series": max(0, total_series - max_series) if max_series else 0,
        "runtime_hard_pressure": runtime_hard_pressure,
    }
    entries = _cache_entries(
        data_manager,
        cache_snapshot,
        active_keys,
        subscribed_keys,
        leased_consumers,
        now_ms,
        effective_policy,
    )
    candidates: list[dict[str, Any]] = []
    protected_count = 0
    for entry in entries:
        if entry["protected"]:
            protected_count += 1
            continue
        action = _candidate_action(entry, effective_policy, pressure)
        if action is None:
            continue
        candidate = {**entry, **action}
        if scoring == "smart":
            candidate.update(_smart_scores(
                candidate,
                behavior_heat=behavior_heat or {},
                data_manager=data_manager,
                pressure=pressure,
                runtime_pressure=runtime_pressure or {},
            ))
        candidates.append(candidate)

    candidates.sort(key=_smart_victim_sort_key if scoring == "smart" else _victim_sort_key)
    victims = candidates[: effective_policy.max_victims]
    return {
        "generated_at_ms": now_ms,
        "expires_at_ms": now_ms + DEFAULT_PLAN_TTL_MS,
        "mode": "dry-run",
        "owner": "data-manager-memory",
        "scoringVersion": 1 if scoring == "smart" else 0,
        "policy": effective_policy.to_dict(),
        "pressure": pressure,
        "runtimePressure": runtime_pressure or {},
        "protected_count": protected_count,
        "candidate_count": len(candidates),
        "victims": victims,
        "would_remove_series": sum(1 for item in victims if item.get("action") == "delete-series"),
        "would_trim_series": sum(1 for item in victims if item.get("action") == "trim-series"),
        "would_free_bars": sum(int(item.get("would_free_bars", 0) or 0) for item in victims),
        "would_free_estimated_bytes": sum(int(item.get("would_free_estimated_bytes", 0) or 0) for item in victims),
    }


def execute_memory_gc_plan(data_manager: Any, plan: dict[str, Any]) -> dict[str, Any]:
    """Execute a pre-filtered memory GC plan against DataManager's BarCache."""
    removed_series = 0
    trimmed_series = 0
    removed_bars = 0
    skipped_count = 0
    unsupported_count = 0
    results: list[dict[str, Any]] = []
    expires_at_ms = int(plan.get("expires_at_ms", 0) or 0)
    if expires_at_ms and int(time.time() * 1000) > expires_at_ms:
        return {
            **plan,
            "mode": "execute",
            "status": "stale",
            "stale_reason": "plan-expired",
            "removed_series": 0,
            "trimmed_series": 0,
            "removed_bars": 0,
            "removed_estimated_bytes": 0,
            "skipped_count": len(plan.get("victims", []) or []),
            "results": [],
        }

    for victim in plan["victims"]:
        key = _series_key_from_victim(victim)
        active = key in _active_keys(data_manager)
        subscribed = key in _subscribed_keys(data_manager)
        if active or subscribed:
            skipped_count += 1
            results.append({
                **victim,
                "removed_bars": 0,
                "status": "protected-at-execute",
                "active_at_execute": active,
                "subscribed_at_execute": subscribed,
            })
            continue

        expected_generation = int(victim.get("generation", -1) or 0)
        expected_revision = int(victim.get("revision", -1) or 0)
        expected_access_revision = int(victim.get("access_revision", -1) or 0)
        expected_last_access_ms = int(victim.get("last_access_ms", 0) or 0)
        if victim.get("action") == "delete-series":
            conditional_remove = getattr(data_manager.cache, "remove_series_if_unchanged", None)
            if callable(conditional_remove) and expected_generation >= 0:
                count, outcome = conditional_remove(
                    key,
                    expected_generation=expected_generation,
                    expected_revision=expected_revision,
                    expected_access_revision=expected_access_revision,
                    expected_last_access_ms=expected_last_access_ms,
                )
            elif callable(conditional_remove):
                count, outcome = 0, "stale"
            else:
                count, outcome = 0, "unsupported"
            removed_series += 1 if count else 0
            removed_bars += count
            if outcome in {"stale", "unsupported"}:
                skipped_count += 1
            if outcome == "unsupported":
                unsupported_count += 1
            results.append({**victim, "removed_bars": count, "status": outcome})
        elif victim.get("action") == "trim-series":
            keep_bars = int(victim.get("keep_bars", 0) or 0)
            conditional_trim = getattr(data_manager.cache, "trim_series_if_unchanged", None)
            if callable(conditional_trim) and expected_generation >= 0:
                count, outcome = conditional_trim(
                    key,
                    keep_bars,
                    expected_generation=expected_generation,
                    expected_revision=expected_revision,
                    expected_access_revision=expected_access_revision,
                    expected_last_access_ms=expected_last_access_ms,
                )
            elif callable(conditional_trim):
                count, outcome = 0, "stale"
            else:
                count, outcome = 0, "unsupported"
            trimmed_series += 1 if count else 0
            removed_bars += count
            if outcome in {"stale", "unsupported"}:
                skipped_count += 1
            if outcome == "unsupported":
                unsupported_count += 1
            results.append({**victim, "removed_bars": count, "status": outcome})

    return {
        **plan,
        "mode": "execute",
        # Protection/revision drift means the safety checks did their job.  It
        # is an execution constraint, not a GC engine failure.
        "status": (
            "partial"
            if unsupported_count
            else "ok"
            if skipped_count == 0
            else "constrained"
        ),
        "removed_series": removed_series,
        "trimmed_series": trimmed_series,
        "removed_bars": removed_bars,
        "removed_estimated_bytes": removed_bars * BAR_ESTIMATED_BYTES,
        "skipped_count": skipped_count,
        "unsupported_count": unsupported_count,
        "results": results,
    }


def run_memory_gc(data_manager: Any, policy: MemoryGcPolicy | dict[str, Any] | None = None) -> dict[str, Any]:
    """Execute a memory GC plan against DataManager's BarCache."""
    plan = plan_memory_gc(data_manager, policy)
    return execute_memory_gc_plan(data_manager, plan)


def _optional_positive_int(value: Any) -> int | None:
    if value is None:
        return None
    parsed = int(value)
    return parsed if parsed > 0 else None


def _int_or_default(value: Any, default: int) -> int:
    if value is None:
        return default
    return int(value)


def _cache_entries(
    data_manager: Any,
    cache_snapshot: dict[str, Any],
    active_keys: set[SeriesKey],
    subscribed_keys: set[SeriesKey],
    leased_consumers: dict[SeriesKey, list[str]],
    now_ms: int,
    policy: MemoryGcPolicy,
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    series_snapshot = cache_snapshot.get("series") or {}
    for key in data_manager.cache.get_all_keys():
        snapshot = series_snapshot.get(str(key), {})
        count = int(snapshot.get("count", 0) or 0)
        last_access_ms = int(snapshot.get("last_access_ms", 0) or 0)
        idle_ms = max(0, now_ms - last_access_ms) if last_access_ms else None
        subscriber_count = _subscriber_count(data_manager, key)
        lease_consumers = leased_consumers.get(key, [])
        active = key in active_keys
        subscribed = key in subscribed_keys or subscriber_count > 0 or bool(lease_consumers)
        protected = active or subscribed
        tier = "active" if active else "subscribed" if subscribed else "cold"
        if not protected and idle_ms is not None and idle_ms < policy.cold_idle_seconds * 1000:
            tier = "warm"
        entries.append({
            "owner": "data-manager-memory",
            "key": str(key),
            "exchange": key.exchange,
            "market_type": key.market_type,
            "symbol": key.symbol,
            "interval": key.interval,
            "bars": count,
            "estimated_bytes": count * BAR_ESTIMATED_BYTES,
            "earliest_time": snapshot.get("earliest_time"),
            "latest_time": snapshot.get("latest_time"),
            "last_access_ms": last_access_ms,
            "generation": int(snapshot.get("generation", 0) or 0),
            "revision": int(snapshot.get("revision", 0) or 0),
            "access_revision": int(snapshot.get("access_revision", 0) or 0),
            "idle_ms": idle_ms,
            "ephemeral": is_ephemeral_interval(key.interval),
            "active": active,
            "subscribed": subscribed,
            "subscriber_count": subscriber_count,
            "lease_consumers": lease_consumers,
            "tier": tier,
            "protected": protected,
        })
    return entries


def _candidate_action(
    entry: dict[str, Any],
    policy: MemoryGcPolicy,
    pressure: dict[str, Any],
) -> dict[str, Any] | None:
    if policy.preserve_active and entry["active"]:
        return None
    if policy.preserve_subscribed and entry["subscribed"]:
        return None
    idle_ms = entry.get("idle_ms")
    idle_enough = idle_ms is not None and idle_ms >= policy.cold_idle_seconds * 1000
    under_pressure = bool(
        pressure.get("over_total_bars")
        or pressure.get("over_series")
        or pressure.get("runtime_hard_pressure")
    )
    if entry["ephemeral"]:
        keep_bars = int(policy.ephemeral_keep_bars or 0)
        if keep_bars <= 0 or entry["bars"] <= keep_bars:
            return None
        if not idle_enough and not under_pressure:
            return None
        would_free = entry["bars"] - keep_bars
        return {
            "action": "trim-series",
            "keep_bars": keep_bars,
            "would_free_bars": would_free,
            "would_free_estimated_bytes": would_free * BAR_ESTIMATED_BYTES,
            "reason": "ephemeral-over-limit",
        }
    if not idle_enough and not under_pressure:
        return None
    return {
        "action": "delete-series",
        "would_free_bars": entry["bars"],
        "would_free_estimated_bytes": entry["estimated_bytes"],
        "reason": "cold-non-ephemeral-storage-backed",
    }
def _victim_sort_key(entry: dict[str, Any]) -> tuple[int, int, int]:
    tier_rank = {"cold": 0, "warm": 1, "subscribed": 2, "active": 3}.get(entry.get("tier"), 9)
    action_rank = 0 if entry.get("action") == "delete-series" else 1
    return (tier_rank, action_rank, -int(entry.get("would_free_bars", 0) or 0))


def _smart_victim_sort_key(entry: dict[str, Any]) -> tuple[float, tuple[int, int, int]]:
    return (-float(entry.get("scores", {}).get("finalEvictScore", 0) or 0), _victim_sort_key(entry))


def _smart_scores(
    entry: dict[str, Any],
    *,
    behavior_heat: dict[str, dict[str, Any]],
    data_manager: Any,
    pressure: dict[str, Any],
    runtime_pressure: dict[str, Any],
) -> dict[str, Any]:
    key = _series_key_from_victim(entry)
    heat = behavior_heat.get(str(key), {})
    heat_score = max(0.0, float(heat.get("heat_score", 0) or 0))
    switch_count = max(0, int(heat.get("switch_count_24h", 0) or 0))
    reuse_probability = max(0.0, min(100.0, heat_score * 8 + switch_count * 12))
    matched_intents = _matched_storage_intents(data_manager, key)
    intent_rank = max((_intent_rank(item) for item in matched_intents), default=0)
    restore_cost, restore_reason = _restore_cost(entry, matched_intents)
    pressure_score = _pressure_score(entry, pressure, runtime_pressure)
    gc_value = min(100.0, (float(entry.get("would_free_estimated_bytes", 0) or 0) / (1024 * 1024)) * 8)
    if entry.get("action") == "delete-series":
        gc_value += 10
    final = max(0.0, gc_value + pressure_score - reuse_probability - restore_cost - intent_rank * 12)
    reuse_reason = "no-recent-heat"
    if reuse_probability >= 60:
        reuse_reason = "hot-series"
    elif reuse_probability >= 20:
        reuse_reason = "recently-reused"
    return {
        "behaviorHeat": heat,
        "matchedIntents": matched_intents,
        "restoreCostReason": restore_reason,
        "reuseReason": reuse_reason,
        "scores": {
            "gcValueScore": round(gc_value, 3),
            "restoreCostScore": round(restore_cost, 3),
            "reuseProbabilityScore": round(reuse_probability, 3),
            "pressureScore": round(pressure_score, 3),
            "finalEvictScore": round(final, 3),
        },
    }


def _matched_storage_intents(data_manager: Any, key: SeriesKey) -> list[dict[str, Any]]:
    registry = getattr(data_manager, "storage_intents", None)
    match = getattr(registry, "match", None)
    if not callable(match):
        return []
    try:
        return [intent.to_dict() for intent in match(key)]
    except Exception:
        return []


def _intent_rank(intent: dict[str, Any]) -> int:
    return {"weak": 1, "normal": 2, "strong": 3}.get(str(intent.get("priority") or "").lower(), 0)


def _restore_cost(entry: dict[str, Any], matched_intents: list[dict[str, Any]]) -> tuple[float, str]:
    if entry.get("ephemeral"):
        return 70.0, "ephemeral-not-storage-backed"
    if any(intent.get("stream_required") for intent in matched_intents):
        return 65.0, "active-stream-or-workflow-intent"
    if any("alert" in str(intent.get("source", "")) for intent in matched_intents):
        return 80.0, "alert-workflow"
    if entry.get("interval") and is_ephemeral_interval(str(entry.get("interval"))):
        return 70.0, "ephemeral-interval"
    return 20.0, "sqlite-reload"


def _pressure_score(
    entry: dict[str, Any],
    pressure: dict[str, Any],
    runtime_pressure: dict[str, Any],
) -> float:
    score = 0.0
    if pressure.get("over_total_bars"):
        score += 25.0
    if pressure.get("over_series"):
        score += 15.0
    rss = ((runtime_pressure or {}).get("processMemory") or {}).get("rss_bytes")
    if rss and int(rss) >= HARD_PROCESS_RSS_BYTES:
        score += 20.0
    if entry.get("action") == "delete-series":
        score += 10.0
    return score


def _runtime_hard_memory_pressure(runtime_pressure: dict[str, Any] | None) -> bool:
    process_memory = ((runtime_pressure or {}).get("processMemory") or {})
    if process_memory.get("available") is False:
        return False
    try:
        return int(process_memory.get("rss_bytes", 0) or 0) >= HARD_PROCESS_RSS_BYTES
    except (TypeError, ValueError):
        return False


def _active_keys(data_manager: Any) -> set[SeriesKey]:
    keys: set[SeriesKey] = set()
    for info in getattr(data_manager.coordinator, "get_all_streams", lambda: [])():
        status = getattr(info, "status", None)
        if status in (StreamStatus.ACTIVE, StreamStatus.STARTING) or getattr(status, "value", None) in {"active", "starting"}:
            key = getattr(info, "key", None)
            if isinstance(key, SeriesKey):
                keys.add(key)
    get_targets = getattr(getattr(data_manager, "bar_aggregator", None), "get_targets", None)
    if callable(get_targets):
        for exchange, market_type, symbol, interval in get_targets():
            keys.add(SeriesKey(symbol, interval, exchange=exchange, market_type=market_type))
    return keys


def _subscribed_keys(data_manager: Any) -> set[SeriesKey]:
    keys: set[SeriesKey] = set()
    event_bus = getattr(data_manager, "event_bus", None)
    get_all_subscribed_keys = getattr(event_bus, "get_all_subscribed_keys", None)
    if callable(get_all_subscribed_keys):
        keys.update(get_all_subscribed_keys())
    keys.update(_leased_consumers(data_manager))
    return keys


def _subscriber_count(data_manager: Any, key: SeriesKey) -> int:
    event_bus = getattr(data_manager, "event_bus", None)
    get_direct_subscriber_count = getattr(
        event_bus,
        "get_direct_subscriber_count",
        None,
    )
    if callable(get_direct_subscriber_count):
        return int(get_direct_subscriber_count(key) or 0)
    get_subscriber_count = getattr(event_bus, "get_subscriber_count", None)
    if callable(get_subscriber_count):
        return int(get_subscriber_count(key) or 0)
    return 0


def _leased_consumers(data_manager: Any) -> dict[SeriesKey, list[str]]:
    leases = getattr(data_manager, "_stream_leases", {}) or {}
    result: dict[SeriesKey, list[str]] = {}
    for key, lease in leases.items():
        if not isinstance(key, SeriesKey):
            continue
        consumers = sorted(str(item) for item in getattr(lease, "consumers", set()) if item)
        if consumers:
            result[key] = consumers
    return result


def _series_key_from_victim(victim: dict[str, Any]) -> SeriesKey:
    return SeriesKey(
        str(victim["symbol"]),
        str(victim["interval"]),
        exchange=str(victim.get("exchange") or "binance"),
        market_type=str(victim.get("market_type") or "spot"),
    )
