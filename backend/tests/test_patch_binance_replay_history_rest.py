from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.replay.history_archive import ReplayHistoryArchiveError
from scripts import patch_binance_replay_history_rest as patcher


OPEN_MS = 1_653_868_800_000
WEEK_MS = 604_800_000
JAN_2024_MS = int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() * 1_000)
FEB_2024_MS = int(datetime(2024, 2, 1, tzinfo=timezone.utc).timestamp() * 1_000)
MAR_2024_MS = int(datetime(2024, 3, 1, tzinfo=timezone.utc).timestamp() * 1_000)


def _body(*, open_ms: int = OPEN_MS, close_ms: int | None = None) -> bytes:
    return json.dumps(
        [
            [
                open_ms,
                "100.1",
                "120.2",
                "90.3",
                "110.4",
                "12.5",
                open_ms + WEEK_MS - 1 if close_ms is None else close_ms,
                "1337.6",
                42,
                "6.7",
                "712.8",
                "0",
            ]
        ],
        separators=(",", ":"),
    ).encode()


def test_request_url_is_exact_and_canonical() -> None:
    assert patcher._request_url("btcusdt", "1w", OPEN_MS) == (
        "https://api.binance.com/api/v3/klines?"
        f"symbol=BTCUSDT&interval=1w&startTime={OPEN_MS}&"
        f"endTime={OPEN_MS + WEEK_MS - 1}&limit=1"
    )


def test_request_url_uses_calendar_month_successor() -> None:
    assert patcher._request_url("BTCUSDT", "1M", JAN_2024_MS) == (
        "https://api.binance.com/api/v3/klines?"
        f"symbol=BTCUSDT&interval=1M&startTime={JAN_2024_MS}&"
        f"endTime={FEB_2024_MS - 1}&limit=1"
    )


def test_parse_exact_bar_preserves_identity_and_fields() -> None:
    bar = patcher._parse_exact_bar(
        _body(),
        expected_open_ms=OPEN_MS,
        interval="1w",
    )

    assert bar == {
        "open_time": OPEN_MS,
        "close_time": OPEN_MS + WEEK_MS - 1,
        "open": "100.1",
        "high": "120.2",
        "low": "90.3",
        "close": "110.4",
        "volume": "12.5",
        "quote_volume": "1337.6",
        "trades": 42,
        "taker_buy_base": "6.7",
        "taker_buy_quote": "712.8",
        "source": "binance_rest_api_exact",
    }


def test_parse_exact_bar_normalizes_same_bucket_early_close() -> None:
    bar = patcher._parse_exact_bar(
        _body(close_ms=OPEN_MS + 13_524),
        expected_open_ms=OPEN_MS,
        interval="1w",
    )

    assert bar == {
        "open_time": OPEN_MS,
        "close_time": OPEN_MS + WEEK_MS - 1,
        "open": "100.1",
        "high": "120.2",
        "low": "90.3",
        "close": "110.4",
        "volume": "12.5",
        "quote_volume": "1337.6",
        "trades": 42,
        "taker_buy_base": "6.7",
        "taker_buy_quote": "712.8",
        "source": "binance_rest_api_exact_close_boundary_normalized",
    }


def test_parse_exact_response_accepts_exchange_confirmed_empty_array() -> None:
    assert (
        patcher._parse_exact_response(
            b"[ ]",
            expected_open_ms=OPEN_MS,
            interval="1w",
        )
        is None
    )


def test_parse_exact_bar_uses_calendar_month_close_bound() -> None:
    bar = patcher._parse_exact_bar(
        _body(open_ms=JAN_2024_MS, close_ms=FEB_2024_MS - 1),
        expected_open_ms=JAN_2024_MS,
        interval="1M",
    )

    assert bar["open_time"] == JAN_2024_MS
    assert bar["close_time"] == FEB_2024_MS - 1


@pytest.mark.parametrize(
    "body",
    (
        b"[]",
        _body(open_ms=OPEN_MS + WEEK_MS),
        _body(close_ms=OPEN_MS + WEEK_MS),
    ),
)
def test_parse_exact_bar_rejects_non_exact_response(body: bytes) -> None:
    with pytest.raises(ReplayHistoryArchiveError):
        patcher._parse_exact_bar(
            body,
            expected_open_ms=OPEN_MS,
            interval="1w",
        )


def test_parse_exact_bar_rejects_close_before_open() -> None:
    with pytest.raises(ReplayHistoryArchiveError):
        patcher._parse_exact_bar(
            _body(close_ms=OPEN_MS - 1),
            expected_open_ms=OPEN_MS,
            interval="1w",
        )


