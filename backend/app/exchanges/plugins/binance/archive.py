"""Binance Vision K-line archive provider."""
from __future__ import annotations

import csv
import math
import zipfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

from app.data_engine.interval_policy import parse_interval_spec
from app.exchanges.archive import (
    ArchiveBar,
    ArchiveCapabilities,
    ArchiveDataError,
    ArchiveGranularity,
    ArchiveHttpClient,
    ArchiveObjectRef,
)


_ORIGIN = "https://data.binance.vision"
_HOSTS = ("data.binance.vision",)
_EARLIEST = datetime(2017, 7, 1, tzinfo=timezone.utc)
_INTERVALS = (
    "1m",
    "3m",
    "5m",
    "15m",
    "30m",
    "1h",
    "2h",
    "4h",
    "6h",
    "8h",
    "12h",
    "1d",
    "3d",
    "1w",
    "1M",
)
_HEADER = (
    "open_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "close_time",
    "quote_volume",
    "count",
    "taker_buy_volume",
    "taker_buy_quote_volume",
    "ignore",
)
_MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
_MAX_COMPRESSION_RATIO = 200
_MAX_ROWS = 100_000


class BinanceKlineArchiveProvider:
    id = "binance-public-kline-v1"

    def capabilities(self, market_type: str) -> ArchiveCapabilities:
        normalized_market = str(market_type or "").strip().lower()
        return ArchiveCapabilities(
            provider_id=self.id,
            market_types=("spot", "futures"),
            intervals=_INTERVALS if normalized_market in {"spot", "futures"} else (),
            granularities=(ArchiveGranularity.MONTHLY, ArchiveGranularity.DAILY),
            packaging_timezone="UTC",
            rest_page_size=1_000,
            checksum_required=True,
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
        normalized_market = str(market_type or "").strip().lower()
        normalized_symbol = str(symbol or "").strip().upper()
        capabilities = self.capabilities(normalized_market)
        if (
            not capabilities.supports(
                market_type=normalized_market,
                interval=interval,
            )
            or not normalized_symbol.isalnum()
            or start_ms > end_ms
        ):
            return []

        start = _utc_datetime(start_ms)
        end = _utc_datetime(end_ms)
        if end < _EARLIEST:
            return []
        start = max(start, _EARLIEST)
        now = _utc_datetime(now_ms)
        current_day = _day_floor(now)
        current_month = _month_floor(now)

        monthly: list[ArchiveObjectRef] = []
        month = _month_floor(start)
        while month < current_month and month <= end:
            month_end = _next_month(month)
            if month_end - timedelta(milliseconds=1) >= start:
                monthly.append(self._object(
                    market_type=normalized_market,
                    symbol=normalized_symbol,
                    interval=interval,
                    granularity=ArchiveGranularity.MONTHLY,
                    period=month.strftime("%Y-%m"),
                    start=month,
                    end=month_end,
                ))
            month = month_end

        # Also expose full daily objects.  The source router chooses monthly
        # versus daily from the requested overlap and REST-page threshold;
        # returning both here is necessary for a small partial old month to
        # remain on REST instead of being forced into a whole-month download.
        daily: list[ArchiveObjectRef] = []
        day = _day_floor(start)
        if start > day:
            day += timedelta(days=1)
        while day < current_day:
            day_end = day + timedelta(days=1)
            if day_end - timedelta(milliseconds=1) > end:
                break
            daily.append(self._object(
                market_type=normalized_market,
                symbol=normalized_symbol,
                interval=interval,
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
        del http
        return list(objects)

    def parse_checksum(self, payload: bytes, ref: ArchiveObjectRef) -> str:
        try:
            text = payload.decode("utf-8-sig").strip()
        except UnicodeDecodeError as exc:
            raise ArchiveDataError("Binance CHECKSUM is not UTF-8") from exc
        fields = text.split()
        if len(fields) != 2:
            raise ArchiveDataError("Binance CHECKSUM must contain digest and filename")
        digest = fields[0].strip().lower()
        filename = fields[1].strip().removeprefix("*")
        if filename != ref.expected_filename:
            raise ArchiveDataError("Binance CHECKSUM filename does not match archive")
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ArchiveDataError("Binance CHECKSUM digest is not SHA-256")
        return digest

    def parse_bars(self, path: Path, ref: ArchiveObjectRef) -> list[ArchiveBar]:
        spec = parse_interval_spec(ref.interval)
        if spec is None:
            raise ArchiveDataError(f"Unsupported Binance archive interval: {ref.interval}")
        try:
            archive = zipfile.ZipFile(path)
        except (OSError, zipfile.BadZipFile) as exc:
            raise ArchiveDataError("Binance K-line ZIP is invalid") from exc

        bars: list[ArchiveBar] = []
        previous_open: int | None = None
        timestamp_unit: str | None = None
        with archive:
            members = [item for item in archive.infolist() if not item.is_dir()]
            if len(members) != 1:
                raise ArchiveDataError("Binance K-line ZIP must contain one CSV")
            member = members[0]
            _validate_member(member, ref)
            try:
                with archive.open(member, "r") as binary:
                    import io

                    with io.TextIOWrapper(binary, encoding="utf-8-sig", newline="") as text:
                        reader = csv.reader(text)
                        for line_number, fields in enumerate(reader, start=1):
                            if not fields or all(not value.strip() for value in fields):
                                continue
                            if line_number == 1 and not _looks_like_integer(fields[0]):
                                header = tuple(value.strip().lower() for value in fields)
                                if header != _HEADER:
                                    raise ArchiveDataError(
                                        "Binance K-line CSV header/schema is incompatible"
                                    )
                                continue
                            row_timestamp_unit = _timestamp_unit(fields[0], fields[6])
                            if ref.market_type == "futures" and row_timestamp_unit != "ms":
                                raise ArchiveDataError(
                                    "Binance Futures archive timestamps must be milliseconds"
                                )
                            if (
                                timestamp_unit is not None
                                and row_timestamp_unit != timestamp_unit
                            ):
                                raise ArchiveDataError(
                                    "Binance K-line archive mixes timestamp units"
                                )
                            timestamp_unit = row_timestamp_unit
                            bar = _parse_row(fields, ref, spec, line_number)
                            if previous_open is not None and bar.open_time <= previous_open:
                                raise ArchiveDataError(
                                    "Binance K-line timestamps are not strictly increasing"
                                )
                            previous_open = bar.open_time
                            bars.append(bar)
                            if len(bars) > _MAX_ROWS:
                                raise ArchiveDataError("Binance K-line archive has too many rows")
            except ArchiveDataError:
                raise
            except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
                raise ArchiveDataError("Binance K-line ZIP failed CRC/read validation") from exc
        if not bars:
            raise ArchiveDataError("Binance K-line archive is empty")
        return bars

    def _object(
        self,
        *,
        market_type: str,
        symbol: str,
        interval: str,
        granularity: ArchiveGranularity,
        period: str,
        start: datetime,
        end: datetime,
    ) -> ArchiveObjectRef:
        archive_interval = "1mo" if interval == "1M" else interval
        filename = f"{symbol}-{archive_interval}-{period}.zip"
        market_path = "spot" if market_type == "spot" else "futures/um"
        url = (
            f"{_ORIGIN}/data/{market_path}/{granularity.value}/klines/"
            f"{symbol}/{archive_interval}/{filename}"
        )
        return ArchiveObjectRef(
            provider_id=self.id,
            exchange="binance",
            market_type=market_type,
            symbol=symbol,
            interval=interval,
            granularity=granularity,
            period=period,
            start_ms=_ms(start),
            end_ms=_ms(end) - 1,
            expected_filename=filename,
            packaging_timezone="UTC",
            url=url,
            checksum_url=f"{url}.CHECKSUM",
            allowed_hosts=_HOSTS,
        )


def _validate_member(member: zipfile.ZipInfo, ref: ArchiveObjectRef) -> None:
    expected_csv = ref.expected_filename.removesuffix(".zip") + ".csv"
    if member.filename != expected_csv or Path(member.filename).name != member.filename:
        raise ArchiveDataError("Binance K-line ZIP member identity is invalid")
    if member.file_size <= 0 or member.file_size > _MAX_UNCOMPRESSED_BYTES:
        raise ArchiveDataError("Binance K-line CSV size is invalid")
    compressed = max(1, int(member.compress_size))
    if member.file_size / compressed > _MAX_COMPRESSION_RATIO:
        raise ArchiveDataError("Binance K-line ZIP compression ratio is unsafe")


def _parse_row(fields: list[str], ref: ArchiveObjectRef, spec, line_number: int) -> ArchiveBar:
    if len(fields) != 12:
        raise ArchiveDataError(
            f"Binance K-line CSV row {line_number} has the wrong schema"
        )
    try:
        open_time, close_time = _timestamps(fields[0], fields[6])
        open_price = _positive_decimal(fields[1], "open")
        high = _positive_decimal(fields[2], "high")
        low = _positive_decimal(fields[3], "low")
        close = _positive_decimal(fields[4], "close")
        volume = _non_negative_decimal(fields[5], "volume")
        quote_volume = _non_negative_decimal(fields[7], "quote_volume")
        trades = _non_negative_integer(fields[8], "trades")
        taker_base = _non_negative_decimal(fields[9], "taker_buy_base")
        taker_quote = _non_negative_decimal(fields[10], "taker_buy_quote")
    except ValueError as exc:
        raise ArchiveDataError(
            f"Binance K-line CSV row {line_number} is invalid: {exc}"
        ) from exc
    if not ref.start_ms <= open_time <= ref.end_ms:
        raise ArchiveDataError("Binance K-line timestamp is outside archive period")
    if spec.floor_ms(open_time) != open_time:
        raise ArchiveDataError("Binance K-line timestamp is not interval-aligned")
    if close_time != spec.next_ms(open_time) - 1:
        raise ArchiveDataError("Binance K-line close timestamp is inconsistent")
    if high < max(open_price, low, close) or low > min(open_price, high, close):
        raise ArchiveDataError("Binance K-line OHLC bounds are inconsistent")
    return ArchiveBar(
        open_time=open_time,
        close_time=close_time,
        open=float(open_price),
        high=float(high),
        low=float(low),
        close=float(close),
        volume=float(volume),
        quote_volume=float(quote_volume),
        trades=trades,
        taker_buy_base=float(taker_base),
        taker_buy_quote=float(taker_quote),
        enhanced_fields=frozenset({
            "quote_volume",
            "trades",
            "taker_buy_base",
            "taker_buy_quote",
        }),
        source="backfill_archive_verified",
    )


def _timestamps(open_value: str, close_value: str) -> tuple[int, int]:
    open_raw = _non_negative_integer(open_value, "open_time")
    close_raw = _non_negative_integer(close_value, "close_time")
    unit = _timestamp_unit_from_values(open_raw, close_raw)
    if unit == "us":
        return open_raw // 1_000, close_raw // 1_000
    return open_raw, close_raw


def _timestamp_unit(open_value: str, close_value: str) -> str:
    try:
        open_raw = _non_negative_integer(open_value, "open_time")
        close_raw = _non_negative_integer(close_value, "close_time")
        return _timestamp_unit_from_values(open_raw, close_raw)
    except ValueError as exc:
        raise ArchiveDataError(f"Binance K-line timestamp is invalid: {exc}") from exc


def _timestamp_unit_from_values(open_raw: int, close_raw: int) -> str:
    open_microseconds = open_raw >= 100_000_000_000_000
    close_microseconds = close_raw >= 100_000_000_000_000
    if open_microseconds != close_microseconds:
        raise ValueError("timestamp units are mixed")
    return "us" if open_microseconds else "ms"


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
    if not parsed.is_finite() or math.isinf(float(parsed)):
        raise ValueError(f"{label} must be finite")
    return parsed


def _non_negative_integer(value: str, label: str) -> int:
    normalized = value.strip()
    if not normalized.isdigit():
        raise ValueError(f"{label} must be a non-negative integer")
    return int(normalized)


def _looks_like_integer(value: str) -> bool:
    return value.strip().isdigit()


def _utc_datetime(timestamp_ms: int) -> datetime:
    return datetime.fromtimestamp(int(timestamp_ms) / 1_000, tz=timezone.utc)


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


__all__ = ["BinanceKlineArchiveProvider"]
