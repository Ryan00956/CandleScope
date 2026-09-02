"""
Exchange symbol (trading pair) information API.

This module now reads symbol metadata through the exchange registry.
Binance remains the default adapter, but the cache shape is already
prepared for future exchanges.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import math
import os
import random
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.core.config import (
    SYMBOL_CATALOG_EMPTY_WAIT_SECONDS,
    SYMBOL_CATALOG_FAILURE_RETRY_SECONDS,
    SYMBOL_CATALOG_FOREGROUND_DWELL_SECONDS,
    SYMBOL_CATALOG_FOREGROUND_RECHECK_SECONDS,
    SYMBOL_CATALOG_MIN_RETAIN_RATIO,
    SYMBOL_CATALOG_RETRY_JITTER_SECONDS,
    SYMBOL_CATALOG_SNAPSHOT_PATH,
    SYMBOL_CATALOG_TTL_SECONDS,
)
from app.exchanges import (
    RateLimitDeferred,
    bootstrap_default_adapters,
    get_exchange_registry,
)

router = APIRouter(prefix="/symbols", tags=["symbols"])
logger = logging.getLogger("candlescope.symbol_catalog")

# ── In-memory cache ──────────────────────────────────────────

_symbol_cache: dict[tuple[str, str], list[dict[str, Any]]] = {}
_cache_loaded_at: float = 0.0
_SNAPSHOT_VERSION = 1
_snapshot_revision = 0
_last_persisted_revision = 0
_snapshot_write_lock = threading.Lock()
_catalog_stopping = False
_DEFAULT_SYMBOL_CATALOG_SNAPSHOT_PATH = Path(SYMBOL_CATALOG_SNAPSHOT_PATH)


@dataclass(slots=True)
class _MarketRefreshState:
    last_attempt_at: float = 0.0
    last_success_at: float = 0.0
    retry_at_ms: int | None = None
    last_error: str | None = None
    stale: bool = True


_market_refresh_state: dict[tuple[str, str], _MarketRefreshState] = {}
_market_refresh_tasks: dict[tuple[str, str], asyncio.Task[int]] = {}
_market_refresh_timers: dict[tuple[str, str], asyncio.TimerHandle] = {}
_market_auto_refresh_tasks: dict[tuple[str, str], asyncio.Task[None]] = {}
_foreground_busy_probe: Callable[[], bool] | None = None
_foreground_idle_probe: Callable[[], float] | None = None


def _market_cache_key(exchange: str, market_type: str) -> tuple[str, str]:
    return exchange.strip().lower(), (market_type or "").strip().lower()


def _merge_symbol_snapshot(
    previous: list[dict[str, Any]],
    current: list[dict[str, Any]],
    *,
    observed_at_ms: int,
    previous_observed_at_ms: int | None,
) -> list[dict[str, Any]]:
    """Retain disappeared instruments as process-local inactive metadata.

    A missing instrument is observational evidence only, so this does not
    invent a delisting timestamp. The planner may still use its last known
    listing/expiry metadata without the public symbol list showing it as live.
    """

    previous_by_symbol = {
        str(item.get("symbol", "")).upper(): item
        for item in previous
        if str(item.get("symbol", "")).strip()
    }
    merged: list[dict[str, Any]] = []
    current_symbols: set[str] = set()
    for item in current:
        snapshot = dict(item)
        symbol = str(snapshot.get("symbol", "")).upper()
        if not symbol:
            continue
        current_symbols.add(symbol)
        old = previous_by_symbol.get(symbol, {})
        snapshot["active"] = True
        snapshot["firstSeenAtMs"] = old.get("firstSeenAtMs", observed_at_ms)
        snapshot["lastSeenAtMs"] = observed_at_ms
        snapshot.pop("inactiveSinceMs", None)
        merged.append(snapshot)

    for symbol, old in previous_by_symbol.items():
        if symbol in current_symbols:
            continue
        snapshot = dict(old)
        snapshot["active"] = False
        snapshot.setdefault(
            "lastSeenAtMs",
            previous_observed_at_ms or observed_at_ms,
        )
        snapshot.setdefault("inactiveSinceMs", observed_at_ms)
        merged.append(snapshot)
    return merged


def get_cached_symbol_metadata(
    exchange: str,
    market_type: str,
    symbol: str,
) -> dict[str, Any] | None:
    """Return a detached synchronous snapshot for history planning."""

    key = _market_cache_key(exchange, market_type)
    normalized_symbol = str(symbol or "").strip().upper()
    for item in _symbol_cache.get(key, ()):
        if str(item.get("symbol", "")).upper() == normalized_symbol:
            return copy.deepcopy(item)
    return None


def evict_exchange_metadata(exchange: str) -> int:
    """Remove Host-owned symbol cache rows for one unregistered exchange."""

    global _cache_loaded_at

    normalized_exchange = exchange.strip().lower()
    if not normalized_exchange:
        raise ValueError("exchange is required for symbol cache eviction")
    keys = {
        key
        for key in (
            set(_symbol_cache)
            | set(_market_refresh_state)
            | set(_market_refresh_tasks)
            | set(_market_refresh_timers)
            | set(_market_auto_refresh_tasks)
        )
        if key[0] == normalized_exchange
    }
    removed = sum(len(_symbol_cache.get(key, ())) for key in keys)
    for key in keys:
        _symbol_cache.pop(key, None)
        _market_refresh_state.pop(key, None)
        _cancel_market_refresh_timer(key)
        refresh_task = _market_refresh_tasks.pop(key, None)
        if refresh_task is not None and not refresh_task.done():
            refresh_task.cancel()
        automatic_task = _market_auto_refresh_tasks.pop(key, None)
        if automatic_task is not None and not automatic_task.done():
            automatic_task.cancel()
    if keys:
        _cache_loaded_at = time.time()
        try:
            asyncio.get_running_loop().create_task(
                _persist_exchange_metadata_snapshot(),
                name=f"symbol-catalog-evict:{normalized_exchange}",
            )
        except RuntimeError:
            pass
    return removed


def initialize_exchange_metadata_cache() -> bool:
    """Start the catalog lifecycle and restore a validated disk snapshot."""

    global _catalog_stopping
    _catalog_stopping = False
    return load_exchange_metadata_snapshot()


def configure_exchange_metadata_foreground_probe(coordinator: Any | None) -> None:
    """Bind speculative catalog timers to the runtime foreground owner."""

    global _foreground_busy_probe, _foreground_idle_probe
    busy = getattr(coordinator, "has_foreground_work", None)
    idle = getattr(coordinator, "foreground_idle_seconds", None)
    _foreground_busy_probe = busy if callable(busy) else None
    _foreground_idle_probe = idle if callable(idle) else None


def _catalog_foreground_is_quiet() -> bool:
    if _foreground_busy_probe is None:
        return True
    try:
        if _foreground_busy_probe():
            return False
        idle_for = (
            float(_foreground_idle_probe())
            if _foreground_idle_probe is not None
            else float("inf")
        )
        return idle_for >= SYMBOL_CATALOG_FOREGROUND_DWELL_SECONDS
    except Exception:
        return False


def load_exchange_metadata_snapshot(path: Path | None = None) -> bool:
    """Atomically publish one fully validated last-known-good snapshot."""

    global _cache_loaded_at, _snapshot_revision, _last_persisted_revision
    snapshot_path = Path(path or SYMBOL_CATALOG_SNAPSHOT_PATH)
    if path is None and not _snapshot_persistence_enabled(snapshot_path):
        return False
    try:
        raw = json.loads(snapshot_path.read_text(encoding="utf-8"))
        restored_cache, restored_states, saved_at, revision = (
            _validate_snapshot_payload(raw)
        )
    except FileNotFoundError:
        return False
    except Exception as exc:
        logger.warning(
            "Ignoring invalid symbol catalog snapshot %s: %s",
            snapshot_path,
            exc,
        )
        return False

    _symbol_cache.clear()
    _symbol_cache.update(restored_cache)
    _market_refresh_state.clear()
    _market_refresh_state.update(restored_states)
    _cache_loaded_at = saved_at
    _snapshot_revision = max(_snapshot_revision, revision)
    _last_persisted_revision = max(_last_persisted_revision, revision)
    logger.info(
        "Restored symbol catalog snapshot %s (%s markets)",
        snapshot_path,
        len(restored_cache),
    )
    return True


def _validate_snapshot_payload(
    raw: object,
) -> tuple[
    dict[tuple[str, str], list[dict[str, Any]]],
    dict[tuple[str, str], _MarketRefreshState],
    float,
    int,
]:
    if not isinstance(raw, dict) or raw.get("version") != _SNAPSHOT_VERSION:
        raise ValueError("unsupported symbol catalog snapshot version")
    saved_at = float(raw.get("saved_at", 0.0))
    if not math.isfinite(saved_at) or saved_at <= 0:
        raise ValueError("invalid symbol catalog snapshot timestamp")
    revision = max(0, int(raw.get("revision", 0)))
    markets = raw.get("markets")
    if not isinstance(markets, list) or not markets:
        raise ValueError("symbol catalog snapshot has no markets")

    restored_cache: dict[tuple[str, str], list[dict[str, Any]]] = {}
    restored_states: dict[tuple[str, str], _MarketRefreshState] = {}
    for market in markets:
        if not isinstance(market, dict):
            raise ValueError("invalid symbol catalog market entry")
        exchange = str(market.get("exchange", "")).strip().lower()
        market_type = str(market.get("market_type", "")).strip().lower()
        key = _market_cache_key(exchange, market_type)
        if not all(key) or key in restored_cache:
            raise ValueError("invalid or duplicate symbol catalog market key")
        last_success_at = float(market.get("last_success_at", saved_at))
        if not math.isfinite(last_success_at) or last_success_at <= 0:
            raise ValueError("invalid symbol catalog market timestamp")
        raw_symbols = market.get("symbols")
        if not isinstance(raw_symbols, list) or not raw_symbols:
            raise ValueError("symbol catalog market has no symbols")

        symbols: list[dict[str, Any]] = []
        seen: set[str] = set()
        active_count = 0
        for item in raw_symbols:
            if not isinstance(item, dict):
                raise ValueError("invalid symbol catalog symbol entry")
            symbol = str(item.get("symbol", "")).strip().upper()
            base_asset = str(item.get("baseAsset", "")).strip().upper()
            quote_asset = str(item.get("quoteAsset", "")).strip().upper()
            item_exchange = str(item.get("exchange", exchange)).strip().lower()
            item_market = str(item.get("marketType", market_type)).strip().lower()
            if (
                not symbol
                or not base_asset
                or not quote_asset
                or symbol in seen
                or item_exchange != exchange
                or item_market != market_type
            ):
                raise ValueError("invalid symbol catalog symbol identity")
            seen.add(symbol)
            snapshot = dict(item)
            snapshot.update({
                "symbol": symbol,
                "baseAsset": base_asset,
                "quoteAsset": quote_asset,
                "exchange": exchange,
                "marketType": market_type,
            })
            if snapshot.get("active", True) is True:
                active_count += 1
            symbols.append(snapshot)
        if active_count <= 0:
            raise ValueError("symbol catalog market has no active symbols")
        restored_cache[key] = symbols
        # A disk snapshot is usable but deliberately stale until an upstream
        # refresh succeeds in this process.
        restored_states[key] = _MarketRefreshState(
            last_success_at=last_success_at,
            stale=True,
        )

    return restored_cache, restored_states, saved_at, revision


def _snapshot_payload(revision: int) -> dict[str, Any]:
    markets: list[dict[str, Any]] = []
    for key, symbols in sorted(_symbol_cache.items()):
        if not symbols or _active_symbol_count(key) <= 0:
            continue
        state = _market_refresh_state.get(key, _MarketRefreshState())
        markets.append({
            "exchange": key[0],
            "market_type": key[1],
            "last_success_at": state.last_success_at or _cache_loaded_at,
            "symbols": copy.deepcopy(symbols),
        })
    return {
        "version": _SNAPSHOT_VERSION,
        "revision": revision,
        "saved_at": _cache_loaded_at or time.time(),
        "markets": markets,
    }


def _write_snapshot_atomic(
    path: Path,
    payload: dict[str, Any],
    revision: int,
) -> None:
    global _last_persisted_revision
    with _snapshot_write_lock:
        if revision < _last_persisted_revision:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(
            f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp"
        )
        try:
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(temporary, path)
            _last_persisted_revision = revision
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


async def _persist_exchange_metadata_snapshot() -> None:
    global _snapshot_revision
    _snapshot_revision += 1
    revision = _snapshot_revision
    payload = _snapshot_payload(revision)
    if not payload["markets"]:
        return
    snapshot_path = Path(SYMBOL_CATALOG_SNAPSHOT_PATH)
    if not _snapshot_persistence_enabled(snapshot_path):
        return
    try:
        await asyncio.to_thread(
            _write_snapshot_atomic,
            snapshot_path,
            payload,
            revision,
        )
    except Exception as exc:
        # Memory has already published the verified snapshot. Persistence is a
        # resilience sidecar and must never roll back a healthy live catalog.
        logger.warning("Symbol catalog snapshot write failed: %s", exc)


def _snapshot_persistence_enabled(path: Path) -> bool:
    return not (
        "PYTEST_CURRENT_TEST" in os.environ
        and path == _DEFAULT_SYMBOL_CATALOG_SNAPSHOT_PATH
    )


async def refresh_exchange_metadata(
    exchange: str = "",
    *,
    market_type: str = "",
    force: bool = False,
) -> dict[str, int]:
    """Refresh one or all exchange catalogs with per-market singleflight.

    Normal refreshes honor the catalog TTL and failure retry deadline.  A
    manual ``force`` bypasses those cache admission checks, but still joins an
    already-running physical refresh and can never bypass exchange cooldowns.
    Failed and empty responses leave the last-known-good snapshot untouched.
    """
    requests = _catalog_refresh_requests(exchange, market_type)

    refreshed = await asyncio.gather(
        *(
            _refresh_market_catalog(adapter, market_type, force=force)
            for _exchange_id, market_type, adapter in requests
        )
    )
    return {
        f"{exchange_id}:{market_type}": count
        for (exchange_id, market_type, _adapter), count in zip(
            requests,
            refreshed,
            strict=True,
        )
    }


def _catalog_refresh_requests(
    exchange: str = "",
    market_type: str = "",
) -> list[tuple[str, str, Any]]:
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    adapters = [registry.get(exchange)] if exchange else registry.list()
    normalized_market_type = market_type.strip().lower()
    requests: list[tuple[str, str, Any]] = []
    for adapter in adapters:
        if not exchange and getattr(adapter, "eager_catalog_refresh", True) is False:
            continue
        seen_market_types: set[str] = set()
        for market in adapter.capabilities().markets:
            candidate = market.market_type.strip().lower()
            if (
                candidate in seen_market_types
                or (normalized_market_type and candidate != normalized_market_type)
            ):
                continue
            seen_market_types.add(candidate)
            requests.append((adapter.id, candidate, adapter))
    return requests


async def cancel_exchange_metadata_refreshes() -> None:
    """Cancel timers and join every catalog task owned by this process."""

    global _catalog_stopping
    _catalog_stopping = True
    for handle in _market_refresh_timers.values():
        handle.cancel()
    _market_refresh_timers.clear()

    automatic_tasks = {
        task
        for task in _market_auto_refresh_tasks.values()
        if not task.done()
    }
    for task in automatic_tasks:
        task.cancel()
    if automatic_tasks:
        await asyncio.gather(*automatic_tasks, return_exceptions=True)
    _market_auto_refresh_tasks.clear()

    tasks = {
        task
        for task in _market_refresh_tasks.values()
        if not task.done()
    }
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    for key, task in list(_market_refresh_tasks.items()):
        if task.done() or task in tasks:
            _market_refresh_tasks.pop(key, None)


def _cancel_market_refresh_timer(key: tuple[str, str]) -> None:
    handle = _market_refresh_timers.pop(key, None)
    if handle is not None:
        handle.cancel()


def _launch_market_auto_refresh(
    adapter: Any,
    market_type: str,
    *,
    source: str,
) -> None:
    """Start one tracked best-effort refresh without blocking its caller."""

    if _catalog_stopping:
        return
    key = _market_cache_key(adapter.id, market_type)
    physical = _market_refresh_tasks.get(key)
    if physical is not None and not physical.done():
        return
    running = _market_auto_refresh_tasks.get(key)
    if running is not None and not running.done():
        return

    async def _refresh() -> None:
        await _refresh_market_catalog(adapter, market_type, force=False)

    task = asyncio.create_task(
        _refresh(),
        name=f"symbol-catalog-{source}:{key[0]}:{key[1]}",
    )
    _market_auto_refresh_tasks[key] = task

    def _discard(finished: asyncio.Task[None]) -> None:
        if _market_auto_refresh_tasks.get(key) is finished:
            _market_auto_refresh_tasks.pop(key, None)
        try:
            finished.exception()
        except (asyncio.CancelledError, Exception):
            pass

    task.add_done_callback(_discard)


def _schedule_market_refresh(
    adapter: Any,
    market_type: str,
    *,
    deadline_ms: int,
    jitter_seconds: float = 0.0,
) -> None:
    if _catalog_stopping:
        return
    key = _market_cache_key(adapter.id, market_type)
    _cancel_market_refresh_timer(key)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    # Windows timer granularity can wake a short call_later early. Keep a
    # small safety margin so the normal admission check cannot consume the
    # timer before retry_at/TTL has actually elapsed.
    delay = max(0.05, deadline_ms / 1000.0 - time.time() + 0.01)
    if jitter_seconds > 0:
        delay += random.uniform(0.0, max(0.0, jitter_seconds))

    def _launch() -> None:
        _market_refresh_timers.pop(key, None)
        if _catalog_stopping:
            return
        if not _catalog_foreground_is_quiet():
            _schedule_market_refresh(
                adapter,
                market_type,
                deadline_ms=int(
                    (time.time() + SYMBOL_CATALOG_FOREGROUND_RECHECK_SECONDS)
                    * 1000
                ),
            )
            return
        _launch_market_auto_refresh(adapter, market_type, source="auto")

    _market_refresh_timers[key] = loop.call_later(delay, _launch)


async def _refresh_market_catalog(
    adapter: Any,
    market_type: str,
    *,
    force: bool,
) -> int:
    key = _market_cache_key(adapter.id, market_type)
    if _catalog_stopping:
        return _active_symbol_count(key)
    running = _market_refresh_tasks.get(key)
    if running is not None and not running.done():
        return await asyncio.shield(running)

    state = _market_refresh_state.setdefault(key, _MarketRefreshState())
    now = time.time()
    if not force:
        if state.retry_at_ms is not None and int(now * 1000) < state.retry_at_ms:
            return _active_symbol_count(key)
        if (
            not state.stale
            and key in _symbol_cache
            and state.last_success_at > 0
            and now - state.last_success_at < SYMBOL_CATALOG_TTL_SECONDS
        ):
            return _active_symbol_count(key)

    task = asyncio.create_task(
        _run_market_refresh(adapter, market_type, attempted_at=now),
        name=f"symbol-catalog:{key[0]}:{key[1]}",
    )
    _cancel_market_refresh_timer(key)
    _market_refresh_tasks[key] = task

    def _discard_finished(finished: asyncio.Task[int]) -> None:
        if _market_refresh_tasks.get(key) is finished:
            _market_refresh_tasks.pop(key, None)

    task.add_done_callback(_discard_finished)
    return await asyncio.shield(task)


async def _run_market_refresh(
    adapter: Any,
    market_type: str,
    *,
    attempted_at: float,
) -> int:
    global _cache_loaded_at

    key = _market_cache_key(adapter.id, market_type)
    state = _market_refresh_state.setdefault(key, _MarketRefreshState())
    state.last_attempt_at = attempted_at
    try:
        symbols = await adapter.list_symbols(market_type)
        current = [item.to_dict() for item in symbols]
        if not current:
            raise RuntimeError(
                f"empty symbol catalog from {adapter.id}:{market_type}"
            )
        seen: set[str] = set()
        for item in current:
            symbol = str(item.get("symbol", "")).strip().upper()
            if (
                not symbol
                or symbol in seen
                or not str(item.get("baseAsset", "")).strip()
                or not str(item.get("quoteAsset", "")).strip()
            ):
                raise RuntimeError(
                    f"invalid symbol catalog from {adapter.id}:{market_type}"
                )
            seen.add(symbol)
        previous_active = _active_symbol_count(key)
        minimum_retained = math.ceil(
            previous_active * SYMBOL_CATALOG_MIN_RETAIN_RATIO
        )
        if previous_active > 0 and len(current) < minimum_retained:
            raise RuntimeError(
                "suspicious symbol catalog shrink for "
                f"{adapter.id}:{market_type}: {previous_active} -> {len(current)}"
            )
    except RateLimitDeferred as exc:
        state.stale = True
        state.last_error = str(exc)
        state.retry_at_ms = exc.retry_at_ms or int(
            (attempted_at + SYMBOL_CATALOG_FAILURE_RETRY_SECONDS) * 1000
        )
        logger.warning(
            "Symbol catalog refresh deferred for %s:%s until %s",
            adapter.id,
            market_type,
            state.retry_at_ms,
        )
        _schedule_market_refresh(
            adapter,
            market_type,
            deadline_ms=state.retry_at_ms,
            jitter_seconds=SYMBOL_CATALOG_RETRY_JITTER_SECONDS,
        )
        return _active_symbol_count(key)
    except Exception as exc:
        state.stale = True
        state.last_error = f"{type(exc).__name__}: {exc}"
        state.retry_at_ms = int(
            (attempted_at + SYMBOL_CATALOG_FAILURE_RETRY_SECONDS) * 1000
        )
        logger.warning(
            "Symbol catalog refresh failed for %s:%s: %s",
            adapter.id,
            market_type,
            exc,
        )
        _schedule_market_refresh(
            adapter,
            market_type,
            deadline_ms=state.retry_at_ms,
            jitter_seconds=SYMBOL_CATALOG_RETRY_JITTER_SECONDS,
        )
        return _active_symbol_count(key)

    observed_at = attempted_at
    observed_at_ms = int(observed_at * 1000)
    previous_observed_at_ms = (
        int(state.last_success_at * 1000)
        if state.last_success_at > 0
        else None
    )
    # Publish only after a complete non-empty response has been normalized.
    _symbol_cache[key] = _merge_symbol_snapshot(
        _symbol_cache.get(key, []),
        current,
        observed_at_ms=observed_at_ms,
        previous_observed_at_ms=previous_observed_at_ms,
    )
    state.last_success_at = observed_at
    state.retry_at_ms = None
    state.last_error = None
    state.stale = False
    _cache_loaded_at = max(_cache_loaded_at, observed_at)
    await _persist_exchange_metadata_snapshot()
    if SYMBOL_CATALOG_TTL_SECONDS > 0:
        _schedule_market_refresh(
            adapter,
            market_type,
            deadline_ms=int(
                (observed_at + SYMBOL_CATALOG_TTL_SECONDS) * 1000
            ),
        )
    return len(current)


def _active_symbol_count(key: tuple[str, str]) -> int:
    return sum(
        1
        for item in _symbol_cache.get(key, ())
        if item.get("active", True) is True
    )


async def load_exchange_info() -> None:
    """Backward-compatible loader for Binance spot metadata."""
    await refresh_exchange_metadata("binance", force=True)


async def load_futures_exchange_info() -> None:
    """Backward-compatible loader for Binance futures metadata."""
    await refresh_exchange_metadata("binance", force=True)


def _iter_cached_symbols(
    exchange: str = "",
    market_type: str = "",
    *,
    include_inactive: bool = False,
) -> list[dict[str, Any]]:
    normalized_exchange = exchange.strip().lower()
    normalized_market_type = market_type.strip().lower()

    results: list[dict[str, Any]] = []
    for (cached_exchange, cached_market_type), symbols in _symbol_cache.items():
        if normalized_exchange and cached_exchange != normalized_exchange:
            continue
        if normalized_market_type and cached_market_type != normalized_market_type:
            continue
        results.extend(
            item
            for item in symbols
            if include_inactive or item.get("active", True) is True
        )
    return results


def list_cached_symbols(
    exchange: str = "",
    market_type: str = "",
    *,
    include_inactive: bool = False,
) -> tuple[list[dict[str, Any]], float]:
    """Return a detached public symbol snapshot for non-HTTP consumers."""

    return (
        copy.deepcopy(
            _iter_cached_symbols(
                exchange=exchange,
                market_type=market_type,
                include_inactive=include_inactive,
            )
        ),
        _cache_loaded_at,
    )


def _catalog_status_payload(
    exchange: str = "",
    market_type: str = "",
) -> dict[str, Any]:
    normalized_exchange = exchange.strip().lower()
    normalized_market_type = market_type.strip().lower()
    keys = set(_symbol_cache) | set(_market_refresh_state) | set(_market_refresh_tasks)

    try:
        bootstrap_default_adapters()
        registry = get_exchange_registry()
        adapters = [registry.get(exchange)] if exchange else registry.list()
        for adapter in adapters:
            for market in adapter.capabilities().markets:
                keys.add(_market_cache_key(adapter.id, market.market_type))
    except Exception:
        # Status rendering must not turn a cached catalog response into a 500.
        pass

    selected = sorted(
        key
        for key in keys
        if (not normalized_exchange or key[0] == normalized_exchange)
        and (not normalized_market_type or key[1] == normalized_market_type)
    )
    now = time.time()
    markets: dict[str, dict[str, Any]] = {}
    for key in selected:
        state = _market_refresh_state.get(key, _MarketRefreshState())
        expired = (
            SYMBOL_CATALOG_TTL_SECONDS > 0
            and state.last_success_at > 0
            and now - state.last_success_at >= SYMBOL_CATALOG_TTL_SECONDS
        )
        stale = state.stale or state.last_success_at <= 0 or expired
        markets[f"{key[0]}:{key[1]}"] = {
            "stale": stale,
            "last_attempt_at": state.last_attempt_at,
            "last_success_at": state.last_success_at,
            "retry_at_ms": state.retry_at_ms,
            "refreshing": bool(
                (task := _market_refresh_tasks.get(key)) is not None
                and not task.done()
            ),
            "last_error": state.last_error,
            "count": _active_symbol_count(key),
        }

    successes = [
        float(status["last_success_at"])
        for status in markets.values()
        if float(status["last_success_at"]) > 0
    ]
    retries = [
        int(status["retry_at_ms"])
        for status in markets.values()
        if status["retry_at_ms"] is not None
    ]
    return {
        "stale": not markets or any(bool(status["stale"]) for status in markets.values()),
        "last_success_at": min(successes) if successes else 0.0,
        "retry_at_ms": min(retries) if retries else None,
        "markets": markets,
    }


async def _ensure_requested_catalog(
    exchange: str,
    market_type: str,
) -> None:
    requests = _catalog_refresh_requests(exchange, market_type)
    selected_keys = [
        _market_cache_key(exchange_id, candidate_market)
        for exchange_id, candidate_market, _adapter in requests
    ]
    if any(_active_symbol_count(key) > 0 for key in selected_keys):
        # A partial LKG is immediately useful to product search.  Return it
        # without waiting for upstream I/O, while repairing every missing or
        # stale selected market through shutdown-owned background tasks.
        now = time.time()
        for exchange_id, candidate_market, adapter in requests:
            key = _market_cache_key(exchange_id, candidate_market)
            state = _market_refresh_state.get(key, _MarketRefreshState())
            expired = (
                SYMBOL_CATALOG_TTL_SECONDS > 0
                and state.last_success_at > 0
                and now - state.last_success_at >= SYMBOL_CATALOG_TTL_SECONDS
            )
            if (
                _active_symbol_count(key) <= 0
                or state.stale
                or state.last_success_at <= 0
                or expired
            ):
                _launch_market_auto_refresh(
                    adapter,
                    candidate_market,
                    source="on-demand",
                )
        return

    try:
        await asyncio.wait_for(
            refresh_exchange_metadata(
                exchange,
                market_type=market_type,
                force=False,
            ),
            timeout=max(0.001, SYMBOL_CATALOG_EMPTY_WAIT_SECONDS),
        )
    except TimeoutError:
        # The shielded per-market physical singleflight remains alive and will
        # publish or schedule its bounded retry after this HTTP request ends.
        pass
    except Exception as exc:
        logger.warning("On-demand symbol catalog refresh failed: %s", exc)

    if any(_active_symbol_count(key) > 0 for key in selected_keys):
        return
    status = _catalog_status_payload(exchange=exchange, market_type=market_type)
    raise HTTPException(
        status_code=503,
        detail={
            "code": "symbol_catalog_unavailable",
            "message": "Symbol catalog is not available yet",
            "retryable": True,
            "retry_at_ms": status["retry_at_ms"],
            "markets": status["markets"],
        },
        headers={"Retry-After": "1"},
    )


# ── API Endpoints ────────────────────────────────────────────


async def _search_provider_symbols(
    *,
    exchange: str,
    market_type: str,
    search: str,
) -> list[dict[str, Any]] | None:
    """Use a provider's bounded query API when it cannot expose a safe full catalog."""

    normalized_exchange = exchange.strip().lower()
    if not normalized_exchange:
        return None
    registry = get_exchange_registry()
    try:
        adapter = registry.get(normalized_exchange)
    except KeyError:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported exchange: {exchange}",
        )
    search_symbols = getattr(adapter, "search_symbols", None)
    if not callable(search_symbols):
        return None
    if not search.strip():
        # Query-only providers deliberately have no unbounded catalog.  An
        # empty selection is still a healthy response and lets the picker ask
        # the user for a bounded search term instead of surfacing a 503.
        return []
    try:
        symbols = await search_symbols(
            search.strip(),
            market_type.strip().lower(),
            limit=120,
        )
    except RateLimitDeferred as exc:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "provider_rate_limited",
                "message": "Symbol provider quota is temporarily exhausted",
                "retryable": True,
                "retry_at_ms": exc.retry_at_ms,
            },
            headers={"Retry-After": str(max(1, int(exc.retry_after_seconds)))},
        ) from exc
    except Exception as exc:
        logger.warning(
            "Direct provider symbol search failed for %s:%s: %s",
            normalized_exchange,
            market_type,
            exc,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "provider_symbol_search_unavailable",
                "message": str(exc),
                "retryable": False,
            },
        ) from exc
    return [item.to_dict() for item in symbols]