def test_persist_source_receipt_binds_raw_response(tmp_path) -> None:
    body = _body()
    response_digest, receipt_digest, receipt_path = (
        patcher._persist_source_receipt(
            tmp_path,
            request_url=patcher._request_url("BTCUSDT", "1w", OPEN_MS),
            body=body,
            received_at_ms=1_700_000_000_123,
            open_time_ms=OPEN_MS,
            interval="1w",
            status=200,
            content_type="application/json;charset=UTF-8",
        )
    )

    assert response_digest == f"sha256:{hashlib.sha256(body).hexdigest()}"
    receipt = json.loads((tmp_path / receipt_path).read_text(encoding="utf-8"))
    response_path = tmp_path / receipt["response_path"]
    assert response_path.read_bytes() == body
    assert receipt["response_content_sha256"] == response_digest
    assert receipt["received_at_utc"] == "2023-11-14T22:13:20.123000Z"
    assert receipt_digest == (
        "sha256:"
        + hashlib.sha256((tmp_path / receipt_path).read_bytes()).hexdigest()
    )


def test_persist_source_receipt_binds_empty_response(tmp_path) -> None:
    body = b"[]"
    response_digest, _, receipt_path = patcher._persist_source_receipt(
        tmp_path,
        request_url=patcher._request_url("BTCUSDT", "1w", OPEN_MS),
        body=body,
        received_at_ms=1_700_000_000_123,
        open_time_ms=OPEN_MS,
        interval="1w",
        status=200,
        content_type="application/json",
    )

    receipt = json.loads((tmp_path / receipt_path).read_text(encoding="utf-8"))
    assert response_digest == f"sha256:{hashlib.sha256(body).hexdigest()}"
    assert (tmp_path / receipt["response_path"]).read_bytes() == body


def test_enumerate_gap_opens_uses_interval_successors() -> None:
    assert patcher._enumerate_gap_opens(
        start_ms=OPEN_MS,
        end_ms=OPEN_MS + 2 * WEEK_MS,
        interval="1w",
        declared_missing_bars=3,
    ) == (OPEN_MS, OPEN_MS + WEEK_MS, OPEN_MS + 2 * WEEK_MS)
    assert patcher._enumerate_gap_opens(
        start_ms=JAN_2024_MS,
        end_ms=MAR_2024_MS,
        interval="1M",
        declared_missing_bars=3,
    ) == (JAN_2024_MS, FEB_2024_MS, MAR_2024_MS)


class _GapRepository:
    def get_bounds_at_revision(self, *args, **kwargs):
        del args, kwargs
        return {
            "earliest_open_time": OPEN_MS - WEEK_MS,
            "latest_open_time": OPEN_MS + 3 * WEEK_MS,
        }

    def scan_gaps_at_revision(self, *args, **kwargs):
        del args, kwargs
        return {
            "gaps": [
                {
                    "start_ms": OPEN_MS,
                    "end_ms": OPEN_MS + 2 * WEEK_MS,
                    "missing_bars": 3,
                }
            ],
            "gap_count": 1,
            "missing_bars": 3,
            "truncated": False,
        }


def test_missing_opens_supports_multi_bar_gap_only_with_explicit_count() -> None:
    assert patcher._missing_opens(
        _GapRepository(),
        revision="sha256:" + "1" * 64,
        symbol="BTCUSDT",
        interval="1w",
        expected_gap_count=1,
        expected_missing_bars=3,
    ) == (OPEN_MS, OPEN_MS + WEEK_MS, OPEN_MS + 2 * WEEK_MS)

    with pytest.raises(ReplayHistoryArchiveError, match="exact expected"):
        patcher._missing_opens(
            _GapRepository(),
            revision="sha256:" + "1" * 64,
            symbol="BTCUSDT",
            interval="1w",
            expected_gap_count=1,
            expected_missing_bars=None,
        )


