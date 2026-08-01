"""Checksum-bound replay data segments, rehydration, and fail-closed GC."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import shutil
import sqlite3
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from app.data_engine.interval_policy import parse_interval_ms
from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.storage.sqlite_store import ReplaySQLiteStore

from .errors import TrainingRunError
from .models import (
    TrainingRunCreateRequest,
    VisibleHistoryMode,
)


SEGMENT_PROTOCOL = "replay.data.segment.v1"
REHYDRATION_PROTOCOL = "replay.data.rehydration.v1"
PREPARE_PROTOCOL = "replay.data.prepare.v1"
GC_PROTOCOL = "replay.data.gc.v1"
DATA_POLICY_PROTOCOL = "replay.data-policy.v1"


def _sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _mapping(value: object, field_name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{field_name} must be an object")
    return value


def _integer(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, str, bytes, bytearray)):
        raise TypeError(f"{field_name} must be an integer")
    return int(value)


def _segment_identity(
    *,
    source_kind: str,
    exchange: str,
    market_type: str,
    symbol: str,
    base_interval: str | None,
    range_start_ms: int,
    range_end_ms: int,
    schema_version: str,
    dataset_epoch: str,
    checksum_sha256: str,
) -> tuple[str, str]:
    identity_key = canonical_sha256(
        {
            "protocol": SEGMENT_PROTOCOL,
            "source_kind": source_kind,
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "base_interval": base_interval,
            "range_start_ms": range_start_ms,
            "range_end_ms": range_end_ms,
            "schema_version": schema_version,
            "dataset_epoch": dataset_epoch,
            "checksum_sha256": checksum_sha256,
        }
    )
    return f"segment-{identity_key.removeprefix('sha256:')[:40]}", identity_key


def _archive_descriptor(
    *,
    source_kind: str,
    dataset_ref: Mapping[str, object],
    dataset_blob: Mapping[str, object] | None,
    snapshot_checksum: str | None,
    snapshot_bytes: int | None,
    actual_replay_start_ms: int,
    actual_replay_end_ms: int,
    base_interval_override: str | None = None,
    history_policy: ResolvedHistoryPolicy | None = None,
    range_start_ms_override: int | None = None,
) -> dict[str, object]:
    base_interval: str | None
    embedded_history_start_ms: int | None = None
    if source_kind == "BAR":
        identity = _mapping(dataset_ref.get("identity"), "BAR dataset identity")
        schema_version = str(dataset_ref.get("schema_version", ""))
        dataset_epoch = str(dataset_ref.get("data_epoch", ""))
        base_interval = str(dataset_ref.get("interval", ""))
        row_count = _integer(dataset_ref.get("row_count", 0), "BAR row_count")
        if dataset_ref.get("warmup_start_ms") is not None:
            embedded_history_start_ms = _integer(
                dataset_ref.get("warmup_start_ms"),
                "BAR warmup_start_ms",
            )
        adapter_kind = "V1_BAR_SNAPSHOT"
        source_manifest: dict[str, object] = {
            "repository_backend": dataset_ref.get("repository_backend"),
            "row_count": row_count,
        }
    elif source_kind == "AGG_TRADE":
        trade_ref = _mapping(
            dataset_ref.get("trade_dataset_ref"),
            "aggregate-trade dataset ref",
        )
        bar_bundle = _mapping(
            None if dataset_blob is None else dataset_blob.get("bar_dataset"),
            "aggregate-trade BAR bundle",
        ) if dataset_blob is not None else {}
        identity = {
            "exchange": trade_ref.get("exchange"),
            "market_type": trade_ref.get("market_type"),
            "symbol": trade_ref.get("symbol"),
        }
        schema_version = str(trade_ref.get("schema_version", ""))
        dataset_epoch = str(trade_ref.get("data_epoch", ""))
        base_interval = base_interval_override or (
            str(bar_bundle.get("interval"))
            if bar_bundle.get("interval") is not None
            else None
        )
        raw_rows = bar_bundle.get("rows")
        if isinstance(raw_rows, list) and raw_rows:
            first_row = _mapping(raw_rows[0], "aggregate-trade first BAR row")
            embedded_history_start_ms = _integer(
                first_row.get("open_time_ms"),
                "aggregate-trade BAR warmup start",
            )
        objects = trade_ref.get("objects")
        source_manifest = {
            "row_count": _integer(
                trade_ref.get("row_count", 0),
                "aggregate-trade row_count",
            ),
            "source_quality": trade_ref.get("source_quality"),
            "object_manifests": objects if isinstance(objects, list) else [],
        }
        adapter_kind = "RAW_AGG_TRADE_PARTITION_SET"
    else:
        raise ValueError("archive segment source_kind is unsupported")

    exchange = str(identity.get("exchange", ""))
    market_type = str(identity.get("market_type", ""))
    symbol = str(identity.get("symbol", ""))
    if not all((exchange, market_type, symbol, schema_version, dataset_epoch)):
        raise ValueError("archive segment identity is incomplete")
    if snapshot_checksum is None:
        if dataset_blob is None:
            raise ValueError("archive segment checksum is missing")
        snapshot_checksum = canonical_sha256(dataset_blob)
    if snapshot_bytes is None:
        if dataset_blob is None:
            raise ValueError("archive segment byte size is missing")
        snapshot_bytes = len(canonical_json(dataset_blob).encode("utf-8"))
    policy_payload: dict[str, object] | None = None
    if history_policy is not None:
        if not isinstance(history_policy, ResolvedHistoryPolicy):
            raise TypeError("history_policy must be a ResolvedHistoryPolicy")
        if history_policy.actual_replay_start_ms != actual_replay_start_ms:
            raise ValueError("archive history policy does not match replay start")
        policy_start_ms = (
            history_policy.actual_replay_start_ms
            - history_policy.effective_warmup_bars * history_policy.interval_ms
        )
        if (
            embedded_history_start_ms is not None
            and embedded_history_start_ms != policy_start_ms
        ):
            raise ValueError("archive embedded history range does not match policy")
        range_start_ms = policy_start_ms
        policy_payload = {
            **history_policy.to_dict(include_actual=True),
            "policy_hash": history_policy.policy_hash,
            "indicator_history_start_ms": (
                history_policy.actual_replay_start_ms
                - history_policy.indicator_warmup_bars
                * history_policy.interval_ms
            ),
            "dataset_history_start_ms": policy_start_ms,
        }
    elif range_start_ms_override is not None:
        range_start_ms = _integer(
            range_start_ms_override,
            "archive range_start_ms_override",
        )
        if (
            embedded_history_start_ms is not None
            and embedded_history_start_ms != range_start_ms
        ):
            raise ValueError("archive range override does not match embedded history")
    elif embedded_history_start_ms is not None:
        range_start_ms = embedded_history_start_ms
    else:
        # Compatibility for callers that do not own a Phase 14 policy.  The
        # migration/backfill path always supplies an exact override.
        range_start_ms = actual_replay_start_ms
    if (
        range_start_ms < 0
        or range_start_ms > actual_replay_start_ms
        or actual_replay_end_ms < actual_replay_start_ms
    ):
        raise ValueError("archive segment range is invalid")
    segment_id, identity_key = _segment_identity(
        source_kind=source_kind,
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        base_interval=base_interval,
        range_start_ms=range_start_ms,
        range_end_ms=actual_replay_end_ms,
        schema_version=schema_version,
        dataset_epoch=dataset_epoch,
        checksum_sha256=snapshot_checksum,
    )
    manifest = {
        "schema": REHYDRATION_PROTOCOL,
        "adapter_kind": adapter_kind,
        "trusted_origin": "REPLAY_SESSION_EMBEDDED",
        "trusted_url": None,
        "locator_kind": "REPLAY_DATASET_REF_BY_ACTIVE_OWNER",
        "source_identity": {
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "base_interval": base_interval,
        },
        "schema_version": schema_version,
        "dataset_epoch": dataset_epoch,
        "checksum_sha256": snapshot_checksum,
        "range": {
            "start_ms": range_start_ms,
            "end_ms": actual_replay_end_ms,
        },
        "source": source_manifest,
    }
    if policy_payload is not None:
        manifest["history_policy"] = policy_payload
    return {
        "segment_id": segment_id,
        "identity_key": identity_key,
        "source_kind": source_kind,
        "adapter_kind": adapter_kind,
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol,
        "base_interval": base_interval,
        "range_start_ms": range_start_ms,
        "range_end_ms": actual_replay_end_ms,
        "schema_version": schema_version,
        "dataset_epoch": dataset_epoch,
        "checksum_sha256": snapshot_checksum,
        "byte_size": snapshot_bytes,
        "manifest": manifest,
    }


def register_archive_segment(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    track_id: str,
    adapter_session_id: str,
    source_kind: str,
    dataset_ref: Mapping[str, object],
    dataset_blob: Mapping[str, object] | None,
    actual_replay_start_ms: int,
    actual_replay_end_ms: int,
    now_ms: int,
    snapshot_checksum: str | None = None,
    snapshot_bytes: int | None = None,
    base_interval_override: str | None = None,
    history_policy: ResolvedHistoryPolicy | None = None,
    range_start_ms_override: int | None = None,
) -> str:
    """Register one immutable v1 dataset adapter inside its creating transaction."""

    descriptor = _archive_descriptor(
        source_kind=source_kind,
        dataset_ref=dataset_ref,
        dataset_blob=dataset_blob,
        snapshot_checksum=snapshot_checksum,
        snapshot_bytes=snapshot_bytes,
        actual_replay_start_ms=actual_replay_start_ms,
        actual_replay_end_ms=actual_replay_end_ms,
        base_interval_override=base_interval_override,
        history_policy=history_policy,
        range_start_ms_override=range_start_ms_override,
    )
    existing = connection.execute(
        "SELECT * FROM replay_data_segment WHERE identity_key = ?",
        (descriptor["identity_key"],),
    ).fetchone()
    if existing is not None and (
        str(existing["checksum_sha256"]) != descriptor["checksum_sha256"]
        or str(existing["dataset_epoch"]) != descriptor["dataset_epoch"]
    ):
        raise sqlite3.IntegrityError("replay data segment identity changed content")
    connection.execute(
        """
        INSERT INTO replay_data_segment(
            segment_id, identity_key, protocol, source_kind, adapter_kind,
            exchange, market_type, symbol, base_interval,
            range_start_ms, range_end_ms, schema_version, dataset_epoch,
            checksum_sha256, coverage_state, continuity_state, health,
            storage_kind, local_path, byte_size, rebuildable, trusted_origin,
            rehydration_manifest_json, quarantine_reason, generation,
            reclaim_token, last_used_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXACT',
                  'CONTIGUOUS', 'READY', 'EMBEDDED_ARCHIVE', NULL, ?, 0,
                  'REPLAY_SESSION_EMBEDDED', ?, NULL, 1, NULL, ?, ?, ?)
        ON CONFLICT(identity_key) DO UPDATE SET
            source_kind = excluded.source_kind,
            adapter_kind = excluded.adapter_kind,
            exchange = excluded.exchange,
            market_type = excluded.market_type,
            symbol = excluded.symbol,
            base_interval = excluded.base_interval,
            range_start_ms = excluded.range_start_ms,
            range_end_ms = excluded.range_end_ms,
            schema_version = excluded.schema_version,
            dataset_epoch = excluded.dataset_epoch,
            checksum_sha256 = excluded.checksum_sha256,
            coverage_state = excluded.coverage_state,
            continuity_state = excluded.continuity_state,
            health = 'READY',
            storage_kind = 'EMBEDDED_ARCHIVE',
            local_path = NULL,
            byte_size = excluded.byte_size,
            rebuildable = 0,
            trusted_origin = excluded.trusted_origin,
            rehydration_manifest_json = excluded.rehydration_manifest_json,
            quarantine_reason = NULL,
            reclaim_token = NULL,
            last_used_at_ms = excluded.last_used_at_ms,
            updated_at_ms = excluded.updated_at_ms
        """,
        (
            descriptor["segment_id"],
            descriptor["identity_key"],
            SEGMENT_PROTOCOL,
            descriptor["source_kind"],
            descriptor["adapter_kind"],
            descriptor["exchange"],
            descriptor["market_type"],
            descriptor["symbol"],
            descriptor["base_interval"],
            descriptor["range_start_ms"],
            descriptor["range_end_ms"],
            descriptor["schema_version"],
            descriptor["dataset_epoch"],
            descriptor["checksum_sha256"],
            descriptor["byte_size"],
            canonical_json(descriptor["manifest"]),
            now_ms,
            now_ms,
            now_ms,
        ),
    )
    segment_row = connection.execute(
        "SELECT segment_id FROM replay_data_segment WHERE identity_key = ?",
        (descriptor["identity_key"],),
    ).fetchone()
    assert segment_row is not None
    segment_id = str(segment_row["segment_id"])
    for owner_kind, owner_id in (
        ("RUN_ARCHIVE", track_id),
        ("ACTOR", adapter_session_id),
    ):
        connection.execute(
            """
            INSERT INTO replay_data_segment_ref(
                segment_id, run_id, track_id, owner_kind, owner_id,
                active, created_at_ms, released_at_ms
            ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
            ON CONFLICT(segment_id, run_id, owner_kind, owner_id) DO UPDATE SET
                active = 1, released_at_ms = NULL
            """,
            (segment_id, run_id, track_id, owner_kind, owner_id, now_ms),
        )
    job_id = f"prepare-{run_id}-{track_id}"
    request_hash = canonical_sha256(
        {
            "segment_id": segment_id,
            "run_id": run_id,
            "track_id": track_id,
            "dataset_epoch": descriptor["dataset_epoch"],
        }
    )
    connection.execute(
        """
        INSERT INTO replay_data_prepare_job(
            job_id, identity_key, request_hash, state,
            progress_numerator, progress_denominator, segment_id,
            run_id, track_id, failure_reason, cancel_requested,
            temp_path, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'READY', 1, 1, ?, ?, ?, NULL, 0, NULL, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
            state = 'READY', progress_numerator = 1,
            progress_denominator = 1, segment_id = excluded.segment_id,
            failure_reason = NULL, cancel_requested = 0,
            temp_path = NULL, updated_at_ms = excluded.updated_at_ms
        """,
        (
            job_id,
            descriptor["identity_key"],
            request_hash,
            segment_id,
            run_id,
            track_id,
            now_ms,
            now_ms,
        ),
    )
    return segment_id


def backfill_archive_segments(connection: sqlite3.Connection, *, now_ms: int) -> int:
    """Adapt pre-v6 immutable session blobs without rewriting them."""

    rows = connection.execute(
        """
        SELECT p.run_id, p.pin_id, p.manifest_json,
               r.source_kind, t.track_id,
               d.snapshot_ref_json, d.snapshot_sha256,
               COALESCE(d.snapshot_size_bytes, length(d.snapshot_blob))
                   AS snapshot_bytes,
               d.actual_replay_start_ms, d.actual_replay_end_ms,
               s.config_json,
               policy.effective_warmup_bars AS policy_effective_warmup_bars,
               policy.interval_ms AS policy_interval_ms
        FROM replay_training_pin AS p
        JOIN replay_training_run AS r USING(run_id)
        JOIN replay_training_market_track AS t ON t.run_id = p.run_id
        JOIN replay_dataset_ref AS d ON d.session_id = t.adapter_session_id
        JOIN replay_session AS s ON s.session_id = t.adapter_session_id
        JOIN replay_training_data_policy AS policy USING(run_id)
        WHERE (
            (p.pin_id = 'primary-dataset' AND t.stable_ordinal = 1)
            OR p.pin_id = t.track_id || '-dataset'
        ) AND NOT EXISTS(
            SELECT 1 FROM replay_data_segment_ref AS existing
            WHERE existing.run_id = p.run_id
              AND existing.track_id = t.track_id
              AND existing.owner_kind = 'RUN_ARCHIVE'
        )
        ORDER BY p.run_id, t.stable_ordinal
        """
    ).fetchall()
    inserted = 0
    for row in rows:
        pin_manifest = json.loads(str(row["manifest_json"]))
        adapter_session_id = str(pin_manifest.get("adapter_session_id", ""))
        if not adapter_session_id:
            continue
        dataset_ref = json.loads(str(row["snapshot_ref_json"]))
        config = json.loads(str(row["config_json"]))
        if not isinstance(dataset_ref, Mapping):
            continue
        register_archive_segment(
            connection,
            run_id=str(row["run_id"]),
            track_id=str(row["track_id"]),
            adapter_session_id=adapter_session_id,
            source_kind=str(row["source_kind"]),
            dataset_ref=dataset_ref,
            dataset_blob=None,
            snapshot_checksum=str(row["snapshot_sha256"]),
            snapshot_bytes=int(row["snapshot_bytes"]),
            actual_replay_start_ms=int(row["actual_replay_start_ms"]),
            actual_replay_end_ms=int(row["actual_replay_end_ms"]),
            now_ms=now_ms,
            base_interval_override=(
                str(config.get("base_interval"))
                if isinstance(config, Mapping) and config.get("base_interval") is not None
                else None
            ),
            range_start_ms_override=(
                int(row["actual_replay_start_ms"])
                - int(row["policy_effective_warmup_bars"])
                * int(row["policy_interval_ms"])
            ),
        )
        inserted += 1
    return inserted


@dataclass(frozen=True, slots=True)
class SegmentPrepareSpec:
    source_kind: str
    adapter_kind: str
    exchange: str
    market_type: str
    symbol: str
    base_interval: str | None
    range_start_ms: int
    range_end_ms: int
    schema_version: str
    dataset_epoch: str
    checksum_sha256: str
    byte_size: int
    trusted_origin: str
    rehydration_manifest: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.source_kind not in {"BAR", "AGG_TRADE", "FUTURE"}:
            raise ValueError("segment source_kind is unsupported")
        required_text = (
            self.adapter_kind,
            self.exchange,
            self.market_type,
            self.symbol,
            self.schema_version,
            self.dataset_epoch,
            self.trusted_origin,
        )
        if any(not value for value in required_text):
            raise ValueError("segment identity fields must be non-empty")
        if self.range_start_ms < 0 or self.range_end_ms < self.range_start_ms:
            raise ValueError("segment range is invalid")
        if self.byte_size < 0:
            raise ValueError("segment byte_size must be non-negative")
        digest = self.checksum_sha256.removeprefix("sha256:")
        if (
            not self.checksum_sha256.startswith("sha256:")
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            raise ValueError("segment checksum_sha256 must be a lowercase SHA-256 digest")

    def manifest_mismatch(self) -> str | None:
        manifest = self.rehydration_manifest
        if manifest.get("schema") != REHYDRATION_PROTOCOL:
            return "MANIFEST_SCHEMA_MISMATCH"
        if manifest.get("trusted_origin") != self.trusted_origin:
            return "MANIFEST_ORIGIN_MISMATCH"
        if manifest.get("checksum_sha256") != self.checksum_sha256:
            return "MANIFEST_CHECKSUM_MISMATCH"
        if manifest.get("schema_version") != self.schema_version:
            return "MANIFEST_SCHEMA_VERSION_MISMATCH"
        if manifest.get("dataset_epoch") != self.dataset_epoch:
            return "MANIFEST_DATASET_EPOCH_MISMATCH"
        if manifest.get("byte_size") != self.byte_size:
            return "MANIFEST_SIZE_MISMATCH"
        trusted_file = manifest.get("trusted_file")
        if (
            not isinstance(trusted_file, str)
            or not trusted_file
            or not Path(trusted_file).is_absolute()
        ):
            return "MANIFEST_REHYDRATOR_MISSING"
        identity = manifest.get("source_identity")
        if not isinstance(identity, Mapping) or any(
            identity.get(field) != expected
            for field, expected in (
                ("exchange", self.exchange),
                ("market_type", self.market_type),
                ("symbol", self.symbol),
                ("base_interval", self.base_interval),
            )
        ):
            return "MANIFEST_IDENTITY_MISMATCH"
        manifest_range = manifest.get("range")
        if not isinstance(manifest_range, Mapping) or (
            manifest_range.get("start_ms") != self.range_start_ms
            or manifest_range.get("end_ms") != self.range_end_ms
        ):
            return "MANIFEST_RANGE_MISMATCH"
        return None

    def identity(self) -> tuple[str, str]:
        return _segment_identity(
            source_kind=self.source_kind,
            exchange=self.exchange,
            market_type=self.market_type,
            symbol=self.symbol,
            base_interval=self.base_interval,
            range_start_ms=self.range_start_ms,
            range_end_ms=self.range_end_ms,
            schema_version=self.schema_version,
            dataset_epoch=self.dataset_epoch,
            checksum_sha256=self.checksum_sha256,
        )


@dataclass(frozen=True, slots=True)
class ResolvedHistoryPolicy:
    indicator_warmup_bars: int
    visible_history_mode: VisibleHistoryMode
    visible_history_lookback_ms: int | None
    visible_history_rows: int
    actual_visible_history_start_ms: int
    actual_replay_start_ms: int
    effective_warmup_bars: int
    forward_cache_ms: int
    interval_ms: int

    def __post_init__(self) -> None:
        numeric = (
            self.indicator_warmup_bars,
            self.visible_history_rows,
            self.actual_visible_history_start_ms,
            self.actual_replay_start_ms,
            self.effective_warmup_bars,
            self.forward_cache_ms,
            self.interval_ms,
        )
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in numeric
        ):
            raise ValueError("resolved replay history policy counters are invalid")
        if self.indicator_warmup_bars < 1 or self.interval_ms < 1:
            raise ValueError("resolved replay history policy is empty")
        if self.actual_visible_history_start_ms > self.actual_replay_start_ms:
            raise ValueError("visible replay history begins after replay start")
        if self.effective_warmup_bars < self.indicator_warmup_bars:
            raise ValueError("effective replay warmup does not cover indicators")
        if self.visible_history_mode is VisibleHistoryMode.DURATION:
            if (
                self.visible_history_lookback_ms is None
                or self.visible_history_lookback_ms
                != self.visible_history_rows * self.interval_ms
                or self.effective_warmup_bars < self.visible_history_rows
                or self.actual_visible_history_start_ms
                != self.actual_replay_start_ms - self.visible_history_lookback_ms
            ):
                raise ValueError("duration replay history policy is misaligned")
        else:
            distance = (
                self.actual_replay_start_ms
                - self.actual_visible_history_start_ms
            )
            if (
                self.visible_history_lookback_ms is not None
                or distance % self.interval_ms
                or self.visible_history_rows != distance // self.interval_ms
            ):
                raise ValueError("all-available replay history is misaligned")

    @property
    def policy_hash(self) -> str:
        return canonical_sha256(self.to_dict(include_actual=True))

    def to_dict(self, *, include_actual: bool) -> dict[str, object]:
        payload: dict[str, object] = {
            "schema_version": DATA_POLICY_PROTOCOL,
            "indicator_warmup_bars": self.indicator_warmup_bars,
            "visible_history_lookback": {
                "mode": self.visible_history_mode.value,
                "duration_ms": self.visible_history_lookback_ms,
            },
            "visible_history_rows": self.visible_history_rows,
            "effective_warmup_bars": self.effective_warmup_bars,
            "forward_cache_ms": self.forward_cache_ms,
            "interval_ms": self.interval_ms,
        }
        if include_actual:
            payload.update(
                {
                    "actual_visible_history_start_ms": (
                        self.actual_visible_history_start_ms
                    ),
                    "actual_replay_start_ms": self.actual_replay_start_ms,
                }
            )
        return payload


def resolve_history_policy(
    request: TrainingRunCreateRequest,
    selection: Mapping[str, object],
    *,
    max_dataset_rows: int,
) -> ResolvedHistoryPolicy:
    interval_ms = _integer(selection.get("interval_ms"), "selection interval_ms")
    selected_start_ms = _integer(
        selection.get("selected_start_ms"),
        "selection selected_start_ms",
    )
    continuous_start_ms = _integer(
        selection.get("continuous_history_start_ms"),
        "selection continuous_history_start_ms",
    )
    source_bounds = selection.get("source_bounds")
    source_start_ms = (
        _integer(
            source_bounds.get("earliest_open_ms"),
            "selection source_bounds.earliest_open_ms",
        )
        if isinstance(source_bounds, Mapping)
        and source_bounds.get("earliest_open_ms") is not None
        else continuous_start_ms
    )
    if source_start_ms > continuous_start_ms or source_start_ms > selected_start_ms:
        raise TrainingRunError(
            "VISIBLE_HISTORY_COVERAGE_UNAVAILABLE",
            "all-available source boundary is inconsistent with the selected start",
            status_code=409,
        )
    visible = request.visible_history_lookback
    assert visible is not None
    if visible.mode is VisibleHistoryMode.DURATION:
        assert visible.duration_ms is not None
        if visible.duration_ms % interval_ms:
            raise TrainingRunError(
                "VISIBLE_HISTORY_INTERVAL_MISMATCH",
                "visible history duration must be an exact base-interval multiple",
                status_code=422,
                details={"base_interval_ms": interval_ms},
            )
        visible_rows = visible.duration_ms // interval_ms
        visible_start_ms = selected_start_ms - visible.duration_ms
        if visible_start_ms < continuous_start_ms:
            raise TrainingRunError(
                "VISIBLE_HISTORY_COVERAGE_UNAVAILABLE",
                "selected start does not have the requested contiguous visible history",
                status_code=409,
                details={
                    "requested_rows": visible_rows,
                    "available_rows": max(
                        0,
                        (selected_start_ms - continuous_start_ms) // interval_ms,
                    ),
                },
            )
        effective = max(request.indicator_warmup_bars, visible_rows)
    else:
        # ALL_AVAILABLE is a chart-navigation contract.  Source gaps before the
        # selected execution segment remain explicit empty ranges; they must not
        # silently turn the latest continuous segment into the listing boundary.
        visible_start_ms = source_start_ms
        distance = selected_start_ms - visible_start_ms
        if distance < 0 or distance % interval_ms:
            raise TrainingRunError(
                "VISIBLE_HISTORY_COVERAGE_UNAVAILABLE",
                "all-available history boundary is not base-interval aligned",
                status_code=409,
            )
        visible_rows = distance // interval_ms
        # ALL_AVAILABLE is a chart navigation boundary, not an instruction to
        # materialize the entire preceding market history into the execution
        # snapshot. Older pages are read lazily through the replay service.
        effective = request.indicator_warmup_bars
    forward_rows = (request.forward_cache_ms + interval_ms - 1) // interval_ms
    estimated_total = effective + forward_rows + 1
    if estimated_total > max_dataset_rows:
        raise TrainingRunError(
            "VISIBLE_HISTORY_BUDGET_EXCEEDED",
            "execution warmup and forward cache exceed the immutable dataset budget",
            status_code=409,
            details={
                "estimated_rows": estimated_total,
                "max_dataset_rows": max_dataset_rows,
            },
        )
    return ResolvedHistoryPolicy(
        indicator_warmup_bars=request.indicator_warmup_bars,
        visible_history_mode=visible.mode,
        visible_history_lookback_ms=visible.duration_ms,
        visible_history_rows=visible_rows,
        actual_visible_history_start_ms=visible_start_ms,
        actual_replay_start_ms=selected_start_ms,
        effective_warmup_bars=effective,
        forward_cache_ms=request.forward_cache_ms,
        interval_ms=interval_ms,
    )


class ReplaySegmentManager:
    """Own replay-only files while SQLite remains the serialization authority."""

    def __init__(
        self,
        store: ReplaySQLiteStore,
        *,
        root: Path | None = None,
        download_worker_enabled: bool = False,
        auto_gc_enabled: bool = False,
        max_archive_bytes: int = 1_099_511_627_776,
        file_is_regular: Callable[[Path], bool] | None = None,
    ) -> None:
        self.store = store
        self.root = (
            root
            if root is not None
            else store.path.parent / f"{store.path.stem}-segments"
        ).resolve()
        self.download_worker_enabled = bool(download_worker_enabled)
        self.auto_gc_enabled = bool(auto_gc_enabled)
        if (
            isinstance(max_archive_bytes, bool)
            or not isinstance(max_archive_bytes, int)
            or max_archive_bytes < 1
        ):
            raise ValueError("max_archive_bytes must be a positive integer")
        self.max_archive_bytes = max_archive_bytes
        self._file_is_regular = file_is_regular or (
            lambda path: path.is_file() and not path.is_symlink()
        )
        self._singleflight: dict[str, asyncio.Task[dict[str, object]]] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._task_lock = asyncio.Lock()
        self._gc_lock = asyncio.Lock()

    async def start(self) -> None:
        await self._recover_reclaims()
        await self._recover_interrupted_prepares()
        await asyncio.to_thread(self._cleanup_stale_files)

    async def shutdown(self) -> None:
        async with self._task_lock:
            tasks = tuple(self._singleflight.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def plan_for_request(
        self,
        request: TrainingRunCreateRequest,
        *,
        max_dataset_rows: int,
    ) -> dict[str, object]:
        interval_ms = parse_interval_ms(request.base_interval)
        if interval_ms is None:
            raise ValueError("base_interval must be a fixed replay interval")
        visible = request.visible_history_lookback
        assert visible is not None
        block_reason: str | None = None
        estimate_kind = "EXACT"
        if visible.mode is VisibleHistoryMode.DURATION:
            assert visible.duration_ms is not None
            if visible.duration_ms % interval_ms:
                visible_rows: int | None = None
                effective_warmup = request.indicator_warmup_bars
                block_reason = "VISIBLE_HISTORY_INTERVAL_MISMATCH"
            else:
                visible_rows = visible.duration_ms // interval_ms
                effective_warmup = max(
                    request.indicator_warmup_bars,
                    visible_rows,
                )
        else:
            visible_rows = None
            effective_warmup = request.indicator_warmup_bars
            estimate_kind = "SELECTION_DEPENDENT"
        forward_rows = (
            request.forward_cache_ms + interval_ms - 1
        ) // interval_ms
        estimated_rows = effective_warmup + forward_rows + 1
        if block_reason is None and estimated_rows > max_dataset_rows:
            block_reason = "VISIBLE_HISTORY_BUDGET_EXCEEDED"
        bytes_per_row = 320 if request.source_kind.value == "AGG_TRADE" else 240
        estimated_size = estimated_rows * bytes_per_row

        def read(connection: sqlite3.Connection) -> tuple[int, int]:
            row = connection.execute(
                """
                SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes
                FROM replay_data_segment
                WHERE source_kind = ? AND exchange = ? AND market_type = ?
                  AND symbol = ? AND COALESCE(base_interval, '') = ?
                  AND health = 'READY'
                """,
                (
                    request.source_kind.value,
                    request.exchange,
                    request.market_type,
                    request.symbol,
                    request.base_interval,
                ),
            ).fetchone()
            assert row is not None
            return int(row["count"]), int(row["bytes"])

        ready_count, ready_bytes = await self.store.run_extension_read(read)
        action = (
            "VERIFY_LOCAL_AGG_TRADE"
            if request.source_kind.value == "AGG_TRADE"
            else "SNAPSHOT_LOCAL_BAR_RANGE"
        )
        return {
            "protocol": PREPARE_PROTOCOL,
            "state": "PREPARE_ON_CREATE",
            "source_kind": request.source_kind.value,
            "identity": {
                "exchange": request.exchange,
                "market_type": request.market_type,
                "symbol": request.symbol,
                "base_interval": request.base_interval,
            },
            "estimated_size_bytes": estimated_size,
            "estimated_rows": estimated_rows,
            "history_policy": {
                "schema_version": DATA_POLICY_PROTOCOL,
                "indicator_warmup_bars": request.indicator_warmup_bars,
                "visible_history_lookback": visible.to_dict(),
                "visible_history_rows_estimate": visible_rows,
                "effective_warmup_bars_estimate": effective_warmup,
                "forward_cache_ms": request.forward_cache_ms,
                "forward_rows_estimate": forward_rows,
                "estimate_kind": estimate_kind,
                "max_dataset_rows": max_dataset_rows,
                "accepted": block_reason is None,
                "blocked_reason": block_reason,
            },
            "prepare_action": action,
            "existing_ready_segments": ready_count,
            "existing_ready_bytes": ready_bytes,
            "selection_loads_history": False,
            "create_loads_only_selected_range": True,
            "download_worker_enabled": self.download_worker_enabled,
            "auto_gc_enabled": self.auto_gc_enabled,
            "failure_policy": "QUARANTINE_AND_FAIL_CLOSED",
        }

    async def list_segments(
        self,
        *,
        run_id: str | None = None,
        redact_ranges: bool = False,
    ) -> dict[str, object]:
        def read(connection: sqlite3.Connection) -> tuple[sqlite3.Row, ...]:
            where = ""
            params: tuple[object, ...] = ()
            if run_id is not None:
                where = "WHERE EXISTS(SELECT 1 FROM replay_data_segment_ref AS rr WHERE rr.segment_id = s.segment_id AND rr.run_id = ?)"
                params = (run_id,)
            return tuple(
                connection.execute(
                    f"""
                    SELECT s.*,
                           (SELECT COUNT(*) FROM replay_data_segment_ref AS r
                            WHERE r.segment_id = s.segment_id AND r.active = 1) AS ref_count
                    FROM replay_data_segment AS s
                    {where}
                    ORDER BY s.last_used_at_ms DESC, s.segment_id
                    """,
                    params,
                ).fetchall()
            )

        rows = await self.store.run_extension_read(read)
        items = [self._public_segment(row, redact_ranges=redact_ranges) for row in rows]
        return {
            "protocol": SEGMENT_PROTOCOL,
            "items": items,
            "summary": {
                "segment_count": len(items),
                "ready_count": sum(item["health"] == "READY" for item in items),
                "quarantined_count": sum(item["health"] == "QUARANTINED" for item in items),
                "local_bytes": sum(
                    _integer(item["byte_size"], "segment byte_size") for item in items
                ),
            },
            "workers": {
                "download_enabled": self.download_worker_enabled,
                "auto_gc_enabled": self.auto_gc_enabled,
            },
        }

    async def prepare_external(
        self,
        spec: SegmentPrepareSpec,
        producer: Callable[[Path], Awaitable[None] | None],
    ) -> dict[str, object]:
        segment_id, identity_key = spec.identity()
        async with self._task_lock:
            task = self._singleflight.get(identity_key)
            if task is None:
                task = asyncio.create_task(
                    self._prepare_external_once(spec, producer),
                    name=f"replay-segment-prepare-{segment_id}",
                )
                self._singleflight[identity_key] = task
        try:
            return await asyncio.shield(task)
        finally:
            if task.done():
                async with self._task_lock:
                    if self._singleflight.get(identity_key) is task:
                        self._singleflight.pop(identity_key, None)

    async def cancel_prepare(self, job_id: str) -> dict[str, object]:
        event = self._cancel_events.get(job_id)
        if event is not None:
            event.set()

        def write(connection: sqlite3.Connection) -> sqlite3.Row | None:
            connection.execute(
                """
                UPDATE replay_data_prepare_job
                SET cancel_requested = 1, updated_at_ms = ?
                WHERE job_id = ? AND state IN ('PLANNED', 'LOADING', 'VALIDATING', 'PUBLISHING')
                """,
                (self.store._validated_now_ms(), job_id),
            )
            return connection.execute(
                "SELECT * FROM replay_data_prepare_job WHERE job_id = ?",
                (job_id,),
            ).fetchone()

        row = await self.store.run_extension_write(write)
        if row is None:
            raise TrainingRunError(
                "SEGMENT_PREPARE_NOT_FOUND",
                "replay segment prepare job does not exist",
                status_code=404,
            )
        return self._public_job(row)

    async def get_prepare_job(self, job_id: str) -> dict[str, object]:
        row = await self.store.run_extension_read(
            lambda connection: connection.execute(
                "SELECT * FROM replay_data_prepare_job WHERE job_id = ?",
                (job_id,),
            ).fetchone()
        )
        if row is None:
            raise TrainingRunError(
                "SEGMENT_PREPARE_NOT_FOUND",
                "replay segment prepare job does not exist",
                status_code=404,
            )
        return self._public_job(row)

    async def gc_plan(
        self,
        *,
        target_reclaim_bytes: int,
        max_segments: int,
        audit: bool = True,
    ) -> dict[str, object]:
        if isinstance(target_reclaim_bytes, bool) or not isinstance(target_reclaim_bytes, int):
            raise TypeError("target_reclaim_bytes must be an integer")
        if not 1 <= target_reclaim_bytes <= 1_000_000_000_000:
            raise ValueError("target_reclaim_bytes must be between 1 and 1000000000000")
        if isinstance(max_segments, bool) or not isinstance(max_segments, int) or not 1 <= max_segments <= 10_000:
            raise ValueError("max_segments must be between 1 and 10000")

        def read(
            connection: sqlite3.Connection,
        ) -> tuple[
            tuple[sqlite3.Row, ...],
            int,
            tuple[sqlite3.Row, ...],
            frozenset[str],
        ]:
            rows = tuple(
                connection.execute(
                    """
                    SELECT * FROM replay_data_segment
                    WHERE health = 'READY'
                    ORDER BY last_used_at_ms, segment_id
                    """
                ).fetchall()
            )
            total = connection.execute(
                """
                SELECT COALESCE(SUM(byte_size), 0) AS bytes
                FROM replay_data_segment
                WHERE health = 'READY' AND storage_kind = 'EXTERNAL_REPLAY_OWNED'
                """
            ).fetchone()
            assert total is not None
            refs = tuple(
                connection.execute(
                    """
                    SELECT r.segment_id, r.run_id, r.owner_kind, r.active,
                           s.state AS session_state,
                           EXISTS(SELECT 1 FROM replay_review_session AS review
                                  WHERE review.run_id = r.run_id) AS has_review,
                           EXISTS(SELECT 1 FROM replay_training_market_track AS t
                                  WHERE t.run_id = r.run_id
                                    AND TRIM(CAST(COALESCE(
                                        json_extract(t.position_json, '$.quantity'), '0'
                                    ) AS TEXT), '0.-') != '') AS has_position
                    FROM replay_data_segment_ref AS r
                    LEFT JOIN replay_training_run AS tr ON tr.run_id = r.run_id
                    LEFT JOIN replay_session AS s ON s.session_id = tr.adapter_session_id
                    """
                ).fetchall()
            )
            preparing = frozenset(
                str(row["segment_id"])
                for row in connection.execute(
                    """
                    SELECT DISTINCT segment_id FROM replay_data_prepare_job
                    WHERE segment_id IS NOT NULL
                      AND state IN ('LOADING', 'VALIDATING', 'PUBLISHING')
                    """
                ).fetchall()
            )
            return rows, int(total["bytes"]), refs, preparing

        rows, total_bytes, refs, preparing = await self.store.run_extension_read(read)
        protections_by_segment: dict[str, set[str]] = {}
        runs_by_segment: dict[str, set[str]] = {}
        for ref in refs:
            segment_id = str(ref["segment_id"])
            reasons = protections_by_segment.setdefault(segment_id, set())
            runs_by_segment.setdefault(segment_id, set()).add(str(ref["run_id"]))
            if bool(ref["active"]) and ref["owner_kind"] in {"ACTOR", "REVIEW", "RECOVERY"}:
                reasons.add(f"ACTIVE_{ref['owner_kind']}")
            if ref["session_state"] in {"PLAYING", "ADVANCING", "INITIALIZING"}:
                reasons.add("ACTIVE_RUN")
            if bool(ref["has_review"]):
                reasons.add("REVIEW_OPEN")
            if bool(ref["has_position"]):
                reasons.add("OPEN_POSITION")
        for segment_id in preparing:
            protections_by_segment.setdefault(segment_id, set()).add("PREPARE_IN_FLIGHT")

        candidates: list[dict[str, object]] = []
        protected: list[dict[str, object]] = []
        reclaimed = 0
        for row in rows:
            segment_id = str(row["segment_id"])
            segment_reasons = list(protections_by_segment.get(segment_id, ()))
            affected_runs = sorted(runs_by_segment.get(segment_id, ()))
            if row["storage_kind"] != "EXTERNAL_REPLAY_OWNED":
                segment_reasons.append("STORAGE_NOT_REPLAY_OWNED")
            if not bool(row["rebuildable"]):
                segment_reasons.append("NON_REBUILDABLE")
            owned_object_issue = self._owned_object_issue(row)
            if owned_object_issue is not None:
                segment_reasons.append(owned_object_issue)
            segment_reasons = sorted(set(segment_reasons))
            item = {
                "segment_id": str(row["segment_id"]),
                "generation": int(row["generation"]),
                "byte_size": int(row["byte_size"]),
                "last_used_at_ms": int(row["last_used_at_ms"]),
                "checksum_sha256": str(row["checksum_sha256"]),
                "affected_run_ids": affected_runs,
                "recoverability": "TRUSTED_MANIFEST_CHECKSUM_BOUND",
            }
            if segment_reasons:
                protected.append({**item, "protection_reasons": segment_reasons})
                continue
            if len(candidates) >= max_segments:
                break
            if reclaimed >= target_reclaim_bytes:
                break
            candidates.append(item)
            reclaimed += int(row["byte_size"])
        request = {
            "target_reclaim_bytes": target_reclaim_bytes,
            "max_segments": max_segments,
        }
        plan_hash = canonical_sha256(
            {
                "protocol": GC_PROTOCOL,
                "request": request,
                "candidates": candidates,
            }
        )
        plan = {
            "protocol": GC_PROTOCOL,
            "mode": "DRY_RUN",
            "plan_hash": plan_hash,
            "request": request,
            "current_external_bytes": total_bytes,
            "estimated_reclaim_bytes": reclaimed,
            "candidates": candidates,
            "protected": protected,
            "non_rebuildable_auto_reclaimed": False,
        }
        if audit:
            await self._audit("DRY_RUN", plan_hash, request, plan)
        return plan

    async def gc_run(
        self,
        *,
        plan_hash: str,
        target_reclaim_bytes: int,
        max_segments: int,
    ) -> dict[str, object]:
        async with self._gc_lock:
            plan = await self.gc_plan(
                target_reclaim_bytes=target_reclaim_bytes,
                max_segments=max_segments,
                audit=False,
            )
            if plan["plan_hash"] != plan_hash:
                raise TrainingRunError(
                    "SEGMENT_GC_PLAN_CHANGED",
                    "replay segment GC plan changed; run dry-run again",
                    status_code=409,
                    details={"current_plan_hash": plan["plan_hash"]},
                )
            reclaimed: list[dict[str, object]] = []
            skipped: list[dict[str, object]] = []
            candidate_values = plan["candidates"]
            if not isinstance(candidate_values, list):
                raise RuntimeError("segment GC plan candidates are malformed")
            for candidate in candidate_values:
                assert isinstance(candidate, Mapping)
                result = await self._reclaim_candidate(candidate)
                (reclaimed if result["reclaimed"] else skipped).append(result)
            result = {
                "protocol": GC_PROTOCOL,
                "mode": "RUN",
                "plan_hash": plan_hash,
                "request": plan["request"],
                "reclaimed": reclaimed,
                "skipped": skipped,
                "reclaimed_bytes": sum(
                    _integer(item["byte_size"], "reclaimed byte_size")
                    for item in reclaimed
                ),
                "exact_dry_run_set": not skipped,
            }
            await self._audit("RUN", plan_hash, plan["request"], result)
            return result

    async def rehydrate(self, segment_id: str) -> dict[str, object]:
        row = await self.store.run_extension_read(
            lambda connection: connection.execute(
                "SELECT * FROM replay_data_segment WHERE segment_id = ?",
                (segment_id,),
            ).fetchone()
        )
        if row is None:
            raise TrainingRunError(
                "SEGMENT_NOT_FOUND", "replay data segment does not exist", status_code=404
            )
        if row["health"] == "READY":
            owned_object_issue = self._owned_object_issue(row)
            if owned_object_issue is None:
                return self._public_segment(row, redact_ranges=False)
            await self._mark_quarantined(segment_id, owned_object_issue)
        if row["health"] in {"LOADING", "RECLAIMING"}:
            raise TrainingRunError(
                "SEGMENT_BUSY",
                "replay data segment has an in-flight ownership transition",
                status_code=409,
            )
        if not bool(row["rebuildable"]):
            raise TrainingRunError(
                "SEGMENT_NOT_REBUILDABLE",
                "replay data segment has no deterministic rehydration proof",
                status_code=409,
            )
        manifest = json.loads(str(row["rehydration_manifest_json"]))
        trusted_file = manifest.get("trusted_file")
        if not isinstance(trusted_file, str):
            raise TrainingRunError(
                "SEGMENT_REHYDRATOR_UNAVAILABLE",
                "no enabled rehydrator can satisfy this trusted manifest",
                status_code=503,
            )
        trusted_path = Path(trusted_file).expanduser()
        if trusted_path.is_symlink():
            raise TrainingRunError(
                "SEGMENT_SOURCE_UNAVAILABLE",
                "trusted replay segment source must not be a symlink",
                status_code=409,
            )
        source = trusted_path.resolve()
        if (
            not source.is_file()
            or source.is_symlink()
            or source == self.root
            or source.is_relative_to(self.root)
        ):
            raise TrainingRunError(
                "SEGMENT_SOURCE_UNAVAILABLE",
                "trusted replay segment source is unavailable",
                status_code=409,
            )
        self._ensure_dirs()
        temp = self.root / ".tmp" / f"rehydrate-{uuid.uuid4().hex}.part"
        final_relative = f"objects/{segment_id}.blob"
        final = self._owned_path(final_relative)
        try:
            await asyncio.to_thread(shutil.copyfile, source, temp)
            checksum = await asyncio.to_thread(self._file_checksum, temp)
        except OSError as exc:
            if temp.exists():
                temp.unlink()
            raise TrainingRunError(
                "SEGMENT_REHYDRATION_FAILED",
                "trusted replay segment could not be copied into owned storage",
                status_code=409,
                details={"reason": type(exc).__name__},
            ) from exc
        if checksum != row["checksum_sha256"]:
            quarantine = self.root / ".quarantine" / f"{segment_id}-{uuid.uuid4().hex}.bad"
            os.replace(temp, quarantine)
            await self._mark_quarantined(segment_id, "REHYDRATION_CHECKSUM_MISMATCH")
            raise TrainingRunError(
                "SEGMENT_CHECKSUM_MISMATCH",
                "rehydrated replay segment failed checksum validation",
                status_code=409,
            )
        async with self._gc_lock:
            try:
                await self._assert_storage_budget(
                    incoming_bytes=temp.stat().st_size,
                    excluding_segment_id=segment_id,
                )
            except BaseException:
                temp.unlink(missing_ok=True)
                raise
            try:
                os.replace(temp, final)
            except OSError as exc:
                if temp.exists():
                    temp.unlink()
                raise TrainingRunError(
                    "SEGMENT_REHYDRATION_FAILED",
                    "validated replay segment could not be published",
                    status_code=409,
                    details={"reason": type(exc).__name__},
                ) from exc
            now = self.store._validated_now_ms()

            def publish(connection: sqlite3.Connection) -> None:
                cursor = connection.execute(
                    """
                    UPDATE replay_data_segment
                    SET health = 'READY', local_path = ?, byte_size = ?,
                        quarantine_reason = NULL, generation = generation + 1,
                        last_used_at_ms = ?, updated_at_ms = ?
                    WHERE segment_id = ? AND rebuildable = 1
                      AND health NOT IN ('LOADING', 'RECLAIMING')
                    """,
                    (
                        final_relative,
                        final.stat().st_size,
                        now,
                        now,
                        segment_id,
                    ),
                )
                if cursor.rowcount != 1:
                    raise RuntimeError(
                        "segment rehydration claim changed before commit"
                    )

            try:
                await self.store.run_extension_write(publish)
            except BaseException:
                final.unlink(missing_ok=True)
                raise
        refreshed = await self.store.run_extension_read(
            lambda connection: connection.execute(
                "SELECT * FROM replay_data_segment WHERE segment_id = ?", (segment_id,)
            ).fetchone()
        )
        assert refreshed is not None
        return self._public_segment(refreshed, redact_ranges=False)

    async def _prepare_external_once(
        self,
        spec: SegmentPrepareSpec,
        producer: Callable[[Path], Awaitable[None] | None],
    ) -> dict[str, object]:
        segment_id, identity_key = spec.identity()
        existing = await self.store.run_extension_read(
            lambda connection: connection.execute(
                "SELECT * FROM replay_data_segment WHERE identity_key = ?", (identity_key,)
            ).fetchone()
        )
        if existing is not None and existing["health"] == "READY":
            owned_object_issue = self._owned_object_issue(existing)
            if owned_object_issue is None:
                return self._public_segment(existing, redact_ranges=False)
            await self._mark_quarantined(segment_id, owned_object_issue)
        self._ensure_dirs()
        job_id = f"prepare-{uuid.uuid4().hex}"
        cancel_event = asyncio.Event()
        self._cancel_events[job_id] = cancel_event
        temp_relative = f".tmp/{job_id}.part"
        temp = self._owned_path(temp_relative)
        final_relative = f"objects/{segment_id}.blob"
        final = self._owned_path(final_relative)
        now = self.store._validated_now_ms()

        def begin(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                INSERT INTO replay_data_segment(
                    segment_id, identity_key, protocol, source_kind, adapter_kind,
                    exchange, market_type, symbol, base_interval,
                    range_start_ms, range_end_ms, schema_version, dataset_epoch,
                    checksum_sha256, coverage_state, continuity_state, health,
                    storage_kind, local_path, byte_size, rebuildable, trusted_origin,
                    rehydration_manifest_json, quarantine_reason, generation,
                    reclaim_token, last_used_at_ms, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXACT',
                          'CONTIGUOUS', 'LOADING', 'EXTERNAL_REPLAY_OWNED', NULL,
                          ?, 1, ?, ?, NULL, 1, NULL, ?, ?, ?)
                ON CONFLICT(identity_key) DO UPDATE SET
                    source_kind = excluded.source_kind,
                    adapter_kind = excluded.adapter_kind,
                    exchange = excluded.exchange,
                    market_type = excluded.market_type,
                    symbol = excluded.symbol,
                    base_interval = excluded.base_interval,
                    range_start_ms = excluded.range_start_ms,
                    range_end_ms = excluded.range_end_ms,
                    schema_version = excluded.schema_version,
                    dataset_epoch = excluded.dataset_epoch,
                    checksum_sha256 = excluded.checksum_sha256,
                    coverage_state = excluded.coverage_state,
                    continuity_state = excluded.continuity_state,
                    health = 'LOADING',
                    storage_kind = 'EXTERNAL_REPLAY_OWNED',
                    local_path = NULL,
                    byte_size = excluded.byte_size,
                    rebuildable = 1,
                    trusted_origin = excluded.trusted_origin,
                    rehydration_manifest_json = excluded.rehydration_manifest_json,
                    quarantine_reason = NULL,
                    reclaim_token = NULL,
                    last_used_at_ms = excluded.last_used_at_ms,
                    updated_at_ms = excluded.updated_at_ms
                """,
                (
                    segment_id, identity_key, SEGMENT_PROTOCOL, spec.source_kind,
                    spec.adapter_kind, spec.exchange, spec.market_type, spec.symbol,
                    spec.base_interval, spec.range_start_ms, spec.range_end_ms,
                    spec.schema_version, spec.dataset_epoch, spec.checksum_sha256,
                    spec.byte_size, spec.trusted_origin,
                    canonical_json(spec.rehydration_manifest), now, now, now,
                ),
            )
            connection.execute(
                """
                INSERT INTO replay_data_prepare_job(
                    job_id, identity_key, request_hash, state,
                    progress_numerator, progress_denominator, segment_id,
                    run_id, track_id, failure_reason, cancel_requested,
                    temp_path, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, 'LOADING', 0, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?)
                """,
                (
                    job_id, identity_key,
                    canonical_sha256(spec.rehydration_manifest),
                    max(spec.byte_size, 1), segment_id, temp_relative, now, now,
                ),
            )

        await self.store.run_extension_write(begin)
        try:
            manifest_mismatch = spec.manifest_mismatch()
            if manifest_mismatch is not None:
                await self._mark_quarantined(
                    segment_id,
                    manifest_mismatch,
                    job_id=job_id,
                )
                raise TrainingRunError(
                    "SEGMENT_MANIFEST_MISMATCH",
                    "replay segment manifest does not match the requested immutable identity",
                    status_code=409,
                    details={"reason": manifest_mismatch},
                )
            produced = producer(temp)
            if inspect.isawaitable(produced):
                await produced
            if cancel_event.is_set() or await self._cancel_requested(job_id):
                raise asyncio.CancelledError
            await self._set_job_state(job_id, "VALIDATING", spec.byte_size, max(spec.byte_size, 1))
            if not self._file_is_regular(temp):
                raise RuntimeError("segment producer did not publish a regular file")
            actual_size = temp.stat().st_size
            actual_checksum = await asyncio.to_thread(self._file_checksum, temp)
            if actual_checksum != spec.checksum_sha256 or actual_size != spec.byte_size:
                quarantine = self.root / ".quarantine" / f"{segment_id}-{job_id}.bad"
                os.replace(temp, quarantine)
                reason = (
                    "CHECKSUM_MISMATCH"
                    if actual_checksum != spec.checksum_sha256
                    else "SIZE_MISMATCH"
                )
                await self._mark_quarantined(segment_id, reason, job_id=job_id)
                raise TrainingRunError(
                    "SEGMENT_CHECKSUM_MISMATCH",
                    "prepared replay segment failed immutable validation",
                    status_code=409,
                    details={"reason": reason},
                )
            await self._set_job_state(job_id, "PUBLISHING", actual_size, max(actual_size, 1))
            if cancel_event.is_set() or await self._cancel_requested(job_id):
                raise asyncio.CancelledError
            async with self._gc_lock:
                try:
                    await self._assert_storage_budget(
                        incoming_bytes=actual_size,
                        excluding_segment_id=segment_id,
                    )
                except TrainingRunError as exc:
                    temp.unlink(missing_ok=True)
                    await self._set_job_state(
                        job_id,
                        "ERROR",
                        0,
                        max(actual_size, 1),
                        failure_reason=exc.code,
                    )
                    await self._set_segment_health(
                        segment_id,
                        "ERROR",
                        exc.code,
                    )
                    raise
                os.replace(temp, final)
                published = self.store._validated_now_ms()

                def finish(connection: sqlite3.Connection) -> sqlite3.Row:
                    cursor = connection.execute(
                        """
                        UPDATE replay_data_segment
                        SET health = 'READY', local_path = ?, byte_size = ?,
                            generation = generation + 1, last_used_at_ms = ?,
                            updated_at_ms = ?, quarantine_reason = NULL
                        WHERE identity_key = ? AND health = 'LOADING'
                        """,
                        (
                            final_relative,
                            actual_size,
                            published,
                            published,
                            identity_key,
                        ),
                    )
                    if cursor.rowcount != 1:
                        raise RuntimeError(
                            "segment publication claim changed before commit"
                        )
                    connection.execute(
                        """
                        UPDATE replay_data_prepare_job
                        SET state = 'READY', progress_numerator = progress_denominator,
                            temp_path = NULL, updated_at_ms = ?
                        WHERE job_id = ?
                        """,
                        (published, job_id),
                    )
                    row = connection.execute(
                        "SELECT * FROM replay_data_segment WHERE identity_key = ?",
                        (identity_key,),
                    ).fetchone()
                    assert row is not None
                    return row

                try:
                    row = await self.store.run_extension_write(finish)
                except BaseException:
                    final.unlink(missing_ok=True)
                    raise
            return self._public_segment(row, redact_ranges=False)
        except asyncio.CancelledError:
            if temp.exists():
                temp.unlink()
            await self._set_job_state(job_id, "CANCELED", 0, max(spec.byte_size, 1))
            await self._set_segment_health(segment_id, "CANCELED", "CANCELED")
            raise
        except TrainingRunError:
            raise
        except BaseException as exc:
            if temp.exists():
                temp.unlink()
            await self._set_job_state(
                job_id,
                "ERROR",
                0,
                max(spec.byte_size, 1),
                failure_reason=type(exc).__name__,
            )
            await self._set_segment_health(segment_id, "ERROR", type(exc).__name__)
            raise
        finally:
            self._cancel_events.pop(job_id, None)

    async def _assert_storage_budget(
        self,
        *,
        incoming_bytes: int,
        excluding_segment_id: str | None,
    ) -> None:
        local_bytes = await self.store.run_extension_read(
            lambda connection: int(
                connection.execute(
                    """
                    SELECT COALESCE(SUM(byte_size), 0)
                    FROM replay_data_segment
                    WHERE storage_kind = 'EXTERNAL_REPLAY_OWNED'
                      AND local_path IS NOT NULL
                      AND (? IS NULL OR segment_id != ?)
                    """,
                    (excluding_segment_id, excluding_segment_id),
                ).fetchone()[0]
            )
        )
        if local_bytes + incoming_bytes > self.max_archive_bytes:
            raise TrainingRunError(
                "SEGMENT_STORAGE_BUDGET_EXCEEDED",
                "replay segment storage budget would be exceeded",
                status_code=409,
                details={
                    "current_local_bytes": local_bytes,
                    "incoming_bytes": incoming_bytes,
                    "max_archive_bytes": self.max_archive_bytes,
                },
            )

    async def _protection_reasons(self, segment_id: str) -> tuple[list[str], list[str]]:
        def read(connection: sqlite3.Connection) -> tuple[tuple[sqlite3.Row, ...], bool]:
            refs = tuple(
                connection.execute(
                    """
                    SELECT r.run_id, r.owner_kind, r.active,
                           s.state AS session_state,
                           EXISTS(SELECT 1 FROM replay_review_session AS review
                                  WHERE review.run_id = r.run_id) AS has_review,
                           EXISTS(SELECT 1 FROM replay_training_market_track AS t
                                  WHERE t.run_id = r.run_id
                                    AND TRIM(CAST(COALESCE(
                                        json_extract(t.position_json, '$.quantity'), '0'
                                    ) AS TEXT), '0.-') != '') AS has_position
                    FROM replay_data_segment_ref AS r
                    LEFT JOIN replay_training_run AS tr ON tr.run_id = r.run_id
                    LEFT JOIN replay_session AS s ON s.session_id = tr.adapter_session_id
                    WHERE r.segment_id = ?
                    """,
                    (segment_id,),
                ).fetchall()
            )
            preparing = connection.execute(
                """
                SELECT 1 FROM replay_data_prepare_job
                WHERE segment_id = ? AND state IN ('LOADING', 'VALIDATING', 'PUBLISHING')
                LIMIT 1
                """,
                (segment_id,),
            ).fetchone() is not None
            return refs, preparing

        refs, preparing = await self.store.run_extension_read(read)
        reasons: set[str] = set()
        runs = sorted({str(row["run_id"]) for row in refs})
        if preparing:
            reasons.add("PREPARE_IN_FLIGHT")
        for row in refs:
            if bool(row["active"]) and row["owner_kind"] in {"ACTOR", "REVIEW", "RECOVERY"}:
                reasons.add(f"ACTIVE_{row['owner_kind']}")
            if row["session_state"] in {"PLAYING", "ADVANCING", "INITIALIZING"}:
                reasons.add("ACTIVE_RUN")
            if bool(row["has_review"]):
                reasons.add("REVIEW_OPEN")
            if bool(row["has_position"]):
                reasons.add("OPEN_POSITION")
        return sorted(reasons), runs

    async def _reclaim_candidate(self, candidate: Mapping[str, object]) -> dict[str, object]:
        segment_id = str(candidate["segment_id"])
        generation = _integer(candidate["generation"], "segment generation")
        reasons, _ = await self._protection_reasons(segment_id)
        if reasons:
            return {
                "segment_id": segment_id,
                "reclaimed": False,
                "byte_size": 0,
                "reason": "PROTECTION_CHANGED",
                "protection_reasons": reasons,
            }
        token = uuid.uuid4().hex
        now = self.store._validated_now_ms()

        def claim(connection: sqlite3.Connection) -> sqlite3.Row | None:
            connection.execute(
                """
                UPDATE replay_data_segment
                SET health = 'RECLAIMING', reclaim_token = ?,
                    generation = generation + 1, updated_at_ms = ?
                WHERE segment_id = ? AND generation = ? AND health = 'READY'
                  AND storage_kind = 'EXTERNAL_REPLAY_OWNED' AND rebuildable = 1
                  AND NOT EXISTS(
                      SELECT 1 FROM replay_data_prepare_job AS j
                      WHERE j.segment_id = replay_data_segment.segment_id
                        AND j.state IN ('LOADING', 'VALIDATING', 'PUBLISHING')
                  )
                  AND NOT EXISTS(
                      SELECT 1 FROM replay_data_segment_ref AS r
                      LEFT JOIN replay_training_run AS tr ON tr.run_id = r.run_id
                      LEFT JOIN replay_session AS s ON s.session_id = tr.adapter_session_id
                      WHERE r.segment_id = replay_data_segment.segment_id
                        AND (
                            (r.active = 1 AND r.owner_kind IN ('ACTOR', 'REVIEW', 'RECOVERY'))
                            OR s.state IN ('PLAYING', 'ADVANCING', 'INITIALIZING')
                            OR EXISTS(
                                SELECT 1 FROM replay_review_session AS review
                                WHERE review.run_id = r.run_id
                            )
                            OR EXISTS(
                                SELECT 1 FROM replay_training_market_track AS t
                                WHERE t.run_id = r.run_id
                                  AND TRIM(CAST(COALESCE(
                                      json_extract(t.position_json, '$.quantity'), '0'
                                  ) AS TEXT), '0.-') != ''
                            )
                        )
                  )
                """,
                (token, now, segment_id, generation),
            )
            return connection.execute(
                "SELECT * FROM replay_data_segment WHERE segment_id = ? AND reclaim_token = ?",
                (segment_id, token),
            ).fetchone()

        row = await self.store.run_extension_write(claim)
        if row is None:
            return {
                "segment_id": segment_id,
                "reclaimed": False,
                "byte_size": 0,
                "reason": "GENERATION_CHANGED",
            }
        relative = row["local_path"]
        if not isinstance(relative, str):
            await self._mark_quarantined(segment_id, "OWNED_PATH_MISSING")
            return {
                "segment_id": segment_id,
                "reclaimed": False,
                "byte_size": 0,
                "reason": "OWNED_PATH_MISSING",
            }
        if relative != f"objects/{segment_id}.blob":
            await self._mark_quarantined(segment_id, "OWNED_PATH_INVALID")
            return {
                "segment_id": segment_id,
                "reclaimed": False,
                "byte_size": 0,
                "reason": "OWNED_PATH_INVALID",
            }
        try:
            source = self._owned_path(relative)
            trash_relative = f".trash/{segment_id}-{token}.trash"
            trash = self._owned_path(trash_relative)
        except ValueError:
            await self._mark_quarantined(segment_id, "OWNED_PATH_INVALID")
            return {
                "segment_id": segment_id,
                "reclaimed": False,
                "byte_size": 0,
                "reason": "OWNED_PATH_INVALID",
            }
        try:
            if not self._file_is_regular(source):
                reason = (
                    "LOCAL_OBJECT_NOT_REGULAR"
                    if source.exists()
                    else "LOCAL_OBJECT_MISSING"
                )
                await self._mark_quarantined(segment_id, reason)
                return {
                    "segment_id": segment_id,
                    "reclaimed": False,
                    "byte_size": 0,
                    "reason": reason,
                }
            await asyncio.to_thread(os.replace, source, trash)
        except OSError as exc:
            await self._restore_reclaim_state(segment_id, token, type(exc).__name__)
            return {
                "segment_id": segment_id,
                "reclaimed": False,
                "byte_size": 0,
                "reason": type(exc).__name__,
            }
        finished = self.store._validated_now_ms()

        def finalize(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                UPDATE replay_data_segment
                SET health = 'EVICTED', local_path = NULL, byte_size = 0,
                    reclaim_token = NULL, updated_at_ms = ?
                WHERE segment_id = ? AND reclaim_token = ? AND health = 'RECLAIMING'
                """,
                (finished, segment_id, token),
            )

        await self.store.run_extension_write(finalize)
        if trash.exists() and not trash.is_dir():
            try:
                await asyncio.to_thread(trash.unlink)
            except OSError:
                pass
        return {
            "segment_id": segment_id,
            "reclaimed": True,
            "byte_size": _integer(candidate["byte_size"], "segment byte_size"),
            "reason": "REHYDRATION_MANIFEST_RETAINED",
        }

    async def _recover_reclaims(self) -> None:
        rows = await self.store.run_extension_read(
            lambda connection: tuple(
                connection.execute(
                    "SELECT * FROM replay_data_segment WHERE health = 'RECLAIMING'"
                ).fetchall()
            )
        )
        if not rows:
            return
        self._ensure_dirs()
        recovered: list[str] = []
        quarantined: list[str] = []
        for row in rows:
            segment_id = str(row["segment_id"])
            token = str(row["reclaim_token"] or "")
            relative = row["local_path"]
            if not token or not isinstance(relative, str):
                await self._mark_quarantined(segment_id, "RECLAIM_RECOVERY_METADATA_INVALID")
                quarantined.append(segment_id)
                continue
            if relative != f"objects/{segment_id}.blob":
                await self._mark_quarantined(
                    segment_id, "RECLAIM_RECOVERY_PATH_INVALID"
                )
                quarantined.append(segment_id)
                continue
            try:
                original = self._owned_path(relative)
                trash = self._owned_path(f".trash/{segment_id}-{token}.trash")
            except ValueError:
                await self._mark_quarantined(
                    segment_id, "RECLAIM_RECOVERY_PATH_INVALID"
                )
                quarantined.append(segment_id)
                continue
            try:
                if self._file_is_regular(original):
                    pass
                elif self._file_is_regular(trash):
                    os.replace(trash, original)
                else:
                    raise FileNotFoundError
            except OSError:
                await self._mark_quarantined(segment_id, "RECLAIM_RECOVERY_FILE_MISSING")
                quarantined.append(segment_id)
                continue
            await self._restore_reclaim_state(segment_id, token, None)
            recovered.append(segment_id)
        await self._audit(
            "RECOVERY",
            canonical_sha256({"recovered": recovered, "quarantined": quarantined}),
            {},
            {"recovered": recovered, "quarantined": quarantined},
        )

    async def _recover_interrupted_prepares(self) -> None:
        now = self.store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> int:
            rows = tuple(
                connection.execute(
                    """
                    SELECT job_id, segment_id FROM replay_data_prepare_job
                    WHERE state IN ('PLANNED', 'LOADING', 'VALIDATING', 'PUBLISHING')
                    """
                ).fetchall()
            )
            if not rows:
                return 0
            job_ids = tuple(str(row["job_id"]) for row in rows)
            segment_ids = tuple(
                str(row["segment_id"])
                for row in rows
                if row["segment_id"] is not None
            )
            placeholders = ", ".join("?" for _ in job_ids)
            connection.execute(
                f"""
                UPDATE replay_data_prepare_job
                SET state = 'ERROR', failure_reason = 'PROCESS_RESTART_INTERRUPTED',
                    temp_path = NULL, updated_at_ms = ?
                WHERE job_id IN ({placeholders})
                """,
                (now, *job_ids),
            )
            if segment_ids:
                segment_placeholders = ", ".join("?" for _ in segment_ids)
                connection.execute(
                    f"""
                    UPDATE replay_data_segment
                    SET health = 'ERROR', quarantine_reason = 'PROCESS_RESTART_INTERRUPTED',
                        local_path = NULL, reclaim_token = NULL,
                        generation = generation + 1, updated_at_ms = ?
                    WHERE segment_id IN ({segment_placeholders}) AND health = 'LOADING'
                    """,
                    (now, *segment_ids),
                )
            return len(job_ids)

        await self.store.run_extension_write(write)

    async def _restore_reclaim_state(
        self, segment_id: str, token: str, reason: str | None
    ) -> None:
        now = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                """
                UPDATE replay_data_segment
                SET health = 'READY', reclaim_token = NULL,
                    quarantine_reason = ?, updated_at_ms = ?
                WHERE segment_id = ? AND reclaim_token = ? AND health = 'RECLAIMING'
                """,
                (reason, now, segment_id, token),
            )
        )

    async def _mark_quarantined(
        self,
        segment_id: str,
        reason: str,
        *,
        job_id: str | None = None,
    ) -> None:
        now = self.store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                UPDATE replay_data_segment
                SET health = 'QUARANTINED', quarantine_reason = ?,
                    local_path = NULL, reclaim_token = NULL,
                    generation = generation + 1, updated_at_ms = ?
                WHERE segment_id = ?
                """,
                (reason[:500], now, segment_id),
            )
            if job_id is not None:
                connection.execute(
                    """
                    UPDATE replay_data_prepare_job
                    SET state = 'QUARANTINED', failure_reason = ?,
                        temp_path = NULL, updated_at_ms = ?
                    WHERE job_id = ?
                    """,
                    (reason[:500], now, job_id),
                )

        await self.store.run_extension_write(write)

    async def _set_segment_health(self, segment_id: str, health: str, reason: str) -> None:
        now = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                """
                UPDATE replay_data_segment
                SET health = ?, quarantine_reason = ?, updated_at_ms = ?
                WHERE segment_id = ?
                """,
                (health, reason[:500], now, segment_id),
            )
        )

    async def _set_job_state(
        self,
        job_id: str,
        state: str,
        numerator: int,
        denominator: int,
        *,
        failure_reason: str | None = None,
    ) -> None:
        now = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                """
                UPDATE replay_data_prepare_job
                SET state = ?, progress_numerator = ?, progress_denominator = ?,
                    failure_reason = ?, updated_at_ms = ?
                WHERE job_id = ?
                """,
                (state, numerator, max(denominator, 1), failure_reason, now, job_id),
            )
        )

    async def _cancel_requested(self, job_id: str) -> bool:
        row = await self.store.run_extension_read(
            lambda connection: connection.execute(
                "SELECT cancel_requested FROM replay_data_prepare_job WHERE job_id = ?",
                (job_id,),
            ).fetchone()
        )
        return row is not None and bool(row["cancel_requested"])

    async def _audit(
        self,
        action: str,
        plan_hash: str,
        request: object,
        result: object,
    ) -> None:
        now = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                """
                INSERT INTO replay_data_gc_audit(
                    audit_id, action, plan_hash, request_json, result_json, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    f"gc-{uuid.uuid4().hex}",
                    action,
                    plan_hash,
                    canonical_json(request),
                    canonical_json(result),
                    now,
                ),
            )
        )

    def _ensure_dirs(self) -> None:
        for relative in ("objects", ".tmp", ".quarantine", ".trash"):
            self._owned_path(relative).mkdir(parents=True, exist_ok=True)

    def _cleanup_stale_files(self) -> None:
        for relative in (".tmp", ".trash"):
            root = self._owned_path(relative)
            if not root.exists():
                continue
            for child in root.iterdir():
                if child.is_symlink():
                    child.unlink()
                    continue
                resolved = child.resolve()
                if not resolved.is_relative_to(root):
                    continue
                if not child.is_dir():
                    child.unlink()

    def _owned_path(self, relative: str) -> Path:
        path = Path(relative)
        if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
            raise ValueError("replay segment path must be a safe relative path")
        resolved = (self.root / path).resolve()
        if not resolved.is_relative_to(self.root):
            raise ValueError("replay segment path escaped its owned root")
        return resolved

    def _owned_object_issue(self, row: Mapping[str, object]) -> str | None:
        if row["storage_kind"] != "EXTERNAL_REPLAY_OWNED":
            return None
        segment_id = str(row["segment_id"])
        relative = row["local_path"]
        if not isinstance(relative, str):
            return "LOCAL_OBJECT_MISSING"
        if relative != f"objects/{segment_id}.blob":
            return "OWNED_PATH_INVALID"
        path = Path(relative)
        if path.is_absolute() or path.parts != ("objects", f"{segment_id}.blob"):
            return "OWNED_PATH_INVALID"
        path = self.root / path
        return None if self._file_is_regular(path) else "LOCAL_OBJECT_MISSING"

    @staticmethod
    def _file_checksum(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        return f"sha256:{digest.hexdigest()}"

    @staticmethod
    def _public_job(row: Mapping[str, object]) -> dict[str, object]:
        denominator = _integer(row["progress_denominator"], "progress denominator")
        numerator = _integer(row["progress_numerator"], "progress numerator")
        return {
            "protocol": PREPARE_PROTOCOL,
            "job_id": str(row["job_id"]),
            "state": str(row["state"]),
            "progress": {
                "numerator": numerator,
                "denominator": denominator,
                "percent": min(100, (numerator * 100) // denominator),
            },
            "segment_id": row["segment_id"],
            "run_id": row["run_id"],
            "track_id": row["track_id"],
            "failure_reason": row["failure_reason"],
            "cancel_requested": bool(row["cancel_requested"]),
        }

    def _public_segment(
        self, row: Mapping[str, object], *, redact_ranges: bool
    ) -> dict[str, object]:
        manifest = json.loads(str(row["rehydration_manifest_json"]))
        if isinstance(manifest, dict):
            manifest.pop("trusted_file", None)
            manifest.pop("trusted_url", None)
            if redact_ranges:
                manifest["range"] = {"redacted": True}
                if "source" in manifest:
                    manifest["source"] = {"redacted": True}
        public_range: dict[str, object] = (
            {"redacted": True}
            if redact_ranges
            else {
                "start_ms": _integer(row["range_start_ms"], "range start"),
                "end_ms": _integer(row["range_end_ms"], "range end"),
            }
        )
        return {
            "segment_id": str(row["segment_id"]),
            "source_kind": str(row["source_kind"]),
            "adapter_kind": str(row["adapter_kind"]),
            "identity": {
                "exchange": str(row["exchange"]),
                "market_type": str(row["market_type"]),
                "symbol": str(row["symbol"]),
                "base_interval": row["base_interval"],
            },
            "range": public_range,
            "schema_version": str(row["schema_version"]),
            "dataset_epoch": str(row["dataset_epoch"]),
            "checksum_sha256": str(row["checksum_sha256"]),
            "coverage_state": str(row["coverage_state"]),
            "continuity_state": str(row["continuity_state"]),
            "health": str(row["health"]),
            "storage_kind": str(row["storage_kind"]),
            "byte_size": _integer(row["byte_size"], "segment byte_size"),
            "rebuildable": bool(row["rebuildable"]),
            "trusted_origin": str(row["trusted_origin"]),
            "rehydration_manifest": manifest,
            "quarantine_reason": row["quarantine_reason"],
            "generation": _integer(row["generation"], "segment generation"),
            "ref_count": (
                _integer(row["ref_count"], "segment ref_count")
                if "ref_count" in row.keys()
                else 0
            ),
            "local_object_present": (
                row["storage_kind"] == "EXTERNAL_REPLAY_OWNED"
                and self._owned_object_issue(row) is None
            ),
            "last_used_at_ms": _integer(row["last_used_at_ms"], "last_used_at_ms"),
        }


__all__ = [
    "DATA_POLICY_PROTOCOL",
    "GC_PROTOCOL",
    "PREPARE_PROTOCOL",
    "REHYDRATION_PROTOCOL",
    "SEGMENT_PROTOCOL",
    "ReplaySegmentManager",
    "ResolvedHistoryPolicy",
    "SegmentPrepareSpec",
    "backfill_archive_segments",
    "register_archive_segment",
    "resolve_history_policy",
]
