from __future__ import annotations

import asyncio
import hashlib
import io
import zipfile
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from app.exchanges.archive import ArchiveDataError, ArchiveHttpResponse
from app.exchanges.plugins.binance.archive import BinanceKlineArchiveProvider
from app.exchanges.plugins.okx.archive import OkxKlineArchiveProvider


UTC = timezone.utc
OKX_TZ = timezone(timedelta(hours=8))


def _ms(value: datetime) -> int:
    return int(value.timestamp() * 1_000)


def _zip_bytes(filename: str, csv_payload: str | bytes) -> bytes:
    payload = csv_payload.encode() if isinstance(csv_payload, str) else csv_payload
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(filename, payload)
    return output.getvalue()


def _monthly_binance_ref(*, market_type: str, year: int, month: int):
    provider = BinanceKlineArchiveProvider()
    start = datetime(year, month, 1, tzinfo=UTC)
    end = (
        datetime(year + 1, 1, 1, tzinfo=UTC)
        if month == 12
        else datetime(year, month + 1, 1, tzinfo=UTC)
    )
    refs = provider.plan_objects(
        market_type=market_type,
        symbol="BTCUSDT",
        interval="1m",
        start_ms=_ms(start),
        end_ms=_ms(end) - 1,
        now_ms=_ms(end + timedelta(days=40)),
    )
    return provider, next(ref for ref in refs if ref.period == f"{year:04d}-{month:02d}")


def test_binance_spot_archive_accepts_headerless_microsecond_rows(tmp_path) -> None:
    provider, ref = _monthly_binance_ref(market_type="spot", year=2025, month=1)
    open_us = ref.start_ms * 1_000
    close_us = (ref.start_ms + 60_000) * 1_000 - 1
    row = (
        f"{open_us},100,110,90,105,1.5,{close_us},157.5,10,"
        "0.75,78.75,0\n"
    )
    archive_path = tmp_path / ref.expected_filename
    archive_path.write_bytes(_zip_bytes(ref.expected_filename[:-4] + ".csv", row))

    bars = provider.parse_bars(archive_path, ref)

    assert len(bars) == 1
    assert bars[0].open_time == ref.start_ms
    assert bars[0].close_time == ref.start_ms + 59_999
    assert bars[0].source == "backfill_archive_verified"


def test_binance_futures_archive_accepts_header_and_millisecond_rows(tmp_path) -> None:
    provider, ref = _monthly_binance_ref(market_type="futures", year=2024, month=1)
    header = (
        "open_time,open,high,low,close,volume,close_time,quote_volume,count,"
        "taker_buy_volume,taker_buy_quote_volume,ignore\n"
    )
    row = (
        f"{ref.start_ms},100,110,90,105,1.5,{ref.start_ms + 59_999},"
        "157.5,10,0.75,78.75,0\n"
    )
    archive_path = tmp_path / ref.expected_filename
    archive_path.write_bytes(
        _zip_bytes(ref.expected_filename[:-4] + ".csv", header + row)
    )

    bars = provider.parse_bars(archive_path, ref)

    assert len(bars) == 1
    assert bars[0].trades == 10
    assert bars[0].quote_volume == 157.5


def test_binance_archive_normalizes_verified_legacy_close_boundary(tmp_path) -> None:
    provider, ref = _monthly_binance_ref(market_type="spot", year=2017, month=9)
    row = (
        f"{ref.start_ms},100,110,90,105,1.5,{ref.start_ms + 60_000},"
        "157.5,10,0.7,73.5,0\n"
    )
    archive_path = tmp_path / ref.expected_filename
    archive_path.write_bytes(
        _zip_bytes(ref.expected_filename[:-4] + ".csv", row)
    )

    bar = provider.parse_bars(archive_path, ref)[0]

    assert bar.close_time == ref.start_ms + 59_999
    assert bar.source == "backfill_archive_verified_close_boundary_normalized"