@router.get("/exchange-info")
async def get_exchange_info(
    search: str = Query("", description="Filter by symbol or asset name (case-insensitive)"),
    quote_asset: str = Query("", description="Filter by quote asset, e.g. USDT, BTC"),
    market_type: str = Query("", description="Filter by market type: spot, futures, or empty for all"),
    exchange: str = Query("", description="Filter by exchange id, e.g. binance, okx"),
) -> dict:
    """Return cached trading pair list with optional filtering."""
    bootstrap_default_adapters()
    provider_results = await _search_provider_symbols(
        exchange=exchange,
        market_type=market_type,
        search=search,
    )
    if provider_results is not None:
        if quote_asset:
            qa = quote_asset.upper().strip()
            provider_results = [
                item for item in provider_results if item["quoteAsset"] == qa
            ]
        return {
            "count": len(provider_results),
            "cached_at": 0.0,
            "symbols": provider_results,
            "stale": False,
            "last_success_at": time.time(),
            "retry_at_ms": None,
            "markets": {},
            "provider_search": True,
        }
    await _ensure_requested_catalog(exchange, market_type)
    results, cached_at = list_cached_symbols(exchange=exchange, market_type=market_type)
    status = _catalog_status_payload(exchange=exchange, market_type=market_type)

    if quote_asset:
        qa = quote_asset.upper().strip()
        results = [s for s in results if s["quoteAsset"] == qa]

    if search:
        q = search.upper().strip()
        results = [
            s for s in results
            if q in s["symbol"] or q in s["baseAsset"] or q in s["quoteAsset"]
        ]

    return {
        "count": len(results),
        "cached_at": cached_at,
        "symbols": results,
        **status,
    }


@router.post("/exchange-info/refresh")
async def refresh_exchange_info(
    exchange: str = Query("", description="Optional exchange id"),
    market_type: str = Query("", description="Optional exact market type"),
) -> dict:
    """Manually re-fetch exchange metadata via the registry."""
    counts = await refresh_exchange_metadata(
        exchange,
        market_type=market_type,
        force=True,
    )
    payload = {
        "counts": counts,
        "cached_at": _cache_loaded_at,
        **_catalog_status_payload(exchange=exchange, market_type=market_type),
    }
    if not any(count > 0 for count in counts.values()):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "symbol_catalog_unavailable",
                "message": "Symbol catalog refresh produced no usable snapshot",
                "retryable": True,
                "retry_at_ms": payload["retry_at_ms"],
                "markets": payload["markets"],
            },
            headers={"Retry-After": "1"},
        )
    return payload
