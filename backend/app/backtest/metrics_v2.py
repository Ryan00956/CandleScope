"""Frozen report-v2 performance metrics owned by the Backtest Host.

All monetary inputs and authoritative outputs use ``Decimal``.  Float is not
used as an accounting authority.  Null metrics always carry a reason code.
"""

from __future__ import annotations

from collections import defaultdict, deque
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation, localcontext
from typing import Any, Iterable, Mapping

from app.backtest.identity import sha256_hex
from app.market_dataset.snapshot import MarketEvent


REPORT_SCHEMA_V2 = "candlescope.backtest-report/2"
METRICS_VERSION = "BACKTEST_METRICS_V2"
EQUITY_SAMPLING = "UTC_DAILY_CLOSE_V1"
BENCHMARK_MODEL = "BUY_HOLD_SAME_WINDOW_COSTS_V1"
ANNUALIZATION_DAYS = 365
MIN_RISK_RETURN_SAMPLES = 30
MIN_ANNUALIZED_WINDOW_DAYS = 365
SAMPLE_ROLES = frozenset({"IN_SAMPLE", "VALIDATION", "OUT_OF_SAMPLE"})


def parse_metrics_identity(payload: Mapping[str, Any]) -> dict[str, Any]:
    requested = payload.get("metrics_version")
    if requested in {None, "", "LEGACY"}:
        return {}
    if str(requested) != METRICS_VERSION:
        raise ValueError("unsupported metrics_version")
    role = str(payload.get("sample_role") or "IN_SAMPLE")
    if role not in SAMPLE_ROLES:
        raise ValueError("sample_role must be IN_SAMPLE, VALIDATION or OUT_OF_SAMPLE")
    try:
        risk_free = Decimal(str(payload.get("risk_free_rate_annual") or "0"))
    except InvalidOperation as exc:
        raise ValueError("risk_free_rate_annual must be Decimal") from exc
    if (
        not risk_free.is_finite()
        or risk_free <= Decimal("-1")
        or risk_free > Decimal("1")
    ):
        raise ValueError("risk_free_rate_annual must be > -1 and <= 1")
    return {
        "report_schema": REPORT_SCHEMA_V2,
        "metrics_version": METRICS_VERSION,
        "equity_sampling": EQUITY_SAMPLING,
        "equity_curve_mode": EQUITY_SAMPLING,
        "annualization_days": ANNUALIZATION_DAYS,
        "risk_free_rate_annual": str(risk_free),
        "benchmark_model": BENCHMARK_MODEL,
        "sample_role": role,
    }


