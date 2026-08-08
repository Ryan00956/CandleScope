from __future__ import annotations

from typing import Any

import pytest
from candlescope_plugin_sdk import Bar, ExecuteBatchRequest, MarketContext

from candlescope_plugin_pyne import (
    PYNE_DATA_BROKER_PROTOCOL_V1,
    PYNE_SESSION_PROTOCOL_V2,
    BrokeredDataPage,
    PyneRuntimePlugin,
    PyneSessionService,
    execute_brokered_batch,
)


def _context() -> MarketContext:
    return MarketContext(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
    )


def _bars() -> tuple[Bar, ...]:
    return tuple(
        Bar(
            time=index * 60,
            open=value,
            high=value + 1,
            low=value - 1,
            close=value,
            volume=10,
        )
        for index, value in enumerate((10.0, 11.0, 12.0), 1)
    )


INCREMENTAL_SCRIPT = """
indicator("Session", mode="incremental", overlay=True)
def on_bar(ctx, bar):
    count = ctx.state("count", 0)
    count.value += 1
    ctx.plot("Count", count.value)
"""


def test_descriptor_advertises_additive_v2_and_explicit_v1_fallback() -> None:
    descriptor = PyneRuntimePlugin().describe()

    assert descriptor.meta["extensionProtocols"] == [
        PYNE_SESSION_PROTOCOL_V2,
        PYNE_DATA_BROKER_PROTOCOL_V1,
    ]
    assert descriptor.meta["v1Fallback"] == {
        "protocol": "candlescope.script-runtime/1",
        "method": "executeBatch",
        "sessionState": False,
        "brokeredData": False,
    }


def test_v2_session_disconnect_and_reconnect_preserve_committed_state() -> None:
    service = PyneSessionService(max_sessions=2, idle_ttl_seconds=60)
    opened = service.open_session(
        "chart:one",
        source=INCREMENTAL_SCRIPT,
        context=_context(),
        retention_bars=2,
    )
    seeded = service.seed_session("chart:one", _bars()[:2])
    service.disconnect_session("chart:one")
    resumed = service.open_session(
        "chart:one",
        source=INCREMENTAL_SCRIPT,
        context=_context(),
        retention_bars=2,
    )
    committed = service.process_bar("chart:one", _bars()[2], preview=False)

    assert opened["protocol"] == PYNE_SESSION_PROTOCOL_V2
    assert opened["resumed"] is False
    assert seeded.ok
    assert resumed["resumed"] is True
    assert committed.ok
    assert committed.meta["totalCommittedBars"] == 3
    snapshot = service.snapshot_session("chart:one")
    assert snapshot.meta["retainedBars"] == 2
    assert service.close_session("chart:one") is True


def test_v2_session_rejects_batch_source_and_identity_rebinding() -> None:
    service = PyneSessionService()
    with pytest.raises(ValueError, match="require an incremental script"):
        service.open_session(
            "chart:batch",
            source='indicator("Batch")',
            context=_context(),
        )

    service.open_session("chart:one", source=INCREMENTAL_SCRIPT, context=_context())
    service.disconnect_session("chart:one")
    with pytest.raises(ValueError, match="different inputs"):
        service.open_session(
            "chart:one",
            source=INCREMENTAL_SCRIPT + "\n# changed",
            context=_context(),
        )


def test_brokered_batch_returns_exact_request_then_completes() -> None:
    request = ExecuteBatchRequest(
        source="""
indicator("Brokered", overlay=True)
requested = request.security("BINANCE:BTCUSDT", "1m", close)
plot(requested, "Requested")
""",
        context=_context(),
        bars=_bars(),
        params={},
        options={},
    )

    pending = execute_brokered_batch(request)
    assert pending.status == "needsData"
    assert pending.result is None
    assert len(pending.data_requests) == 1
    broker_request = pending.data_requests[0]
    page = BrokeredDataPage(
        request_id=broker_request.request_id,
        symbol=broker_request.symbol,
        timeframe=broker_request.timeframe,
        start=broker_request.start,
        end=broker_request.end,
        bars=tuple(_bar_dict(bar) for bar in _bars()),
        metadata={
            "syminfo": {"tickerid": "BINANCE:BTCUSDT", "mintick": 0.1},
            "timeframe": "1m",
        },
    )

    complete = execute_brokered_batch(request, pages=(page,))

    assert complete.status == "complete"
    assert complete.result is not None and complete.result.ok
    assert complete.result.output is not None
    assert complete.result.output.series[0].title == "Requested"
    assert complete.to_wire()["protocol"] == PYNE_SESSION_PROTOCOL_V2


def test_broker_page_wire_contract_rejects_wrong_protocol() -> None:
    with pytest.raises(ValueError, match="protocol is not supported"):
        BrokeredDataPage.from_wire(
            {
                "protocol": "wrong",
                "requestId": "request",
                "symbol": "BTCUSDT",
                "timeframe": "1m",
                "start": 0,
                "end": 1,
                "bars": [],
            }
        )


def test_broker_page_rejects_out_of_range_and_unsorted_rows() -> None:
    with pytest.raises(ValueError, match="outside the requested range"):
        BrokeredDataPage(
            request_id="request",
            symbol="BTCUSDT",
            timeframe="1m",
            start=60,
            end=120,
            bars=(_bar_dict(_bars()[2]),),
        )
    with pytest.raises(ValueError, match="strictly increasing"):
        BrokeredDataPage(
            request_id="request",
            symbol="BTCUSDT",
            timeframe="1m",
            start=0,
            end=240,
            bars=(_bar_dict(_bars()[1]), _bar_dict(_bars()[0])),
        )


def _bar_dict(bar: Bar) -> dict[str, Any]:
    return {
        "time": bar.time,
        "open": bar.open,
        "high": bar.high,
        "low": bar.low,
        "close": bar.close,
        "volume": bar.volume,
    }