class _TailGapRepository:
    def __init__(
        self,
        *,
        latest_open_ms: int,
        gap_start_ms: int,
        gap_end_ms: int,
        missing_bars: int,
    ) -> None:
        self.latest_open_ms = latest_open_ms
        self.gap_start_ms = gap_start_ms
        self.gap_end_ms = gap_end_ms
        self.missing_bars = missing_bars

    def get_bounds_at_revision(self, *args, **kwargs):
        del args, kwargs
        return {
            "earliest_open_time": self.latest_open_ms,
            "latest_open_time": self.latest_open_ms,
        }

    def scan_gaps_at_revision(self, *args, **kwargs):
        del args
        assert kwargs["end_ms"] == self.gap_end_ms
        return {
            "gaps": [
                {
                    "start_ms": self.gap_start_ms,
                    "end_ms": self.gap_end_ms,
                    "missing_bars": self.missing_bars,
                }
            ],
            "gap_count": 1,
            "missing_bars": self.missing_bars,
            "truncated": False,
        }


def test_required_tail_uses_month_and_catalog_anchored_fixed_grid() -> None:
    assert patcher._missing_opens(
        _TailGapRepository(
            latest_open_ms=JAN_2024_MS,
            gap_start_ms=FEB_2024_MS,
            gap_end_ms=MAR_2024_MS,
            missing_bars=2,
        ),
        revision="sha256:" + "1" * 64,
        symbol="BTCUSDT",
        interval="1M",
        expected_gap_count=1,
        expected_missing_bars=2,
        required_end_open_ms=MAR_2024_MS,
    ) == (FEB_2024_MS, MAR_2024_MS)

    anchored_3d_open = JAN_2024_MS + 86_400_000
    three_days_ms = 3 * 86_400_000
    assert patcher._missing_opens(
        _TailGapRepository(
            latest_open_ms=anchored_3d_open,
            gap_start_ms=anchored_3d_open + three_days_ms,
            gap_end_ms=anchored_3d_open + 2 * three_days_ms,
            missing_bars=2,
        ),
        revision="sha256:" + "1" * 64,
        symbol="BTCUSDT",
        interval="3d",
        expected_gap_count=1,
        expected_missing_bars=2,
        required_end_open_ms=anchored_3d_open + 2 * three_days_ms,
    ) == (
        anchored_3d_open + three_days_ms,
        anchored_3d_open + 2 * three_days_ms,
    )


def test_required_tail_rejects_off_grid_end() -> None:
    with pytest.raises(ReplayHistoryArchiveError, match="not on the pinned"):
        patcher._missing_opens(
            _TailGapRepository(
                latest_open_ms=JAN_2024_MS,
                gap_start_ms=FEB_2024_MS,
                gap_end_ms=FEB_2024_MS,
                missing_bars=1,
            ),
            revision="sha256:" + "1" * 64,
            symbol="BTCUSDT",
            interval="1M",
            expected_gap_count=1,
            expected_missing_bars=1,
            required_end_open_ms=FEB_2024_MS + 1,
        )


def _object(first_open_ms: int, last_open_ms: int, token: str):
    return SimpleNamespace(
        first_open_ms=first_open_ms,
        last_open_ms=last_open_ms,
        object_sha256=f"sha256:{token * 64}",
        source_object_key=f"vision:{token}",
    )


def test_gap_placement_allows_between_objects() -> None:
    manifest = SimpleNamespace(
        catalog_epoch="sha256:" + "a" * 64,
        interval="1w",
        objects=(
            _object(OPEN_MS - 2 * WEEK_MS, OPEN_MS - WEEK_MS, "1"),
            _object(OPEN_MS + WEEK_MS, OPEN_MS + 2 * WEEK_MS, "2"),
        ),
    )

    assert patcher._gap_placement_blocker(manifest, (OPEN_MS,)) is None
    patcher._assert_safe_gap_placement(manifest, (OPEN_MS,))


def test_gap_placement_fails_closed_inside_existing_object() -> None:
    manifest = SimpleNamespace(
        catalog_epoch="sha256:" + "a" * 64,
        interval="1w",
        objects=(_object(OPEN_MS - WEEK_MS, OPEN_MS + WEEK_MS, "1"),),
    )

    blocker = patcher._gap_placement_blocker(
        manifest,
        (OPEN_MS, OPEN_MS + 2 * WEEK_MS),
    )
    assert blocker is not None
    assert blocker["blocked_missing_bars"] == 1
    assert blocker["safe_missing_bars"] == 1
    assert "atomically replace the whole object" in blocker["required_remediation"]
    with pytest.raises(ReplayHistoryArchiveError, match="REST patch blocked"):
        patcher._assert_safe_gap_placement(
            manifest,
            (OPEN_MS, OPEN_MS + 2 * WEEK_MS),
        )


def _archive_bar(open_ms: int, *, source: str) -> dict[str, object]:
    bar = patcher._parse_exact_bar(
        _body(open_ms=open_ms),
        expected_open_ms=open_ms,
        interval="1w",
    )
    bar["source"] = source
    return bar