def build_market_context(
    events: Iterable[MarketEvent], fills: Iterable[Mapping[str, Any]]
) -> dict[str, Any]:
    """Reduce an immutable snapshot to bounded metric evidence.

    This deliberately stores daily closes and per-fill source prices, not the
    full event tape, so the main report remains bounded.
    """

    fill_list = list(fills)
    fill_sequences = {
        int(item.get("source_sequence") or item.get("sequence") or -1)
        for item in fill_list
    }
    pending = deque(_trade_windows(fill_list))
    active: list[dict[str, Any]] = []
    excursions: dict[str, dict[str, str]] = {}
    source_prices: dict[str, str] = {}
    daily: dict[str, dict[str, Any]] = {}
    first: dict[str, Any] | None = None
    last: dict[str, Any] | None = None
    count = 0
    for event in events:
        price = _event_price(event)
        if price is None:
            continue
        count += 1
        point = {
            "sequence": int(event.sequence),
            "event_time_ms": int(event.event_time_ms),
            "price": str(price),
        }
        if first is None:
            first = point
        last = point
        day = (
            datetime.fromtimestamp(event.event_time_ms / 1000, tz=UTC)
            .date()
            .isoformat()
        )
        daily[day] = point
        if event.sequence in fill_sequences:
            source_prices[str(event.sequence)] = str(
                _event_fill_reference_price(event) or price
            )
        while pending and int(pending[0]["entry_sequence"]) <= event.sequence:
            window = pending.popleft()
            window["low"] = _decimal(window["entry_price"])
            window["high"] = _decimal(window["entry_price"])
            active.append(window)
        event_low, event_high = _event_range(event, price)
        retained: list[dict[str, Any]] = []
        for window in active:
            if event.sequence < int(window["exit_sequence"]):
                window["low"] = min(_decimal(window["low"]), event_low)
                window["high"] = max(_decimal(window["high"]), event_high)
                retained.append(window)
                continue
            exit_reference = _event_fill_reference_price(event) or price
            window["low"] = min(_decimal(window["low"]), exit_reference)
            window["high"] = max(_decimal(window["high"]), exit_reference)
            entry = _decimal(window["entry_price"])
            if window["side"] == "LONG":
                mae = min(Decimal("0"), _decimal(window["low"]) / entry - 1)
                mfe = max(Decimal("0"), _decimal(window["high"]) / entry - 1)
            else:
                mae = min(Decimal("0"), 1 - _decimal(window["high"]) / entry)
                mfe = max(Decimal("0"), 1 - _decimal(window["low"]) / entry)
            excursions[str(window["trade_id"])] = {
                "mae": str(mae),
                "mfe": str(mfe),
                "entry_reason": str(window.get("entry_reason") or ""),
                "exit_reason": str(window.get("exit_reason") or ""),
            }
        active = retained
    body = {
        "schemaVersion": "candlescope.backtest-market-metrics-context/1",
        "event_count": count,
        "first": first,
        "last": last,
        "daily_closes": [daily[key] for key in sorted(daily)],
        "fill_source_prices": source_prices,
        "trade_excursions": excursions,
    }
    return {**body, "context_hash": "sha256:" + sha256_hex(body)}


def enrich_trades_v2(
    trades: list[dict[str, str]], context: Mapping[str, Any]
) -> list[dict[str, str]]:
    excursions = context.get("trade_excursions") or {}
    result: list[dict[str, str]] = []
    for trade in trades:
        enriched = dict(trade)
        evidence = excursions.get(str(trade.get("trade_id")))
        enriched["mae"] = str(evidence["mae"]) if evidence else ""
        enriched["mfe"] = str(evidence["mfe"]) if evidence else ""
        enriched["entry_reason"] = str(evidence["entry_reason"]) if evidence else ""
        enriched["exit_reason"] = str(evidence["exit_reason"]) if evidence else ""
        result.append(enriched)
    return result


