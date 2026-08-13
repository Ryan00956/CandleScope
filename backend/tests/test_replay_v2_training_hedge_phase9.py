from __future__ import annotations

import asyncio
import json
import sqlite3
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pytest

from app.replay.service import ReplayService
from app.replay.training.errors import TrainingRunError
from app.replay.training.hedge_inputs import build_hedge_public_history_archive
from app.replay.training.models import (
    ReplayV2CommandType,
    TrainingRunCreateRequest,
    TrainingRunMarketSelectionRequest,
    TrainingRunSetupRequest,
)
from tests.fixtures.replay.hedge_input_fakes import (
    build_book_archive,
    import_hedge_track_public_inputs,
    prepare_hedge_request,
)
from tests.test_replay_v2_training_phase5 import _acquire, _request
from tests.test_replay_v2_training_phase6 import _risk_service, _sandbox_request, _send


pytestmark = pytest.mark.anyio


@pytest.mark.parametrize(
    ("time_disclosure_policy", "expected_time_domain"),
    (("HIDE_ALL", "PUBLIC"), ("NONE", "ACTUAL")),
)
async def test_public_hedge_input_view_uses_one_disclosed_time_domain(
    tmp_path: Path,
    time_disclosure_policy: str,
    expected_time_domain: str,
) -> None:
    database = tmp_path / f"phase9-public-input-{time_disclosure_policy.lower()}.db"
    service = await _risk_service(database)
    try:
        base = replace(
            _sandbox_request(await _request(service)),
            market_type="futures",
            time_disclosure_policy=time_disclosure_policy,
        )
        request = await prepare_hedge_request(
            service,
            base,
            root=tmp_path,
            prefix=f"phase9-public-input-{time_disclosure_policy.lower()}",
            mark_prices=["100"] * 13,
        )
        assert service.training is not None
        created = await service.training.create_run(request)
        run_id = str(created["run"]["run_id"])
        public_portfolio = (await service.training.get_market_tracks(run_id))[
            "portfolio"
        ]
        public_view = public_portfolio["hedge_inputs"]

        def read_private(
            connection: sqlite3.Connection,
        ) -> tuple[dict[str, object], sqlite3.Row]:
            private_view = service.training.store._hedge_input_projection(
                connection,
                run_id=run_id,
            )
            dataset = connection.execute(
                """
                SELECT actual_replay_start_ms, actual_replay_end_ms,
                       synthetic_origin_ms
                FROM replay_dataset_ref
                WHERE session_id = (
                    SELECT adapter_session_id FROM replay_training_run
                    WHERE run_id = ?
                )
                """,
                (run_id,),
            ).fetchone()
            assert private_view is not None and dataset is not None
            return private_view, dataset

        (
            private_view,
            dataset,
        ) = await service.training.store.base_store.run_extension_read(read_private)
        assert private_view["schema_version"] == "replay.hedge-input-view.v1"
        assert public_view["schema_version"] == "replay.hedge-input-view.v2"
        assert public_view["time_domain"] == expected_time_domain
        expected_origin = (
            int(dataset["synthetic_origin_ms"])
            if expected_time_domain == "PUBLIC"
            else int(dataset["actual_replay_start_ms"])
        )
        assert public_view["bound_range_start_ms"] == expected_origin
        assert public_view["bound_range_end_ms"] == (
            expected_origin
            + int(private_view["bound_range_end_ms"])
            - int(private_view["bound_range_start_ms"])
        )
        for projection in [
            *public_view["projections"],
            *(item["projection"] for item in public_view["track_public"]),
        ]:
            assert projection["time_domain"] == expected_time_domain
            assert (
                public_view["bound_range_start_ms"]
                <= projection["as_of_time_ms"]
                <= public_view["bound_range_end_ms"]
            )
            assert "state" not in projection
            assert "as_of_actual_time_ms" not in projection
            assert "as_of_virtual_time_ms" not in projection
            assert projection["state_hash"].startswith("sha256:")
            assert projection["source_component_hash"].startswith("sha256:")
        assert set(public_view["auditor"]) == {
            "status",
            "proof_hash",
            "difference_count",
            "difference_hashes",
        }
        account_audit = await service.training.audit_account(run_id)
        hedge_audit = account_audit["hedge_input_audit"]
        assert hedge_audit == {
            "schema_version": "replay.hedge-input-audit-summary.v1",
            "status": "PASS",
            "proof_hash": hedge_audit["proof_hash"],
            "difference_count": 0,
            "difference_hashes": [],
            "snapshot_hash": hedge_audit["snapshot_hash"],
        }
        assert str(hedge_audit["proof_hash"]).startswith("sha256:")
        assert str(hedge_audit["snapshot_hash"]).startswith("sha256:")
        encoded_audit = json.dumps(account_audit, separators=(",", ":"))
        assert '"as_of_actual_time_ms"' not in encoded_audit
        assert '"as_of_virtual_time_ms"' not in encoded_audit
        assert (
            '"snapshot":{"schema_version":"replay.hedge-input-audit.v1"'
            not in encoded_audit
        )
        if expected_time_domain == "PUBLIC":
            encoded = json.dumps(public_view, separators=(",", ":"))
            assert str(private_view["bound_range_start_ms"]) not in encoded
            assert str(private_view["bound_range_end_ms"]) not in encoded
            assert '"as_of_actual_time_ms"' not in encoded
            assert '"state":' not in encoded
            session_id = str(created["run"]["adapter_session_id"])
            await _acquire(
                service,
                run_id=run_id,
                selected_session_id=session_id,
                command_id="phase9-public-input-reveal-acquire",
            )
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="phase9-public-input-reveal",
                command_type=ReplayV2CommandType.REVEAL_TIME,
                payload={"reason": "verify irreversible public HEDGE time view"},
            )
            revealed_view = (await service.training.get_market_tracks(run_id))[
                "portfolio"
            ]["hedge_inputs"]
            assert revealed_view["time_domain"] == "ACTUAL"
            assert revealed_view["bound_range_start_ms"] == int(
                private_view["bound_range_start_ms"]
            )
            assert all(
                item["time_domain"] == "ACTUAL" for item in revealed_view["projections"]
            )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_same_symbol_hedge_legs_add_protect_partial_close_and_flatten(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "phase9-leg-lifecycle.db")
    try:
        base = replace(
            _sandbox_request(await _request(service), initial_equity="10000"),
            market_type="futures",
        )
        request = await prepare_hedge_request(
            service,
            base,
            root=tmp_path,
            prefix="phase9-leg-lifecycle",
            mark_prices=["100"] * 13,
        )
        assert service.training is not None
        created = await service.training.create_run(request)
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase9-leg-lifecycle-acquire",
        )
        for position_side, side in (("LONG", "BUY"), ("SHORT", "SELL")):
            for ordinal, quantity in enumerate(("0.5", "0.25"), start=1):
                await _send(
                    service,
                    run_id=run_id,
                    session_id=session_id,
                    command_id=(
                        f"phase9-leg-lifecycle-{position_side.lower()}-{ordinal}"
                    ),
                    command_type=ReplayV2CommandType.PLACE_ORDER,
                    payload={
                        "client_order_id": (
                            f"phase9-leg-lifecycle-{position_side.lower()}-{ordinal}"
                        ),
                        "side": side,
                        "position_side": position_side,
                        "order_type": "MARKET",
                        "quantity": quantity,
                        "reduce_only": False,
                        "limit_price": None,
                        "stop_price": None,
                    },
                )
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"phase9-leg-lifecycle-partial-{position_side.lower()}",
                command_type=ReplayV2CommandType.CLOSE_POSITION,
                payload={"quantity": "0.2", "position_side": position_side},
            )
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"phase9-leg-lifecycle-protect-{position_side.lower()}",
                command_type=ReplayV2CommandType.SET_POSITION_PROTECTION,
                payload={
                    "position_side": position_side,
                    "quantity": None,
                    "stop_loss_price": "80" if position_side == "LONG" else "120",
                    "take_profit_price": "120" if position_side == "LONG" else "80",
                },
            )
        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]
        assert {
            item["position_side"]: item["position"]["quantity"]
            for item in portfolio["positions"]
        } == {"LONG": "0.55", "SHORT": "-0.55"}
        assert all(
            len(item["protection"]["orders"]) == 2 for item in portfolio["positions"]
        )
        for position_side in ("LONG", "SHORT"):
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"phase9-leg-lifecycle-flat-{position_side.lower()}",
                command_type=ReplayV2CommandType.CLOSE_POSITION,
                payload={"quantity": None, "position_side": position_side},
            )
        final = (await service.training.get_market_tracks(run_id))["portfolio"]
        assert final["positions"] == []
        assert final["status"] == "ACTIVE"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_high_rate_hedge_playback_yields_control_lock_after_each_bar(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _risk_service(tmp_path / "phase9-interactive-playback-liveness.db")
    pause_task: asyncio.Task[dict[str, object]] | None = None
    release_first_bar = asyncio.Event()
    try:
        base = replace(
            _sandbox_request(await _request(service), initial_equity="10000"),
            market_type="futures",
        )
        request = await prepare_hedge_request(
            service,
            base,
            root=tmp_path,
            prefix="phase9-interactive-playback-liveness",
            mark_prices=["100"] * 13,
        )
        assert service.training is not None
        created = await service.training.create_run(request)
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase9-interactive-playback-liveness-acquire",
        )
        # Match the order/fill cardinality from the release-soak failure while
        # compressing away its wall-clock waits and browser lifecycle work.
        for ordinal in range(37):
            for side, position_side in (("BUY", "LONG"), ("SELL", "SHORT")):
                suffix = f"{position_side.lower()}-{ordinal}"
                await _send(
                    service,
                    run_id=run_id,
                    session_id=session_id,
                    command_id=f"phase9-interactive-playback-liveness-{suffix}",
                    command_type=ReplayV2CommandType.PLACE_ORDER,
                    payload={
                        "client_order_id": (
                            f"phase9-interactive-playback-liveness-{suffix}"
                        ),
                        "side": side,
                        "position_side": position_side,
                        "order_type": "MARKET",
                        "quantity": "0.05",
                        "leverage": "3",
                        "reduce_only": False,
                        "limit_price": None,
                        "stop_price": None,
                    },
                )

        def accumulated_counts(connection: sqlite3.Connection) -> tuple[int, int]:
            orders = connection.execute(
                "SELECT COUNT(*) FROM replay_training_contract_order WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            fills = connection.execute(
                "SELECT COUNT(*) FROM replay_training_contract_fill WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            assert orders is not None and fills is not None
            return int(orders[0]), int(fills[0])

        assert await service.training.store.base_store.run_extension_read(
            accumulated_counts
        ) == (74, 74)

        binding = await service.training.store.run_binding(run_id)
        projection = await service.training.get_market_tracks(run_id)
        tracks = tuple(
            track
            for track in projection["tracks"]
            if track["subscription_tier"] == "FULL"
        )
        before_play = await service.get_session(session_id)
        before_sequence = int(before_play["snapshot"]["cursor"]["source_sequence"])
        assert (
            service.training._ordered_playback_interactive_batch_limit(
                binding=binding,
                tracks=tracks,
                snapshot=before_play["snapshot"],
                target_virtual_time_ms=(
                    int(before_play["snapshot"]["cursor"]["virtual_time_ms"]) + 60_000
                ),
            )
            == 1
        )

        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase9-interactive-playback-liveness-profile",
            command_type=ReplayV2CommandType.SET_SPEED,
            payload={"basis": "BASE_BAR", "rate": 10_000},
        )

        original_advance = service.training._advance_adapter_to
        first_bar_advanced = asyncio.Event()
        advance_kwargs: list[dict[str, object]] = []

        async def forbidden_account_audit(_run_id: str) -> dict[str, object]:
            raise AssertionError(
                "ordered playback must not run the exhaustive account auditor "
                "while holding the pause acknowledgement lock"
            )

        async def controlled_advance(**kwargs):
            advance_kwargs.append(dict(kwargs))
            result = await original_advance(**kwargs)
            first_bar_advanced.set()
            await release_first_bar.wait()
            return result

        monkeypatch.setattr(
            service.training,
            "_advance_adapter_to",
            controlled_advance,
        )
        monkeypatch.setattr(
            service.training,
            "audit_account",
            forbidden_account_audit,
        )
        monkeypatch.setattr(
            "app.replay.training.service.discrete_playback_units",
            lambda _elapsed_seconds, *, rate: 64,
        )

        playing = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase9-interactive-playback-liveness-play",
            command_type=ReplayV2CommandType.PLAY,
            payload={"basis": "BASE_BAR", "rate": 10_000},
        )
        assert playing["state"] == "PLAYING"
        await asyncio.wait_for(first_bar_advanced.wait(), timeout=1.0)

        pause_task = asyncio.create_task(
            _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="phase9-interactive-playback-liveness-pause",
                command_type=ReplayV2CommandType.PAUSE,
                payload={},
            )
        )
        actor = service.training._run_actors[run_id]
        for _attempt in range(100):
            if actor._playback_stop.is_set():
                break
            await asyncio.sleep(0)
        assert actor._playback_stop.is_set()
        release_first_bar.set()

        paused = await asyncio.wait_for(pause_task, timeout=1.0)
        pause_task = None
        assert paused["state"] == "PAUSED"
        assert len(advance_kwargs) == 1
        assert advance_kwargs[0]["final_state_max_events"] is None
        assert advance_kwargs[0]["require_empty_account"] is False
        after_pause = await service.get_session(session_id)
        assert (
            int(after_pause["snapshot"]["cursor"]["source_sequence"])
            == before_sequence + 1
        )
    finally:
        release_first_bar.set()
        if pause_task is not None:
            pause_task.cancel()
            await asyncio.gather(pause_task, return_exceptions=True)
        await service.shutdown(step_timeout=1.0)


