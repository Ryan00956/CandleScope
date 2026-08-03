"""Path-redacted storage inventory and production support declarations."""

from __future__ import annotations

import sqlite3
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING

from app.replay.storage.sqlite_store import ReplaySQLiteStore

from .account_history import AccountHistoryArchiveManager
from .historical_book import HistoricalBookArchiveManager
from .segments import ReplaySegmentManager

if TYPE_CHECKING:
    from app.core.config import ReplaySettings


STORAGE_INVENTORY_PROTOCOL = "replay.storage.inventory.v1"
MAX_CATEGORY_ITEMS = 200
MAX_OBSERVED_IDENTITIES = 100
REVIEW_ANCHOR_LIMIT_BYTES = 512 * 1024 * 1024
REVIEW_ARTIFACT_LIMIT_BYTES = 128 * 1024 * 1024
REVIEW_EVENT_LIMIT = 8_192
REVIEW_VIEWPORT_LIMIT = 2_048


def _pressure_bps(used: int, maximum: int) -> int:
    if maximum <= 0:
        return 0
    return min(1_000_000, used * 10_000 // maximum)


def _identity(
    row: Mapping[str, object],
    *,
    interval_field: str | None = None,
) -> dict[str, object]:
    identity: dict[str, object] = {
        "exchange": str(row["exchange"]),
        "market_type": str(row["market_type"]),
        "symbol": str(row["symbol"]),
    }
    if interval_field is not None:
        value = row[interval_field]
        identity["base_interval"] = None if value is None else str(value)
    return identity


def _structural_source_issue(
    value: object,
    *,
    expected_bytes: int,
) -> str | None:
    try:
        raw = Path(str(value)).expanduser()
        if raw.is_symlink():
            return "TRUSTED_SOURCE_SYMLINK"
        source = raw.resolve()
        if not source.is_file() or source.is_symlink():
            return "TRUSTED_SOURCE_UNAVAILABLE"
        if source.stat().st_size != expected_bytes:
            return "TRUSTED_SOURCE_SIZE_MISMATCH"
    except (OSError, TypeError, ValueError):
        return "TRUSTED_SOURCE_UNAVAILABLE"
    return None


class ReplayStorageGovernance:
    """Assemble a bounded public view without exposing storage locators or time."""

    def __init__(
        self,
        store: ReplaySQLiteStore,
        *,
        settings: ReplaySettings,
        segments: ReplaySegmentManager,
        historical_books: HistoricalBookArchiveManager,
        account_history: AccountHistoryArchiveManager,
        bar_repository: object | None = None,
        raw_trade_archive: object | None = None,
    ) -> None:
        self.store = store
        self.settings = settings
        self.segments = segments
        self.historical_books = historical_books
        self.account_history = account_history
        self.bar_repository = bar_repository
        self.raw_trade_archive = raw_trade_archive

    async def inventory(self) -> dict[str, object]:
        (
            segments,
            books,
            accounts,
            review,
        ) = await self.store.run_extension_read(self._read_inventory)
        categories = {
            "segments": self._segment_category(*segments),
            "historical_books": self._book_category(*books),
            "account_history": self._account_category(*accounts),
            "review_evidence": self._review_category(*review),
        }
        support_matrix = self._support_matrix(categories)
        alerts = self._alerts(categories)
        core_enabled = self.settings.enabled
        return {
            "protocol": STORAGE_INVENTORY_PROTOCOL,
            "decision": {
                "state": "ENABLE" if core_enabled else "HOLD",
                "default_flags_enabled": core_enabled,
                "reason_codes": (
                    []
                    if core_enabled
                    else ["REPLAY_RUNTIME_FLAGS_DISABLED"]
                ),
                "implementation_state": (
                    "RUNTIME_ENABLED_SOURCE_GATED"
                    if core_enabled
                    else "RUNTIME_DISABLED"
                ),
            },
            "feature_flags": {
                "replay_enabled": self.settings.enabled,
                "agg_trade_enabled": self.settings.replay_agg_trade_enabled,
                "segment_download_worker_enabled": (
                    self.settings.replay_segment_download_worker_enabled
                ),
                "segment_auto_gc_enabled": (
                    self.settings.replay_segment_auto_gc_enabled
                ),
                "fast_forward_optimization_enabled": (
                    self.settings.replay_fast_forward_optimization_enabled
                ),
                "historical_book_enabled": (
                    self.settings.replay_historical_book_enabled
                ),
                "account_history_enabled": (
                    self.settings.replay_account_history_enabled
                ),
            },
            "categories": categories,
            "support_matrix": support_matrix,
            "alerts": alerts,
            "bounds": {
                "max_items_per_category": MAX_CATEGORY_ITEMS,
                "max_observed_identities": MAX_OBSERVED_IDENTITIES,
                "actual_time_exposed": False,
                "local_paths_exposed": False,
            },
        }

    @staticmethod
    def _read_inventory(
        connection: sqlite3.Connection,
    ) -> tuple[
        tuple[tuple[sqlite3.Row, ...], sqlite3.Row],
        tuple[tuple[sqlite3.Row, ...], sqlite3.Row],
        tuple[tuple[sqlite3.Row, ...], sqlite3.Row],
        tuple[tuple[sqlite3.Row, ...], sqlite3.Row],
    ]:
        segment_rows = tuple(
            connection.execute(
                """
                SELECT segment.*,
                       (SELECT COUNT(*) FROM replay_data_segment_ref AS ref
                        WHERE ref.segment_id = segment.segment_id
                          AND ref.active = 1) AS active_refs,
                       (SELECT GROUP_CONCAT(DISTINCT owner_kind)
                        FROM replay_data_segment_ref AS ref
                        WHERE ref.segment_id = segment.segment_id
                          AND ref.active = 1) AS active_owner_kinds,
                       EXISTS(
                           SELECT 1 FROM replay_data_segment_ref AS ref
                           JOIN replay_training_run AS run
                             ON run.run_id = ref.run_id
                           WHERE ref.segment_id = segment.segment_id
                             AND run.state IN (
                                 'PLAYING', 'ADVANCING', 'INITIALIZING'
                             )
                       ) AS active_run,
                       EXISTS(
                           SELECT 1 FROM replay_data_segment_ref AS ref
                           JOIN replay_review_session AS review
                             ON review.run_id = ref.run_id
                           WHERE ref.segment_id = segment.segment_id
                       ) AS review_open,
                       EXISTS(
                           SELECT 1 FROM replay_data_segment_ref AS ref
                           JOIN replay_training_market_track AS track
                             ON track.run_id = ref.run_id
                           WHERE ref.segment_id = segment.segment_id
                             AND TRIM(CAST(COALESCE(
                                 json_extract(track.position_json, '$.quantity'),
                                 '0'
                             ) AS TEXT), '0.-') != ''
                       ) AS open_position,
                       EXISTS(
                           SELECT 1 FROM replay_data_prepare_job AS job
                           WHERE job.segment_id = segment.segment_id
                             AND job.state IN (
                                 'PLANNED', 'LOADING',
                                 'VALIDATING', 'PUBLISHING'
                             )
                       ) AS prepare_in_flight
                FROM replay_data_segment AS segment
                ORDER BY segment.last_used_at_ms DESC, segment.segment_id
                LIMIT ?
                """,
                (MAX_CATEGORY_ITEMS,),
            ).fetchall()
        )
        segment_summary = connection.execute(
            """
            SELECT COUNT(*) AS object_count,
                   SUM(health = 'READY') AS ready_count,
                   SUM(health = 'EVICTED') AS evicted_count,
                   SUM(health = 'QUARANTINED') AS quarantined_count,
                   SUM(EXISTS(
                       SELECT 1 FROM replay_data_segment_ref AS ref
                       WHERE ref.segment_id = segment.segment_id
                         AND ref.active = 1
                   )) AS pinned_count,
                   COALESCE(SUM(
                       CASE WHEN storage_kind = 'EXTERNAL_REPLAY_OWNED'
                                  AND local_path IS NOT NULL
                            THEN byte_size ELSE 0 END
                   ), 0) AS local_bytes
            FROM replay_data_segment AS segment
            """
        ).fetchone()
        assert segment_summary is not None

        book_rows = tuple(
            connection.execute(
                """
                SELECT archive.*,
                       (SELECT COUNT(*)
                        FROM replay_historical_book_ref AS ref
                        WHERE ref.archive_id = archive.archive_id
                          AND ref.active = 1) AS active_refs
                FROM replay_historical_book_archive AS archive
                ORDER BY archive.last_used_at_ms DESC, archive.archive_id
                LIMIT ?
                """,
                (MAX_CATEGORY_ITEMS,),
            ).fetchall()
        )
        book_summary = connection.execute(
            """
            SELECT COUNT(*) AS object_count,
                   SUM(health = 'READY') AS ready_count,
                   SUM(health = 'EVICTED') AS evicted_count,
                   SUM(health = 'QUARANTINED') AS quarantined_count,
                   SUM(EXISTS(
                       SELECT 1 FROM replay_historical_book_ref AS ref
                       WHERE ref.archive_id = archive.archive_id
                         AND ref.active = 1
                   )) AS pinned_count,
                   COALESCE(SUM(
                       CASE WHEN local_path IS NOT NULL
                            THEN byte_size ELSE 0 END
                   ), 0) AS local_bytes
            FROM replay_historical_book_archive AS archive
            """
        ).fetchone()
        assert book_summary is not None

        account_rows = tuple(
            connection.execute(
                """
                SELECT archive.*,
                       (SELECT COUNT(*)
                        FROM replay_account_history_ref AS ref
                        WHERE ref.archive_id = archive.archive_id
                          AND ref.active = 1) AS active_refs
                FROM replay_account_history_archive AS archive
                ORDER BY archive.last_used_at_ms DESC, archive.archive_id
                LIMIT ?
                """,
                (MAX_CATEGORY_ITEMS,),
            ).fetchall()
        )
        account_summary = connection.execute(
            """
            SELECT COUNT(*) AS object_count,
                   SUM(health = 'READY') AS ready_count,
                   SUM(health = 'EVICTED') AS evicted_count,
                   SUM(health = 'QUARANTINED') AS quarantined_count,
                   SUM(EXISTS(
                       SELECT 1 FROM replay_account_history_ref AS ref
                       WHERE ref.archive_id = archive.archive_id
                         AND ref.active = 1
                   )) AS pinned_count,
                   COALESCE(SUM(
                       CASE WHEN local_path IS NOT NULL
                            THEN byte_size ELSE 0 END
                   ), 0) AS local_bytes
            FROM replay_account_history_archive AS archive
            """
        ).fetchone()
        assert account_summary is not None

        review_rows = tuple(
            connection.execute(
                """
                SELECT run.run_id, run.state,
                       (SELECT COUNT(*) FROM replay_review_timeline_event AS event
                        WHERE event.run_id = run.run_id) AS critical_events,
                       (SELECT COUNT(*) FROM replay_review_viewport_sample AS sample
                        WHERE sample.run_id = run.run_id) AS viewport_samples,
                       COALESCE((
                           SELECT SUM(
                               CASE WHEN stored_bytes > 0 THEN stored_bytes
                                    ELSE length(payload) END
                           )
                           FROM replay_review_actor_anchor AS anchor
                           WHERE anchor.run_id = run.run_id
                       ), 0) AS anchor_bytes,
                       COALESCE((
                           SELECT SUM(
                               length(CAST(projection_json AS BLOB))
                           )
                           FROM replay_review_timeline_event AS event
                           WHERE event.run_id = run.run_id
                       ), 0)
                       + COALESCE((
                           SELECT SUM(document_bytes)
                           FROM replay_review_drawing_document AS drawing
                           WHERE drawing.run_id = run.run_id
                       ), 0)
                       + COALESCE((
                           SELECT SUM(length(CAST(text AS BLOB)))
                           FROM replay_review_marker AS marker
                           WHERE marker.run_id = run.run_id
                       ), 0) AS artifact_bytes,
                       EXISTS(
                           SELECT 1 FROM replay_review_session AS review
                           WHERE review.run_id = run.run_id
                       ) AS review_open,
                       EXISTS(
                           SELECT 1 FROM replay_review_fork_lineage AS lineage
                           WHERE lineage.parent_run_id = run.run_id
                       ) AS fork_parent,
                       EXISTS(
                           SELECT 1 FROM replay_review_fork_lineage AS lineage
                           WHERE lineage.child_run_id = run.run_id
                       ) AS fork_child,
                       EXISTS(
                           SELECT 1 FROM replay_training_market_track AS track
                           WHERE track.run_id = run.run_id
                             AND TRIM(CAST(COALESCE(
                                 json_extract(track.position_json, '$.quantity'),
                                 '0'
                             ) AS TEXT), '0.-') != ''
                       ) AS open_position
                FROM replay_training_run AS run
                WHERE EXISTS(
                    SELECT 1 FROM replay_review_timeline_event AS event
                    WHERE event.run_id = run.run_id
                )
                   OR EXISTS(
                    SELECT 1 FROM replay_review_actor_anchor AS anchor
                    WHERE anchor.run_id = run.run_id
                )
                ORDER BY run.updated_at_ms DESC, run.run_id
                LIMIT ?
                """,
                (MAX_CATEGORY_ITEMS,),
            ).fetchall()
        )
        review_summary = connection.execute(
            """
            SELECT COUNT(*) AS run_count,
                   COALESCE(SUM(anchor_bytes), 0) AS anchor_bytes,
                   COALESCE(SUM(artifact_bytes), 0) AS artifact_bytes
            FROM (
                SELECT run.run_id,
                       COALESCE((
                            SELECT SUM(
                                CASE WHEN stored_bytes > 0 THEN stored_bytes
                                     ELSE length(payload) END
                            )
                           FROM replay_review_actor_anchor AS anchor
                           WHERE anchor.run_id = run.run_id
                       ), 0) AS anchor_bytes,
                       COALESCE((
                           SELECT SUM(
                               length(CAST(projection_json AS BLOB))
                           )
                           FROM replay_review_timeline_event AS event
                           WHERE event.run_id = run.run_id
                       ), 0)
                       + COALESCE((
                           SELECT SUM(document_bytes)
                           FROM replay_review_drawing_document AS drawing
                           WHERE drawing.run_id = run.run_id
                       ), 0)
                       + COALESCE((
                           SELECT SUM(length(CAST(text AS BLOB)))
                           FROM replay_review_marker AS marker
                           WHERE marker.run_id = run.run_id
                       ), 0) AS artifact_bytes
                FROM replay_training_run AS run
                WHERE EXISTS(
                    SELECT 1 FROM replay_review_timeline_event AS event
                    WHERE event.run_id = run.run_id
                )
                   OR EXISTS(
                    SELECT 1 FROM replay_review_actor_anchor AS anchor
                    WHERE anchor.run_id = run.run_id
                )
            )
            """
        ).fetchone()
        assert review_summary is not None
        return (
            (segment_rows, segment_summary),
            (book_rows, book_summary),
            (account_rows, account_summary),
            (review_rows, review_summary),
        )

    def _segment_category(
        self,
        rows: tuple[sqlite3.Row, ...],
        summary: sqlite3.Row,
    ) -> dict[str, object]:
        items: list[dict[str, object]] = []
        for row in rows:
            reasons: set[str] = set()
            owner_kinds = (
                []
                if row["active_owner_kinds"] is None
                else str(row["active_owner_kinds"]).split(",")
            )
            for owner in owner_kinds:
                if owner in {"ACTOR", "REVIEW", "RECOVERY"}:
                    reasons.add(f"ACTIVE_{owner}")
                elif owner:
                    reasons.add(f"ACTIVE_{owner}_REF")
            if bool(row["active_run"]):
                reasons.add("ACTIVE_RUN")
            if bool(row["review_open"]):
                reasons.add("REVIEW_OPEN")
            if bool(row["open_position"]):
                reasons.add("OPEN_POSITION")
            if bool(row["prepare_in_flight"]):
                reasons.add("PREPARE_IN_FLIGHT")
            if not bool(row["rebuildable"]):
                reasons.add("NON_REBUILDABLE")
            if row["storage_kind"] != "EXTERNAL_REPLAY_OWNED":
                reasons.add("STORAGE_NOT_REPLAY_OWNED")
            if row["health"] != "READY":
                reasons.add(f"HEALTH_{row['health']}")
            elif (
                row["storage_kind"] == "EXTERNAL_REPLAY_OWNED"
                and self.segments._owned_object_issue(row) is not None
            ):
                reasons.add(str(self.segments._owned_object_issue(row)))
            items.append(
                {
                    "object_id": str(row["segment_id"]),
                    "source_kind": str(row["source_kind"]),
                    "identity": _identity(row, interval_field="base_interval"),
                    "health": str(row["health"]),
                    "byte_size": int(row["byte_size"]),
                    "generation": int(row["generation"]),
                    "active_ref_count": int(row["active_refs"]),
                    "recoverability": (
                        "TRUSTED_MANIFEST_CHECKSUM_BOUND"
                        if bool(row["rebuildable"])
                        else "NOT_REBUILDABLE"
                    ),
                    "protection_reasons": sorted(reasons),
                    "rehydration_available": bool(row["rebuildable"]),
                }
            )
        return self._category(
            summary,
            items=items,
            maximum=self.segments.max_archive_bytes,
            count_field="object_count",
            gc_protocol="replay.data.gc.v1",
            auto_gc_enabled=self.segments.auto_gc_enabled,
        )

    def _book_category(
        self,
        rows: tuple[sqlite3.Row, ...],
        summary: sqlite3.Row,
    ) -> dict[str, object]:
        items: list[dict[str, object]] = []
        for row in rows:
            reasons: set[str] = set()
            if int(row["active_refs"]) > 0:
                reasons.add("ACTIVE_ARCHIVE_PIN")
            if row["health"] != "READY":
                reasons.add(f"HEALTH_{row['health']}")
            if row["health"] == "EVICTED":
                reasons.add("REHYDRATION_REQUIRED")
            if isinstance(row["local_path"], str):
                try:
                    self.historical_books._owned_file(row, False)
                except Exception:
                    reasons.add("OWNED_OBJECT_UNAVAILABLE")
            source_issue = _structural_source_issue(
                row["trusted_source_path"],
                expected_bytes=int(row["byte_size"]),
            )
            if source_issue is not None:
                reasons.add(source_issue)
            items.append(
                {
                    "object_id": str(row["archive_id"]),
                    "source_kind": "BOOK",
                    "identity": _identity(row),
                    "health": str(row["health"]),
                    "byte_size": int(row["byte_size"]),
                    "generation": int(row["generation"]),
                    "active_ref_count": int(row["active_refs"]),
                    "recoverability": (
                        "TRUSTED_LOCAL_SOURCE_CHECKSUM_BOUND"
                        if source_issue is None
                        else "SOURCE_UNAVAILABLE"
                    ),
                    "protection_reasons": sorted(reasons),
                    "rehydration_available": source_issue is None,
                }
            )
        return self._category(
            summary,
            items=items,
            maximum=self.historical_books.max_archive_bytes,
            count_field="object_count",
            gc_protocol="replay.historical-book.gc.v1",
            auto_gc_enabled=False,
        )

    def _account_category(
        self,
        rows: tuple[sqlite3.Row, ...],
        summary: sqlite3.Row,
    ) -> dict[str, object]:
        items: list[dict[str, object]] = []
        for row in rows:
            reasons: set[str] = set()
            if int(row["active_refs"]) > 0:
                reasons.add("ACTIVE_ARCHIVE_PIN")
            if row["health"] != "READY":
                reasons.add(f"HEALTH_{row['health']}")
            if row["health"] == "EVICTED":
                reasons.add("REHYDRATION_REQUIRED")
            if isinstance(row["local_path"], str):
                try:
                    self.account_history._owned_file(row, False)
                except Exception:
                    reasons.add("OWNED_OBJECT_UNAVAILABLE")
            source_issue = _structural_source_issue(
                row["trusted_source_path"],
                expected_bytes=int(row["byte_size"]),
            )
            if source_issue is not None:
                reasons.add(source_issue)
            items.append(
                {
                    "object_id": str(row["archive_id"]),
                    "source_kind": "ACCOUNT_HISTORY",
                    "identity": _identity(row),
                    "health": str(row["health"]),
                    "byte_size": int(row["byte_size"]),
                    "generation": int(row["generation"]),
                    "active_ref_count": int(row["active_refs"]),
                    "recoverability": (
                        "TRUSTED_LOCAL_SOURCE_CHECKSUM_BOUND"
                        if source_issue is None
                        else "SOURCE_UNAVAILABLE"
                    ),
                    "protection_reasons": sorted(reasons),
                    "rehydration_available": source_issue is None,
                }
            )
        return self._category(
            summary,
            items=items,
            maximum=self.account_history.max_archive_bytes,
            count_field="object_count",
            gc_protocol="replay.account-history.gc.v1",
            auto_gc_enabled=False,
        )

    @staticmethod
    def _review_category(
        rows: tuple[sqlite3.Row, ...],
        summary: sqlite3.Row,
    ) -> dict[str, object]:
        items: list[dict[str, object]] = []
        for row in rows:
            reasons = {"RUN_ARCHIVE_EVIDENCE"}
            if bool(row["review_open"]):
                reasons.add("REVIEW_OPEN")
            if bool(row["fork_parent"]):
                reasons.add("FORK_PARENT")
            if bool(row["fork_child"]):
                reasons.add("FORK_CHILD")
            if bool(row["open_position"]):
                reasons.add("OPEN_POSITION")
            items.append(
                {
                    "run_id": str(row["run_id"]),
                    "run_state": str(row["state"]),
                    "anchor_bytes": int(row["anchor_bytes"]),
                    "anchor_limit_bytes": REVIEW_ANCHOR_LIMIT_BYTES,
                    "artifact_bytes": int(row["artifact_bytes"]),
                    "artifact_limit_bytes": REVIEW_ARTIFACT_LIMIT_BYTES,
                    "critical_events": int(row["critical_events"]),
                    "critical_event_limit": REVIEW_EVENT_LIMIT,
                    "viewport_samples": int(row["viewport_samples"]),
                    "viewport_sample_limit": REVIEW_VIEWPORT_LIMIT,
                    "protection_reasons": sorted(reasons),
                    "gc_available": False,
                }
            )
        run_count = int(summary["run_count"])
        local_bytes = int(summary["anchor_bytes"]) + int(summary["artifact_bytes"])
        maximum = run_count * (
            REVIEW_ANCHOR_LIMIT_BYTES + REVIEW_ARTIFACT_LIMIT_BYTES
        )
        return {
            "summary": {
                "object_count": run_count,
                "ready_count": run_count,
                "evicted_count": 0,
                "quarantined_count": 0,
                "pinned_count": run_count,
                "local_bytes": local_bytes,
                "max_bytes": maximum,
                "pressure_bps": _pressure_bps(local_bytes, maximum),
                "truncated": run_count > len(items),
            },
            "items": items,
            "gc_protocol": None,
            "auto_gc_enabled": False,
        }

    @staticmethod
    def _category(
        summary: sqlite3.Row,
        *,
        items: list[dict[str, object]],
        maximum: int,
        count_field: str,
        gc_protocol: str,
        auto_gc_enabled: bool,
    ) -> dict[str, object]:
        local_bytes = int(summary["local_bytes"])
        object_count = int(summary[count_field])
        return {
            "summary": {
                "object_count": object_count,
                "ready_count": int(summary["ready_count"] or 0),
                "evicted_count": int(summary["evicted_count"] or 0),
                "quarantined_count": int(summary["quarantined_count"] or 0),
                "pinned_count": int(summary["pinned_count"] or 0),
                "local_bytes": local_bytes,
                "max_bytes": maximum,
                "pressure_bps": _pressure_bps(local_bytes, maximum),
                "truncated": object_count > len(items),
            },
            "items": items,
            "gc_protocol": gc_protocol,
            "auto_gc_enabled": auto_gc_enabled,
        }

    def _support_matrix(
        self,
        categories: Mapping[str, object],
    ) -> list[dict[str, object]]:
        segment_category = categories["segments"]
        book_category = categories["historical_books"]
        account_category = categories["account_history"]
        assert isinstance(segment_category, Mapping)
        assert isinstance(book_category, Mapping)
        assert isinstance(account_category, Mapping)
        segment_items = segment_category["items"]
        book_items = book_category["items"]
        account_items = account_category["items"]
        assert isinstance(segment_items, list)
        assert isinstance(book_items, list)
        assert isinstance(account_items, list)

        def observed(
            items: list[object],
            source_kind: str | None = None,
        ) -> list[dict[str, object]]:
            identities: dict[str, dict[str, object]] = {}
            for raw in items:
                if not isinstance(raw, Mapping):
                    continue
                if raw.get("health") != "READY":
                    continue
                if source_kind is not None and raw.get("source_kind") != source_kind:
                    continue
                identity = raw.get("identity")
                if not isinstance(identity, Mapping):
                    continue
                public = {str(key): value for key, value in identity.items()}
                key = "|".join(f"{name}={public[name]}" for name in sorted(public))
                identities[key] = public
            return [
                identities[key]
                for key in sorted(identities)[:MAX_OBSERVED_IDENTITIES]
            ]

        def current_bar_identities() -> list[dict[str, object]]:
            list_all = getattr(self.bar_repository, "list_all_series", None)
            if not callable(list_all):
                return []
            try:
                rows = list_all(custom_only=False)
            except Exception:
                return []
            identities: dict[str, dict[str, object]] = {}
            for row in rows:
                if not isinstance(row, Mapping):
                    continue
                identity = {
                    "exchange": str(row.get("exchange", "")),
                    "market_type": str(row.get("market_type", "")),
                    "symbol": str(row.get("symbol", "")),
                    "base_interval": str(row.get("interval", "")),
                }
                key = "|".join(str(identity[name]) for name in sorted(identity))
                identities[key] = identity
            return [
                identities[key]
                for key in sorted(identities)[:MAX_OBSERVED_IDENTITIES]
            ]

        def current_agg_identities() -> list[dict[str, object]]:
            list_verified = getattr(
                self.raw_trade_archive,
                "list_verified_identities",
                None,
            )
            if not callable(list_verified):
                return []
            try:
                return [
                    dict(item)
                    for item in list_verified()[:MAX_OBSERVED_IDENTITIES]
                    if isinstance(item, Mapping)
                ]
            except Exception:
                return []

        core_enabled = self.settings.enabled
        bar_identities = current_bar_identities()
        raw_agg_identities = current_agg_identities()
        bar_identity_keys = {
            (
                str(item.get("exchange", "")),
                str(item.get("market_type", "")),
                str(item.get("symbol", "")),
            )
            for item in bar_identities
        }
        identity_matched_agg = [
            item
            for item in raw_agg_identities
            if (
                str(item.get("exchange", "")),
                str(item.get("market_type", "")),
                str(item.get("symbol", "")),
            )
            in bar_identity_keys
        ]
        agg_identities = identity_matched_agg
        bar_ready = core_enabled and bool(bar_identities)
        agg_ready = (
            core_enabled
            and self.settings.replay_agg_trade_enabled
            and bool(agg_identities)
        )

        return [
            {
                "mode": "BAR",
                "source_contract": "CANDLESCOPE_CLOSED_KLINE_CATALOG",
                "declared_scope": "DYNAMIC_EXCHANGE_MARKET_SYMBOL_INTERVAL_CATALOG",
                "fidelity": "EXACT_CLOSED_BAR_COVERAGE_INTRABAR_CONSERVATIVE",
                "queue_exact": False,
                "required_flags": ["REPLAY_ENABLED"],
                "observed_identities": bar_identities,
                "production_readiness": "ENABLE" if bar_ready else "HOLD",
                "reason_codes": [] if bar_ready else ["CURRENT_BAR_SOURCE_UNAVAILABLE"],
            },
            {
                "mode": "AGG_TRADE",
                "source_contract": "BINANCE_DATA_VISION_USDM_DAILY_AGGTRADES",
                "declared_scope": "BINANCE_FUTURES_USDM",
                "fidelity": (
                    "VERIFIED_AGG_TRADE_TAPE_APPROXIMATE_BAR_PROJECTION"
                ),
                "queue_exact": False,
                "required_flags": [
                    "REPLAY_ENABLED",
                    "REPLAY_AGG_TRADE_ENABLED",
                ],
                "observed_identities": agg_identities,
                "production_readiness": "ENABLE" if agg_ready else "HOLD",
                "reason_codes": (
                    []
                    if agg_ready
                    else (
                        ["REPLAY_AGG_TRADE_DISABLED"]
                        if not self.settings.replay_agg_trade_enabled
                        else (
                            ["VERIFIED_AGG_TRADE_SOURCE_UNAVAILABLE"]
                            if not raw_agg_identities
                            else ["MATCHING_BAR_SOURCE_UNAVAILABLE"]
                        )
                    )
                ),
            },
            {
                "mode": "BOOK_ASSISTED",
                "source_contract": "BINANCE_USDM_OPERATOR_DIFF_DEPTH_CAPTURE",
                "declared_scope": "BINANCE_FUTURES_USDM",
                "fidelity": "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE",
                "queue_exact": False,
                "required_flags": ["REPLAY_HISTORICAL_BOOK_ENABLED"],
                "observed_identities": observed(book_items),
                "production_readiness": "HOLD",
                "reason_codes": ["PRODUCTION_CAPTURE_NOT_PRESENT"],
            },
            {
                "mode": "HISTORICAL_EXACT_ACCOUNT",
                "source_contract": "OPERATOR_CAPTURED_LINEAR_ACCOUNT_HISTORY",
                "declared_scope": (
                    "LINEAR_QUOTE_SETTLED_V1_ONE_WAY_SINGLE_QUOTE"
                ),
                "fidelity": "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT",
                "queue_exact": False,
                "required_flags": ["REPLAY_ACCOUNT_HISTORY_ENABLED"],
                "observed_identities": observed(account_items),
                "production_readiness": "HOLD",
                "reason_codes": ["PRODUCTION_CAPTURE_NOT_PRESENT"],
            },
        ]

    def _alerts(
        self,
        categories: Mapping[str, object],
    ) -> list[dict[str, str]]:
        alerts: list[dict[str, str]] = []
        if not self.settings.enabled:
            alerts.append({
                "severity": "INFO",
                "code": "REPLAY_CORE_DEFAULT_OFF",
                "category": "release",
                "message": (
                    "Replay remains gated by the default-off core switch."
                ),
            })
        if not self.settings.replay_historical_book_enabled:
            alerts.append({
                "severity": "WARNING",
                "code": "BOOK_PRODUCTION_SOURCE_MISSING",
                "category": "historical_books",
                "message": (
                    "BOOK is continuity-gated and has no bound production capture."
                ),
            })
        if not self.settings.replay_account_history_enabled:
            alerts.append({
                "severity": "WARNING",
                "code": "ACCOUNT_PRODUCTION_SOURCE_MISSING",
                "category": "account_history",
                "message": (
                    "Exact account mode has no bound production operator capture."
                ),
            })
        for name, raw_category in categories.items():
            if not isinstance(raw_category, Mapping):
                continue
            summary = raw_category.get("summary")
            if not isinstance(summary, Mapping):
                continue
            pressure = int(summary.get("pressure_bps", 0))
            quarantined = int(summary.get("quarantined_count", 0))
            if pressure >= 9_500:
                alerts.append(
                    {
                        "severity": "CRITICAL",
                        "code": "STORAGE_PRESSURE_CRITICAL",
                        "category": name,
                        "message": "Storage usage is at or above 95% of budget.",
                    }
                )
            elif pressure >= 8_000:
                alerts.append(
                    {
                        "severity": "WARNING",
                        "code": "STORAGE_PRESSURE_HIGH",
                        "category": name,
                        "message": "Storage usage is at or above 80% of budget.",
                    }
                )
            if quarantined:
                alerts.append(
                    {
                        "severity": "WARNING",
                        "code": "QUARANTINED_OBJECTS_PRESENT",
                        "category": name,
                        "message": "One or more immutable objects are quarantined.",
                    }
                )
        return alerts


__all__ = [
    "MAX_CATEGORY_ITEMS",
    "MAX_OBSERVED_IDENTITIES",
    "ReplayStorageGovernance",
    "STORAGE_INVENTORY_PROTOCOL",
]