def build_metrics_v2(
    *,
    run: Mapping[str, Any],
    config: Mapping[str, Any],
    payload: Mapping[str, Any],
    trades: list[dict[str, str]],
) -> dict[str, Any]:
    account = dict((payload.get("ledger") or {}).get("account") or {})
    initial = _decimal(
        account.get("initial_balance", config.get("initial_balance", "0"))
    )
    final_equity = _decimal(account.get("equity", initial))
    wallet = _decimal(account.get("wallet_balance", account.get("quote_balance", "0")))
    unrealized = _decimal(account.get("unrealized_pnl", "0"))
    realized = _decimal(account.get("cumulative_realized_pnl", "0"))
    curve = _daily_equity_curve(
        payload.get("equity_curve") or [],
        start_ms=int(run.get("start_time_ms") or 0),
        initial=initial,
    )
    returns = _returns(curve)
    non_positive_equity = any(_decimal(item["equity"]) <= 0 for item in curve)
    duration_ms = max(
        0, int(run.get("end_time_ms") or 0) - int(run.get("start_time_ms") or 0)
    )
    duration_days = Decimal(duration_ms) / Decimal(86_400_000)
    total_return = None if initial <= 0 else final_equity / initial - 1
    annualized = _annualized_return(total_return, duration_days, final_equity)
    drawdowns, max_drawdown, drawdown_duration = _drawdowns(curve)
    risk_free = _decimal(config.get("risk_free_rate_annual", "0"))
    risk = _risk_metrics(
        returns,
        risk_free,
        annualized,
        max_drawdown,
        invalid_reason=(
            "NON_POSITIVE_EQUITY_IN_SAMPLING" if non_positive_equity else None
        ),
    )
    completed = _trade_metrics(trades)
    market = dict(payload.get("metrics_market_context") or {})
    benchmark = _benchmark_metrics(config, market, initial, duration_days)
    execution = _execution_metrics(payload, account, curve, market)
    reconciliation = _reconcile(
        payload, trades, account, final_equity, wallet, unrealized
    )
    if not reconciliation["passed"]:
        raise ValueError("BACKTEST_REPORT_RECONCILIATION_FAILED")
    monthly = _monthly_returns(curve)
    quality = _quality_metrics(payload, config, trades)
    metrics = {
        "schemaVersion": "candlescope.backtest-metrics/2",
        "metrics_version": METRICS_VERSION,
        "sampling": {
            "equity": EQUITY_SAMPLING,
            "annualization_days": ANNUALIZATION_DAYS,
            "risk_free_rate_annual": str(risk_free),
            "minimum_risk_return_samples": MIN_RISK_RETURN_SAMPLES,
            "minimum_annualized_window_days": MIN_ANNUALIZED_WINDOW_DAYS,
        },
        "sample_role": config.get("sample_role"),
        "returns": {
            "total_return": _metric(total_return, "NON_POSITIVE_INITIAL_EQUITY"),
            "annualized_return": _metric(
                annualized,
                (
                    "NON_POSITIVE_FINAL_EQUITY"
                    if final_equity <= 0
                    else "WINDOW_SHORTER_THAN_365_DAYS"
                ),
            ),
            "realized_pnl": _metric(realized),
            "unrealized_pnl": _metric(unrealized),
            "net_pnl": _metric(final_equity - initial),
            "benchmark_return": benchmark["return"],
            "excess_return": _metric(
                None
                if total_return is None or benchmark["raw_return"] is None
                else total_return - benchmark["raw_return"],
                "BENCHMARK_UNAVAILABLE",
            ),
        },
        "risk": {
            "max_drawdown": _metric(max_drawdown, "INSUFFICIENT_EQUITY_SAMPLES"),
            "drawdown_duration_ms": _metric(
                drawdown_duration, "INSUFFICIENT_EQUITY_SAMPLES"
            ),
            **risk,
            "max_single_trade_loss": completed["max_single_trade_loss"],
            "max_consecutive_losses": completed["max_consecutive_losses"],
        },
        "trading": completed,
        "execution": execution,
        "quality": quality,
        "benchmark": benchmark["evidence"],
        "reconciliation": reconciliation,
        "equity_daily": curve,
        "drawdown_daily": drawdowns,
        "monthly_returns": monthly,
    }
    return {**metrics, "metrics_hash": "sha256:" + sha256_hex(metrics)}


def _event_price(event: MarketEvent) -> Decimal | None:
    payload = event.payload
    raw = (
        payload.get("close")
        if event.role == "BARS"
        else payload.get("price")
        if event.role in {"TRADES", "AGG_TRADES"}
        else None
    )
    if raw is None:
        return None
    value = _decimal(raw)
    return value if value > 0 else None


def _event_fill_reference_price(event: MarketEvent) -> Decimal | None:
    raw = (
        event.payload.get("open")
        if event.role == "BARS"
        else event.payload.get("price")
    )
    if raw is None:
        return None
    value = _decimal(raw)
    return value if value > 0 else None


def _event_range(event: MarketEvent, fallback: Decimal) -> tuple[Decimal, Decimal]:
    if event.role != "BARS":
        return fallback, fallback
    low = _decimal(event.payload.get("low", fallback))
    high = _decimal(event.payload.get("high", fallback))
    return low, high


