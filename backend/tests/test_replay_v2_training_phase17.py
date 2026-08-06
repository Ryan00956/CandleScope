from __future__ import annotations

import copy
import sqlite3
from pathlib import Path

import pytest

from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.actor import ReplaySessionActor
from app.replay.training import review as review_module
from app.replay.training import storage as training_storage_module
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import ReplayV2CommandType
from tests.test_replay_v2_training_phase5 import (
    _acquire,
    _command,
    _request,
    _service,
)
from tests.test_replay_v2_training_phase6 import _sandbox_request, _send
from tests.test_replay_v2_training_phase6 import _risk_service
from tests.fixtures.replay.account_history import build_account_history_archive
from tests.fixtures.replay.trade_service_fakes import TRADE_REPLAY_START_MS
from tests.test_replay_v2_training_phase16 import (
    ARCHIVE_END,
    REPLAY_START,
    _base_request as _exact_base_request,
    _exact_request,
    _import_and_plan,
    _service as _exact_service,
)
from tests.test_replay_v2_training_phase9 import (
    _book_archive,
    _book_request,
    _service as _book_service,
)


pytestmark = pytest.mark.anyio


async def test_review_checkpoint_classifier_ignores_market_only_changes() -> None:
    before = {
        "bar_builder": {"close": "100"},
        "orders": [],
        "fills": [],
        "ledger": {"tail_hash": f"sha256:{'1' * 64}", "next_entry": 3},
        "journal": [],
        "position": {
            "side": "FLAT",
            "quantity": "0",
            "entry_price": None,
            "realized_pnl": "0",
            "unrealized_pnl": "0",
        },
    }
    market_only = {
        **before,
        "bar_builder": {"close": "101"},
        "position": {**before["position"], "unrealized_pnl": "1"},
    }
    assert not ReplaySessionActor._review_checkpoint_required(  # noqa: SLF001
        before,
        market_only,
    )
    assert (
        review_module.ReviewRecorder._position_descriptor(  # noqa: SLF001
            before["position"]
        )
        == review_module.ReviewRecorder._position_descriptor(  # noqa: SLF001
            market_only["position"]
        )
    )
    assert (
        review_module.ReviewRecorder.descriptors(
            {
                "kind": "COMMAND",
                "accepted": True,
                "command": {"type": "acquire_controller"},
            },
            None,
            {},
        )
        == []
    )
    assert review_module.ReviewRecorder._internal_adapter_command(  # noqa: SLF001
        {
            "kind": "COMMAND",
            "command": {
                "command_id": f"v2multi-{'a' * 40}",
                "type": "step",
            },
        }
    )
    assert review_module.ReviewRecorder._internal_adapter_command(  # noqa: SLF001
        {
            "kind": "COMMAND",
            "command": {
                "command_id": f"v2part-{'b' * 40}",
                "type": "_training_fast_forward_final_state",
            },
        }
    )
    assert review_module.ReviewRecorder._internal_adapter_command(  # noqa: SLF001
        {
            "kind": "COMMAND",
            "command": {
                "command_id": f"v2multi-{'c' * 40}",
                "type": "_training_execute_historical_book_close",
            },
        }
    )
    assert review_module.ReviewRecorder._internal_adapter_command(  # noqa: SLF001
        {"kind": "STATE", "state_kind": "controller_expired"}
    )
    assert ReplaySessionActor._review_checkpoint_required(  # noqa: SLF001
        before,
        {
            **market_only,
            "fills": [{"fill_id": "fill-1", "price": "101"}],
        },
    )
    assert ReplaySessionActor._review_checkpoint_required(  # noqa: SLF001
        before,
        {
            **market_only,
            "ledger": {"tail_hash": f"sha256:{'2' * 64}", "next_entry": 5},
        },
    )
    assert ReplaySessionActor._review_checkpoint_required(  # noqa: SLF001
        before,
        {
            **market_only,
            "position": {**before["position"], "quantity": "1", "side": "LONG"},
        },
    )
    with pytest.raises(TrainingRunError) as disclosure:
        training_storage_module.TrainingRunStore._public_review_projection(  # noqa: SLF001
            {"books": [{"archive_id": "must-not-cross-api"}]}
        )
    assert disclosure.value.code == "REVIEW_DISCLOSURE_VIOLATION"