def test_patch_history_publishes_exact_rows_and_retains_confirmed_empty(
    tmp_path,
    monkeypatch,
) -> None:
    identity = patcher.ReplaySeriesIdentity("binance", "spot", "BTCUSDT")
    writer = patcher.ReplayHistoryArchiveWriter(tmp_path)
    base = writer.import_batches(
        identity,
        "1w",
        (
            patcher.ReplayHistoryImportBatch(
                rows=(_archive_bar(OPEN_MS - WEEK_MS, source="vision"),),
                source_provider="binance_vision",
                source_object_key="vision:left",
                source_period="left",
                source_row_count=1,
                source_filter_policy="test_exact_rows_v1",
            ),
            patcher.ReplayHistoryImportBatch(
                rows=(_archive_bar(OPEN_MS + 2 * WEEK_MS, source="vision"),),
                source_provider="binance_vision",
                source_object_key="vision:right",
                source_period="right",
                source_row_count=1,
                source_filter_policy="test_exact_rows_v1",
            ),
        ),
    )

    class _FakeHttp:
        def __init__(self) -> None:
            self.responses = [
                SimpleNamespace(
                    status=200,
                    headers={"content-type": "application/json"},
                    body=_body(open_ms=OPEN_MS, close_ms=OPEN_MS + 13_524),
                ),
                SimpleNamespace(
                    status=200,
                    headers={"content-type": "application/json"},
                    body=_body(open_ms=OPEN_MS + WEEK_MS),
                ),
                SimpleNamespace(
                    status=200,
                    headers={"content-type": "application/json"},
                    body=b"[]",
                ),
            ]

        async def get_bytes(self, url, *, allowed_hosts, max_bytes):
            assert url.startswith("https://api.binance.com/api/v3/klines?")
            assert allowed_hosts == ("api.binance.com",)
            assert max_bytes == patcher._MAX_RESPONSE_BYTES
            return self.responses.pop(0)

    fake_http = _FakeHttp()
    monkeypatch.setattr(
        patcher,
        "AiohttpArchiveHttpClient",
        lambda **kwargs: fake_http,
    )
    monkeypatch.setattr(patcher.time, "time", lambda: 1_700_000_000.123)

    report = asyncio.run(
        patcher.patch_history(
            SimpleNamespace(
                archive_dir=tmp_path,
                symbol="BTCUSDT",
                interval="1w",
                base_revision=base.catalog_epoch,
                expected_gap_count=2,
                expected_missing_bars=3,
                required_end_open_ms=OPEN_MS + 3 * WEEK_MS,
                timeout_seconds=30.0,
            )
        )
    )

    assert report["catalog_epoch"] != base.catalog_epoch
    assert report["required_end_open_ms"] == OPEN_MS + 3 * WEEK_MS
    assert report["probed_count"] == 3
    assert report["patched_count"] == 2
    assert report["exchange_confirmed_true_gap_count"] == 1
    assert report["gap_count"] == 1
    assert report["missing_bars"] == 1
    assert report["total_count"] == 4
    assert report["objects_verified"] == 4
    assert report["imported"][0]["open_time_ms"] == OPEN_MS
    manifest = writer.current_manifest(identity, "1w")
    assert manifest is not None
    normalized_object = next(
        item for item in manifest.objects if item.first_open_ms == OPEN_MS
    )
    assert normalized_object.source_normalized_rows == 1
    empty = report["exchange_confirmed_true_gaps"][0]
    assert empty["open_time_ms"] == OPEN_MS + 3 * WEEK_MS
    assert empty["status"] == "exchange_confirmed_true_gap"
    receipt = json.loads(
        (tmp_path / empty["receipt_path"]).read_text(encoding="utf-8")
    )
    assert (tmp_path / receipt["response_path"]).read_bytes() == b"[]"

    repository = patcher.ReplayHistoryRepository(tmp_path)
    patched_bar = repository.query_bars_at_revision(
        report["catalog_epoch"],
        "BTCUSDT",
        "1w",
        start_ms=OPEN_MS,
        end_ms=OPEN_MS,
        exchange="binance",
        market_type="spot",
    )[0]
    assert patched_bar["open_time"] == OPEN_MS
    assert patched_bar["close_time"] == OPEN_MS + WEEK_MS - 1
    assert patched_bar["source"] == (
        "binance_rest_api_exact_close_boundary_normalized"
    )