def _daily_equity_curve(
    points: Iterable[Mapping[str, Any]], *, start_ms: int, initial: Decimal
) -> list[dict[str, Any]]:
    daily: dict[str, dict[str, Any]] = {}
    if start_ms > 0:
        day = datetime.fromtimestamp(start_ms / 1000, tz=UTC).date().isoformat()
        daily[day] = {
            "event_time_ms": start_ms,
            "equity": str(initial),
            "position_qty": "0",
            "source": "RUN_INITIAL",
        }
    for point in points:
        timestamp = int(point.get("event_time_ms") or 0)
        if timestamp <= 0:
            continue
        day = datetime.fromtimestamp(timestamp / 1000, tz=UTC).date().isoformat()
        daily[day] = {
            "event_time_ms": timestamp,
            "equity": str(_decimal(point.get("equity", "0"))),
            "position_qty": str(_decimal(point.get("position_qty", "0"))),
            "source": "MARK_TO_MARKET",
        }
    return [{"date": day, **daily[day]} for day in sorted(daily)]


def _returns(curve: list[Mapping[str, Any]]) -> list[Decimal]:
    result: list[Decimal] = []
    for previous, current in zip(curve, curve[1:]):
        left = _decimal(previous["equity"])
        right = _decimal(current["equity"])
        if left <= 0 or right <= 0:
            return []
        result.append(right / left - 1)
    return result


def _annualized_return(
    total: Decimal | None, days: Decimal, final_equity: Decimal
) -> Decimal | None:
    if total is None or days < MIN_ANNUALIZED_WINDOW_DAYS or final_equity <= 0:
        return None
    with localcontext() as ctx:
        ctx.prec = 34
        return (
            (Decimal(1) + total).ln() * (Decimal(ANNUALIZATION_DAYS) / days)
        ).exp() - 1


def _drawdowns(
    curve: list[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], Decimal | None, int | None]:
    if len(curve) < 2:
        return [], None, None
    peak = _decimal(curve[0]["equity"])
    peak_time = int(curve[0]["event_time_ms"])
    maximum = Decimal("0")
    duration = 0
    result: list[dict[str, Any]] = []
    for point in curve:
        equity = _decimal(point["equity"])
        timestamp = int(point["event_time_ms"])
        if equity >= peak:
            peak = equity
            peak_time = timestamp
        drawdown = Decimal("0") if peak <= 0 else equity / peak - 1
        maximum = min(maximum, drawdown)
        duration = max(duration, timestamp - peak_time if drawdown < 0 else 0)
        result.append(
            {
                "date": point["date"],
                "event_time_ms": timestamp,
                "drawdown": str(drawdown),
            }
        )
    return result, abs(maximum), duration


def _risk_metrics(
    returns: list[Decimal],
    risk_free: Decimal,
    annualized: Decimal | None,
    max_drawdown: Decimal | None,
    invalid_reason: str | None = None,
) -> dict[str, Any]:
    if invalid_reason is not None or len(returns) < MIN_RISK_RETURN_SAMPLES:
        reason = invalid_reason or "FEWER_THAN_30_DAILY_RETURNS"
        null = _metric(None, reason)
        return {
            "volatility": null,
            "downside_volatility": null,
            "sharpe": null,
            "sortino": null,
            "calmar": _metric(None, "ANNUALIZATION_UNAVAILABLE"),
        }
    with localcontext() as ctx:
        ctx.prec = 34
        daily_rf = (
            (Decimal(1) + risk_free).ln() / Decimal(ANNUALIZATION_DAYS)
        ).exp() - 1
    excess = [item - daily_rf for item in returns]
    volatility = _sample_std(returns) * Decimal(ANNUALIZATION_DAYS).sqrt()
    excess_std = _sample_std(excess)
    downside = [min(item - daily_rf, Decimal("0")) for item in returns]
    downside_deviation = (
        sum((item * item for item in downside), Decimal("0")) / Decimal(len(downside))
    ).sqrt() * Decimal(ANNUALIZATION_DAYS).sqrt()
    sharpe = (
        None
        if excess_std == 0
        else (_mean(excess) / excess_std) * Decimal(ANNUALIZATION_DAYS).sqrt()
    )
    sortino = (
        None
        if downside_deviation == 0
        else (_mean(excess) * Decimal(ANNUALIZATION_DAYS)) / downside_deviation
    )
    calmar = (
        None if annualized is None or not max_drawdown else annualized / max_drawdown
    )
    return {
        "volatility": _metric(volatility),
        "downside_volatility": _metric(downside_deviation),
        "sharpe": _metric(sharpe, "ZERO_EXCESS_VOLATILITY"),
        "sortino": _metric(sortino, "ZERO_DOWNSIDE_VOLATILITY"),
        "calmar": _metric(calmar, "ANNUALIZATION_OR_DRAWDOWN_UNAVAILABLE"),
    }


