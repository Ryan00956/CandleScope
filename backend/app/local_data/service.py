"""Import, validate, publish, and query immutable local K-line datasets."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import sqlite3
import uuid
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Mapping
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.data_engine.interval_policy import (
    IntervalAlignment,
    IntervalSpec,
    parse_interval_spec,
)
from app.local_data.resampling import (
    LocalResamplePlan,
    LocalResamplingError,
    resolve_local_resample_plan,
)
from app.market_dataset.adapters.contract_aux import (
    load_contract_history,
    write_contract_history,
)
from app.market_dataset.snapshot import MarketDatasetError, canonical_json


DATASET_ID_RE = re.compile(r"^local-[0-9a-f]{32}$")
EPOCH_RE = re.compile(r"^[0-9a-f]{64}$")
SCHEMA_VERSION = 2
PROJECT_PACKAGE_SCHEMA_VERSION = 1
MAX_PROJECT_PACKAGE_ENTRIES = 2_000
MAX_PROJECT_PACKAGE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
MAX_PROJECT_CLIENT_STATE_BYTES = 32 * 1024 * 1024
MAX_PROJECT_MANIFEST_BYTES = 4 * 1024 * 1024

ProgressCallback = Callable[[str, int, int | None], None]
CancellationCheck = Callable[[], bool]


class LocalDatasetError(ValueError):
    def __init__(self, message: str, *, code: str = "invalid_dataset") -> None:
        super().__init__(message)
        self.code = code


COLUMN_ALIASES = {
    "time": ("time", "timestamp", "datetime", "date", "open_time", "open time", "t"),
    "open": ("open", "o", "Open"),
    "high": ("high", "h", "High"),
    "low": ("low", "l", "Low"),
    "close": ("close", "c", "Close"),
    "volume": ("volume", "vol", "Volume", "qty"),
}


@dataclass(frozen=True, slots=True)
class LocalImportOptions:
    name: str
    symbol: str
    interval: str
    timezone_name: str = "UTC"
    timestamp_unit: str = "auto"
    time_column: str = "time"
    open_column: str = "open"
    high_column: str = "high"
    low_column: str = "low"
    close_column: str = "close"
    volume_column: str = "volume"
    volume_required: bool = False
    quote_volume_column: str | None = None
    trades_column: str | None = None
    taker_buy_base_column: str | None = None
    taker_buy_quote_column: str | None = None
    last_bar_closed: bool = True
    dataset_id: str | None = None


@dataclass(frozen=True, slots=True)
class _NormalizedBar:
    open_time_ms: int
    close_time_ms: int
    open: str
    high: str
    low: str
    close: str
    volume: str | None
    quote_volume: str | None
    trades: int | None
    taker_buy_base: str | None
    taker_buy_quote: str | None
    is_closed: bool
    source_row: int


class LocalDatasetService:
    def __init__(self, root: Path) -> None:
        self.root = Path(root).resolve()

    def start(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / ".staging").mkdir(exist_ok=True)
        (self.root / ".uploads").mkdir(exist_ok=True)
        (self.root / ".exports").mkdir(exist_ok=True)
        (self.root / ".trash").mkdir(exist_ok=True)
        (self.root / ".cache").mkdir(exist_ok=True)

    def new_upload_path(self) -> Path:
        self.start()
        return self.root / ".uploads" / f"{uuid.uuid4().hex}.csv"

    def import_csv(
        self,
        csv_path: Path,
        options: LocalImportOptions,
        *,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
    ) -> dict[str, Any]:
        self.start()
        self._raise_if_cancelled(cancelled)
        self._report_progress(progress, "validating", 0, None)
        interval = parse_interval_spec(options.interval)
        if interval is None:
            raise LocalDatasetError(f"Unsupported interval: {options.interval}")
        dataset_id = options.dataset_id or f"local-{uuid.uuid4().hex}"
        if DATASET_ID_RE.fullmatch(dataset_id) is None:
            raise LocalDatasetError("dataset_id must match local-<32 lowercase hex>")
        name = options.name.strip()
        symbol = options.symbol.strip().upper()
        if not name:
            raise LocalDatasetError("Dataset name is required")
        if not symbol:
            raise LocalDatasetError("Symbol is required")
        if options.dataset_id is not None and (self.root / dataset_id).exists():
            current = self.get_manifest(dataset_id)
            if current["symbol"] != symbol or current["interval"] != interval.canonical:
                raise LocalDatasetError(
                    "A new revision must keep the dataset symbol and interval",
                    code="dataset_identity_mismatch",
                )

        staging = self.root / ".staging" / f"{dataset_id}-{uuid.uuid4().hex}"
        staging.mkdir(parents=True)
        try:
            bars, excluded_ranges, resolved_columns = self._parse_csv(
                csv_path,
                options,
                interval,
                progress=progress,
                cancelled=cancelled,
            )
            self._raise_if_cancelled(cancelled)
            self._report_progress(progress, "building_revision", len(bars), len(bars))
            epoch_hex = self._content_epoch(symbol, interval, bars, excluded_ranges)
            manifest = self._write_staging_dataset(
                staging,
                dataset_id=dataset_id,
                epoch_hex=epoch_hex,
                name=name,
                symbol=symbol,
                interval=interval,
                options=options,
                bars=bars,
                excluded_ranges=excluded_ranges,
                resolved_columns=resolved_columns,
            )
            self._raise_if_cancelled(cancelled)
            published = self._publish(staging, dataset_id, epoch_hex, manifest)
            staging = None
            self._report_progress(progress, "completed", len(bars), len(bars))
            return published
        finally:
            if staging is not None and staging.exists():
                shutil.rmtree(staging)

    def import_parquet(
        self,
        parquet_path: Path,
        options: LocalImportOptions,
        *,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
    ) -> dict[str, Any]:
        """Stream a local Parquet/Arrow table into the immutable CSV importer."""
        self.start()
        try:
            import pyarrow.parquet as pq
        except ImportError as exc:
            raise LocalDatasetError(
                "Parquet/Arrow import requires a local pyarrow install",
                code="FIDELITY_UNSUPPORTED",
            ) from exc
        self._raise_if_cancelled(cancelled)
        staging_csv = self.root / ".uploads" / f"{uuid.uuid4().hex}.csv"
        try:
            table_file = pq.ParquetFile(parquet_path)
            wrote_header = False
            with staging_csv.open("w", encoding="utf-8", newline="") as handle:
                writer: csv.DictWriter[str] | None = None
                for batch in table_file.iter_batches(batch_size=8_192):
                    self._raise_if_cancelled(cancelled)
                    frame = batch.to_pydict()
                    if not frame:
                        continue
                    length = len(next(iter(frame.values())))
                    if writer is None:
                        writer = csv.DictWriter(handle, fieldnames=list(frame))
                        writer.writeheader()
                        wrote_header = True
                    for index in range(length):
                        writer.writerow(
                            {key: "" if values[index] is None else values[index] for key, values in frame.items()}
                        )
            if not wrote_header:
                raise LocalDatasetError("Parquet table contains no rows")
            return self.import_csv(
                staging_csv, options, progress=progress, cancelled=cancelled
            )
        finally:
            staging_csv.unlink(missing_ok=True)

    def catalog_entry(self, dataset_id: str) -> dict[str, Any]:
        manifest = self.get_manifest(dataset_id)
        quality_path = self._revision_dir(dataset_id) / "quality-report.json"
        quality = {}
        if quality_path.is_file():
            try:
                quality = json.loads(quality_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                quality = {}
        return {
            "dataset_id": manifest["dataset_id"],
            "source": manifest.get("source") or "local_dataset",
            "checksum": manifest.get("sqlite_sha256") or manifest["data_epoch"],
            "coverage": {
                "rows": manifest.get("rows"),
                "first_open_ms": manifest.get("first_open_ms"),
                "last_open_ms": manifest.get("last_open_ms"),
                "interval": manifest.get("interval"),
                "timezone": manifest.get("timezone"),
            },
            "gap": {
                "excluded_range_count": manifest.get("excluded_range_count", 0),
                "status": quality.get("status") or "unknown",
            },
            "revision": manifest["data_epoch"],
            "symbol": manifest.get("symbol"),
            "name": manifest.get("name"),
        }

    def import_contract_history(
        self,
        bundle_path: Path,
        *,
        dataset_id: str,
        data_epoch: str,
    ) -> dict[str, Any]:
        """Attach verified contract history as a new immutable dataset revision."""
        self.start()
        current, source_revision = self._validated_revision_dir(dataset_id, data_epoch)
        try:
            descriptor = load_contract_history(Path(bundle_path))
        except MarketDatasetError as exc:
            raise LocalDatasetError(str(exc), code=exc.code) from exc
        if descriptor.identity["symbol"] != current["symbol"]:
            raise LocalDatasetError(
                "Contract history symbol does not match the dataset",
                code="dataset_identity_mismatch",
            )
        epoch_hex = hashlib.sha256(
            canonical_json(
                {
                    "schema_version": "candlescope.local.contract-revision.v1",
                    "parent_data_epoch": data_epoch,
                    "contract_bundle_hash": descriptor.bundle_hash,
                }
            ).encode("utf-8")
        ).hexdigest()
        staging: Path | None = (
            self.root / ".staging" / f"{dataset_id}-contract-{uuid.uuid4().hex}"
        )
        try:
            shutil.copytree(source_revision, staging)
            for name in ("contract-history.json", "contract-history.manifest.json"):
                (staging / name).unlink(missing_ok=True)
            temporary_bundle = staging / ".contract-history"
            write_contract_history(descriptor, temporary_bundle)
            for name in ("contract-history.json", "contract-history.manifest.json"):
                os.replace(temporary_bundle / name, staging / name)
            temporary_bundle.rmdir()
            manifest = json.loads(
                (staging / "manifest.json").read_text(encoding="utf-8")
            )
            manifest.update(
                {
                    "data_epoch": f"sha256:{epoch_hex}",
                    "parent_data_epoch": data_epoch,
                    "contract_history": {
                        "schema_version": descriptor.manifest["schema_version"],
                        "bundle_hash": descriptor.bundle_hash,
                        "role_hashes": dict(descriptor.role_hashes),
                        "roles": list(descriptor.role_hashes),
                    },
                    "imported_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            self._write_json(staging / "manifest.json", manifest)
            quality = json.loads(
                (staging / "quality-report.json").read_text(encoding="utf-8")
            )
            quality["contract_history"] = descriptor.manifest
            self._write_json(staging / "quality-report.json", quality)
            receipt = json.loads(
                (staging / "import-receipt.json").read_text(encoding="utf-8")
            )
            receipt["contract_history"] = {
                "importer": "candlescope.contract-history.v1",
                "source_path": str(Path(bundle_path).resolve()),
                "bundle_hash": descriptor.bundle_hash,
            }
            self._write_json(staging / "import-receipt.json", receipt)
            published = self._publish(staging, dataset_id, epoch_hex, manifest)
            staging = None
            return published
        except MarketDatasetError as exc:
            raise LocalDatasetError(str(exc), code=exc.code) from exc
        finally:
            if staging is not None and staging.exists():
                shutil.rmtree(staging)

    def _parse_csv(
        self,
        csv_path: Path,
        options: LocalImportOptions,
        interval: IntervalSpec,
        *,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
    ) -> tuple[
        list[_NormalizedBar],
        list[dict[str, Any]],
        dict[str, str | None],
    ]:
        required = {
            "time": options.time_column,
            "open": options.open_column,
            "high": options.high_column,
            "low": options.low_column,
            "close": options.close_column,
        }
        optional = {
            "quote_volume": options.quote_volume_column,
            "trades": options.trades_column,
            "taker_buy_base": options.taker_buy_base_column,
            "taker_buy_quote": options.taker_buy_quote_column,
        }
        bars: list[_NormalizedBar] = []
        gaps: list[dict[str, Any]] = []
        try:
            timezone_info = ZoneInfo(options.timezone_name)
        except ZoneInfoNotFoundError as exc:
            raise LocalDatasetError(
                f"Unknown timezone: {options.timezone_name}"
            ) from exc

        with Path(csv_path).open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None:
                raise LocalDatasetError("CSV must contain a header row")
            resolved_columns = self._resolve_columns(
                reader.fieldnames,
                {
                    **required,
                    "volume": options.volume_column,
                    **{key: column for key, column in optional.items() if column},
                },
                optional_missing=set() if options.volume_required else {"volume"},
            )
            required = {key: resolved_columns[key] for key in required}
            optional = {key: resolved_columns.get(key) for key in optional}

            previous_open: int | None = None
            fixed_alignment_offset_ms: int | None = None
            for source_row, row in enumerate(reader, start=2):
                if source_row % 1_000 == 0:
                    self._raise_if_cancelled(cancelled)
                    self._report_progress(progress, "parsing", source_row - 2, None)
                if not any((value or "").strip() for value in row.values()):
                    continue
                open_ms = self._parse_time(
                    row.get(required["time"], ""),
                    options.timestamp_unit,
                    timezone_info,
                    source_row,
                )
                if interval.alignment is IntervalAlignment.FIXED_EPOCH:
                    row_offset_ms = open_ms % interval.nominal_ms
                    if fixed_alignment_offset_ms is None:
                        fixed_alignment_offset_ms = row_offset_ms
                    elif row_offset_ms != fixed_alignment_offset_ms:
                        raise LocalDatasetError(
                            f"Row {source_row}: timestamp phase does not match "
                            f"the first {interval.canonical} bar"
                        )
                elif interval.floor_ms(open_ms) != open_ms:
                    raise LocalDatasetError(
                        f"Row {source_row}: timestamp is not aligned to {interval.canonical}"
                    )
                if previous_open is not None and open_ms <= previous_open:
                    relation = (
                        "duplicate" if open_ms == previous_open else "out of order"
                    )
                    raise LocalDatasetError(f"Row {source_row}: {relation} timestamp")

                values = {
                    key: self._parse_decimal(row.get(column, ""), key, source_row)
                    for key, column in required.items()
                    if key != "time"
                }
                volume_column = resolved_columns["volume"]
                volume = (
                    self._parse_decimal(
                        row.get(volume_column, ""), "volume", source_row
                    )
                    if volume_column is not None
                    else None
                )
                if values["high"] < max(values["open"], values["close"]):
                    raise LocalDatasetError(
                        f"Row {source_row}: high is below open or close"
                    )
                if values["low"] > min(values["open"], values["close"]):
                    raise LocalDatasetError(
                        f"Row {source_row}: low is above open or close"
                    )
                if values["low"] > values["high"]:
                    raise LocalDatasetError(f"Row {source_row}: low exceeds high")
                if volume is not None and volume < 0:
                    raise LocalDatasetError(
                        f"Row {source_row}: volume must be non-negative"
                    )

                parsed_optional: dict[str, Any] = {}
                for key, column in optional.items():
                    raw = (row.get(column, "") if column else "").strip()
                    if not raw:
                        parsed_optional[key] = None
                    elif key == "trades":
                        try:
                            parsed_optional[key] = int(raw)
                        except ValueError as exc:
                            raise LocalDatasetError(
                                f"Row {source_row}: trades must be an integer"
                            ) from exc
                        if parsed_optional[key] < 0:
                            raise LocalDatasetError(
                                f"Row {source_row}: trades must be non-negative"
                            )
                    else:
                        parsed_optional[key] = self._parse_decimal(raw, key, source_row)
                        if parsed_optional[key] < 0:
                            raise LocalDatasetError(
                                f"Row {source_row}: {key} must be non-negative"
                            )

                if previous_open is not None:
                    expected = interval.next_ms(previous_open)
                    if open_ms != expected:
                        gaps.append(
                            {
                                "start_ms": expected,
                                "end_ms": open_ms,
                                "reason": "source_gap",
                                "missing_bars": self._count_missing(
                                    interval, expected, open_ms
                                ),
                            }
                        )
                bars.append(
                    _NormalizedBar(
                        open_time_ms=open_ms,
                        close_time_ms=interval.next_ms(open_ms) - 1,
                        open=self._decimal_text(values["open"]),
                        high=self._decimal_text(values["high"]),
                        low=self._decimal_text(values["low"]),
                        close=self._decimal_text(values["close"]),
                        volume=(
                            self._decimal_text(volume) if volume is not None else None
                        ),
                        quote_volume=self._optional_decimal_text(
                            parsed_optional["quote_volume"]
                        ),
                        trades=parsed_optional["trades"],
                        taker_buy_base=self._optional_decimal_text(
                            parsed_optional["taker_buy_base"]
                        ),
                        taker_buy_quote=self._optional_decimal_text(
                            parsed_optional["taker_buy_quote"]
                        ),
                        is_closed=True,
                        source_row=source_row,
                    )
                )
                previous_open = open_ms

        if not bars:
            raise LocalDatasetError("CSV contains no data rows")
        if not options.last_bar_closed:
            last = bars[-1]
            bars[-1] = _NormalizedBar(**{**asdict(last), "is_closed": False})
        return bars, gaps, resolved_columns

    @staticmethod
    def _report_progress(
        callback: ProgressCallback | None,
        stage: str,
        processed: int,
        total: int | None,
    ) -> None:
        if callback is not None:
            callback(stage, processed, total)

    @staticmethod
    def _raise_if_cancelled(cancelled: CancellationCheck | None) -> None:
        if cancelled is not None and cancelled():
            raise LocalDatasetError("Import cancelled", code="job_cancelled")

    @staticmethod
    def _resolve_columns(
        fieldnames: list[str],
        configured: dict[str, str],
        *,
        optional_missing: set[str] | None = None,
    ) -> dict[str, str | None]:
        optional_missing = optional_missing or set()
        folded: dict[str, list[str]] = {}
        for fieldname in fieldnames:
            folded.setdefault(fieldname.strip().casefold(), []).append(fieldname)

        resolved: dict[str, str | None] = {}
        missing: list[str] = []
        for logical_name, requested in configured.items():
            if requested in fieldnames:
                resolved[logical_name] = requested
                continue
            matches = folded.get(requested.strip().casefold(), [])
            if len(matches) == 1:
                resolved[logical_name] = matches[0]
            elif len(matches) > 1:
                raise LocalDatasetError(
                    f"CSV column is ambiguous ignoring case: {requested}"
                )
            elif logical_name in optional_missing:
                resolved[logical_name] = None
            else:
                alias_hit: str | None = None
                for alias in COLUMN_ALIASES.get(logical_name, ()):
                    matches = folded.get(alias.casefold(), [])
                    if len(matches) == 1:
                        alias_hit = matches[0]
                        break
                    if len(matches) > 1:
                        raise LocalDatasetError(
                            f"CSV column is ambiguous ignoring case: {alias}"
                        )
                if alias_hit is not None:
                    resolved[logical_name] = alias_hit
                else:
                    missing.append(requested)

        if missing:
            raise LocalDatasetError(
                f"CSV columns not found: {', '.join(sorted(set(missing)))}"
            )
        return resolved

    @staticmethod
    def _parse_decimal(raw: str | None, field: str, row: int) -> Decimal:
        try:
            value = Decimal((raw or "").strip())
        except (InvalidOperation, ValueError) as exc:
            raise LocalDatasetError(f"Row {row}: {field} is not a number") from exc
        if not value.is_finite():
            raise LocalDatasetError(f"Row {row}: {field} must be finite")
        return value

    @staticmethod
    def _decimal_text(value: Decimal) -> str:
        normalized = value.normalize()
        text = format(normalized, "f")
        return "0" if text in {"-0", ""} else text

    @classmethod
    def _optional_decimal_text(cls, value: Decimal | None) -> str | None:
        return None if value is None else cls._decimal_text(value)

    @staticmethod
    def _parse_time(raw: str, unit: str, timezone_info: ZoneInfo, row: int) -> int:
        value = raw.strip()
        normalized_unit = unit.strip().lower()
        if normalized_unit not in {"auto", "s", "ms", "iso"}:
            raise LocalDatasetError("timestamp_unit must be auto, s, ms, or iso")
        try:
            if normalized_unit == "iso" or (
                normalized_unit == "auto"
                and not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", value)
            ):
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone_info)
                return int(parsed.timestamp() * 1000)
            number = Decimal(value)
            if not number.is_finite():
                raise ValueError
            if normalized_unit == "auto":
                normalized_unit = (
                    "ms" if abs(number) >= Decimal("100000000000") else "s"
                )
            multiplier = 1000 if normalized_unit == "s" else 1
            milliseconds = number * multiplier
            if milliseconds != milliseconds.to_integral_value():
                raise ValueError
            return int(milliseconds)
        except (ValueError, InvalidOperation, OverflowError) as exc:
            raise LocalDatasetError(f"Row {row}: invalid timestamp {value!r}") from exc

    @staticmethod
    def _count_missing(interval: IntervalSpec, expected: int, current: int) -> int:
        if current <= expected:
            return 0
        if interval.alignment.value != "calendar_month":
            return max(0, (current - expected) // interval.nominal_ms)
        count = 0
        cursor = expected
        while cursor < current:
            count += 1
            cursor = interval.next_ms(cursor)
        return count

    @staticmethod
    def _content_epoch(
        symbol: str,
        interval: IntervalSpec,
        bars: Iterable[_NormalizedBar],
        gaps: list[dict[str, Any]],
    ) -> str:
        digest = hashlib.sha256()
        identity = {
            "schema_version": SCHEMA_VERSION,
            "symbol": symbol,
            "interval": interval.canonical,
            "alignment": interval.alignment.value,
        }
        digest.update(
            json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
        )
        for bar in bars:
            digest.update(b"\n")
            digest.update(
                json.dumps(asdict(bar), sort_keys=True, separators=(",", ":")).encode()
            )
        digest.update(b"\n")
        digest.update(json.dumps(gaps, sort_keys=True, separators=(",", ":")).encode())
        return digest.hexdigest()

    def _write_staging_dataset(
        self,
        staging: Path,
        *,
        dataset_id: str,
        epoch_hex: str,
        name: str,
        symbol: str,
        interval: IntervalSpec,
        options: LocalImportOptions,
        bars: list[_NormalizedBar],
        excluded_ranges: list[dict[str, Any]],
        resolved_columns: dict[str, str | None],
    ) -> dict[str, Any]:
        db_path = staging / "bars.sqlite"
        connection = sqlite3.connect(db_path)
        try:
            connection.executescript(
                """
                PRAGMA journal_mode=DELETE;
                PRAGMA synchronous=FULL;
                CREATE TABLE bars (
                    open_time_ms INTEGER PRIMARY KEY,
                    close_time_ms INTEGER NOT NULL,
                    open TEXT NOT NULL,
                    high TEXT NOT NULL,
                    low TEXT NOT NULL,
                    close TEXT NOT NULL,
                    volume TEXT,
                    quote_volume TEXT,
                    trades INTEGER,
                    taker_buy_base TEXT,
                    taker_buy_quote TEXT,
                    is_closed INTEGER NOT NULL,
                    source_row INTEGER NOT NULL
                );
                CREATE TABLE excluded_ranges (
                    start_ms INTEGER NOT NULL,
                    end_ms INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    missing_bars INTEGER NOT NULL
                );
                """
            )
            connection.executemany(
                """
                INSERT INTO bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        bar.open_time_ms,
                        bar.close_time_ms,
                        bar.open,
                        bar.high,
                        bar.low,
                        bar.close,
                        bar.volume,
                        bar.quote_volume,
                        bar.trades,
                        bar.taker_buy_base,
                        bar.taker_buy_quote,
                        int(bar.is_closed),
                        bar.source_row,
                    )
                    for bar in bars
                ],
            )
            connection.executemany(
                "INSERT INTO excluded_ranges VALUES (?, ?, ?, ?)",
                [
                    (gap["start_ms"], gap["end_ms"], gap["reason"], gap["missing_bars"])
                    for gap in excluded_ranges
                ],
            )
            check = connection.execute("PRAGMA quick_check").fetchone()
            if not check or check[0] != "ok":
                raise LocalDatasetError("SQLite integrity validation failed")
            connection.commit()
        finally:
            connection.close()

        sqlite_sha256 = self._file_sha256(db_path)
        now = datetime.now(timezone.utc).isoformat()
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "dataset_id": dataset_id,
            "data_epoch": f"sha256:{epoch_hex}",
            "name": name,
            "source": "local_dataset",
            "symbol": symbol,
            "interval": interval.canonical,
            "volume_available": resolved_columns["volume"] is not None,
            "alignment": interval.alignment.value,
            "alignment_offset_ms": (
                bars[0].open_time_ms % interval.nominal_ms
                if interval.alignment is IntervalAlignment.FIXED_EPOCH
                else 0
            ),
            "timezone": options.timezone_name,
            "timestamp_semantics": "bar_open",
            "rows": len(bars),
            "first_open_ms": bars[0].open_time_ms,
            "last_open_ms": bars[-1].open_time_ms,
            "all_rows_final": all(bar.is_closed for bar in bars),
            "excluded_range_count": len(excluded_ranges),
            "sqlite_sha256": sqlite_sha256,
            "imported_at": now,
        }
        quality = {
            "status": "accepted_with_gaps" if excluded_ranges else "accepted",
            "rows": len(bars),
            "excluded_ranges": excluded_ranges,
            "duplicates": 0,
            "out_of_order": 0,
            "invalid_rows": 0,
            "volume_available": resolved_columns["volume"] is not None,
            "missing_volume_rows": (
                0 if resolved_columns["volume"] is not None else len(bars)
            ),
        }
        receipt = {
            "importer": "candlescope.local.csv.v1",
            "imported_at": now,
            "columns": {
                f"{key}_column": value
                for key, value in resolved_columns.items()
                if value
            },
            "timestamp_unit": options.timestamp_unit,
            "timezone": options.timezone_name,
            "volume_required": options.volume_required,
        }
        self._write_json(staging / "manifest.json", manifest)
        self._write_json(staging / "quality-report.json", quality)
        self._write_json(staging / "import-receipt.json", receipt)
        return manifest

    def _publish(
        self,
        staging: Path,
        dataset_id: str,
        epoch_hex: str,
        manifest: dict[str, Any],
    ) -> dict[str, Any]:
        dataset_root = self.root / dataset_id
        dataset_root.mkdir(exist_ok=True)
        target = dataset_root / epoch_hex
        if target.exists():
            shutil.rmtree(staging)
        else:
            os.replace(staging, target)
        self._write_json(
            dataset_root / "current.json",
            {"data_epoch": manifest["data_epoch"], "revision": epoch_hex},
        )
        metadata_path = dataset_root / "library.json"
        if not metadata_path.exists():
            self._write_json(
                metadata_path,
                {
                    "name": manifest["name"],
                    "archived": False,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
            )
        return self.get_manifest(dataset_id)

    @staticmethod
    def _write_json(path: Path, payload: dict[str, Any]) -> None:
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)

    @staticmethod
    def _file_sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def read_analysis_cache(
        self,
        dataset_id: str,
        *,
        data_epoch: str,
        cache_key: str,
    ) -> dict[str, Any] | None:
        self._validated_revision_dir(dataset_id, data_epoch)
        if re.fullmatch(r"[0-9a-f]{64}", cache_key) is None:
            raise ValueError("cache_key must be a SHA-256 hex digest")
        path = (
            self.root
            / ".cache"
            / dataset_id
            / data_epoch.removeprefix("sha256:")
            / f"{cache_key}.json"
        )
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError):
            path.unlink(missing_ok=True)
            return None
        return payload if isinstance(payload, dict) else None

    def write_analysis_cache(
        self,
        dataset_id: str,
        *,
        data_epoch: str,
        cache_key: str,
        payload: dict[str, Any],
    ) -> None:
        self._validated_revision_dir(dataset_id, data_epoch)
        directory = (
            self.root / ".cache" / dataset_id / data_epoch.removeprefix("sha256:")
        )
        directory.mkdir(parents=True, exist_ok=True)
        self._write_json(directory / f"{cache_key}.json", payload)

    def list_datasets(self, *, include_archived: bool = False) -> list[dict[str, Any]]:
        if not self.root.exists():
            return []
        manifests = []
        for candidate in sorted(self.root.iterdir()):
            if candidate.is_dir() and DATASET_ID_RE.fullmatch(candidate.name):
                try:
                    manifest = self.get_manifest(candidate.name)
                    if include_archived or not manifest["archived"]:
                        manifests.append(manifest)
                except LocalDatasetError:
                    continue
        return sorted(manifests, key=lambda item: item["imported_at"], reverse=True)

    def _revision_dir(self, dataset_id: str) -> Path:
        if DATASET_ID_RE.fullmatch(dataset_id) is None:
            raise LocalDatasetError("Invalid dataset id", code="dataset_not_found")
        current_path = self.root / dataset_id / "current.json"
        try:
            current = json.loads(current_path.read_text(encoding="utf-8"))
            revision = current["revision"]
        except (OSError, KeyError, json.JSONDecodeError) as exc:
            raise LocalDatasetError(
                "Dataset not found", code="dataset_not_found"
            ) from exc
        if not isinstance(revision, str) or EPOCH_RE.fullmatch(revision) is None:
            raise LocalDatasetError("Invalid dataset revision", code="dataset_corrupt")
        path = self.root / dataset_id / revision
        if not path.is_dir():
            raise LocalDatasetError(
                "Dataset revision not found", code="dataset_corrupt"
            )
        return path

    def get_manifest(self, dataset_id: str) -> dict[str, Any]:
        try:
            manifest = json.loads(
                (self._revision_dir(dataset_id) / "manifest.json").read_text(
                    encoding="utf-8"
                )
            )
        except (OSError, json.JSONDecodeError) as exc:
            raise LocalDatasetError(
                "Dataset manifest is unreadable", code="dataset_corrupt"
            ) from exc
        manifest.setdefault("volume_available", True)
        metadata = self._read_library_metadata(dataset_id, manifest)
        manifest["name"] = metadata["name"]
        manifest["archived"] = metadata["archived"]
        manifest["revision_count"] = len(self.list_revisions(dataset_id))
        return manifest

    def _read_library_metadata(
        self,
        dataset_id: str,
        manifest: dict[str, Any],
    ) -> dict[str, Any]:
        path = self.root / dataset_id / "library.json"
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"name": manifest["name"], "archived": False}
        except (OSError, json.JSONDecodeError) as exc:
            raise LocalDatasetError(
                "Dataset library metadata is unreadable", code="dataset_corrupt"
            ) from exc
        name = payload.get("name")
        archived = payload.get("archived", False)
        if (
            not isinstance(name, str)
            or not name.strip()
            or not isinstance(archived, bool)
        ):
            raise LocalDatasetError(
                "Dataset library metadata is invalid", code="dataset_corrupt"
            )
        return {"name": name.strip(), "archived": archived}

    def update_library_metadata(
        self,
        dataset_id: str,
        *,
        name: str | None = None,
        archived: bool | None = None,
    ) -> dict[str, Any]:
        manifest = self.get_manifest(dataset_id)
        current = self._read_library_metadata(dataset_id, manifest)
        if name is not None:
            name = name.strip()
            if not name:
                raise LocalDatasetError("Dataset name is required")
            current["name"] = name
        if archived is not None:
            current["archived"] = bool(archived)
        current["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._write_json(self.root / dataset_id / "library.json", current)
        return self.get_manifest(dataset_id)

    def trash_dataset(self, dataset_id: str) -> dict[str, Any]:
        manifest = self.get_manifest(dataset_id)
        trash_id = f"trash-{uuid.uuid4().hex}"
        trash_root = self.root / ".trash" / trash_id
        trash_root.mkdir(parents=True)
        self._write_json(
            trash_root / "entry.json",
            {
                "trash_id": trash_id,
                "dataset_id": dataset_id,
                "name": manifest["name"],
                "deleted_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        os.replace(self.root / dataset_id, trash_root / dataset_id)
        return json.loads((trash_root / "entry.json").read_text(encoding="utf-8"))

    def list_trash(self) -> list[dict[str, Any]]:
        self.start()
        entries: list[dict[str, Any]] = []
        for candidate in (self.root / ".trash").iterdir():
            try:
                payload = json.loads(
                    (candidate / "entry.json").read_text(encoding="utf-8")
                )
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict):
                entries.append(payload)
        return sorted(
            entries, key=lambda item: str(item.get("deleted_at", "")), reverse=True
        )

    def restore_trash(self, trash_id: str) -> dict[str, Any]:
        if re.fullmatch(r"trash-[0-9a-f]{32}", trash_id) is None:
            raise LocalDatasetError("Trash entry not found", code="dataset_not_found")
        trash_root = self.root / ".trash" / trash_id
        try:
            entry = json.loads((trash_root / "entry.json").read_text(encoding="utf-8"))
            dataset_id = entry["dataset_id"]
        except (OSError, KeyError, json.JSONDecodeError) as exc:
            raise LocalDatasetError(
                "Trash entry not found", code="dataset_not_found"
            ) from exc
        target = self.root / dataset_id
        if target.exists():
            raise LocalDatasetError(
                "A dataset with this identity already exists",
                code="dataset_identity_conflict",
            )
        os.replace(trash_root / dataset_id, target)
        shutil.rmtree(trash_root)
        return self.get_manifest(dataset_id)

    def _specific_revision_dir(self, dataset_id: str, data_epoch: str) -> Path:
        if DATASET_ID_RE.fullmatch(dataset_id) is None:
            raise LocalDatasetError("Dataset not found", code="dataset_not_found")
        revision = data_epoch.removeprefix("sha256:")
        if EPOCH_RE.fullmatch(revision) is None:
            raise LocalDatasetError(
                "Dataset revision not found", code="dataset_not_found"
            )
        path = self.root / dataset_id / revision
        if not path.is_dir():
            raise LocalDatasetError(
                "Dataset revision not found", code="dataset_not_found"
            )
        return path

    def list_revisions(self, dataset_id: str) -> list[dict[str, Any]]:
        dataset_root = self.root / dataset_id
        if not dataset_root.is_dir() or DATASET_ID_RE.fullmatch(dataset_id) is None:
            raise LocalDatasetError("Dataset not found", code="dataset_not_found")
        current_dir = self._revision_dir(dataset_id).name
        revisions: list[dict[str, Any]] = []
        for candidate in dataset_root.iterdir():
            if not candidate.is_dir() or EPOCH_RE.fullmatch(candidate.name) is None:
                continue
            try:
                manifest = json.loads(
                    (candidate / "manifest.json").read_text(encoding="utf-8")
                )
                quality = json.loads(
                    (candidate / "quality-report.json").read_text(encoding="utf-8")
                )
            except (OSError, json.JSONDecodeError):
                continue
            revisions.append(
                {
                    **manifest,
                    "current": candidate.name == current_dir,
                    "quality_status": quality.get("status", "unknown"),
                }
            )
        return sorted(revisions, key=lambda item: item["imported_at"], reverse=True)

    def revision_details(self, dataset_id: str, data_epoch: str) -> dict[str, Any]:
        revision_dir = self._specific_revision_dir(dataset_id, data_epoch)
        try:
            manifest = json.loads(
                (revision_dir / "manifest.json").read_text(encoding="utf-8")
            )
            quality = json.loads(
                (revision_dir / "quality-report.json").read_text(encoding="utf-8")
            )
            receipt = json.loads(
                (revision_dir / "import-receipt.json").read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError) as exc:
            raise LocalDatasetError(
                "Dataset revision is unreadable", code="dataset_corrupt"
            ) from exc
        return {"manifest": manifest, "quality": quality, "receipt": receipt}

    def activate_revision(
        self,
        dataset_id: str,
        *,
        data_epoch: str,
        expected_current_epoch: str,
    ) -> dict[str, Any]:
        current = self.get_manifest(dataset_id)
        if current["data_epoch"] != expected_current_epoch:
            raise LocalDatasetError(
                "Dataset revision changed; reload it before continuing",
                code="dataset_revision_changed",
            )
        revision_dir = self._specific_revision_dir(dataset_id, data_epoch)
        self._write_json(
            self.root / dataset_id / "current.json",
            {"data_epoch": data_epoch, "revision": revision_dir.name},
        )
        return self.get_manifest(dataset_id)

    def compare_revisions(
        self,
        dataset_id: str,
        *,
        left_epoch: str,
        right_epoch: str,
    ) -> dict[str, Any]:
        left = self._specific_revision_dir(dataset_id, left_epoch) / "bars.sqlite"
        right = self._specific_revision_dir(dataset_id, right_epoch) / "bars.sqlite"
        connection = sqlite3.connect(f"file:{left.as_posix()}?mode=ro", uri=True)
        try:
            connection.execute("ATTACH DATABASE ? AS right_revision", (str(right),))
            added = connection.execute(
                "SELECT COUNT(*) FROM right_revision.bars r LEFT JOIN bars l USING(open_time_ms) WHERE l.open_time_ms IS NULL"
            ).fetchone()[0]
            removed = connection.execute(
                "SELECT COUNT(*) FROM bars l LEFT JOIN right_revision.bars r USING(open_time_ms) WHERE r.open_time_ms IS NULL"
            ).fetchone()[0]
            fields = "open,high,low,close,volume,quote_volume,trades,taker_buy_base,taker_buy_quote,is_closed"
            changed_predicate = " OR ".join(
                f"l.{field} IS NOT r.{field}" for field in fields.split(",")
            )
            changed_row = connection.execute(
                f"SELECT COUNT(*), MIN(l.open_time_ms), MAX(l.open_time_ms) FROM bars l JOIN right_revision.bars r USING(open_time_ms) WHERE {changed_predicate}"
            ).fetchone()
            common = connection.execute(
                "SELECT COUNT(*) FROM bars l JOIN right_revision.bars r USING(open_time_ms)"
            ).fetchone()[0]
        except sqlite3.DatabaseError as exc:
            raise LocalDatasetError(
                "Dataset revisions are unreadable", code="dataset_corrupt"
            ) from exc
        finally:
            connection.close()
        changed = int(changed_row[0])
        return {
            "dataset_id": dataset_id,
            "left_epoch": left_epoch,
            "right_epoch": right_epoch,
            "added": int(added),
            "removed": int(removed),
            "changed": changed,
            "unchanged": int(common) - changed,
            "first_changed_ms": changed_row[1],
            "last_changed_ms": changed_row[2],
        }

    def _validated_revision_dir(
        self,
        dataset_id: str,
        data_epoch: str,
    ) -> tuple[dict[str, Any], Path]:
        """Resolve one caller-pinned immutable revision without a second current lookup."""
        manifest = self.get_manifest(dataset_id)
        if manifest["data_epoch"] != data_epoch:
            raise LocalDatasetError(
                "Dataset revision changed; reload it before continuing",
                code="dataset_revision_changed",
            )
        revision = data_epoch.removeprefix("sha256:")
        if EPOCH_RE.fullmatch(revision) is None:
            raise LocalDatasetError(
                "Dataset revision changed; reload it before continuing",
                code="dataset_revision_changed",
            )
        revision_dir = self.root / dataset_id / revision
        if not revision_dir.is_dir():
            raise LocalDatasetError(
                "Dataset revision not found", code="dataset_corrupt"
            )
        bars_path = revision_dir / "bars.sqlite"
        try:
            actual_sqlite_hash = self._file_sha256(bars_path)
        except OSError as exc:
            raise LocalDatasetError(
                "Dataset revision payload is unreadable",
                code="DATA_SNAPSHOT_MISMATCH",
            ) from exc
        if actual_sqlite_hash != manifest.get("sqlite_sha256"):
            raise LocalDatasetError(
                "Dataset revision payload hash changed",
                code="DATA_SNAPSHOT_MISMATCH",
            )
        return manifest, revision_dir

    def load_revision_bars(
        self,
        dataset_id: str,
        *,
        data_epoch: str,
        max_rows: int,
        interval: str | None = None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Load all rows from exactly one immutable revision for static analysis."""
        if max_rows < 1:
            raise ValueError("max_rows must be positive")
        manifest, revision_dir = self._validated_revision_dir(
            dataset_id,
            data_epoch,
        )
        plan = self.resolve_interval(manifest, interval or manifest["interval"])
        if plan.derived:
            selected = self._read_derived_rows(
                revision_dir,
                plan=plan,
                fetch_limit=max_rows + 1,
            )
            if len(selected) > max_rows:
                raise LocalDatasetError(
                    f"Static indicators currently support at most {max_rows} bars",
                    code="indicator_dataset_too_large",
                )
            selected.reverse()
            return manifest, [self._wire_bar(row) for row in selected]
        db_path = revision_dir / "bars.sqlite"
        uri = f"file:{db_path.as_posix()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        try:
            connection.row_factory = sqlite3.Row
            selected = connection.execute(
                "SELECT * FROM bars ORDER BY open_time_ms ASC LIMIT ?",
                (max_rows + 1,),
            ).fetchall()
        except sqlite3.DatabaseError as exc:
            raise LocalDatasetError(
                "Dataset bars are unreadable", code="dataset_corrupt"
            ) from exc
        finally:
            connection.close()
        if len(selected) > max_rows:
            raise LocalDatasetError(
                f"Static indicators currently support at most {max_rows} bars",
                code="indicator_dataset_too_large",
            )
        return manifest, [self._wire_bar(row) for row in selected]

    def load_canonical_bars(
        self,
        dataset_id: str,
        *,
        data_epoch: str,
        interval: str | None = None,
        max_rows: int = 200_000,
    ) -> tuple[dict[str, Any], list[dict[str, str | int | None]]]:
        """Load one revision as Decimal-safe strings for immutable snapshots."""
        if max_rows < 1:
            raise ValueError("max_rows must be positive")
        manifest, revision_dir = self._validated_revision_dir(
            dataset_id,
            data_epoch,
        )
        plan = self.resolve_interval(manifest, interval or manifest["interval"])
        if plan.derived:
            selected = self._read_derived_rows(
                revision_dir,
                plan=plan,
                fetch_limit=max_rows + 1,
            )
            selected.reverse()
        else:
            db_path = revision_dir / "bars.sqlite"
            uri = f"file:{db_path.as_posix()}?mode=ro"
            connection = sqlite3.connect(uri, uri=True)
            try:
                connection.row_factory = sqlite3.Row
                selected = connection.execute(
                    "SELECT * FROM bars ORDER BY open_time_ms ASC LIMIT ?",
                    (max_rows + 1,),
                ).fetchall()
            except sqlite3.DatabaseError as exc:
                raise LocalDatasetError(
                    "Dataset bars are unreadable", code="dataset_corrupt"
                ) from exc
            finally:
                connection.close()
        if len(selected) > max_rows:
            raise LocalDatasetError(
                f"Snapshot currently supports at most {max_rows} bars",
                code="BUDGET_EXCEEDED",
            )
        canonical: list[dict[str, str | int | None]] = []
        for row in selected:
            canonical.append(
                {
                    "open_time_ms": int(row["open_time_ms"]),
                    "close_time_ms": int(row["close_time_ms"]),
                    "open": str(row["open"]),
                    "high": str(row["high"]),
                    "low": str(row["low"]),
                    "close": str(row["close"]),
                    "volume": None if row["volume"] is None else str(row["volume"]),
                }
            )
        return manifest, canonical

    @staticmethod
    def resolve_interval(
        manifest: dict[str, Any],
        interval: str,
    ) -> LocalResamplePlan:
        alignment_offset = manifest.get("alignment_offset_ms")
        if alignment_offset is None:
            source = parse_interval_spec(str(manifest.get("interval", "")))
            first_open_ms = manifest.get("first_open_ms")
            alignment_offset = (
                int(first_open_ms) % source.nominal_ms
                if source is not None and first_open_ms is not None
                else -1
            )
        try:
            return resolve_local_resample_plan(
                str(manifest["interval"]),
                interval,
                alignment_offset_ms=int(alignment_offset),
            )
        except LocalResamplingError as exc:
            raise LocalDatasetError(str(exc), code=exc.code) from exc

    @staticmethod
    def _read_derived_rows(
        revision_dir: Path,
        *,
        plan: LocalResamplePlan,
        fetch_limit: int,
        before_ms: int | None = None,
        start_ms: int | None = None,
        end_ms: int | None = None,
    ) -> list[dict[str, Any]]:
        """Aggregate only complete target buckets from one immutable revision."""
        if not plan.derived:
            raise ValueError("A derived resample plan is required")
        source_ms = plan.source.nominal_ms
        target_ms = plan.target.nominal_ms
        last_component_offset_ms = target_ms - source_ms
        factor = plan.factor
        db_path = revision_dir / "bars.sqlite"
        uri = f"file:{db_path.as_posix()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        try:
            connection.row_factory = sqlite3.Row
            source_rows = connection.execute(
                "SELECT * FROM bars ORDER BY open_time_ms ASC"
            ).fetchall()
        except sqlite3.DatabaseError as exc:
            raise LocalDatasetError(
                "Dataset bars are unreadable", code="dataset_corrupt"
            ) from exc
        finally:
            connection.close()
        grouped: dict[int, list[sqlite3.Row]] = {}
        for row in source_rows:
            bucket = (int(row["open_time_ms"]) // target_ms) * target_ms
            grouped.setdefault(bucket, []).append(row)
        derived: list[dict[str, Any]] = []
        for bucket, members in grouped.items():
            if before_ms is not None and bucket >= int(before_ms):
                continue
            if start_ms is not None and bucket < int(start_ms):
                continue
            if end_ms is not None and bucket > int(end_ms):
                continue
            if len(members) != factor:
                continue
            opens = [int(item["open_time_ms"]) for item in members]
            if min(opens) != bucket or max(opens) != bucket + last_component_offset_ms:
                continue
            if any(
                int(item["close_time_ms"]) != int(item["open_time_ms"]) + source_ms - 1
                for item in members
            ):
                continue
            first = next(
                item for item in members if int(item["open_time_ms"]) == bucket
            )
            last = next(
                item
                for item in members
                if int(item["open_time_ms"]) == bucket + last_component_offset_ms
            )
            derived.append(
                {
                    "open_time_ms": bucket,
                    "close_time_ms": bucket + target_ms - 1,
                    "open": first["open"],
                    "high": _decimal_text(
                        max(Decimal(str(item["high"])) for item in members)
                    ),
                    "low": _decimal_text(
                        min(Decimal(str(item["low"])) for item in members)
                    ),
                    "close": last["close"],
                    "volume": _sum_optional_decimals(
                        item["volume"] for item in members
                    ),
                    "quote_volume": _sum_optional_decimals(
                        item["quote_volume"] for item in members
                    ),
                    "trades": _sum_optional_ints(item["trades"] for item in members),
                    "taker_buy_base": _sum_optional_decimals(
                        item["taker_buy_base"] for item in members
                    ),
                    "taker_buy_quote": _sum_optional_decimals(
                        item["taker_buy_quote"] for item in members
                    ),
                    "is_closed": min(int(item["is_closed"]) for item in members),
                }
            )
        derived.sort(key=lambda item: int(item["open_time_ms"]), reverse=True)
        return derived[: max(1, int(fetch_limit))]

    def query(
        self,
        dataset_id: str,
        *,
        interval: str,
        limit: int,
        before_ms: int | None = None,
        start_ms: int | None = None,
        end_ms: int | None = None,
    ) -> dict[str, Any]:
        manifest = self.get_manifest(dataset_id)
        plan = self.resolve_interval(manifest, interval)
        limit = max(1, min(int(limit), 5_000))
        if plan.derived:
            return self._query_derived(
                dataset_id,
                manifest=manifest,
                plan=plan,
                limit=limit,
                before_ms=before_ms,
                start_ms=start_ms,
                end_ms=end_ms,
            )
        clauses: list[str] = []
        parameters: list[int] = []
        if before_ms is not None:
            clauses.append("open_time_ms < ?")
            parameters.append(int(before_ms))
        if start_ms is not None:
            clauses.append("open_time_ms >= ?")
            parameters.append(int(start_ms))
        if end_ms is not None:
            clauses.append("open_time_ms <= ?")
            parameters.append(int(end_ms))
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        db_path = self._revision_dir(dataset_id) / "bars.sqlite"
        uri = f"file:{db_path.as_posix()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        try:
            connection.row_factory = sqlite3.Row
            selected = connection.execute(
                f"SELECT * FROM bars {where} ORDER BY open_time_ms DESC LIMIT ?",
                [*parameters, limit + 1],
            ).fetchall()
            gaps = connection.execute(
                "SELECT * FROM excluded_ranges ORDER BY start_ms ASC"
            ).fetchall()
        finally:
            connection.close()
        has_more = len(selected) > limit
        selected = selected[:limit]
        selected.reverse()
        rows = [self._wire_bar(row) for row in selected]
        earliest_selected = selected[0]["open_time_ms"] if selected else None
        return {
            "source": "local_dataset",
            "dataset_id": dataset_id,
            "data_epoch": manifest["data_epoch"],
            "symbol": manifest["symbol"],
            "interval": plan.target.canonical,
            "source_interval": manifest["interval"],
            "derived": False,
            "aggregation_factor": 1,
            "volume_available": manifest["volume_available"],
            "data": rows,
            "count": len(rows),
            "all_rows_final": all(row["is_closed"] for row in rows),
            "complete": True,
            "retryable": False,
            "renderable": bool(rows),
            "has_more": has_more,
            "truncated": has_more,
            "next_end_ms": earliest_selected - 1
            if has_more and earliest_selected is not None
            else None,
            "next_before_ms": earliest_selected if has_more else None,
            "history_state": "ready" if has_more else "exhausted",
            "terminal_reason": None if has_more else "dataset_boundary",
            "earliest_available_ms": manifest["first_open_ms"],
            "availability_revision": manifest["data_epoch"],
            "verified_contiguous": not gaps,
            "excluded_ranges": [dict(gap) for gap in gaps],
            "missing_ranges": [],
        }

    def _query_derived(
        self,
        dataset_id: str,
        *,
        manifest: dict[str, Any],
        plan: LocalResamplePlan,
        limit: int,
        before_ms: int | None,
        start_ms: int | None,
        end_ms: int | None,
    ) -> dict[str, Any]:
        revision_dir = self._revision_dir(dataset_id)
        selected = self._read_derived_rows(
            revision_dir,
            plan=plan,
            fetch_limit=limit + 1,
            before_ms=before_ms,
            start_ms=start_ms,
            end_ms=end_ms,
        )
        has_more = len(selected) > limit
        selected = selected[:limit]
        selected.reverse()
        rows = [self._wire_bar(row) for row in selected]
        earliest_selected = selected[0]["open_time_ms"] if selected else None
        db_path = revision_dir / "bars.sqlite"
        uri = f"file:{db_path.as_posix()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        try:
            connection.row_factory = sqlite3.Row
            gaps = connection.execute(
                "SELECT * FROM excluded_ranges ORDER BY start_ms ASC"
            ).fetchall()
        finally:
            connection.close()
        return {
            "source": "local_dataset",
            "dataset_id": dataset_id,
            "data_epoch": manifest["data_epoch"],
            "symbol": manifest["symbol"],
            "interval": plan.target.canonical,
            "source_interval": plan.source.canonical,
            "derived": True,
            "aggregation_factor": plan.factor,
            "data": rows,
            "count": len(rows),
            "all_rows_final": all(row["is_closed"] for row in rows),
            "complete": True,
            "retryable": False,
            "renderable": bool(rows),
            "has_more": has_more,
            "truncated": has_more,
            "next_end_ms": earliest_selected - 1
            if has_more and earliest_selected is not None
            else None,
            "next_before_ms": earliest_selected if has_more else None,
            "history_state": "ready" if has_more else "exhausted",
            "terminal_reason": None if has_more else "dataset_boundary",
            "earliest_available_ms": (
                earliest_selected
                if not has_more and earliest_selected is not None
                else plan.target.floor_ms(manifest["first_open_ms"])
            ),
            "availability_revision": manifest["data_epoch"],
            "verified_contiguous": not gaps,
            "excluded_ranges": [dict(gap) for gap in gaps],
            "missing_ranges": [],
            "resampling": {
                "policy": "complete_buckets_only",
                "incomplete_buckets_omitted": True,
            },
        }

    def resolve_event_times(
        self,
        dataset_id: str,
        *,
        data_epoch: str,
        times_ms: list[int],
        mode: str,
    ) -> dict[str, Any]:
        """Resolve user event timestamps against one immutable dataset revision."""
        manifest, revision_dir = self._validated_revision_dir(dataset_id, data_epoch)
        if mode not in {"exact", "containing"}:
            raise LocalDatasetError("Event time mode must be exact or containing")
        if not times_ms or len(times_ms) > 5_000:
            raise LocalDatasetError("Event time batch must contain 1 to 5000 rows")
        if any(
            not isinstance(value, int) or isinstance(value, bool) or value <= 0
            for value in times_ms
        ):
            raise LocalDatasetError(
                "Event timestamps must be positive integer milliseconds"
            )

        # Open the revision that was validated above, rather than resolving
        # current.json a second time and risking a cross-revision race.
        db_path = revision_dir / "bars.sqlite"
        uri = f"file:{db_path.as_posix()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        try:
            connection.row_factory = sqlite3.Row
            if mode == "exact":
                statement = (
                    "SELECT open_time_ms, close_time_ms FROM bars "
                    "WHERE open_time_ms = ?"
                )
            else:
                statement = (
                    "SELECT open_time_ms, close_time_ms FROM bars "
                    "WHERE open_time_ms <= ? AND close_time_ms >= ? "
                    "ORDER BY open_time_ms DESC LIMIT 1"
                )
            results: list[dict[str, Any]] = []
            matched = 0
            for index, input_time_ms in enumerate(times_ms):
                parameters = (
                    (input_time_ms,)
                    if mode == "exact"
                    else (input_time_ms, input_time_ms)
                )
                row = connection.execute(statement, parameters).fetchone()
                if row is None:
                    results.append(
                        {
                            "input_index": index,
                            "input_time_ms": input_time_ms,
                            "matched": False,
                        }
                    )
                    continue
                open_time_ms = int(row["open_time_ms"])
                matched += 1
                results.append(
                    {
                        "input_index": index,
                        "input_time_ms": input_time_ms,
                        "matched": True,
                        "bar_open_ms": open_time_ms,
                        "bar_close_ms": int(row["close_time_ms"]),
                        "delta_ms": input_time_ms - open_time_ms,
                    }
                )
        finally:
            connection.close()
        return {
            "dataset_id": dataset_id,
            "data_epoch": manifest["data_epoch"],
            "mode": mode,
            "matched": matched,
            "rejected": len(times_ms) - matched,
            "results": results,
        }

    def export_project_package(
        self,
        dataset_id: str,
        *,
        data_epoch: str,
        client_state: dict[str, Any],
    ) -> Path:
        """Create a portable package pinned to the caller's current revision."""
        manifest, _ = self._validated_revision_dir(dataset_id, data_epoch)
        dataset_root = self.root / dataset_id
        package_path = (
            self.root / ".exports" / f"{dataset_id}-{uuid.uuid4().hex}.csproject"
        )
        files: dict[str, str] = {}
        selected: list[tuple[Path, str]] = []
        for path in dataset_root.rglob("*"):
            if path.is_file() and "indicator-cache" not in path.parts:
                archive_name = f"dataset/{path.relative_to(dataset_root).as_posix()}"
                selected.append((path, archive_name))
                files[archive_name] = self._file_sha256(path)
        client_bytes = json.dumps(
            client_state,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(client_bytes) > MAX_PROJECT_CLIENT_STATE_BYTES:
            raise LocalDatasetError("Project client state exceeds the safe limit")
        files["client-state.json"] = hashlib.sha256(client_bytes).hexdigest()
        package = {
            "schema_version": PROJECT_PACKAGE_SCHEMA_VERSION,
            "kind": "candlescope.local.project",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "dataset_id": dataset_id,
            "data_epoch": data_epoch,
            "name": manifest["name"],
            "files": files,
        }
        with zipfile.ZipFile(
            package_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
        ) as archive:
            archive.writestr("client-state.json", client_bytes)
            for path, archive_name in selected:
                archive.write(path, archive_name)
            archive.writestr(
                "package.json",
                json.dumps(package, ensure_ascii=False, indent=2, sort_keys=True)
                + "\n",
            )
        return package_path

    def import_project_package(self, package_path: Path) -> dict[str, Any]:
        """Validate and atomically install a portable project package."""
        self.start()
        staging = self.root / ".staging" / f"project-{uuid.uuid4().hex}"
        staging.mkdir(parents=True)
        try:
            with zipfile.ZipFile(package_path) as archive:
                entries = archive.infolist()
                if len(entries) > MAX_PROJECT_PACKAGE_ENTRIES:
                    raise LocalDatasetError("Project package contains too many files")
                total_size = sum(entry.file_size for entry in entries)
                if total_size > MAX_PROJECT_PACKAGE_UNCOMPRESSED_BYTES:
                    raise LocalDatasetError(
                        "Project package expands beyond the safe limit"
                    )
                names = {entry.filename for entry in entries}
                if len(names) != len(entries):
                    raise LocalDatasetError("Project package contains duplicate paths")
                if "package.json" not in names or "client-state.json" not in names:
                    raise LocalDatasetError("Project package is missing its manifest")
                entries_by_name = {entry.filename: entry for entry in entries}
                if (
                    entries_by_name["package.json"].file_size
                    > MAX_PROJECT_MANIFEST_BYTES
                ):
                    raise LocalDatasetError(
                        "Project package manifest exceeds the safe limit"
                    )
                client_entry = entries_by_name["client-state.json"]
                if client_entry.file_size > MAX_PROJECT_CLIENT_STATE_BYTES:
                    raise LocalDatasetError(
                        "Project client state exceeds the safe limit"
                    )
                for entry in entries:
                    if entry.is_dir() or not self._safe_archive_name(entry.filename):
                        raise LocalDatasetError(
                            "Project package contains an unsafe path"
                        )
                    if (
                        entry.filename != "package.json"
                        and entry.filename != "client-state.json"
                        and not entry.filename.startswith("dataset/")
                    ):
                        raise LocalDatasetError(
                            "Project package contains an unsupported file"
                        )
                package = json.loads(archive.read("package.json"))
                if (
                    package.get("kind") != "candlescope.local.project"
                    or package.get("schema_version") != PROJECT_PACKAGE_SCHEMA_VERSION
                    or not isinstance(package.get("files"), dict)
                ):
                    raise LocalDatasetError("Unsupported project package")
                declared_files: dict[str, str] = package["files"]
                if set(declared_files) != names - {"package.json"}:
                    raise LocalDatasetError(
                        "Project package file inventory does not match"
                    )
                for name, expected_hash in declared_files.items():
                    destination = staging / PurePosixPath(name)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    digest = hashlib.sha256()
                    with (
                        archive.open(entries_by_name[name]) as source,
                        destination.open("xb") as target,
                    ):
                        for chunk in iter(lambda: source.read(1024 * 1024), b""):
                            digest.update(chunk)
                            target.write(chunk)
                    if digest.hexdigest() != expected_hash:
                        raise LocalDatasetError("Project package checksum mismatch")

            old_dataset_id = package.get("dataset_id")
            old_epoch = package.get("data_epoch")
            if (
                not isinstance(old_dataset_id, str)
                or DATASET_ID_RE.fullmatch(old_dataset_id) is None
            ):
                raise LocalDatasetError("Project package dataset identity is invalid")
            if not isinstance(old_epoch, str):
                raise LocalDatasetError("Project package revision identity is invalid")
            source_root = staging / "dataset"
            current = json.loads(
                (source_root / "current.json").read_text(encoding="utf-8")
            )
            if current.get("data_epoch") != old_epoch:
                raise LocalDatasetError(
                    "Project package current revision does not match"
                )
            new_dataset_id = (
                old_dataset_id
                if not (self.root / old_dataset_id).exists()
                else f"local-{uuid.uuid4().hex}"
            )
            revision_count = 0
            for revision_dir in source_root.iterdir():
                if (
                    not revision_dir.is_dir()
                    or EPOCH_RE.fullmatch(revision_dir.name) is None
                ):
                    continue
                self._validate_packaged_revision(revision_dir, old_dataset_id)
                manifest_path = revision_dir / "manifest.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                manifest["dataset_id"] = new_dataset_id
                self._write_json(manifest_path, manifest)
                revision_count += 1
            if revision_count < 1:
                raise LocalDatasetError("Project package contains no dataset revisions")
            client_state = json.loads(
                (staging / "client-state.json").read_text(encoding="utf-8")
            )
            if not isinstance(client_state, dict):
                raise LocalDatasetError("Project package client state is invalid")
            os.replace(source_root, self.root / new_dataset_id)
            return {
                "dataset": self.get_manifest(new_dataset_id),
                "source_dataset_id": old_dataset_id,
                "dataset_id": new_dataset_id,
                "identity_changed": old_dataset_id != new_dataset_id,
                "revision_count": revision_count,
                "client_state": client_state,
            }
        except (
            zipfile.BadZipFile,
            UnicodeDecodeError,
            json.JSONDecodeError,
            OSError,
        ) as exc:
            if isinstance(exc, LocalDatasetError):
                raise
            raise LocalDatasetError("Project package is unreadable") from exc
        finally:
            if staging.exists():
                shutil.rmtree(staging)

    def _validate_packaged_revision(self, revision_dir: Path, dataset_id: str) -> None:
        try:
            manifest = json.loads(
                (revision_dir / "manifest.json").read_text(encoding="utf-8")
            )
            if manifest["dataset_id"] != dataset_id:
                raise LocalDatasetError("Project package mixes dataset identities")
            if manifest["data_epoch"] != f"sha256:{revision_dir.name}":
                raise LocalDatasetError("Project package revision path does not match")
            db_path = revision_dir / "bars.sqlite"
            if self._file_sha256(db_path) != manifest["sqlite_sha256"]:
                raise LocalDatasetError("Project package dataset checksum mismatch")
            contract_history = manifest.get("contract_history")
            if contract_history is not None:
                if not isinstance(contract_history, dict):
                    raise LocalDatasetError(
                        "Project package contract history manifest is invalid"
                    )
                try:
                    descriptor = load_contract_history(
                        revision_dir / "contract-history.json"
                    )
                except MarketDatasetError as exc:
                    raise LocalDatasetError(
                        "Project package contract history validation failed"
                    ) from exc
                if descriptor.bundle_hash != contract_history.get("bundle_hash"):
                    raise LocalDatasetError(
                        "Project package contract history checksum mismatch"
                    )
            connection = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
            try:
                check = connection.execute("PRAGMA quick_check").fetchone()
            finally:
                connection.close()
            if not check or check[0] != "ok":
                raise LocalDatasetError("Project package SQLite integrity check failed")
        except (OSError, KeyError, json.JSONDecodeError, sqlite3.DatabaseError) as exc:
            if isinstance(exc, LocalDatasetError):
                raise
            raise LocalDatasetError("Project package revision is unreadable") from exc

    @staticmethod
    def _safe_archive_name(name: str) -> bool:
        if not name or "\\" in name:
            return False
        path = PurePosixPath(name)
        return not path.is_absolute() and ".." not in path.parts

    @staticmethod
    def _wire_bar(row: sqlite3.Row | Mapping[str, Any]) -> dict[str, Any]:
        result = {
            "time": row["open_time_ms"] // 1000,
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": None if row["volume"] is None else float(row["volume"]),
            "is_closed": bool(row["is_closed"]),
        }
        for key in ("quote_volume", "taker_buy_base", "taker_buy_quote"):
            result[key] = None if row[key] is None else float(row[key])
        result["trades"] = row["trades"]
        return result

    def diagnostics(self) -> dict[str, Any]:
        return {
            "status": "ready",
            "root": str(self.root),
            "datasets": len(self.list_datasets()),
            "immutable_revisions": True,
        }


def _decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _sum_optional_decimals(values: Iterable[object]) -> str | None:
    total = Decimal("0")
    for value in values:
        if value is None:
            return None
        total += Decimal(str(value))
    return _decimal_text(total)


def _sum_optional_ints(values: Iterable[object]) -> int | None:
    total = 0
    for value in values:
        if value is None:
            return None
        total += int(value)
    return total
