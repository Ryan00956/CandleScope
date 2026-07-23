from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import indicators as indicators_api
from app.data_engine.data_manager.models import BarData


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    return TestClient(app)


def _bars(count: int = 30) -> list[dict]:
    return [
        {
            "time": 1_700_000_000 + index * 60,
            "open": 100 + index,
            "high": 101 + index,
            "low": 99 + index,
            "close": 100 + index,
            "volume": 10 + index,
        }
        for index in range(count)
    ]


def _item(
    index: int,
    *,
    job_key: str | None = None,
    client_id: str | None = None,
    name: str = "MA",
) -> dict:
    return {
        "jobKey": job_key if job_key is not None else f"job-{index}",
        "clientId": client_id if client_id is not None else f"indicator-{index}",
        "mode": "builtin",
        "name": name,
        "params": {"period": 3},
    }


def _body(requests: list[dict], *, schema_version: int = 1) -> dict:
    return {
        "schemaVersion": schema_version,
        "context": {
            "exchange": "binance",
            "marketType": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
        },
        "ohlcv": _bars(),
        "requests": requests,
    }


@pytest.mark.parametrize(
    ("schema_version", "requests", "error_fragment"),
    [
        (2, [_item(1)], "schemaVersion must be 1"),
        (1, [], "between 1 and 32"),
        (1, [_item(index) for index in range(33)], "between 1 and 32"),
        (
            1,
            [_item(1, job_key="same"), _item(2, job_key="same")],
            "duplicate jobKey",
        ),
        (
            1,
            [_item(1, client_id="same"), _item(2, client_id="same")],
            "duplicate clientId",
        ),
        (1, [_item(1, job_key=" ")], "non-blank jobKey and clientId"),
    ],
)
def test_compute_batch_rejects_ambiguous_identities_before_work(
    schema_version: int,
    requests: list[dict],
    error_fragment: str,
) -> None:
    response = _client().post(
        "/api/v1/indicators/compute/batch",
        json=_body(requests, schema_version=schema_version),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["code"] == "INVALID_INDICATOR_COMPUTE_BATCH"
    assert payload["errorDetail"]["code"] == "INVALID_INDICATOR_COMPUTE_BATCH"
    assert error_fragment in payload["error"]


def test_compute_batch_parses_builtin_bars_once_and_isolates_ordered_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bars = _bars()
    original_from_dict = BarData.from_dict.__func__
    converted_times: list[int] = []

    def counted_from_dict(cls, item: dict) -> BarData:
        converted_times.append(int(item["time"]))
        return original_from_dict(cls, item)

    monkeypatch.setattr(BarData, "from_dict", classmethod(counted_from_dict))
    response = _client().post(
        "/api/v1/indicators/compute/batch",
        json={
            **_body([
                _item(1, name="MA"),
                _item(2, name="DOES_NOT_EXIST"),
                _item(3, name="RSI"),
            ]),
            "ohlcv": bars,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["schemaVersion"] == 1
    assert payload["type"] == "indicator.compute_batch"
    assert payload["ok"] is False
    assert [
        (item["jobKey"], item["clientId"])
        for item in payload["results"]
    ] == [
        ("job-1", "indicator-1"),
        ("job-2", "indicator-2"),
        ("job-3", "indicator-3"),
    ]

    first, failed, third = [item["payload"] for item in payload["results"]]
    assert first["ok"] is True
    assert failed["ok"] is False
    assert failed["code"] == "INDICATOR_NOT_FOUND"
    assert failed["errorDetail"]["code"] == "INDICATOR_NOT_FOUND"
    assert third["ok"] is True
    assert converted_times == [bar["time"] for bar in bars]


@pytest.mark.anyio
async def test_compute_batch_reuses_one_validated_ohlcv_list_for_all_items(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen_ohlcv: list[list[dict[str, object]]] = []

    async def capture_request(req, **_kwargs) -> dict[str, object]:
        seen_ohlcv.append(req.ohlcv)
        return {"ok": True, "lines": []}

    monkeypatch.setattr(indicators_api, "_compute_batch_item", capture_request)
    request = indicators_api.IndicatorComputeBatchRequest(
        **_body([_item(1), _item(2), _item(3)])
    )

    payload = await indicators_api.compute_batch(request)

    assert payload["ok"] is True
    assert len(seen_ohlcv) == 3
    assert all(ohlcv is request.ohlcv for ohlcv in seen_ohlcv)


@pytest.mark.anyio
async def test_compute_batch_rejects_shared_script_ohlcv_window_before_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execute_calls: list[bool] = []

    def unexpected_execute(**_kwargs):
        execute_calls.append(True)
        raise AssertionError("script execution must not start")

    monkeypatch.setattr(indicators_api, "execute_pyne_script", unexpected_execute)
    one_bar = _bars(1)[0]
    script_item = {
        "jobKey": "script-job",
        "clientId": "script-indicator",
        "mode": "script",
        "script": 'plot(close, title="Close")',
    }

    for ohlcv, expected_error in (
        ([], "No OHLCV data provided"),
        ([one_bar] * 50_001, "Too many data points (max 50000)"),
    ):
        request = indicators_api.IndicatorComputeBatchRequest(
            **{
                **_body([script_item]),
                "ohlcv": ohlcv,
            }
        )
        payload = await indicators_api.compute_batch(request)

        assert payload["ok"] is False
        assert payload["code"] == "INVALID_OHLCV"
        assert payload["errorDetail"]["code"] == "INVALID_OHLCV"
        assert payload["error"] == expected_error
    assert execute_calls == []


def test_compute_batch_mixed_runtime_failure_is_isolated_and_ordered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_script(**_kwargs):
        raise RuntimeError("mixed script exploded")

    monkeypatch.setattr(indicators_api, "execute_pyne_script", fail_script)
    response = _client().post(
        "/api/v1/indicators/compute/batch",
        json=_body([
            _item(1, name="MA"),
            {
                "jobKey": "job-2",
                "clientId": "indicator-2",
                "mode": "script",
                "script": 'plot(close, title="Close")',
            },
            _item(3, name="RSI"),
        ]),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert [
        (item["jobKey"], item["clientId"])
        for item in payload["results"]
    ] == [
        ("job-1", "indicator-1"),
        ("job-2", "indicator-2"),
        ("job-3", "indicator-3"),
    ]
    first, failed, third = [item["payload"] for item in payload["results"]]
    assert first["ok"] is True
    assert failed["ok"] is False
    assert failed["code"] == "INDICATOR_BATCH_ITEM_FAILED"
    assert failed["errorDetail"]["code"] == "INDICATOR_BATCH_ITEM_FAILED"
    assert failed["error"] == "mixed script exploded"
    assert third["ok"] is True