def _trade_metrics(trades: list[dict[str, str]]) -> dict[str, Any]:
    pnl = [_decimal(item["net_pnl"]) for item in trades]
    gross = [_decimal(item["gross_pnl"]) for item in trades]
    wins = [item for item in pnl if item > 0]
    losses = [item for item in pnl if item < 0]
    durations = sorted(int(item.get("duration_ms") or 0) for item in trades)
    gross_profit = sum((item for item in gross if item > 0), Decimal("0"))
    gross_loss = sum((item for item in gross if item < 0), Decimal("0"))
    groups: dict[str, list[Decimal]] = defaultdict(list)
    for item in trades:
        groups[str(item.get("side"))].append(_decimal(item["net_pnl"]))
    streak = current = 0
    for item in pnl:
        current = current + 1 if item < 0 else 0
        streak = max(streak, current)
    count = len(trades)
    mae = [
        _decimal(item["mae"]) for item in trades if item.get("mae") not in {None, ""}
    ]
    mfe = [
        _decimal(item["mfe"]) for item in trades if item.get("mfe") not in {None, ""}
    ]
    return {
        "trade_count": count,
        "winning_trade_count": len(wins),
        "win_rate": _metric(
            None if not count else Decimal(len(wins)) / Decimal(count),
            "NO_CLOSED_TRADES",
        ),
        "gross_profit": _metric(gross_profit),
        "gross_loss": _metric(gross_loss),
        "profit_factor": _metric(
            None if gross_loss == 0 else gross_profit / abs(gross_loss), "NO_GROSS_LOSS"
        ),
        "expectancy": _metric(
            None if not count else sum(pnl, Decimal("0")) / Decimal(count),
            "NO_CLOSED_TRADES",
        ),
        "payoff_ratio": _metric(
            None if not wins or not losses else (_mean(wins) / abs(_mean(losses))),
            "WIN_OR_LOSS_SAMPLE_MISSING",
        ),
        "average_holding_ms": _metric(
            None
            if not durations
            else Decimal(sum(durations)) / Decimal(len(durations)),
            "NO_CLOSED_TRADES",
        ),
        "median_holding_ms": _metric(
            None if not durations else _median(durations), "NO_CLOSED_TRADES"
        ),
        "average_mae": _metric(
            _mean(mae) if len(mae) == count and count else None,
            "INCOMPLETE_TRADE_EXCURSION_TRACE",
        ),
        "average_mfe": _metric(
            _mean(mfe) if len(mfe) == count and count else None,
            "INCOMPLETE_TRADE_EXCURSION_TRACE",
        ),
        "max_single_trade_loss": _metric(
            None if not losses else min(losses), "NO_LOSING_TRADES"
        ),
        "max_consecutive_losses": _metric(
            None if not count else Decimal(streak), "NO_CLOSED_TRADES"
        ),
        "long": _group(groups.get("LONG", [])),
        "short": _group(groups.get("SHORT", [])),
    }