async def test_book_assisted_review_fork_preserves_pinned_book_inputs(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase17-book-fork.db"
    service = await _book_service(
        database,
        archive_root=tmp_path / "phase17-book-trades",
    )
    try:
        assert service.training is not None
        await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "phase17-book.sqlite3")
        )
        created = await service.training.create_run(await _book_request(service))
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase17-book-acquire",
        )
        session = await service.get_session(session_id)
        await service.training.command(
            run_id,
            _command(
                run_id,
                "phase17-book-advance",
                ReplayV2CommandType.ADVANCE_TO,
                session,
                {"virtual_time_ms": TRADE_REPLAY_START_MS + 2 * 60_000},
            ),
        )
        review = await service.training.start_review(run_id, event_id=None)
        parent_book = review["projection"]["books"][0]
        assert "archive_id" not in parent_book
        assert parent_book["queue_exact"] is False
        assert parent_book["status"] == "READY"

        forked = await service.training.fork_run(
            run_id,
            event_id=str(review["selected_event_id"]),
        )
        child_run_id = str(forked["run"]["run_id"])
        child_session_id = str(forked["run"]["adapter_session_id"])
        child_tracks = await service.training.get_market_tracks(child_run_id)
        child_book = child_tracks["tracks"][0]["historical_book"]
        assert child_book["status"] == "READY"
        assert child_book["book_hash"] == parent_book["book_hash"]
        assert child_book["queue_exact"] is False
        assert child_book["capability_state"] == "AVAILABLE_EXACT"

        await _acquire(
            service,
            run_id=child_run_id,
            selected_session_id=child_session_id,
            command_id="phase17-book-child-acquire",
        )
        child_session = await service.get_session(child_session_id)
        advanced = await service.training.command(
            child_run_id,
            _command(
                child_run_id,
                "phase17-book-child-advance",
                ReplayV2CommandType.ADVANCE_TO,
                child_session,
                {"virtual_time_ms": TRADE_REPLAY_START_MS + 3 * 60_000},
            ),
        )
        assert (
            advanced["cursor"]["virtual_time_ms"]
            == TRADE_REPLAY_START_MS + 3 * 60_000
        )
        advanced_tracks = await service.training.get_market_tracks(child_run_id)
        advanced_book = advanced_tracks["tracks"][0]["historical_book"]
        assert advanced_book["status"] == "READY"
        assert advanced_book["last_update_id"] == 103
        assert advanced_book["queue_exact"] is False
        assert advanced_book["capability_state"] == "AVAILABLE_EXACT"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_review_timeline_cursor_drawing_and_multi_track_fork(
    tmp_path: Path,
) -> None:
    frontend_golden_document = {
        "documentSchemaVersion": 1,
        "scopeKey": "replay-run:run-17",
        "documentRevision": 9,
        "updatedAt": 123456,
        "entities": [
            {
                "id": "line-17",
                "kind": "line",
                "geometryRevision": 1,
                "styleRevision": 1,
                "geometry": {
                    "kind": "line",
                    "lineType": "line-segment",
                    "dataPoints": [
                        {
                            "time": {"$replay_decimal_v1": "100.125"},
                            "price": {"$replay_decimal_v1": "10.25"},
                        },
                        {
                            "time": {"$replay_decimal_v1": "200.875"},
                            "price": {"$replay_decimal_v1": "20.75"},
                        },
                    ],
                },
                "style": {
                    "kind": "line",
                    "color": "#ffffff",
                    "lineWidth": {"$replay_decimal_v1": "2.5"},
                },
                "bounds": {"kind": "deferred"},
            }
        ],
    }
    assert canonical_sha256(frontend_golden_document) == (
        "sha256:57ab1912cecb3107e24d3c6bf3a004fac6b38613621fd2820c62480b2a54de02"
    )
    database = tmp_path / "phase17-multi.db"
    service = await _service(database, symbols=("ETHUSDT",))
    try:
        assert service.training is not None
        created = await service.training.create_run(await _request(service))
        run_id = str(created["run"]["run_id"])
        primary_session = str(created["run"]["adapter_session_id"])
        primary = await service.get_session(primary_session)
        await service.training.command(
            run_id,
            _command(
                run_id,
                "phase17-add-eth",
                ReplayV2CommandType.ADD_TRACK,
                primary,
                {
                    "exchange": "binance",
                    "market_type": "spot",
                    "symbol": "ETHUSDT",
                    "settlement_asset": "USDT",
                    "subscription_tier": "FULL",
                },
            ),
        )
        document = {
            **frontend_golden_document,
            "scopeKey": f"replay-run:{run_id}",
        }
        drawing = await service.training.record_drawing_document(
            run_id,
            command_id="phase17-drawing-1",
            document_hash=canonical_sha256(document),
            document=document,
            entity_count=1,
        )
        assert drawing["revision"] == 1
        assert drawing["entity_count"] == 1
        current_drawing = await service.training.current_drawing_document(run_id)
        assert current_drawing["document_hash"] == canonical_sha256(document)
        assert current_drawing["document"] == document
        rules = await service.training.rules(run_id)
        assert rules["schema_version"] == "replay.run-rules.v1"
        assert rules["instrument_rules"][0]["immutable_exchange_rule"] is True

        before = await service.get_session(primary_session)
        review = await service.training.start_review(run_id, event_id=None)
        assert review["schema_version"] == "replay.review.timeline.v1"
        assert review["drawing_document"] == document
        assert review["immutability_proof"]["verified"] is True
        moved = await service.training.control_review(
            run_id,
            str(review["review_id"]),
            action="PREVIOUS",
            event_id=None,
            expected_cursor_revision=int(review["cursor_revision"]),
            playback_rate=None,
        )
        assert moved["cursor_revision"] == 2
        assert moved["read_only"] is True
        playing = await service.training.control_review(
            run_id,
            str(review["review_id"]),
            action="PLAY",
            event_id=None,
            expected_cursor_revision=int(moved["cursor_revision"]),
            playback_rate="2",
        )
        assert playing["playback_state"] == "PLAYING"
        assert playing["playback_rate"] == "2"
        playback = playing
        for _ in range(len(review["events"]) + 1):
            if playback["playback_state"] != "PLAYING":
                break
            previous_sequence = int(playback["selected_timeline_sequence"])
            playback = await service.training.control_review(
                run_id,
                str(review["review_id"]),
                action="NEXT",
                event_id=None,
                expected_cursor_revision=int(playback["cursor_revision"]),
                playback_rate=None,
            )
            assert int(playback["selected_timeline_sequence"]) >= previous_sequence
        assert playback["playback_state"] == "PAUSED"
        assert int(playback["selected_timeline_sequence"]) == max(
            int(event["timeline_sequence"]) for event in review["events"]
        )
        after = await service.get_session(primary_session)
        assert before["snapshot"]["state_hash"] == after["snapshot"]["state_hash"]
        assert before["snapshot"]["cursor"] == after["snapshot"]["cursor"]

        forked = await service.training.fork_run(
            run_id,
            event_id=str(review["selected_event_id"]),
        )
        assert len(forked["tracks"]) == 2
        assert forked["anchor_set_hash"] == review["events"][-1]["anchor_set_hash"]
        assert {
            track["cursor"]["virtual_time_ms"] for track in forked["tracks"]
        } == {review["projection"]["cursor"]["virtual_time_ms"]}
        child_drawing = await service.training.current_drawing_document(
            str(forked["run"]["run_id"])
        )
        assert child_drawing["document_hash"] == drawing["document_hash"]
        assert child_drawing["document"] == document
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
            lineage = connection.execute(
                """
                SELECT parent_run_id, parent_event_id
                FROM replay_review_fork_lineage WHERE child_run_id = ?
                """,
                (forked["run"]["run_id"],),
            ).fetchone()
            assert tuple(lineage) == (run_id, review["selected_event_id"])
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_drawing_document_boundary_is_strict_and_atomic(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase17-drawing-boundary.db"
    service = await _service(database)
    try:
        assert service.training is not None
        created = await service.training.create_run(await _request(service))
        run_id = str(created["run"]["run_id"])
        entity = {
            "id": "line-boundary",
            "kind": "line",
            "geometryRevision": 1,
            "styleRevision": 1,
            "geometry": {
                "kind": "line",
                "lineType": "line-segment",
                "dataPoints": [
                    {
                        "time": {"$replay_decimal_v1": "100.125"},
                        "price": {"$replay_decimal_v1": "10.25"},
                    },
                    {
                        "time": {"$replay_decimal_v1": "200.875"},
                        "price": {"$replay_decimal_v1": "20.75"},
                    },
                ],
            },
            "style": {
                "kind": "line",
                "color": "#ffffff",
                "lineWidth": {"$replay_decimal_v1": "2.5"},
            },
            "bounds": {"kind": "deferred"},
        }
        valid = {
            "documentSchemaVersion": 1,
            "scopeKey": f"replay-run:{run_id}",
            "documentRevision": 1,
            "updatedAt": 1,
            "entities": [entity],
        }
        invalid_documents: list[tuple[str, dict[str, object], int]] = []

        extra_root = copy.deepcopy(valid)
        extra_root["unexpected"] = True
        invalid_documents.append(("extra-root", extra_root, 1))

        extra_entity = copy.deepcopy(valid)
        extra_entity["entities"][0]["unexpected"] = True
        invalid_documents.append(("extra-entity", extra_entity, 1))

        private_time = copy.deepcopy(valid)
        private_time["entities"][0]["geometry"]["actual_time_ms"] = 100
        invalid_documents.append(("private-time", private_time, 1))

        binary_float = copy.deepcopy(valid)
        binary_float["entities"][0]["style"]["lineWidth"] = 2.5
        invalid_documents.append(("binary-float", binary_float, 1))

        safe_integer_wrapper = copy.deepcopy(valid)
        safe_integer_wrapper["entities"][0]["style"]["lineWidth"] = {
            "$replay_decimal_v1": "2"
        }
        invalid_documents.append(("safe-integer-wrapper", safe_integer_wrapper, 1))

        kind_mismatch = copy.deepcopy(valid)
        kind_mismatch["entities"][0]["style"]["kind"] = "text"
        invalid_documents.append(("kind-mismatch", kind_mismatch, 1))

        duplicate_id = copy.deepcopy(valid)
        duplicate_id["entities"].append(copy.deepcopy(entity))
        invalid_documents.append(("duplicate-id", duplicate_id, 2))

        with sqlite3.connect(database) as connection:
            drawing_before = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_review_drawing_document
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
            )
            timeline_before = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_review_timeline_event
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
            )

        for index, (label, document, count) in enumerate(invalid_documents):
            with pytest.raises(TrainingRunError) as rejected:
                await service.training.record_drawing_document(
                    run_id,
                    command_id=f"phase17-invalid-{index}",
                    document_hash="sha256:" + ("0" * 64),
                    document=document,
                    entity_count=count,
                )
            assert rejected.value.code == "REVIEW_DRAWING_INVALID", label

        with pytest.raises(TrainingRunError) as mismatch:
            await service.training.record_drawing_document(
                run_id,
                command_id="phase17-hash-mismatch",
                document_hash="sha256:" + ("0" * 64),
                document=valid,
                entity_count=1,
            )
        assert mismatch.value.code == "REVIEW_DRAWING_HASH_MISMATCH"

        with sqlite3.connect(database) as connection:
            assert (
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_review_drawing_document
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
                == drawing_before
            )
            assert (
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_review_timeline_event
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
                == timeline_before
            )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_rule_history_marker_and_same_cursor_as_of_fork(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase17-rules.db"
    service = await _service(database)
    try:
        assert service.training is not None
        created = await service.training.create_run(
            _sandbox_request(await _request(service))
        )
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase17-rules-acquire",
        )
        before_rules = await service.training.rules(run_id)
        before_review = await service.training.start_review(run_id, event_id=None)
        before_event_id = str(before_review["selected_event_id"])
        with sqlite3.connect(database) as connection:
            instrument_before = tuple(
                connection.execute(
                    """
                    SELECT revision, rule_hash, rule_json
                    FROM replay_training_instrument_rule
                    WHERE run_id = ? ORDER BY track_id, revision
                    """,
                    (run_id,),
                ).fetchall()
            )

        fee_payload = {
            "maker_fee_bps": "1",
            "taker_fee_bps": "9",
            "reason": "phase17 fee revision",
        }
        fee = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase17-fee",
            command_type=ReplayV2CommandType.CHANGE_FEE_POLICY,
            payload=fee_payload,
        )
        replayed_fee = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase17-fee",
            command_type=ReplayV2CommandType.CHANGE_FEE_POLICY,
            payload=fee_payload,
        )
        assert fee["data"]["deduplicated"] is False
        assert replayed_fee["data"]["policy_hash"] == fee["data"]["policy_hash"]
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase17-leverage",
            command_type=ReplayV2CommandType.CHANGE_LEVERAGE_CAP,
            payload={
                "max_leverage": "2",
                "reason": "phase17 user cap overlay",
            },
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase17-funding",
            command_type=ReplayV2CommandType.CHANGE_FUNDING_POLICY,
            payload={
                "funding_mode": "SANDBOX_FIXED",
                "fixed_funding_rate": "0.001",
                "funding_interval_ms": 60_000,
                "reason": "phase17 sandbox funding",
            },
        )
        opened = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase17-open",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "phase17-open-order",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        assert opened["data"]["portfolio"]["fills"] == []
        assert opened["data"]["portfolio"]["history"]["fills_total"] == 1
        fill_page = await service.training.account_record_page(
            run_id,
            record_type="FILLS",
            order_scope="ALL",
            track_id=None,
            cursor=None,
            limit=50,
        )
        assert fill_page["items"]
        marker = await service.training.record_review_marker(
            run_id,
            command_id="phase17-marker",
            text="  first position opened  ",
        )
        assert marker["text"] == "first position opened"
        repeated_marker = await service.training.record_review_marker(
            run_id,
            command_id="phase17-marker",
            text="first position opened",
        )
        assert repeated_marker["deduplicated"] is True
        with pytest.raises(TrainingRunError, match="command_id was reused"):
            await service.training.record_review_marker(
                run_id,
                command_id="phase17-marker",
                text="different marker",
            )

        rules = await service.training.rules(run_id)
        assert rules["fee_policy"]["maker_fee_bps"] == "1"
        assert rules["leverage_policy"]["max_leverage"] == "2"
        assert rules["funding_policy"]["funding_mode"] == "SANDBOX_FIXED"
        assert rules["effective_leverage_by_track"]["track-1"] == "2"
        assert len(rules["history"]) == 6
        revised = [item for item in rules["history"] if item["command_id"] is not None]
        assert {item["command_id"] for item in revised} == {
            "phase17-fee",
            "phase17-leverage",
            "phase17-funding",
        }
        assert all(item["old"] is not None and item["new"] is not None for item in revised)
        assert all(
            "timeline_ms" in item["public_time"]
            and "sequence" in item["public_time"]
            for item in rules["history"]
        )
        with sqlite3.connect(database) as connection:
            instrument_after = tuple(
                connection.execute(
                    """
                    SELECT revision, rule_hash, rule_json
                    FROM replay_training_instrument_rule
                    WHERE run_id = ? ORDER BY track_id, revision
                    """,
                    (run_id,),
                ).fetchall()
            )
        assert instrument_after == instrument_before

        review = await service.training.start_review(run_id, event_id=None)
        assert {"RULE", "ORDER", "FILL", "POSITION", "MARKER"}.issubset(
            {event["category"] for event in review["events"]}
        )
        assert review["projection"]["fills"]
        assert review["projection"]["ledger"]
        assert review["projection"]["markers"][-1]["text"] == "first position opened"
        marker_event = next(
            event for event in review["events"] if event["event_id"] == marker["event_id"]
        )
        assert marker_event["detail"]["content_hash"] == marker["content_hash"]

        before_fork = await service.training.fork_run(
            run_id,
            event_id=before_event_id,
        )
        before_child_rules = await service.training.rules(
            str(before_fork["run"]["run_id"])
        )
        assert (
            before_child_rules["fee_policy"]["maker_fee_bps"]
            == before_rules["fee_policy"]["maker_fee_bps"]
        )
        assert (
            before_child_rules["leverage_policy"]["max_leverage"]
            == before_rules["leverage_policy"]["max_leverage"]
        )
        assert before_child_rules["funding_policy"]["funding_mode"] == "OFF"

        latest_fork = await service.training.fork_run(
            run_id,
            event_id=str(review["selected_event_id"]),
        )
        latest_child_rules = await service.training.rules(
            str(latest_fork["run"]["run_id"])
        )
        assert latest_child_rules["fee_policy"]["maker_fee_bps"] == "1"
        assert latest_child_rules["leverage_policy"]["max_leverage"] == "2"
        assert latest_child_rules["funding_policy"]["funding_mode"] == "SANDBOX_FIXED"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_review_anchor_survives_core_ring_eviction_and_restart(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase17-anchor-restart.db"
    service = await _service(database)
    run_id = ""
    target_event_id = ""
    target_state_hash = ""
    target_checkpoint_id = 0
    try:
        assert service.training is not None
        created = await service.training.create_run(await _request(service))
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase17-anchor-acquire",
        )
        session = await service.get_session(session_id)
        await service.training.command(
            run_id,
            _command(
                run_id,
                "phase17-anchor-target",
                ReplayV2CommandType.SET_SPEED,
                session,
                {"speed": 1},
            ),
        )
        target_review = await service.training.start_review(run_id, event_id=None)
        target_event_id = str(target_review["selected_event_id"])
        target_state_hash = str(target_review["selected_state_hash"])
        for index in range(40):
            session = await service.get_session(session_id)
            await service.training.command(
                run_id,
                _command(
                    run_id,
                    f"phase17-anchor-evict-{index}",
                    ReplayV2CommandType.SET_SPEED,
                    session,
                    {"speed": 5 if index % 2 == 0 else 1},
                ),
            )
        with sqlite3.connect(database) as connection:
            target_checkpoint_id = int(
                connection.execute(
                    """
                    SELECT anchor.checkpoint_id
                    FROM replay_review_timeline_event AS event
                    JOIN replay_review_event_anchor AS link
                      ON link.run_id = event.run_id
                     AND link.timeline_sequence = event.timeline_sequence
                     AND link.track_id = 'track-1'
                    JOIN replay_review_actor_anchor AS anchor
                      ON anchor.run_id = link.run_id
                     AND anchor.anchor_id = link.anchor_id
                    WHERE event.run_id = ? AND event.event_id = ?
                    """,
                    (run_id, target_event_id),
                ).fetchone()[0]
            )
            assert (
                connection.execute(
                    "SELECT 1 FROM replay_checkpoint WHERE checkpoint_id = ?",
                    (target_checkpoint_id,),
                ).fetchone()
                is None
            )
            assert (
                connection.execute(
                    """
                    SELECT payload_sha256 FROM replay_review_actor_anchor
                    WHERE run_id = ? AND checkpoint_id = ?
                    """,
                    (run_id, target_checkpoint_id),
                ).fetchone()
                is not None
            )
    finally:
        await service.shutdown(step_timeout=1.0)

    restarted = await _service(database)
    try:
        assert restarted.training is not None
        restarted._session_id_factory = type(  # noqa: SLF001
            restarted._session_id_factory  # noqa: SLF001
        )("phase17-restart-adapter")
        restarted.training._run_id_factory = type(  # noqa: SLF001
            restarted.training._run_id_factory  # noqa: SLF001
        )("phase17-restart-run")
        review = await restarted.training.start_review(
            run_id,
            event_id=target_event_id,
        )
        assert review["selected_state_hash"] == target_state_hash
        forked = await restarted.training.fork_run(
            run_id,
            event_id=target_event_id,
        )
        assert forked["parent_event_id"] == target_event_id
        assert forked["run"]["state_hash"] == target_state_hash
        with sqlite3.connect(database) as connection:
            assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
            assert (
                connection.execute(
                    """
                    SELECT 1 FROM replay_review_actor_anchor
                    WHERE run_id = ? AND checkpoint_id = ?
                    """,
                    (run_id, target_checkpoint_id),
                ).fetchone()
                is not None
            )
    finally:
        await restarted.shutdown(step_timeout=1.0)