@pytest.mark.parametrize("setup_start_mode", ("MANUAL", "RANDOM"))
async def test_segment_plan_resolves_cross_verified_explicit_hedge_refs(
    tmp_path: Path,
    setup_start_mode: str,
) -> None:
    service = await _risk_service(tmp_path / "phase9-plan.db")
    try:
        base = replace(
            _sandbox_request(await _request(service), initial_equity="1000"),
            market_type="futures",
        )
        pinned = await prepare_hedge_request(
            service,
            base,
            root=tmp_path,
            prefix="phase9-plan",
            mark_prices=["100"] * 13,
        )
        planning_payload = pinned.to_dict()
        planning_payload["hedge_public_history_ref"] = None
        planning_payload["simulation_manifest_ref"] = None
        planning = TrainingRunCreateRequest.from_dict(planning_payload)
        assert service.training is not None
        plan = await service.training.segment_plan(planning)
        hedge_plan = plan["hedge_inputs"]
        assert hedge_plan["feature_enabled"] is True
        assert hedge_plan["capability_state"] == "AVAILABLE_EXACT"
        assert hedge_plan["fallback_applied"] is False
        assert hedge_plan["historical_exchange_private_state"] is False
        assert hedge_plan["hedge_public_history_ref"] == (
            pinned.hedge_public_history_ref.to_dict()
        )
        assert hedge_plan["simulation_manifest_ref"] == (
            pinned.simulation_manifest_ref.to_dict()
        )
        setup_payload = TrainingRunSetupRequest.from_market_request(planning).to_dict()
        if setup_start_mode == "RANDOM":
            setup_payload.update(
                {
                    "start_mode": "RANDOM",
                    "requested_start_ms": None,
                    "random_range_start_ms": planning.requested_start_ms,
                    "random_range_end_ms": planning.requested_start_ms,
                }
            )
        shell = await service.training.create_empty_run(
            TrainingRunSetupRequest.from_dict(setup_payload)
        )
        run_id = str(shell["run"]["run_id"])
        commitment = await service.training.store.get_time_commitment(run_id)
        assert commitment["start_mode"] == setup_start_mode
        assert commitment["committed_start_ms"] == planning.requested_start_ms
        if setup_start_mode == "RANDOM":
            assert commitment["seed_source"] == "SERVER"
            assert commitment["random_seed"] is not None
        selection_payload = {
            "catalog_epoch": planning.catalog_epoch,
            "exchange": planning.exchange,
            "market_type": planning.market_type,
            "symbol": planning.symbol,
            "base_interval": planning.base_interval,
            "display_interval": planning.display_interval,
            "account_history_ref": None,
            "hedge_public_history_ref": None,
            "simulation_manifest_ref": None,
        }
        initial_plan = await service.training.initial_market_plan(
            run_id,
            TrainingRunMarketSelectionRequest.from_dict(selection_payload),
        )
        assert initial_plan["hedge_inputs"] == hedge_plan
        selection_payload["hedge_public_history_ref"] = hedge_plan[
            "hedge_public_history_ref"
        ]
        selection_payload["simulation_manifest_ref"] = hedge_plan[
            "simulation_manifest_ref"
        ]
        created = await service.training.select_initial_market(
            run_id,
            TrainingRunMarketSelectionRequest.from_dict(selection_payload),
        )
        projection = await service.training.get_market_tracks(
            str(created["run"]["run_id"])
        )
        assert projection["portfolio"]["position_mode"] == "HEDGE"
        if setup_start_mode == "RANDOM":
            with sqlite3.connect(tmp_path / "phase9-plan.db") as connection:
                persisted = connection.execute(
                    """
                    SELECT start_mode, seed_source, random_seed, actual_start_ms
                    FROM replay_training_start_selection
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()
            assert persisted is not None
            assert persisted[0] == "RANDOM"
            assert persisted[1] == "SERVER"
            assert persisted[2] == commitment["random_seed"]
            assert persisted[3] == commitment["committed_start_ms"]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_setup_admission_never_cross_pairs_public_ref_with_another_book(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase9-cross-pair.db"
    service = await _risk_service(database)
    try:
        base = replace(
            _sandbox_request(await _request(service), initial_equity="1000"),
            market_type="futures",
        )
        pinned = await prepare_hedge_request(
            service,
            base,
            root=tmp_path,
            prefix="phase9-cross-pair",
            mark_prices=["100"] * 13,
            book_level_quantities=["1"] * 50,
        )
        assert pinned.requested_start_ms is not None
        assert pinned.hedge_public_history_ref is not None
        assert service.training is not None

        start = pinned.requested_start_ms
        short_book_path = build_book_archive(
            tmp_path / "phase9-cross-pair-short-book.sqlite3",
            exchange=pinned.exchange,
            market_type=pinned.market_type,
            symbol=pinned.symbol,
            range_start_ms=start,
            range_end_ms=start + pinned.forward_cache_ms,
        )
        short_book = await service.training.historical_books.import_archive(
            short_book_path,
            trusted_origin="TEST_CAPTURE",
        )

        original_public_path = tmp_path / "phase9-cross-pair-public.json"
        original_public = json.loads(original_public_path.read_text(encoding="utf-8"))
        short_public_path = tmp_path / "phase9-cross-pair-short-public.json"
        short_public_ref = build_hedge_public_history_archive(
            short_public_path,
            archive_id="phase9-cross-pair-short-public",
            exchange=pinned.exchange,
            market_type=pinned.market_type,
            symbol=pinned.symbol,
            settlement_asset=pinned.settlement_asset,
            range_start_ms=start,
            range_end_ms=start + pinned.forward_cache_ms,
            max_mark_gap_ms=60_000,
            source_identity="TEST_PINNED_PUBLIC_CAPTURE",
            capture_receipt="receipt:phase9-cross-pair-short",
            historical_l2_ref={
                "archive_id": short_book["archive_id"],
                "dataset_epoch": short_book["dataset_epoch"],
                "checksum_sha256": short_book["checksum_sha256"],
            },
            events=[
                {
                    "event_time_ms": event["event_time_ms"],
                    "event_kind": event["event_kind"],
                    "payload": event["payload"],
                }
                for event in original_public["events"]
            ],
        )
        await service.training.hedge_inputs.import_public(short_public_path)
        await service.training.store.base_store.run_extension_write(
            lambda connection: connection.execute(
                """
                UPDATE replay_hedge_public_archive
                SET health = 'QUARANTINED',
                    local_path = NULL,
                    quarantine_reason = 'TEST_REPLACED_BY_SHORT_REF'
                WHERE archive_id = ?
                """,
                (pinned.hedge_public_history_ref.archive_id,),
            )
        )

        planning_payload = pinned.to_dict()
        planning_payload["hedge_public_history_ref"] = None
        planning_payload["simulation_manifest_ref"] = None
        planning = TrainingRunCreateRequest.from_dict(planning_payload)
        plan = await service.training.segment_plan(planning)
        assert plan["historical_book"]["capability_state"] == "AVAILABLE_EXACT"
        assert plan["hedge_inputs"]["capability_state"] == "AVAILABLE_EXACT"
        assert plan["hedge_inputs"]["historical_l2_ref"] == {
            "archive_id": short_book["archive_id"],
            "dataset_epoch": short_book["dataset_epoch"],
            "checksum_sha256": short_book["checksum_sha256"],
        }
        assert plan["hedge_inputs"]["hedge_public_history_ref"] == {
            "schema_version": "replay.hedge-public-history-ref.v1",
            **short_public_ref,
        }

        setup = TrainingRunSetupRequest.from_market_request(planning)
        with pytest.raises(TrainingRunError) as exc_info:
            await service.training.create_empty_run(setup)
        assert exc_info.value.status_code == 409
        assert exc_info.value.code == "NO_ELIGIBLE_SOURCE_MARKET_AT_START"
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_training_run"
            ).fetchone() == (0,)
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_training_time_commitment"
            ).fetchone() == (0,)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_hedge_without_imported_archives_materializes_playable_hybrid(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "phase9-hybrid.db")
    try:
        payload = _sandbox_request(
            await _request(service),
            initial_equity="1000",
        ).to_dict()
        payload.update(
            {
                "market_type": "futures",
                "position_mode": "HEDGE",
                "account_data_mode": "DETERMINISTIC_SIMULATION",
                "account_fidelity": (
                    "PINNED_PUBLIC_INPUTS_DETERMINISTIC_SIMULATED_PRIVATE_STATE"
                ),
                "insurance_adl_fidelity": (
                    "DETERMINISTIC_SIMULATION_NOT_HISTORICAL_EXCHANGE_FACT"
                ),
                "funding_mode": "HISTORICAL_EXACT",
                "hedge_public_history_ref": None,
                "simulation_manifest_ref": None,
            }
        )
        request = TrainingRunCreateRequest.from_dict(payload)
        assert service.training is not None

        plan = await service.training.segment_plan(request)
        hedge_plan = plan["hedge_inputs"]
        assert hedge_plan["capability_state"] == "AVAILABLE_APPROX"
        assert hedge_plan["public_fidelity"] == "VERSIONED_HYBRID_PUBLIC_INPUT"
        assert hedge_plan["fallback_applied"] is True
        assert hedge_plan["historical_l2_ref"] is None
        assert hedge_plan["hedge_public_history_ref"] is not None
        assert hedge_plan["simulation_manifest_ref"] is not None

        created = await service.training.create_run(request)
        run_id = str(created["run"]["run_id"])
        projection = await service.training.get_market_tracks(run_id)
        portfolio = projection["portfolio"]
        assert portfolio["position_mode"] == "HEDGE"
        assert portfolio["funding_mode"] == "OFF"
        account_fidelity = await service.training.store.base_store.run_extension_read(
            lambda connection: connection.execute(
                "SELECT fidelity FROM replay_training_contract_account WHERE run_id = ?",
                (run_id,),
            ).fetchone()["fidelity"]
        )
        assert account_fidelity == ("HYBRID_PUBLIC_INPUT_MODELLED_HEDGE_ACCOUNT")
        capabilities = projection["tracks"][0]["capabilities"]
        assert capabilities["HISTORICAL_MARK_INDEX"] == "AVAILABLE_APPROX"
        assert capabilities["HISTORICAL_INSTRUMENT_RULE"] == "AVAILABLE_APPROX"
        assert capabilities["HISTORICAL_FUNDING"] == "OFF_NOT_REQUESTED"
        assert (await service.training.audit_account(run_id))["status"] == "PASS"
    finally:
        await service.shutdown(step_timeout=1.0)


async def _multitrack_run(
    service: ReplayService,
    root: Path,
    *,
    prefix: str,
    initial_equity: str = "10000",
    btc_marks: list[str] | None = None,
    eth_marks: list[str] | None = None,
    btc_quantities: tuple[str, str] = ("2", "2"),
    eth_quantities: tuple[str, str] = ("1", "1"),
) -> tuple[str, str, str]:
    base = replace(
        _sandbox_request(await _request(service), initial_equity=initial_equity),
        market_type="futures",
    )
    request = await prepare_hedge_request(
        service,
        base,
        root=root,
        prefix=prefix,
        mark_prices=btc_marks or (["100", "101"] + ["101"] * 11),
        required_symbols=["BTCUSDT", "ETHUSDT"],
    )
    await import_hedge_track_public_inputs(
        service,
        request,
        root=root,
        prefix=prefix,
        symbol="ETHUSDT",
        mark_prices=eth_marks or (["200", "201"] + ["201"] * 11),
    )
    assert service.training is not None
    created = await service.training.create_run(request)
    run_id = str(created["run"]["run_id"])
    primary_session = str(created["run"]["adapter_session_id"])
    await _acquire(
        service,
        run_id=run_id,
        selected_session_id=primary_session,
        command_id=f"{prefix}-acquire",
    )
    for (side, position_side), quantity in zip(
        (("BUY", "LONG"), ("SELL", "SHORT")),
        btc_quantities,
        strict=True,
    ):
        await _send(
            service,
            run_id=run_id,
            session_id=primary_session,
            command_id=f"{prefix}-btc-{position_side.lower()}",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": f"{prefix}-btc-{position_side.lower()}",
                "side": side,
                "position_side": position_side,
                "order_type": "MARKET",
                "quantity": quantity,
                "leverage": "3",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
    added = await _send(
        service,
        run_id=run_id,
        session_id=primary_session,
        command_id=f"{prefix}-add-eth",
        command_type=ReplayV2CommandType.ADD_TRACK,
        payload={
            "exchange": "binance",
            "market_type": "futures",
            "symbol": "ETHUSDT",
            "settlement_asset": "USDT",
            "subscription_tier": "FULL",
        },
    )
    track = added["data"]["track"]
    assert isinstance(track, dict)
    track_id = str(track["track_id"])
    selected = await _send(
        service,
        run_id=run_id,
        session_id=primary_session,
        command_id=f"{prefix}-select-eth",
        command_type=ReplayV2CommandType.SELECT_TRACK,
        payload={"track_id": track_id, "expected_viewer_revision": 0},
    )
    secondary_session = str(selected["session_id"])
    for (side, position_side), quantity in zip(
        (("BUY", "LONG"), ("SELL", "SHORT")),
        eth_quantities,
        strict=True,
    ):
        await _send(
            service,
            run_id=run_id,
            session_id=secondary_session,
            command_id=f"{prefix}-eth-{position_side.lower()}",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": f"{prefix}-eth-{position_side.lower()}",
                "side": side,
                "position_side": position_side,
                "order_type": "MARKET",
                "quantity": quantity,
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
    return run_id, secondary_session, track_id


async def test_real_add_track_uses_track_specific_mark_funding_and_audit(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase9-multitrack.db"
    service = await _risk_service(
        database,
        symbols=("BTCUSDT", "ETHUSDT"),
    )
    try:
        run_id, secondary_session, secondary_track_id = await _multitrack_run(
            service,
            tmp_path,
            prefix="phase9-multitrack",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=secondary_session,
            command_id="phase9-multitrack-step",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 2},
        )
        assert service.training is not None
        projection = await service.training.get_market_tracks(run_id)
        tracks = {str(track["symbol"]): track for track in projection["tracks"]}
        assert tracks["BTCUSDT"]["public_price"] == "101"
        assert tracks["ETHUSDT"]["public_price"] == "201"
        assert tracks["ETHUSDT"]["track_id"] == secondary_track_id
        positions = projection["portfolio"]["positions"]
        assert {
            (str(item["symbol"]), str(item["position_side"])) for item in positions
        } == {
            ("BTCUSDT", "LONG"),
            ("BTCUSDT", "SHORT"),
            ("ETHUSDT", "LONG"),
            ("ETHUSDT", "SHORT"),
        }
        hedge_inputs = projection["portfolio"]["hedge_inputs"]
        assert {
            (str(item["track_id"]), str(item["archive_id"]))
            for item in hedge_inputs["track_public"]
        } == {
            ("track-1", "phase9-multitrack-public"),
            (secondary_track_id, "phase9-multitrack-ethusdt-public"),
        }
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            funding = connection.execute(
                """
                SELECT track_id, position_side, mark_price
                FROM replay_training_hedge_funding_settlement
                WHERE run_id = ? ORDER BY track_id, position_side
                """,
                (run_id,),
            ).fetchall()
            assert [tuple(row) for row in funding] == [
                ("track-1", "LONG", "101"),
                ("track-1", "SHORT", "101"),
                (secondary_track_id, "LONG", "201"),
                (secondary_track_id, "SHORT", "201"),
            ]
        audit = await service.training.hedge_inputs.audit_run(run_id)
        assert audit["status"] == "PASS", audit["differences"]

        def tamper(connection: sqlite3.Connection) -> None:
            row = connection.execute(
                """
                SELECT state_json FROM replay_hedge_track_public_projection
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, secondary_track_id),
            ).fetchone()
            state = json.loads(str(row["state_json"]))
            state["mark_index"]["mark_price"] = "999"
            connection.execute(
                """
                UPDATE replay_hedge_track_public_projection SET state_json = ?
                WHERE run_id = ? AND track_id = ?
                """,
                (json.dumps(state, separators=(",", ":")), run_id, secondary_track_id),
            )

        await service.training.store.base_store.run_extension_write(tamper)
        failed = await service.training.hedge_inputs.audit_run(run_id)
        assert failed["status"] == "FAIL"
        assert any(
            str(item["field"]).startswith(f"track_projection.{secondary_track_id}")
            for item in failed["differences"]
        )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_real_multitrack_cross_breach_creates_one_account_case(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase9-multitrack-liquidation.db"
    service = await _risk_service(
        database,
        symbols=("BTCUSDT", "ETHUSDT"),
    )
    try:
        run_id, secondary_session, _ = await _multitrack_run(
            service,
            tmp_path,
            prefix="phase9-multitrack-liquidation",
            initial_equity="200",
            btc_marks=["104", "50", *(["50"] * 11)],
            eth_marks=["104", "50", *(["50"] * 11)],
            btc_quantities=("2.4", "0.4"),
            eth_quantities=("2.4", "0.4"),
        )
        await _send(
            service,
            run_id=run_id,
            session_id=secondary_session,
            command_id="phase9-multitrack-liquidation-crash",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 4},
        )
        assert service.training is not None
        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]
        assert len(portfolio["liquidations"]) == 1, portfolio
        case = portfolio["liquidations"][0]
        assert case["state"] == "COMPLETED"
        assert {str(leg["track_id"]) for leg in case["legs"]} == {
            "track-1",
            "track-2",
        }
        execution_orders = [
            order
            for step in case["steps"]
            if step["step_type"] in {"PARTIAL_LIQUIDATION", "FULL_LIQUIDATION"}
            for order in step["orders"]
        ]
        assert execution_orders
        execution_fills = [
            fill for order in execution_orders for fill in order["fills"]
        ]
        assert len({str(order["order_id"]) for order in execution_orders}) == len(
            execution_orders
        )
        assert len({str(fill["fill_id"]) for fill in execution_fills}) == len(
            execution_fills
        )
        assert Decimal(str(portfolio["liquidation_fees_paid"])) == sum(
            (Decimal(str(fill["liquidation_fee"])) for fill in execution_fills),
            start=Decimal("0"),
        )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_added_hedge_full_track_fails_closed_without_exact_public_input(
    tmp_path: Path,
) -> None:
    service = await _risk_service(
        tmp_path / "phase9-missing-public.db",
        symbols=("BTCUSDT", "ETHUSDT"),
    )
    try:
        base = replace(
            _sandbox_request(await _request(service), initial_equity="10000"),
            market_type="futures",
        )
        request = await prepare_hedge_request(
            service,
            base,
            root=tmp_path,
            prefix="phase9-missing-public",
            required_symbols=["BTCUSDT", "ETHUSDT"],
        )
        assert service.training is not None
        created = await service.training.create_run(request)
        run_id = str(created["run"]["run_id"])
        primary_session = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=primary_session,
            command_id="phase9-missing-acquire",
        )
        with pytest.raises(TrainingRunError) as unavailable:
            await _send(
                service,
                run_id=run_id,
                session_id=primary_session,
                command_id="phase9-missing-add",
                command_type=ReplayV2CommandType.ADD_TRACK,
                payload={
                    "exchange": "binance",
                    "market_type": "futures",
                    "symbol": "ETHUSDT",
                    "settlement_asset": "USDT",
                    "subscription_tier": "FULL",
                },
            )
        assert unavailable.value.code == "HISTORICAL_BOOK_EXACT_COVERAGE_UNAVAILABLE"
        tracks = await service.training.get_market_tracks(run_id)
        assert [track["symbol"] for track in tracks["tracks"]] == ["BTCUSDT"]
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.parametrize(
    ("crash_mark", "victim_side", "survivor_side"),
    [
        ("50", "LONG", "SHORT"),
        ("150", "SHORT", "LONG"),
    ],
)
async def test_isolated_liquidation_closes_only_the_breached_hedge_leg(
    tmp_path: Path,
    crash_mark: str,
    victim_side: str,
    survivor_side: str,
) -> None:
    suffix = victim_side.lower()
    service = await _risk_service(tmp_path / f"phase9-isolated-{suffix}.db")
    try:
        base = replace(
            _sandbox_request(
                await _request(service),
                initial_equity="200",
                margin_mode="ISOLATED",
            ),
            market_type="futures",
        )
        request = await prepare_hedge_request(
            service,
            base,
            root=tmp_path,
            prefix=f"phase9-isolated-{suffix}",
            mark_prices=["104", crash_mark, *([crash_mark] * 11)],
            insurance_opening_balance="1000000",
        )
        assert service.training is not None
        created = await service.training.create_run(request)
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id=f"phase9-isolated-{suffix}-acquire",
        )
        for position_side in ("LONG", "SHORT"):
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"phase9-isolated-{suffix}-allocate-{position_side.lower()}",
                command_type=ReplayV2CommandType.ALLOCATE_ISOLATED_MARGIN,
                payload={
                    "track_id": "track-1",
                    "position_side": position_side,
                    "amount": "70",
                },
            )
        for position_side in ("LONG", "SHORT"):
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"phase9-isolated-{suffix}-open-{position_side.lower()}",
                command_type=ReplayV2CommandType.PLACE_ORDER,
                payload={
                    "client_order_id": (
                        f"phase9-isolated-{suffix}-open-{position_side.lower()}"
                    ),
                    "side": "BUY" if position_side == "LONG" else "SELL",
                    "position_side": position_side,
                    "order_type": "MARKET",
                    "quantity": "2" if position_side == victim_side else "0.4",
                    "reduce_only": False,
                    "limit_price": None,
                    "stop_price": None,
                },
            )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id=f"phase9-isolated-{suffix}-crash",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 2},
        )
        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]
        assert portfolio["status"] == "ACTIVE", portfolio
        assert [item["position_side"] for item in portfolio["positions"]] == [
            survivor_side
        ]
        case = portfolio["liquidations"][0]
        assert {leg["position_side"] for leg in case["legs"]} == {victim_side}
        assert case["state"] == "COMPLETED"
        assert portfolio["isolated_allocations"] == {f"track-1:{survivor_side}": "70"}
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_cross_liquidation_cancels_opening_order_and_recovers_before_close(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "phase9-cancel-recovery.db")
    try:
        base = replace(
            _sandbox_request(await _request(service), initial_equity="1000"),
            market_type="futures",
        )
        request = await prepare_hedge_request(
            service,
            base,
            root=tmp_path,
            prefix="phase9-cancel-recovery",
            mark_prices=["104", "50", *(["50"] * 11)],
        )
        assert service.training is not None
        created = await service.training.create_run(request)
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase9-cancel-recovery-acquire",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase9-cancel-recovery-position",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "phase9-cancel-recovery-position",
                "side": "BUY",
                "position_side": "LONG",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        pending = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase9-cancel-recovery-order",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "phase9-cancel-recovery-order",
                "side": "SELL",
                "position_side": "SHORT",
                "order_type": "LIMIT",
                "quantity": "26",
                "leverage": "3",
                "reduce_only": False,
                "limit_price": "110",
                "stop_price": None,
            },
        )
        assert pending["data"]["portfolio"]["reserved_margin"] == "953.33333334"
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase9-cancel-recovery-crash",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 2},
        )
        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]
        assert portfolio["status"] == "ACTIVE"
        assert portfolio["reserved_margin"] == "0"
        assert len(portfolio["positions"]) == 1
        assert portfolio["positions"][0]["position_side"] == "LONG"
        assert portfolio["liquidations"] == []
        case = portfolio["liquidation_recoveries"][0]
        assert case["state"] == "RECOVERED_AFTER_CANCEL"
        assert [step["step_type"] for step in case["steps"]] == [
            "CANCEL_ORDERS",
            "RISK_RECHECK",
            "COMPLETE",
        ]
        assert [order["state"] for order in case["steps"][0]["orders"]] == ["CANCELED"]
    finally:
        await service.shutdown(step_timeout=1.0)