def _benchmark_metrics(
    config: Mapping[str, Any],
    market: Mapping[str, Any],
    initial: Decimal,
    duration_days: Decimal,
) -> dict[str, Any]:
    first = market.get("first") or {}
    last = market.get("last") or {}
    if initial <= 0 or not first or not last:
        return {
            "raw_return": None,
            "return": _metric(None, "BENCHMARK_PRICE_COVERAGE_MISSING"),
            "evidence": {"model": BENCHMARK_MODEL, "status": "UNAVAILABLE"},
        }
    start = _decimal(first["price"])
    end = _decimal(last["price"])
    fee = _decimal(config.get("taker_fee_bps", "0")) / Decimal(10_000)
    slippage = _decimal(config.get("slippage_bps", "0")) / Decimal(10_000)
    entry = start * (1 + slippage)
    qty = initial / (entry * (1 + fee))
    proceeds = qty * end * (1 - slippage) * (1 - fee)
    result = proceeds / initial - 1
    return {
        "raw_return": result,
        "return": _metric(result),
        "evidence": {
            "model": BENCHMARK_MODEL,
            "snapshot_context_hash": market.get("context_hash"),
            "start_time_ms": first.get("event_time_ms"),
            "end_time_ms": last.get("event_time_ms"),
            "start_price": str(start),
            "end_price": str(end),
            "taker_fee_bps": str(config.get("taker_fee_bps", "0")),
            "slippage_bps": str(config.get("slippage_bps", "0")),
            "tradable_window_days": str(duration_days),
            "same_snapshot_and_window": True,
        },
    }


def _execution_metrics(
    payload: Mapping[str, Any],
    account: Mapping[str, Any],
    curve: list[Mapping[str, Any]],
    market: Mapping[str, Any],
) -> dict[str, Any]:
    fills = list(payload.get("fills") or [])
    orders = list(payload.get("orders") or [])
    source_prices = market.get("fill_source_prices") or {}
    slippage = Decimal("0")
    traced = 0
    turnover_notional = Decimal("0")
    for fill in fills:
        qty = _decimal(fill.get("qty", "0"))
        price = _decimal(fill.get("price", "0"))
        turnover_notional += qty * price
        source = source_prices.get(
            str(fill.get("source_sequence") or fill.get("sequence") or "")
        )
        if source is not None:
            traced += 1
            source_price = _decimal(source)
            slippage += (
                (price - source_price)
                * qty
                * (Decimal("1") if str(fill.get("side")) == "BUY" else Decimal("-1"))
            )
    average_equity = (
        _mean([_decimal(item["equity"]) for item in curve]) if curve else None
    )
    exposure = _exposure_time(curve)
    return {
        "fill_count": len(fills),
        "order_count": len(orders),
        "rejected_order_count": len(payload.get("rejected") or []),
        "partial_order_count": sum(
            str(item.get("status")) == "PARTIAL" for item in orders
        ),
        "unfilled_order_count": sum(
            str(item.get("status")) in {"OPEN", "CANCELLED", "EXPIRED"}
            for item in orders
        ),
        "fees": _metric(
            _decimal(
                account.get(
                    "cumulative_fees",
                    (payload.get("ledger") or {}).get("fee_total", "0"),
                )
            )
        ),
        "funding": _metric(_decimal(account.get("cumulative_funding", "0"))),
        "slippage": _metric(
            slippage if traced == len(fills) else None,
            "INCOMPLETE_FILL_SOURCE_PRICE_TRACE",
        ),
        "turnover": _metric(
            None
            if not average_equity or average_equity <= 0
            else turnover_notional / average_equity,
            "NON_POSITIVE_AVERAGE_EQUITY",
        ),
        "exposure_time": _metric(exposure, "INSUFFICIENT_EQUITY_SAMPLES"),
    }