async def test_review_requires_a_paused_original_run(tmp_path: Path) -> None:
    service = await _service(tmp_path / "phase17-review-pause.db")
    try:
        assert service.training is not None
        created = await service.training.create_run(await _request(service))
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase17-review-pause-acquire",
        )
        session = await service.get_session(session_id)
        playing = await service.training.command(
            run_id,
            _command(
                run_id,
                "phase17-review-play",
                ReplayV2CommandType.PLAY,
                session,
                {"basis": "BASE_BAR", "rate": 1},
            ),
        )
        assert playing["state"] == "PLAYING"
        with pytest.raises(TrainingRunError) as active_error:
            await service.training.start_review(run_id, event_id=None)
        assert active_error.value.code == "REVIEW_REQUIRES_PAUSED_RUN"

        current = await service.get_session(session_id)
        paused = await service.training.command(
            run_id,
            _command(
                run_id,
                "phase17-review-pause",
                ReplayV2CommandType.PAUSE,
                current,
                {},
            ),
        )
        assert paused["state"] == "PAUSED"
        review = await service.training.start_review(run_id, event_id=None)
        assert review["read_only"] is True
        reopened = review
        for _ in range(50):
            reopened = await service.training.start_review(run_id, event_id=None)
        assert reopened["review_id"] == review["review_id"]
        assert reopened["cursor_revision"] == review["cursor_revision"] + 50
        with sqlite3.connect(tmp_path / "phase17-review-pause.db") as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_review_session WHERE run_id = ?",
                (run_id,),
            ).fetchone() == (1,)
            assert connection.execute(
                """
                SELECT COUNT(*) FROM replay_review_cursor
                WHERE review_id = ?
                """,
                (review["review_id"],),
            ).fetchone() == (1,)
            assert connection.execute(
                """
                SELECT COUNT(DISTINCT owner_id)
                FROM replay_data_segment_ref
                WHERE run_id = ? AND owner_kind = 'REVIEW' AND active = 1
                """,
                (run_id,),
            ).fetchone()[0] <= 1
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_review_cursor_conflict_and_original_view_change_fail_closed(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "phase17-review-cursor.db")
    try:
        assert service.training is not None
        created = await service.training.create_run(await _request(service))
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        review = await service.training.start_review(run_id, event_id=None)
        with pytest.raises(TrainingRunError) as conflict:
            await service.training.control_review(
                run_id,
                str(review["review_id"]),
                action="NEXT",
                event_id=None,
                expected_cursor_revision=99,
                playback_rate=None,
            )
        assert conflict.value.code == "REVIEW_CURSOR_CONFLICT"

        before = await service.get_session(session_id)
        changed = await service.training.command(
            run_id,
            _command(
                run_id,
                    "phase17-review-view-change",
                    ReplayV2CommandType.SET_DISPLAY_INTERVAL,
                    before,
                    {
                        "display_interval": "5m",
                        "expected_viewer_revision": 0,
                    },
                ),
        )
        assert changed["viewer_state"]["semantic_view_revision"] == 1
        with pytest.raises(TrainingRunError) as changed_error:
            await service.training.control_review(
                run_id,
                str(review["review_id"]),
                action="NEXT",
                event_id=None,
                expected_cursor_revision=int(review["cursor_revision"]),
                playback_rate=None,
            )
        assert changed_error.value.code == "REVIEW_ORIGINAL_RUN_CHANGED"
        with sqlite3.connect(tmp_path / "phase17-review-cursor.db") as connection:
            cursor = connection.execute(
                """
                SELECT cursor_revision, timeline_sequence
                FROM replay_review_cursor WHERE review_id = ?
                """,
                (review["review_id"],),
            ).fetchone()
            assert tuple(cursor) == (
                review["cursor_revision"],
                review["selected_timeline_sequence"],
            )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_review_budgets_rollback_and_100k_viewport_offers_are_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "phase17-budget.db"
    service = await _service(database)
    try:
        assert service.training is not None
        created = await service.training.create_run(await _request(service))
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        store = service.training.store
        public_time = {
            "policy": "NONE",
            "timeline_ms": 1,
            "relative_ms": 0,
            "sequence": 0,
            "label": "bounded viewport",
        }

        def offer_viewports(connection: sqlite3.Connection) -> None:
            for index in range(100_000):
                bucket = index % 2_048
                store._review.record_viewport(  # noqa: SLF001
                    connection,
                    run_id=run_id,
                    bucket_key=f"viewport:{bucket}",
                    event_type="VISIBLE_RANGE",
                    value={"from": index, "to": index + 10},
                    public_time=public_time,
                    now_ms=index + 1,
                )
            bounded_count, sample_count = connection.execute(
                """
                SELECT COUNT(*), SUM(sample_count)
                FROM replay_review_viewport_sample WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            assert bounded_count == 2_048
            assert sample_count == 100_000
            for index in range(2_048, 3_048):
                store._review.record_viewport(  # noqa: SLF001
                    connection,
                    run_id=run_id,
                    bucket_key=f"viewport:{index}",
                    event_type="VISIBLE_RANGE",
                    value={"from": index, "to": index + 10},
                    public_time=public_time,
                    now_ms=100_001 + index,
                )

        await store.base_store.run_extension_write(offer_viewports)
        with sqlite3.connect(database) as connection:
            viewport_count, offered_count = connection.execute(
                """
                SELECT COUNT(*), SUM(sample_count)
                FROM replay_review_viewport_sample WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            assert viewport_count == 2_048
            assert offered_count <= 101_000

        document = {
            "documentSchemaVersion": 1,
            "scopeKey": f"replay-run:{run_id}",
            "documentRevision": 1,
            "updatedAt": 1,
            "entities": [],
        }
        with sqlite3.connect(database) as connection:
            artifact_used = int(
                connection.execute(
                    """
                    SELECT COALESCE(SUM(length(CAST(projection_json AS BLOB))), 0)
                    FROM replay_review_timeline_event WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
            )
            timeline_before = int(
                connection.execute(
                    "SELECT COUNT(*) FROM replay_review_timeline_event WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
            )
        document_bytes = len(canonical_json(document).encode("utf-8"))
        failing_limit = artifact_used + document_bytes + 1
        with monkeypatch.context() as bounded:
            bounded.setattr(
                training_storage_module,
                "REVIEW_ARTIFACT_BYTES_LIMIT",
                failing_limit,
            )
            bounded.setattr(
                review_module,
                "REVIEW_ARTIFACT_BYTES_LIMIT",
                failing_limit,
            )
            with pytest.raises(TrainingRunError) as artifact_error:
                await service.training.record_drawing_document(
                    run_id,
                    command_id="phase17-over-budget-drawing",
                    document_hash=canonical_sha256(document),
                    document=document,
                    entity_count=0,
                )
            assert artifact_error.value.code == "REVIEW_ARTIFACT_BUDGET_EXCEEDED"
        with sqlite3.connect(database) as connection:
            assert (
                connection.execute(
                    """
                    SELECT COUNT(*) FROM replay_review_drawing_document
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
                == 0
            )
            assert (
                connection.execute(
                    "SELECT COUNT(*) FROM replay_review_timeline_event WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
                == timeline_before
            )

        with monkeypatch.context() as bounded:
            bounded.setattr(
                review_module,
                "REVIEW_CRITICAL_EVENT_LIMIT",
                timeline_before,
            )
            with pytest.raises(TrainingRunError) as event_error:
                await service.training.record_review_marker(
                    run_id,
                    command_id="phase17-over-budget-marker",
                    text="must rollback",
                )
            assert event_error.value.code == "REVIEW_TIMELINE_BUDGET_EXCEEDED"
        with sqlite3.connect(database) as connection:
            assert (
                connection.execute(
                    "SELECT COUNT(*) FROM replay_review_marker WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
                == 0
            )

        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase17-budget-acquire",
        )
        with sqlite3.connect(database) as connection:
            durable_before = tuple(
                connection.execute(
                    """
                    SELECT revision, state_hash FROM replay_session
                    WHERE session_id = ?
                    """,
                    (session_id,),
                ).fetchone()
            )
            anchor_bytes = int(
                connection.execute(
                    """
                    SELECT SUM(
                        CASE WHEN stored_bytes > 0 THEN stored_bytes
                             ELSE length(payload) END
                    )
                    FROM replay_review_actor_anchor
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
            )
        session = await service.get_session(session_id)
        with monkeypatch.context() as bounded:
            bounded.setattr(
                review_module,
                "REVIEW_ANCHOR_BYTES_LIMIT",
                anchor_bytes,
            )
            with pytest.raises(TrainingRunError):
                await service.training.command(
                    run_id,
                    _command(
                        run_id,
                        "phase17-over-budget-anchor",
                        ReplayV2CommandType.SET_SPEED,
                        session,
                        {"speed": 5},
                    ),
                )
        with sqlite3.connect(database) as connection:
            durable_after = tuple(
                connection.execute(
                    """
                    SELECT revision, state_hash FROM replay_session
                    WHERE session_id = ?
                    """,
                    (session_id,),
                ).fetchone()
            )
            assert durable_after == durable_before
            assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_exact_leverage_overlay_preserves_archive_rules_and_funding_rejects_cleanly(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase17-exact-rules.db"
    archive = tmp_path / "phase17-exact-rules.sqlite3"
    build_account_history_archive(
        archive,
        archive_id="phase17-exact-rules",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    service = await _exact_service(database)
    try:
        assert service.training is not None
        base = _sandbox_request(
            await _exact_base_request(service),
            funding_mode="HISTORICAL_EXACT",
        )
        exact, _ = await _import_and_plan(
            service,
            archive,
            _exact_request(base, funding=True),
        )
        created = await service.training.create_run(exact)
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase17-exact-acquire",
        )
        with sqlite3.connect(database) as connection:
            archive_rules_before = tuple(
                connection.execute(
                    """
                    SELECT revision, rule_hash, rule_json
                    FROM replay_training_instrument_rule
                    WHERE run_id = ? ORDER BY track_id, revision
                    """,
                    (run_id,),
                ).fetchall()
            )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase17-exact-leverage",
            command_type=ReplayV2CommandType.CHANGE_LEVERAGE_CAP,
            payload={
                "max_leverage": "2",
                "reason": "phase17 exact user cap",
            },
        )
        rules = await service.training.rules(run_id)
        assert rules["leverage_policy"]["max_leverage"] == "2"
        assert rules["effective_leverage_by_track"]["track-1"] == "2"
        assert all(
            item["fidelity"] == "HISTORICAL_EXACT_VERSIONED_EXCHANGE_RULE"
            for item in rules["instrument_rules"]
        )
        with sqlite3.connect(database) as connection:
            archive_rules_after = tuple(
                connection.execute(
                    """
                    SELECT revision, rule_hash, rule_json
                    FROM replay_training_instrument_rule
                    WHERE run_id = ? ORDER BY track_id, revision
                    """,
                    (run_id,),
                ).fetchall()
            )
            before_counts = tuple(
                connection.execute(
                    """
                    SELECT
                      (SELECT COUNT(*) FROM replay_training_funding_policy
                       WHERE run_id = ?),
                      (SELECT COUNT(*) FROM replay_training_contract_ledger
                       WHERE run_id = ?),
                      (SELECT COUNT(*) FROM replay_run_action_event
                       WHERE run_id = ?),
                      (SELECT COUNT(*) FROM replay_review_timeline_event
                       WHERE run_id = ?)
                    """,
                    (run_id, run_id, run_id, run_id),
                ).fetchone()
            )
            account_before = tuple(
                connection.execute(
                    """
                    SELECT funding_mode, fixed_funding_rate,
                           funding_interval_ms, ledger_tail_hash
                    FROM replay_training_contract_account WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()
            )
        assert archive_rules_after == archive_rules_before
        with pytest.raises(TrainingRunError) as rejected:
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="phase17-exact-funding-rejected",
                command_type=ReplayV2CommandType.CHANGE_FUNDING_POLICY,
                payload={
                    "funding_mode": "SANDBOX_FIXED",
                    "fixed_funding_rate": "0.001",
                    "funding_interval_ms": 60_000,
                    "reason": "must not replace exact funding",
                },
            )
        assert rejected.value.code == "HISTORICAL_FUNDING_POLICY_IMMUTABLE"
        with sqlite3.connect(database) as connection:
            after_counts = tuple(
                connection.execute(
                    """
                    SELECT
                      (SELECT COUNT(*) FROM replay_training_funding_policy
                       WHERE run_id = ?),
                      (SELECT COUNT(*) FROM replay_training_contract_ledger
                       WHERE run_id = ?),
                      (SELECT COUNT(*) FROM replay_run_action_event
                       WHERE run_id = ?),
                      (SELECT COUNT(*) FROM replay_review_timeline_event
                       WHERE run_id = ?)
                    """,
                    (run_id, run_id, run_id, run_id),
                ).fetchone()
            )
            account_after = tuple(
                connection.execute(
                    """
                    SELECT funding_mode, fixed_funding_rate,
                           funding_interval_ms, ledger_tail_hash
                    FROM replay_training_contract_account WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()
            )
        assert after_counts == before_counts
        assert account_after == account_before
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_review_indexes_funding_and_max_drawdown_liquidation_frames(
    tmp_path: Path,
) -> None:
    funding_service = await _service(tmp_path / "phase17-funding-events.db")
    try:
        assert funding_service.training is not None
        created = await funding_service.training.create_run(
            _sandbox_request(
                await _request(funding_service),
                funding_mode="SANDBOX_FIXED",
                fixed_funding_rate="0.001",
                funding_interval_ms=60_000,
            )
        )
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            funding_service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase17-funding-events-acquire",
        )
        await _send(
            funding_service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase17-funding-events-position",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "phase17-funding-events-position",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        for index in range(2):
            await _send(
                funding_service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"phase17-funding-events-step-{index}",
                command_type=ReplayV2CommandType.STEP_BASE,
                payload={"count": 1},
            )
        funding_review = await funding_service.training.start_review(
            run_id,
            event_id=None,
        )
        assert any(
            event["event_type"] == "FUNDING_SETTLEMENT"
            for event in funding_review["events"]
        )
        funding_event = next(
            event
            for event in funding_review["events"]
            if event["event_type"] == "FUNDING_SETTLEMENT"
        )
        funding_projection = await funding_service.training.control_review(
            run_id,
            str(funding_review["review_id"]),
            action="JUMP",
            event_id=str(funding_event["event_id"]),
            expected_cursor_revision=int(funding_review["cursor_revision"]),
            playback_rate=None,
        )
        assert any(
            entry["kind"] == "FUNDING_SETTLEMENT"
            for entry in funding_projection["projection"]["ledger"]
        )
    finally:
        await funding_service.shutdown(step_timeout=1.0)

    liquidation_service = await _risk_service(
        tmp_path / "phase17-liquidation-events.db"
    )
    try:
        assert liquidation_service.training is not None
        created = await liquidation_service.training.create_run(
            _sandbox_request(
                await _request(liquidation_service),
                initial_equity="100",
            )
        )
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            liquidation_service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase17-liquidation-acquire",
        )
        await _send(
            liquidation_service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase17-liquidation-entry",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "phase17-liquidation-entry",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "2.5",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        for index in range(2):
            await _send(
                liquidation_service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"phase17-liquidation-step-{index}",
                command_type=ReplayV2CommandType.STEP_BASE,
                payload={"count": 1},
            )
        liquidation_review = await liquidation_service.training.start_review(
            run_id,
            event_id=None,
        )
        event_types = {
            event["event_type"] for event in liquidation_review["events"]
        }
        assert "LIQUIDATION" in event_types
        assert "MAX_DRAWDOWN" in event_types
        liquidation_event = next(
            event
            for event in liquidation_review["events"]
            if event["event_type"] == "LIQUIDATION"
        )
        selected = await liquidation_service.training.control_review(
            run_id,
            str(liquidation_review["review_id"]),
            action="JUMP",
            event_id=str(liquidation_event["event_id"]),
            expected_cursor_revision=int(liquidation_review["cursor_revision"]),
            playback_rate=None,
        )
        assert selected["projection"]["domain"]["liquidation_count"] == 1
        assert selected["projection"]["tracks"][0]["position"]["quantity"] == "0"
    finally:
        await liquidation_service.shutdown(step_timeout=1.0)
