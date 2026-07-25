"""Guarded OKX historical-data page archive provider.

The resolver is intentionally isolated behind the exchange plugin because the
download-link endpoint belongs to the public website rather than API v5.
"""
from __future__ import annotations

import csv
import zipfile
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from app.data_engine.interval_policy import parse_interval_spec
from app.exchanges.archive import (
    ArchiveBar,
    ArchiveCapabilities,
    ArchiveCompatibilityError,
    ArchiveDataError,
    ArchiveGranularity,
    ArchiveHttpClient,
    ArchiveObjectRef,
)


_RESOLVER_URL = "https://www.okx.com/priapi/v5/broker/public/trade-data/download-link"
_RESOLVER_HOSTS = ("www.okx.com",)
_DOWNLOAD_HOSTS = ("static.okx.com",)
_DOWNLOAD_PREFIX = "/cdn/okex/traderecords/candlesticks/"
_OKX_TZ = timezone(timedelta(hours=8))
_EARLIEST = datetime(2023, 7, 1, tzinfo=_OKX_TZ)
_HEADER = (
    "instrument_name",
    "open",
    "high",
    "low",
    "close",
    "vol",
    "vol_ccy",
    "vol_quote",
    "open_time",
    "confirm",
)
_MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
_MAX_COMPRESSION_RATIO = 200
_MAX_ROWS = 100_000