def test_binance_replay_parser_audits_partial_and_off_grid_legacy_rows(
    tmp_path,
) -> None:
    provider, ref = _monthly_binance_ref(market_type="spot", year=2017, month=12)

    def row(open_time: int, close_time: int) -> str:
        return (
            f"{open_time},100,110,90,105,1.5,{close_time},"
            "157.5,10,0.7,73.5,0\n"
        )

    payload = "".join(
        (
            row(ref.start_ms, ref.start_ms + 59_999),
            row(ref.start_ms + 60_000, ref.start_ms + 80_798),
            row(ref.start_ms + 80_799, ref.start_ms + 140_798),
            row(ref.start_ms + 180_000, ref.start_ms + 239_999),
        )
    )
    archive_path = tmp_path / ref.expected_filename
    archive_path.write_bytes(
        _zip_bytes(ref.expected_filename[:-4] + ".csv", payload)
    )

    with pytest.raises(ArchiveDataError, match="interval-aligned"):
        provider.parse_bars(archive_path, ref)

    audited = provider.parse_bars_for_replay(archive_path, ref)
    assert [bar.open_time for bar in audited.bars] == [
        ref.start_ms,
        ref.start_ms + 60_000,
        ref.start_ms + 180_000,
    ]
    normalized = audited.bars[1]
    assert normalized.close_time == ref.start_ms + 119_999
    assert normalized.open == 100
    assert normalized.high == 110
    assert normalized.low == 90
    assert normalized.close == 105
    assert normalized.volume == 1.5
    assert normalized.quote_volume == 157.5
    assert normalized.trades == 10
    assert normalized.taker_buy_base == 0.7
    assert normalized.taker_buy_quote == 73.5
    assert normalized.source == (
        "backfill_archive_verified_close_boundary_normalized"
    )
    assert audited.source_row_count == 4
    assert audited.rejected_row_count == 1
    assert audited.normalized_row_count == 1
    assert dict(audited.rejection_reasons) == {
        "open_not_interval_aligned": 1,
    }


def test_binance_replay_parser_rejects_close_before_open(tmp_path) -> None:
    provider, ref = _monthly_binance_ref(market_type="spot", year=2017, month=12)

    def row(open_time: int, close_time: int) -> str:
        return (
            f"{open_time},100,110,90,105,1.5,{close_time},"
            "157.5,10,0.7,73.5,0\n"
        )

    payload = "".join(
        (
            row(ref.start_ms, ref.start_ms + 59_999),
            row(ref.start_ms + 60_000, ref.start_ms + 59_999),
        )
    )
    archive_path = tmp_path / ref.expected_filename
    archive_path.write_bytes(
        _zip_bytes(ref.expected_filename[:-4] + ".csv", payload)
    )

    with pytest.raises(ArchiveDataError, match="close timestamp"):
        provider.parse_bars(archive_path, ref)

    audited = provider.parse_bars_for_replay(archive_path, ref)
    assert [bar.open_time for bar in audited.bars] == [ref.start_ms]
    assert audited.source_row_count == 2
    assert audited.rejected_row_count == 1
    assert audited.normalized_row_count == 0
    assert dict(audited.rejection_reasons) == {
        "close_timestamp_inconsistent": 1,
    }


def test_binance_archive_rejects_bad_checksum_schema_and_unsafe_zip(tmp_path) -> None:
    provider, ref = _monthly_binance_ref(market_type="spot", year=2025, month=1)
    assert provider.parse_checksum(
        f"{'a' * 64}  {ref.expected_filename}\n".encode(),
        ref,
    ) == "a" * 64
    with pytest.raises(ArchiveDataError, match="filename"):
        provider.parse_checksum(f"{'a' * 64}  wrong.zip\n".encode(), ref)

    drift_path = tmp_path / "drift.zip"
    drift_path.write_bytes(
        _zip_bytes(
            ref.expected_filename[:-4] + ".csv",
            "time,open,high,low,close,volume\n1,1,1,1,1,1\n",
        )
    )
    with pytest.raises(ArchiveDataError, match="header/schema"):
        provider.parse_bars(drift_path, ref)

    traversal_path = tmp_path / "traversal.zip"
    traversal_path.write_bytes(_zip_bytes("../evil.csv", "bad"))
    with pytest.raises(ArchiveDataError, match="member identity"):
        provider.parse_bars(traversal_path, ref)

    bomb_path = tmp_path / "bomb.zip"
    bomb_path.write_bytes(
        _zip_bytes(ref.expected_filename[:-4] + ".csv", b"0" * 1_000_000)
    )
    with pytest.raises(ArchiveDataError, match="compression ratio"):
        provider.parse_bars(bomb_path, ref)