def _exposure_time(curve: list[Mapping[str, Any]]) -> Decimal | None:
    if len(curve) < 2 or not all("position_qty" in item for item in curve):
        return None
    total = active = 0
    for left, right in zip(curve, curve[1:]):
        span = int(right["event_time_ms"]) - int(left["event_time_ms"])
        total += max(0, span)
        if _decimal(left.get("position_qty", "0")) != 0:
            active += max(0, span)
    return None if total <= 0 else Decimal(active) / Decimal(total)


def _quality_metrics(
    payload: Mapping[str, Any],
    config: Mapping[str, Any],
    trades: list[Mapping[str, Any]],
) -> dict[str, Any]:
    quality = dict(payload.get("data_quality") or {})
    warnings = list(quality.get("warnings") or [])
    metric_warnings: list[str] = []
    if len(trades) == 0:
        metric_warnings.append("NO_CLOSED_TRADES")
    elif len(trades) < 30:
        metric_warnings.append("SMALL_CLOSED_TRADE_SAMPLE")
    net_values = [abs(_decimal(item["net_pnl"])) for item in trades]
    if net_values and sum(net_values, Decimal("0")) > 0:
        if max(net_values) / sum(net_values, Decimal("0")) >= Decimal("0.5"):
            metric_warnings.append("SINGLE_TRADE_DOMINATES_ABSOLUTE_PNL")
    return {
        "data_coverage": quality,
        "gap_count": _quality_count(quality.get("gap_count", quality.get("gaps"))),
        "duplicate_count": _quality_count(
            quality.get("duplicate_count", quality.get("duplicates"))
        ),
        "warning_count": len(warnings) + len(metric_warnings),
        "metric_warnings": metric_warnings,
        "ambiguity_count": int(payload.get("ambiguity_count") or 0),
        "fill_model": (payload.get("fill_model") or {}).get("name"),
        "account_model": config.get("account_model"),
        "metrics_version": METRICS_VERSION,
        "sample_role": config.get("sample_role"),
        "closed_trade_count": len(trades),
        "open_position_excluded_from_trade_metrics": _decimal(
            ((payload.get("ledger") or {}).get("account") or {}).get(
                "position_qty", "0"
            )
        )
        != 0,
        "suitability": "RESEARCH_ONLY",
    }


def _reconcile(
    payload: Mapping[str, Any],
    trades: list[Mapping[str, Any]],
    account: Mapping[str, Any],
    final_equity: Decimal,
    wallet: Decimal,
    unrealized: Decimal,
) -> dict[str, Any]:
    gross = sum((_decimal(item["gross_pnl"]) for item in trades), Decimal("0"))
    fill_fees = sum(
        (_decimal(item.get("fee", "0")) for item in payload.get("fills") or []),
        Decimal("0"),
    )
    realized = _decimal(account.get("cumulative_realized_pnl", gross))
    account_fees = _decimal(account.get("cumulative_fees", fill_fees))
    entries = account.get("ledger_entries") or []
    funding_entries = sum(
        (
            _decimal(
                item.get("amount", (item.get("details") or {}).get("amount", "0"))
            )
            for item in entries
            if item.get("kind") == "FUNDING"
        ),
        Decimal("0"),
    )
    account_funding = _decimal(account.get("cumulative_funding", funding_entries))
    checks = {
        "closed_trade_gross_equals_realized": gross == realized,
        "fill_fees_equal_account_fees": fill_fees == account_fees,
        "funding_events_equal_account_funding": funding_entries == account_funding,
        "final_equity_equals_wallet_plus_unrealized": final_equity
        == wallet + unrealized,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "values": {
            "closed_trade_gross_pnl": str(gross),
            "account_realized_pnl": str(realized),
            "fill_fees": str(fill_fees),
            "account_fees": str(account_fees),
            "funding_event_sum": str(funding_entries),
            "account_funding": str(account_funding),
            "final_equity": str(final_equity),
            "wallet_plus_unrealized": str(wallet + unrealized),
        },
    }