class OkxKlineArchiveProvider:
    id = "okx-public-kline-page-v1"

    def capabilities(self, market_type: str) -> ArchiveCapabilities:
        normalized_market = _market_type(market_type)
        supported = normalized_market in {"spot", "futures", "swap"}
        return ArchiveCapabilities(
            provider_id=self.id,
            market_types=("spot", "futures", "swap"),
            intervals=("1m",) if supported else (),
            granularities=(ArchiveGranularity.MONTHLY, ArchiveGranularity.DAILY),
            packaging_timezone="UTC+08:00",
            rest_page_size=300,
            checksum_required=False,
        )

    def plan_objects(
        self,
        *,
        market_type: str,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        now_ms: int,
    ) -> list[ArchiveObjectRef]:
        normalized_market = _market_type(market_type)
        normalized_symbol = str(symbol or "").strip().upper()
        if (
            not self.capabilities(normalized_market).supports(
                market_type=normalized_market,
                interval=interval,
            )
            or not normalized_symbol
            or start_ms > end_ms
        ):
            return []
        start = _okx_datetime(start_ms)
        end = _okx_datetime(end_ms)
        if end < _EARLIEST:
            return []
        start = max(start, _EARLIEST)
        now = _okx_datetime(now_ms)
        current_day = _day_floor(now)
        current_month = _month_floor(now)

        monthly: list[ArchiveObjectRef] = []
        month = _month_floor(start)
        if start > month:
            month = _next_month(month)
        while month < current_month:
            month_end = _next_month(month)
            if month_end - timedelta(milliseconds=1) > end:
                break
            monthly.append(self._object(
                market_type=normalized_market,
                symbol=normalized_symbol,
                granularity=ArchiveGranularity.MONTHLY,
                period=month.strftime("%Y-%m"),
                start=month,
                end=month_end,
            ))
            month = month_end

        covered_months = {(item.start_ms, item.end_ms) for item in monthly}
        daily: list[ArchiveObjectRef] = []
        day = _day_floor(start)
        if start > day:
            day += timedelta(days=1)
        while day < current_day:
            day_end = day + timedelta(days=1)
            if day_end - timedelta(milliseconds=1) > end:
                break
            day_start_ms = _ms(day)
            day_end_ms = _ms(day_end) - 1
            if not any(
                month_start <= day_start_ms and day_end_ms <= month_end
                for month_start, month_end in covered_months
            ):
                daily.append(self._object(
                    market_type=normalized_market,
                    symbol=normalized_symbol,
                    granularity=ArchiveGranularity.DAILY,
                    period=day.strftime("%Y-%m-%d"),
                    start=day,
                    end=day_end,
                ))
            day = day_end
        return monthly + daily

    async def resolve_objects(
        self,
        objects: list[ArchiveObjectRef],
        http: ArchiveHttpClient,
    ) -> list[ArchiveObjectRef]:
        if not objects:
            return []
        resolved: list[ArchiveObjectRef] = []
        for granularity in (ArchiveGranularity.MONTHLY, ArchiveGranularity.DAILY):
            group = [item for item in objects if item.granularity is granularity]
            if not group:
                continue
            payload = _resolver_payload(group)
            response, body = await http.post_json(
                _RESOLVER_URL,
                payload,
                allowed_hosts=_RESOLVER_HOSTS,
                max_bytes=2 * 1024 * 1024,
            )
            if response.status != 200:
                raise ArchiveDataError(
                    f"OKX archive resolver returned HTTP {response.status}"
                )
            if not isinstance(body, dict) or str(body.get("code")) != "0":
                raise ArchiveCompatibilityError(
                    "OKX archive resolver response contract is incompatible"
                )
            downloads = _download_records(body)
            for ref in group:
                record = downloads.get(ref.expected_filename)
                if record is None:
                    continue
                url = str(record.get("url") or "").strip()
                if not _valid_download_url(url):
                    raise ArchiveCompatibilityError(
                        "OKX archive resolver returned a non-allowlisted URL"
                    )
                size_bytes = _size_bytes(record.get("sizeMB"))
                resolved.append(replace(
                    ref,
                    url=url,
                    size_bytes=size_bytes,
                    metadata={
                        **ref.metadata,
                        "resolver_export_time": (
                            body.get("data", {}).get("exportTime")
                            if isinstance(body.get("data"), dict)
                            else None
                        ),
                    },
                ))
        return resolved

    def parse_checksum(self, payload: bytes, ref: ArchiveObjectRef) -> str:
        del payload, ref
        raise ArchiveDataError("OKX K-line archives do not publish a checksum sidecar")

    def parse_bars(self, path: Path, ref: ArchiveObjectRef) -> list[ArchiveBar]:
        spec = parse_interval_spec(ref.interval)
        if spec is None or ref.interval != "1m":
            raise ArchiveDataError("OKX archive parser accepts 1m K-lines only")
        try:
            archive = zipfile.ZipFile(path)
        except (OSError, zipfile.BadZipFile) as exc:
            raise ArchiveDataError("OKX K-line ZIP is invalid") from exc
        bars: list[ArchiveBar] = []
        previous_open: int | None = None
        with archive:
            members = [item for item in archive.infolist() if not item.is_dir()]
            if len(members) != 1:
                raise ArchiveDataError("OKX K-line ZIP must contain one CSV")
            member = members[0]
            _validate_member(member, ref)
            try:
                with archive.open(member, "r") as binary:
                    import io

                    with io.TextIOWrapper(binary, encoding="utf-8-sig", newline="") as text:
                        reader = csv.reader(text)
                        header_seen = False
                        for line_number, fields in enumerate(reader, start=1):
                            if not fields or all(not value.strip() for value in fields):
                                continue
                            if not header_seen:
                                header = tuple(value.strip().lower() for value in fields)
                                if header != _HEADER:
                                    raise ArchiveCompatibilityError(
                                        "OKX K-line CSV header/schema is incompatible"
                                    )
                                header_seen = True
                                continue
                            bar = _parse_row(fields, ref, spec, line_number)
                            if previous_open is not None and bar.open_time <= previous_open:
                                raise ArchiveDataError(
                                    "OKX K-line timestamps are not strictly increasing"
                                )
                            previous_open = bar.open_time
                            bars.append(bar)
                            if len(bars) > _MAX_ROWS:
                                raise ArchiveDataError("OKX K-line archive has too many rows")
            except ArchiveDataError:
                raise
            except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
                raise ArchiveDataError("OKX K-line ZIP failed CRC/read validation") from exc
        if not bars:
            raise ArchiveDataError("OKX K-line archive is empty")
        return bars

    def _object(
        self,
        *,
        market_type: str,
        symbol: str,
        granularity: ArchiveGranularity,
        period: str,
        start: datetime,
        end: datetime,
    ) -> ArchiveObjectRef:
        filename = f"{symbol}-candlesticks-{period}.zip"
        return ArchiveObjectRef(
            provider_id=self.id,
            exchange="okx",
            market_type=market_type,
            symbol=symbol,
            interval="1m",
            granularity=granularity,
            period=period,
            start_ms=_ms(start),
            end_ms=_ms(end) - 1,
            expected_filename=filename,
            packaging_timezone="UTC+08:00",
            allowed_hosts=_DOWNLOAD_HOSTS,
        )


def _resolver_payload(objects: list[ArchiveObjectRef]) -> dict[str, Any]:
    first = min(objects, key=lambda item: item.start_ms)
    last = max(objects, key=lambda item: item.end_ms)
    inst_type = {
        "spot": "SPOT",
        "futures": "FUTURES",
        "swap": "SWAP",
    }[first.market_type]
    if first.market_type == "spot":
        instrument_query = {"instIdList": [first.symbol]}
    else:
        family = first.symbol.removesuffix("-SWAP")
        instrument_query = {"instFamilyList": [family]}
    return {
        "module": "2",
        "instType": inst_type,
        "instQueryParam": instrument_query,
        "dateQuery": {
            "dateAggrType": first.granularity.value,
            "begin": str(first.start_ms),
            "end": str(last.end_ms + 1),
        },
    }