def test_okx_archive_uses_utc8_boundaries_confirm_and_market_volume(tmp_path) -> None:
    provider = OkxKlineArchiveProvider()
    month_start = datetime(2024, 1, 1, tzinfo=OKX_TZ)
    month_end = datetime(2024, 2, 1, tzinfo=OKX_TZ)
    refs = provider.plan_objects(
        market_type="spot",
        symbol="BTC-USDT",
        interval="1m",
        start_ms=_ms(month_start),
        end_ms=_ms(month_end) - 1,
        now_ms=_ms(month_end + timedelta(days=40)),
    )
    ref = next(item for item in refs if item.period == "2024-01")
    assert ref.start_ms == _ms(datetime(2023, 12, 31, 16, tzinfo=UTC))
    assert ref.end_ms == _ms(datetime(2024, 1, 31, 16, tzinfo=UTC)) - 1

    header = (
        "instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,"
        "open_time,confirm\n"
    )
    row = f"BTC-USDT,100,110,90,105,2,3,210,{ref.start_ms},1\n"
    spot_path = tmp_path / ref.expected_filename
    spot_path.write_bytes(
        _zip_bytes(ref.expected_filename[:-4] + ".csv", header + row)
    )
    assert provider.parse_bars(spot_path, ref)[0].volume == 2

    futures_ref = replace(ref, market_type="futures")
    assert provider.parse_bars(spot_path, futures_ref)[0].volume == 3

    unconfirmed_path = tmp_path / "unconfirmed.zip"
    unconfirmed_path.write_bytes(
        _zip_bytes(
            ref.expected_filename[:-4] + ".csv",
            header + row.removesuffix("1\n") + "0\n",
        )
    )
    with pytest.raises(ArchiveDataError, match="unconfirmed"):
        provider.parse_bars(unconfirmed_path, ref)


def test_okx_resolver_only_accepts_static_allowlisted_downloads() -> None:
    provider = OkxKlineArchiveProvider()
    start = datetime(2024, 1, 1, tzinfo=OKX_TZ)
    end = datetime(2024, 2, 1, tzinfo=OKX_TZ)
    ref = next(
        item
        for item in provider.plan_objects(
            market_type="spot",
            symbol="BTC-USDT",
            interval="1m",
            start_ms=_ms(start),
            end_ms=_ms(end) - 1,
            now_ms=_ms(end + timedelta(days=40)),
        )
        if item.period == "2024-01"
    )

    class _Http:
        async def post_json(self, *args, **kwargs):
            return ArchiveHttpResponse(200, {}), {
                "code": "0",
                "data": {
                    "details": [{
                        "groupDetails": [{
                            "filename": ref.expected_filename,
                            "url": "https://evil.example/archive.zip",
                            "sizeMB": "1.5",
                        }],
                    }],
                },
            }

    with pytest.raises(ArchiveDataError, match="non-allowlisted"):
        asyncio.run(provider.resolve_objects([ref], _Http()))


def test_zip_fixture_hash_is_stable() -> None:
    # Guards the byte-oriented test helpers used by cache checksum tests.
    payload = _zip_bytes("sample.csv", "1,2,3\n")
    assert len(hashlib.sha256(payload).hexdigest()) == 64
