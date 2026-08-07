"""Built-in indicator values exposed to alert expressions."""
from __future__ import annotations

from typing import Any

from app.data_engine.data_manager.models import BarData
from app.indicator.indicators.ma import MAIndicator
from app.indicator.indicators.macd import MACDIndicator
from app.indicator.indicators.rsi import RSIIndicator


ALERT_INDICATOR_HISTORY_LIMIT = 250


def compute_alert_indicator_values(bars: list[BarData]) -> dict[str, float | None]:
    """Compute the supported alert aliases from one authoritative bar window."""
    if not bars:
        return {"rsi": None, "macdHist": None, "ma20": None}

    rsi = RSIIndicator({"period": 14, "source": "close"})
    macd = MACDIndicator({"fast": 12, "slow": 26, "signal": 9, "source": "close"})
    ma = MAIndicator({"period": 20, "source": "close"})
    rsi.init(bars)
    macd.init(bars)
    ma.init(bars)
    return {
        "rsi": _optional_float(rsi.get_latest().get("rsi")),
        "macdHist": _optional_float(macd.get_latest().get("hist")),
        "ma20": _optional_float(ma.get_latest().get("ma")),
    }


def merge_alert_bar_window(
    existing: list[BarData],
    bar: BarData,
    *,
    limit: int = ALERT_INDICATOR_HISTORY_LIMIT,
) -> list[BarData]:
    """Replace an amended/forming timestamp or append a newer bar."""
    by_time: dict[int, BarData] = {int(item.time): item for item in existing}
    by_time[int(bar.time)] = bar
    return [by_time[key] for key in sorted(by_time)[-limit:]]


def indicator_readiness(values: dict[str, Any]) -> dict[str, bool]:
    return {
        key: isinstance(values.get(key), (int, float))
        for key in ("rsi", "macdHist", "ma20")
    }


def _optional_float(value: Any) -> float | None:
    if value is None:
        return None
    parsed = float(value)
    return parsed if parsed == parsed else None