def _download_records(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    data = payload.get("data")
    if not isinstance(data, dict):
        return {}
    records: dict[str, dict[str, Any]] = {}
    details = data.get("details")
    if not isinstance(details, list):
        return records
    for detail in details:
        if not isinstance(detail, dict):
            continue
        group = detail.get("groupDetails")
        if not isinstance(group, list):
            continue
        for raw in group:
            if not isinstance(raw, dict):
                continue
            filename = str(raw.get("filename") or "").strip()
            if filename:
                records[filename] = raw
    return records


def _valid_download_url(url: str) -> bool:
    parsed = urlparse(url)
    return (
        parsed.scheme == "https"
        and (parsed.hostname or "").lower() in _DOWNLOAD_HOSTS
        and parsed.path.startswith(_DOWNLOAD_PREFIX)
    )


def _size_bytes(value: object) -> int | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed <= 0:
        return None
    return int(parsed * 1024 * 1024)


def _validate_member(member: zipfile.ZipInfo, ref: ArchiveObjectRef) -> None:
    expected_csv = ref.expected_filename.removesuffix(".zip") + ".csv"
    if member.filename != expected_csv or Path(member.filename).name != member.filename:
        raise ArchiveDataError("OKX K-line ZIP member identity is invalid")
    if member.file_size <= 0 or member.file_size > _MAX_UNCOMPRESSED_BYTES:
        raise ArchiveDataError("OKX K-line CSV size is invalid")
    compressed = max(1, int(member.compress_size))
    if member.file_size / compressed > _MAX_COMPRESSION_RATIO:
        raise ArchiveDataError("OKX K-line ZIP compression ratio is unsafe")


def _parse_row(fields: list[str], ref: ArchiveObjectRef, spec, line_number: int) -> ArchiveBar:
    if len(fields) != 10:
        raise ArchiveCompatibilityError(
            f"OKX K-line CSV row {line_number} has the wrong schema"
        )
    if fields[0].strip().upper() != ref.symbol:
        raise ArchiveCompatibilityError(
            "OKX K-line instrument does not match archive request"
        )
    if fields[9].strip() != "1":
        raise ArchiveCompatibilityError(
            "OKX K-line archive contains an unconfirmed candle"
        )
    try:
        open_price = _positive_decimal(fields[1], "open")
        high = _positive_decimal(fields[2], "high")
        low = _positive_decimal(fields[3], "low")
        close = _positive_decimal(fields[4], "close")
        spot_volume = _non_negative_decimal(fields[5], "vol")
        base_volume = _non_negative_decimal(fields[6], "vol_ccy")
        quote_volume = _non_negative_decimal(fields[7], "vol_quote")
        open_time = _non_negative_integer(fields[8], "open_time")
    except ValueError as exc:
        raise ArchiveDataError(
            f"OKX K-line CSV row {line_number} is invalid: {exc}"
        ) from exc
    if not ref.start_ms <= open_time <= ref.end_ms:
        raise ArchiveDataError("OKX K-line timestamp is outside archive period")
    if spec.floor_ms(open_time) != open_time:
        raise ArchiveDataError("OKX K-line timestamp is not interval-aligned")
    if high < max(open_price, low, close) or low > min(open_price, high, close):
        raise ArchiveDataError("OKX K-line OHLC bounds are inconsistent")
    volume = spot_volume if ref.market_type == "spot" else base_volume
    return ArchiveBar(
        open_time=open_time,
        close_time=spec.next_ms(open_time) - 1,
        open=float(open_price),
        high=float(high),
        low=float(low),
        close=float(close),
        volume=float(volume),
        quote_volume=float(quote_volume),
        enhanced_fields=frozenset({"quote_volume"}),
        source="backfill_archive_confirmed",
    )


def _positive_decimal(value: str, label: str) -> Decimal:
    parsed = _decimal(value, label)
    if parsed <= 0:
        raise ValueError(f"{label} must be positive")
    return parsed


def _non_negative_decimal(value: str, label: str) -> Decimal:
    parsed = _decimal(value, label)
    if parsed < 0:
        raise ValueError(f"{label} must be non-negative")
    return parsed


def _decimal(value: str, label: str) -> Decimal:
    try:
        parsed = Decimal(value.strip())
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{label} must be decimal") from exc
    if not parsed.is_finite():
        raise ValueError(f"{label} must be finite")
    return parsed


def _non_negative_integer(value: str, label: str) -> int:
    normalized = value.strip()
    if not normalized.isdigit():
        raise ValueError(f"{label} must be a non-negative integer")
    return int(normalized)


def _market_type(value: str) -> str:
    normalized = str(value or "spot").strip().lower()
    return {"perpetual": "swap"}.get(normalized, normalized)


def _okx_datetime(timestamp_ms: int) -> datetime:
    return datetime.fromtimestamp(int(timestamp_ms) / 1_000, tz=_OKX_TZ)


def _day_floor(value: datetime) -> datetime:
    return value.replace(hour=0, minute=0, second=0, microsecond=0)


def _month_floor(value: datetime) -> datetime:
    return value.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _next_month(value: datetime) -> datetime:
    if value.month == 12:
        return value.replace(year=value.year + 1, month=1)
    return value.replace(month=value.month + 1)


def _ms(value: datetime) -> int:
    return int(value.timestamp() * 1_000)


__all__ = ["OkxKlineArchiveProvider"]