def _monthly_returns(curve: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[Decimal]] = defaultdict(list)
    for item in curve:
        grouped[str(item["date"])[:7]].append(_decimal(item["equity"]))
    result = []
    for month in sorted(grouped):
        values = grouped[month]
        value = (
            None if len(values) < 2 or values[0] <= 0 else values[-1] / values[0] - 1
        )
        result.append(
            {"month": month, **_metric(value, "FEWER_THAN_TWO_MONTHLY_EQUITY_SAMPLES")}
        )
    return result


def _metric(
    value: Decimal | int | None, reason: str | None = None
) -> dict[str, str | None]:
    if value is None:
        return {"value": None, "reason": reason or "NOT_APPLICABLE"}
    return {"value": str(value), "reason": None}


def _decimal(value: Any) -> Decimal:
    return Decimal(str(value))


def _mean(values: list[Decimal]) -> Decimal:
    return sum(values, Decimal("0")) / Decimal(len(values))


def _sample_std(values: list[Decimal]) -> Decimal:
    if len(values) < 2:
        return Decimal("0")
    mean = _mean(values)
    return (
        sum(((item - mean) ** 2 for item in values), Decimal("0"))
        / Decimal(len(values) - 1)
    ).sqrt()


def _median(values: list[int]) -> Decimal:
    middle = len(values) // 2
    if len(values) % 2:
        return Decimal(values[middle])
    return Decimal(values[middle - 1] + values[middle]) / Decimal(2)


def _group(values: list[Decimal]) -> dict[str, Any]:
    return {
        "trade_count": len(values),
        "net_pnl": str(sum(values, Decimal("0"))),
        "win_rate": _metric(
            None
            if not values
            else Decimal(sum(item > 0 for item in values)) / Decimal(len(values)),
            "NO_CLOSED_TRADES",
        ),
    }


def _quality_count(value: Any) -> int:
    if isinstance(value, Mapping):
        return sum(_quality_count(item) for item in value.values())
    if isinstance(value, (list, tuple, set)):
        return len(value)
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _trade_windows(fills: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    lots: deque[dict[str, Any]] = deque()
    windows: list[dict[str, Any]] = []
    for fill in sorted(
        fills,
        key=lambda item: (
            int(item.get("source_sequence") or item.get("sequence") or 0),
            str(item.get("order_id") or ""),
        ),
    ):
        side = str(fill.get("side") or "").upper()
        if side not in {"BUY", "SELL"}:
            continue
        sign = Decimal("1") if side == "BUY" else Decimal("-1")
        qty = _decimal(fill.get("qty", "0"))
        while qty > 0 and lots and lots[0]["sign"] != sign:
            lot = lots[0]
            closed = min(qty, _decimal(lot["qty"]))
            windows.append(
                {
                    "trade_id": f"trade-{len(windows) + 1}",
                    "side": "LONG" if lot["sign"] > 0 else "SHORT",
                    "entry_sequence": int(lot["sequence"]),
                    "exit_sequence": int(
                        fill.get("source_sequence") or fill.get("sequence") or 0
                    ),
                    "entry_price": str(lot["price"]),
                    "entry_reason": str(lot.get("reason") or ""),
                    "exit_reason": str(fill.get("reason") or ""),
                }
            )
            qty -= closed
            lot["qty"] = _decimal(lot["qty"]) - closed
            if lot["qty"] == 0:
                lots.popleft()
        if qty > 0:
            lots.append(
                {
                    "sign": sign,
                    "qty": qty,
                    "price": _decimal(fill.get("price", "0")),
                    "sequence": int(
                        fill.get("source_sequence") or fill.get("sequence") or 0
                    ),
                    "reason": str(fill.get("reason") or ""),
                }
            )
    return sorted(windows, key=lambda item: int(item["entry_sequence"]))
