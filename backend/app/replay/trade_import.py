"""Checksum-first Binance public aggregate-trade import boundary."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import shutil
import tempfile
import urllib.request
import zipfile
from collections.abc import Iterator
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import BinaryIO, Callable
from urllib.parse import urlparse
from uuid import uuid4

from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    VerifiedRawAggTradeDay,
)


BINANCE_PUBLIC_DATA_ORIGIN = "https://data.binance.vision"
_FUTURES_HEADER = (
    "agg_trade_id",
    "price",
    "quantity",
    "first_trade_id",
    "last_trade_id",
    "transact_time",
    "is_buyer_maker",
)
_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024


class ReplayTradeImportError(RuntimeError):
    """Official archive input failed validation and cannot be released."""


def official_agg_trade_urls(
    *,
    market_type: str,
    symbol: str,
    day: date,
) -> tuple[str, str, str]:
    normalized_market = market_type.strip().lower()
    normalized_symbol = symbol.strip().upper()
    if normalized_market != "futures":
        raise ReplayTradeImportError(
            "Phase 8 exact importer supports Binance USD-M futures only"
        )
    if not normalized_symbol or not normalized_symbol.isalnum():
        raise ReplayTradeImportError("symbol must be an alphanumeric Binance symbol")
    filename = f"{normalized_symbol}-aggTrades-{day.isoformat()}.zip"
    relative = (
        f"/data/futures/um/daily/aggTrades/{normalized_symbol}/{filename}"
    )
    url = f"{BINANCE_PUBLIC_DATA_ORIGIN}{relative}"
    return url, f"{url}.CHECKSUM", filename


def parse_official_checksum(payload: str, *, expected_filename: str) -> str:
    fields = payload.strip().split()
    if len(fields) != 2:
        raise ReplayTradeImportError("official CHECKSUM must contain digest and filename")
    digest = fields[0].lower()
    filename = fields[1].removeprefix("*")
    if filename != expected_filename:
        raise ReplayTradeImportError("official CHECKSUM filename does not match request")
    if len(digest) != 64 or any(value not in "0123456789abcdef" for value in digest):
        raise ReplayTradeImportError("official CHECKSUM digest is not SHA-256")
    return digest


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_verified_agg_trade_zip(
    zip_path: Path,
    *,
    source_url: str,
    source_checksum_sha256: str,
    exchange: str,
    market_type: str,
    symbol: str,
    day: date,
) -> VerifiedRawAggTradeDay:
    count = 0
    first_id: int | None = None
    last_id: int | None = None
    first_time: int | None = None
    last_time: int | None = None
    for row in iter_verified_agg_trade_rows(
        zip_path,
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        day=day,
    ):
        count += 1
        first_id = row["agg_trade_id"] if first_id is None else first_id
        last_id = row["agg_trade_id"]
        first_time = row["trade_time_ms"] if first_time is None else first_time
        last_time = row["trade_time_ms"]
    if None in {first_id, last_id, first_time, last_time}:
        raise ReplayTradeImportError("official aggTrade CSV is empty")
    assert first_id is not None and last_id is not None
    assert first_time is not None and last_time is not None
    return VerifiedRawAggTradeDay(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        date=day.isoformat(),
        source_url=source_url,
        source_file=zip_path.name,
        source_checksum_sha256=source_checksum_sha256,
        row_count=count,
        first_agg_trade_id=first_id,
        last_agg_trade_id=last_id,
        first_trade_time_ms=first_time,
        last_trade_time_ms=last_time,
    )


def iter_verified_agg_trade_rows(
    zip_path: Path,
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    day: date,
) -> Iterator[dict[str, object]]:
    normalized_exchange = exchange.strip().lower()
    normalized_market = market_type.strip().lower()
    normalized_symbol = symbol.strip().upper()
    expected_csv = f"{normalized_symbol}-aggTrades-{day.isoformat()}.csv"
    start_ms = int(datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc).timestamp() * 1000)
    end_ms = start_ms + 86_400_000
    previous_agg_id: int | None = None
    previous_trade_id: int | None = None
    previous_order: tuple[int, int] | None = None
    try:
        archive = zipfile.ZipFile(zip_path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise ReplayTradeImportError("official aggTrade ZIP is invalid") from exc
    with archive:
        members = [item for item in archive.infolist() if not item.is_dir()]
        if len(members) != 1:
            raise ReplayTradeImportError("official aggTrade ZIP must contain one CSV")
        member = members[0]
        if (
            member.filename != expected_csv
            or Path(member.filename).name != member.filename
            or member.file_size > _MAX_UNCOMPRESSED_BYTES
        ):
            raise ReplayTradeImportError(
                "official aggTrade ZIP member identity or size is invalid"
            )
        with archive.open(member, "r") as binary:
            import io

            with io.TextIOWrapper(binary, encoding="utf-8-sig", newline="") as text:
                reader = csv.reader(text)
                for line_number, fields in enumerate(reader, start=1):
                    if not fields or all(not value.strip() for value in fields):
                        continue
                    if line_number == 1 and not fields[0].strip().isdigit():
                        header = tuple(value.strip().lower() for value in fields)
                        if header != _FUTURES_HEADER:
                            raise ReplayTradeImportError(
                                "official aggTrade CSV header/schema is incompatible"
                            )
                        continue
                    if len(fields) != 7:
                        raise ReplayTradeImportError(
                            f"official aggTrade CSV row {line_number} has wrong schema"
                        )
                    try:
                        agg_trade_id = _non_negative_integer(fields[0], "agg_trade_id")
                        price = _positive_decimal(fields[1], "price")
                        quantity = _positive_decimal(fields[2], "quantity")
                        first_trade_id = _non_negative_integer(
                            fields[3], "first_trade_id"
                        )
                        last_trade_id = _non_negative_integer(
                            fields[4], "last_trade_id"
                        )
                        trade_time_ms = _non_negative_integer(
                            fields[5], "trade_time_ms"
                        )
                        is_buyer_maker = _boolean(fields[6])
                    except ValueError as exc:
                        raise ReplayTradeImportError(
                            f"official aggTrade CSV row {line_number} is invalid: {exc}"
                        ) from exc
                    if first_trade_id > last_trade_id:
                        raise ReplayTradeImportError(
                            "official aggTrade first_trade_id exceeds last_trade_id"
                        )
                    if not start_ms <= trade_time_ms < end_ms:
                        raise ReplayTradeImportError(
                            "official aggTrade timestamp does not match requested date"
                        )
                    if previous_agg_id is not None and agg_trade_id != previous_agg_id + 1:
                        raise ReplayTradeImportError(
                            "official aggTrade aggregate IDs are not contiguous"
                        )
                    if previous_trade_id is not None and first_trade_id <= previous_trade_id:
                        raise ReplayTradeImportError(
                            "official aggTrade first/last trade IDs overlap or move backward"
                        )
                    order = (trade_time_ms, agg_trade_id)
                    if previous_order is not None and order <= previous_order:
                        raise ReplayTradeImportError(
                            "official aggTrade timestamps/IDs are not strictly ordered"
                        )
                    previous_agg_id = agg_trade_id
                    previous_trade_id = last_trade_id
                    previous_order = order
                    yield {
                        "exchange": normalized_exchange,
                        "market_type": normalized_market,
                        "symbol": normalized_symbol,
                        "agg_trade_id": agg_trade_id,
                        "first_trade_id": first_trade_id,
                        "last_trade_id": last_trade_id,
                        "price": str(price),
                        "quantity": str(quantity),
                        "quote_quantity": str(price * quantity),
                        "trade_time_ms": trade_time_ms,
                        "event_time_ms": trade_time_ms,
                        "received_at_ms": trade_time_ms,
                        "is_buyer_maker": is_buyer_maker,
                        "source": "binance_public",
                    }


def import_local_verified_day(
    archive: ParquetRawAggTradeArchive,
    *,
    zip_path: Path,
    checksum_path: Path,
    source_url: str,
    exchange: str,
    market_type: str,
    symbol: str,
    day: date,
) -> tuple[int, VerifiedRawAggTradeDay]:
    expected_digest = parse_official_checksum(
        checksum_path.read_text(encoding="utf-8"),
        expected_filename=zip_path.name,
    )
    actual_digest = file_sha256(zip_path)
    if actual_digest != expected_digest:
        raise ReplayTradeImportError("official aggTrade ZIP checksum mismatch")
    metadata = inspect_verified_agg_trade_zip(
        zip_path,
        source_url=source_url,
        source_checksum_sha256=expected_digest,
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        day=day,
    )
    accepted = archive.import_verified_day(
        iter_verified_agg_trade_rows(
            zip_path,
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            day=day,
        ),
        metadata,
    )
    return accepted, metadata


def import_official_date_range(
    *,
    archive_dir: Path,
    exchange: str,
    market_type: str,
    symbol: str,
    start: date,
    end: date,
    require_checksum: bool,
    max_rows_per_file: int = 100_000,
    opener: Callable[..., BinaryIO] = urllib.request.urlopen,
) -> dict[str, object]:
    if exchange.strip().lower() != "binance":
        raise ReplayTradeImportError("only Binance official public data is accepted")
    if not require_checksum:
        raise ReplayTradeImportError(
            "--require-checksum is mandatory for exact replay imports"
        )
    if start > end:
        raise ReplayTradeImportError("start date cannot exceed end date")
    archive_dir = archive_dir.resolve()
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive = ParquetRawAggTradeArchive(
        archive_dir,
        max_rows_per_file=max_rows_per_file,
    )
    results: list[dict[str, object]] = []
    current = start
    while current <= end:
        source_url, checksum_url, filename = official_agg_trade_urls(
            market_type=market_type,
            symbol=symbol,
            day=current,
        )
        with tempfile.TemporaryDirectory(prefix="candlescope-aggtrade-") as raw_tmp:
            temporary = Path(raw_tmp)
            zip_path = temporary / filename
            checksum_path = temporary / f"{filename}.CHECKSUM"
            try:
                _download_official(source_url, zip_path, opener=opener)
                _download_official(checksum_url, checksum_path, opener=opener)
                accepted, metadata = import_local_verified_day(
                    archive,
                    zip_path=zip_path,
                    checksum_path=checksum_path,
                    source_url=source_url,
                    exchange=exchange,
                    market_type=market_type,
                    symbol=symbol,
                    day=current,
                )
            except BaseException as exc:
                _quarantine_downloads(
                    archive_dir,
                    files=(zip_path, checksum_path),
                    reason=str(exc),
                    identity={
                        "exchange": exchange,
                        "market_type": market_type,
                        "symbol": symbol,
                        "date": current.isoformat(),
                    },
                )
                raise
            results.append(
                {
                    "date": current.isoformat(),
                    "accepted_rows": accepted,
                    "row_count": metadata.row_count,
                    "first_agg_trade_id": metadata.first_agg_trade_id,
                    "last_agg_trade_id": metadata.last_agg_trade_id,
                    "source_checksum_sha256": metadata.source_checksum_sha256,
                    "idempotent": accepted == 0,
                }
            )
        current += timedelta(days=1)
    return {
        "schema_version": "replay-trade-import-report.v1",
        "exchange": exchange.strip().lower(),
        "market_type": market_type.strip().lower(),
        "symbol": symbol.strip().upper(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "require_checksum": True,
        "days": results,
    }


def _download_official(
    url: str,
    destination: Path,
    *,
    opener: Callable[..., BinaryIO],
) -> None:
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "data.binance.vision"
        or not parsed.path.startswith("/data/")
    ):
        raise ReplayTradeImportError("download URL is not Binance official public data")
    temporary = destination.with_name(f".{destination.name}.{uuid4().hex}.tmp")
    try:
        with opener(url, timeout=60) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        os.replace(temporary, destination)
    except BaseException as exc:
        raise ReplayTradeImportError(f"failed to download official object: {url}") from exc
    finally:
        temporary.unlink(missing_ok=True)


def _quarantine_downloads(
    archive_dir: Path,
    *,
    files: tuple[Path, ...],
    reason: str,
    identity: dict[str, object],
) -> None:
    quarantine = archive_dir / "_quarantine" / f"download-{uuid4().hex}"
    quarantine.mkdir(parents=True, exist_ok=False)
    moved: list[str] = []
    for path in files:
        if path.exists():
            destination = quarantine / path.name
            shutil.move(str(path), str(destination))
            moved.append(destination.name)
    (quarantine / "report.json").write_text(
        json.dumps(
            {
                "schema_version": "replay-trade-import-quarantine.v1",
                "state": "quarantined",
                "reason": reason[:1000],
                "identity": identity,
                "objects": moved,
            },
            separators=(",", ":"),
            sort_keys=True,
        ),
        encoding="utf-8",
    )


def _non_negative_integer(value: str, label: str) -> int:
    normalized = value.strip()
    if not normalized.isdigit():
        raise ValueError(f"{label} must be a non-negative integer")
    return int(normalized)


def _positive_decimal(value: str, label: str) -> Decimal:
    try:
        parsed = Decimal(value.strip())
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{label} must be a finite Decimal") from exc
    if not parsed.is_finite() or parsed <= 0:
        raise ValueError(f"{label} must be positive and finite")
    return parsed


def _boolean(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    raise ValueError("is_buyer_maker must be true or false")


__all__ = [
    "BINANCE_PUBLIC_DATA_ORIGIN",
    "ReplayTradeImportError",
    "file_sha256",
    "import_local_verified_day",
    "import_official_date_range",
    "inspect_verified_agg_trade_zip",
    "iter_verified_agg_trade_rows",
    "official_agg_trade_urls",
    "parse_official_checksum",
]
