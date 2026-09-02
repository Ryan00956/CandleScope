"""Rate-aware HTTP helper for exchange symbol catalogs.

Catalog endpoints are not historical-data endpoints, but they still consume
the same exchange/IP budgets.  Keeping their physical requests behind the
loop-shared limiter prevents a metadata refresh from bypassing a cooldown
opened by backfill (or vice versa).
"""
from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from typing import Any

import aiohttp

from .rate_limits import (
    HistoricalRequest,
    RateLimitDeferred,
    get_shared_rate_limit_manager,
    get_shared_rate_limit_semaphore,
)

logger = logging.getLogger("candlescope.exchange.catalog")

_RATE_LIMIT_BODY_CODES = frozenset({"-1003", "50011"})


class CatalogHttpError(RuntimeError):
    """One catalog endpoint returned an unusable response."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        headers: Mapping[str, str] | None = None,
        body_code: str | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.headers = dict(headers or {})
        self.body_code = body_code
        self.retry_after = retry_after


async def fetch_catalog_json(
    *,
    exchange: str,
    market_type: str,
    base_urls: Sequence[str],
    path: str,
    params: Mapping[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
    timeout_seconds: float,
    proxy: str | None,
) -> Any:
    """Fetch a catalog payload under the exchange's shared REST budget.

    Budget/circuit deferrals fail fast so the catalog cache can immediately
    serve its last-known-good snapshot and expose the retry deadline.  A
    physical 418/429 (or exchange-equivalent body code) never rotates to an
    alternate hostname because those aliases share the same IP quota.
    Ordinary transport and non-rate-limit HTTP failures may still fail over.
    """

    # Import lazily: built-in plugins import their adapters while the exchange
    # registry module itself is still being initialized.
    from .registry import bootstrap_default_adapters, get_exchange_registry

    bootstrap_default_adapters()
    plugin = get_exchange_registry().get_plugin(exchange)
    # Match the default DataEngine transport's environment-backed limits.  A
    # catalog request may be the first caller to materialize a shared bucket,
    # so constructing it with legacy hard-coded defaults would silently ignore
    # operator overrides for the later backfill requests in that same bucket.
    from app.data_engine.ingestion.config import IngestionConfig

    policy = plugin.rate_limit_policy(IngestionConfig())
    request = HistoricalRequest(
        exchange=exchange,
        market_type=market_type,
        endpoint=path,
        symbol="*",
        params=dict(params or {}),
    )
    rule = policy.rule_for(request)
    manager = get_shared_rate_limit_manager()
    semaphore = get_shared_rate_limit_semaphore(
        rule,
        fallback=policy.concurrency_for(market_type),
    )

    urls = [str(base).rstrip("/") for base in base_urls if str(base).strip()]
    if not urls:
        raise CatalogHttpError(f"No catalog endpoints configured for {exchange}:{market_type}")

    request_headers = dict(headers or {})
    last_error: Exception | None = None
    timeout = aiohttp.ClientTimeout(total=max(0.001, float(timeout_seconds)))
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for base in urls:
            url = f"{base}{path}"
            acquired = False
            response_headers_accounted = False
            response_completed = False
            try:
                admission = await manager.inspect(rule, request)
                if not admission.allowed:
                    raise RateLimitDeferred(admission)

                await semaphore.acquire()
                acquired = True
                # Recheck after the semaphore: another in-flight endpoint may
                # have opened a bucket cooldown or an exchange-wide circuit.
                await manager.acquire_nowait(rule, request)

                async with session.get(
                    url,
                    params=dict(params or {}),
                    headers=request_headers,
                    proxy=proxy,
                ) as response:
                    response_headers = {
                        str(key): str(value)
                        for key, value in response.headers.items()
                    }
                    if response.status != 200:
                        body = ""
                        body_error: Exception | None = None
                        try:
                            body = await response.text()
                        except Exception as exc:
                            body_error = exc
                        body_code = _extract_body_code(body)
                        error = CatalogHttpError(
                            (
                                f"HTTP {response.status}: {body[:200]}"
                                if body_error is None
                                else f"HTTP {response.status}: response body unavailable: {body_error}"
                            ),
                            status_code=response.status,
                            headers=response_headers,
                            body_code=body_code,
                            retry_after=_parse_retry_after(
                                response_headers.get("Retry-After")
                            ),
                        )
                        manager.record_response(
                            rule,
                            status_code=error.status_code,
                            headers=error.headers,
                            body_code=error.body_code,
                            retry_after=error.retry_after,
                            fallback_cooldown_seconds=rule.cooldown_seconds,
                        )
                        if _is_rate_limit_error(error):
                            raise await manager.deferred_error(rule, request) from error
                        if body_error is not None:
                            raise body_error
                        raise error

                    # Account response headers before parsing.  A truncated or
                    # malformed JSON body must not erase the exchange's
                    # authoritative used-weight observation.
                    manager.record_response(
                        rule,
                        status_code=response.status,
                        headers=response_headers,
                        fallback_cooldown_seconds=rule.cooldown_seconds,
                        response_complete=False,
                    )
                    response_headers_accounted = True
                    payload = await response.json()
                    body_code = _extract_body_code(payload)
                    manager.record_response(
                        rule,
                        status_code=response.status,
                        headers=response_headers,
                        body_code=body_code,
                        retry_after=_parse_retry_after(
                            response_headers.get("Retry-After")
                        ),
                        fallback_cooldown_seconds=rule.cooldown_seconds,
                    )
                    response_completed = True
                    if body_code in _RATE_LIMIT_BODY_CODES:
                        raise await manager.deferred_error(rule, request)
                    if body_code not in (None, "0"):
                        raise CatalogHttpError(
                            f"Exchange error {body_code}: {str(payload)[:200]}",
                            status_code=response.status,
                            headers=response_headers,
                            body_code=body_code,
                        )
                    return payload
            except RateLimitDeferred:
                # Shared quota/circuit state applies to every hostname.
                raise
            except Exception as exc:
                if response_headers_accounted and not response_completed:
                    manager.record_response(rule, response_unknown=True)
                last_error = exc
                logger.warning(
                    "Catalog fetch failed (%s): [%s] %s",
                    base,
                    type(exc).__name__,
                    exc,
                )
            finally:
                if acquired:
                    semaphore.release()

    raise CatalogHttpError(
        f"Failed to load catalog for {exchange}:{market_type} from all endpoints: "
        f"{last_error}"
    ) from last_error


def _extract_body_code(body: object) -> str | None:
    payload = body
    if isinstance(body, str):
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, TypeError):
            return None
    if not isinstance(payload, dict):
        return None
    raw = payload.get("code")
    return str(raw) if raw is not None else None


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _is_rate_limit_error(error: CatalogHttpError) -> bool:
    return error.status_code in {418, 429} or error.body_code in _RATE_LIMIT_BODY_CODES
