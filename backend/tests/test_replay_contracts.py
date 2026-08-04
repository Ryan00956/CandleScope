from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

from app.core.config import load_replay_settings
from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.constants import (
    REPLAY_PROTOCOL,
    CommandType,
    DataFidelity,
    ExecutionFidelity,
    ExecutionModel,
    QualityMode,
    ReplayEventType,
    SessionState,
    SourceKind,
)
from app.replay.errors import ERROR_HTTP_STATUS, ReplayErrorCode
from app.replay.models import (
    MAX_TIMESTAMP_MS,
    ReplayCommand,
    ReplayCursor,
    ReplayEvent,
    ReplaySessionConfig,
    normalize_decimal_string,
    validate_identifier,
)


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "replay" / "canonical_v1.json"


def _fixture() -> dict[str, object]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_protocol_literals_and_enums_are_frozen_and_round_trip() -> None:
    assert REPLAY_PROTOCOL == "replay.v1"
    enum_contracts = {
        SourceKind: {"bar", "agg_trade"},
        QualityMode: {"exact", "best_effort"},
        DataFidelity: {
            "EXACT_BAR_COVERAGE",
            "EXACT_AGG_TRADE_COVERAGE",
            "VERIFIED_AGG_TRADE_APPROXIMATE_BARS",
            "BEST_EFFORT",
        },
        ExecutionFidelity: {"BAR_CONSERVATIVE", "AGG_TRADE_TAPE"},
        ExecutionModel: {"paper_linear_v1"},
        SessionState: {"INITIALIZING", "PAUSED", "PLAYING", "ENDED", "ERROR"},
        CommandType: {
            "acquire_controller",
            "release_controller",
            "play",
            "pause",
            "set_speed",
            "step",
            "advance_by",
                "seek_to",
                "place_order",
                "replace_order",
                "cancel_order",
                "cancel_orders",
                "close_position",
            "execute_position_intent",
            "set_position_protection",
            "add_journal_note",
            "reveal_history",
            "end_session",
        },
        ReplayEventType: {
            "replay.delta",
            "replay.final_state",
            "replay.snapshot",
            "replay.status",
            "replay.bar.replace",
            "replay.bar.append",
            "replay.bar.tick",
            "replay.order",
            "replay.fill",
            "replay.position",
            "replay.account",
            "replay.journal",
            "replay.warning",
            "replay.resync_required",
            "replay.ended",
        },
    }

    for enum_type, expected_values in enum_contracts.items():
        assert {member.value for member in enum_type} == expected_values
        assert all(enum_type(member.value) is member for member in enum_type)


@pytest.mark.parametrize(
    "command_type",
    ("_training_adjust_capital", "_training_reveal_history"),
)
def test_replay_v1_transport_rejects_training_internal_command_types(
    command_type: str,
) -> None:
    with pytest.raises(ValueError, match="command type"):
        ReplayCommand.from_dict(
            {
                "protocol": "replay.v1",
                "command_id": "internal-boundary",
                "client_instance_id": "contract-test",
                "expected_revision": 0,
                "type": command_type,
                "payload": {},
            }
        )


@pytest.mark.parametrize("value", ["", "  ", "has space", "slash/value", "x" * 129])
def test_identifier_validation_rejects_unsafe_or_ambiguous_values(value: str) -> None:
    with pytest.raises((TypeError, ValueError)):
        validate_identifier(value, field_name="command_id")


@pytest.mark.parametrize("value", ["", "NaN", "Infinity", "-Infinity", "1e3", "--1", 1.0])
def test_decimal_string_validation_rejects_noncanonical_inputs(value: object) -> None:
    with pytest.raises((TypeError, ValueError)):
        normalize_decimal_string(value, field_name="amount")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("0", "0"),
        ("-0.000", "0"),
        ("+001.2300", "1.23"),
        (".5000", "0.5"),
        ("10000.00", "10000"),
    ],
)
def test_decimal_strings_normalize_without_binary_float(raw: str, expected: str) -> None:
    assert normalize_decimal_string(raw, field_name="amount") == expected


def test_revision_sequence_and_timestamp_validation_fail_closed() -> None:
    with pytest.raises(ValueError, match="source_sequence"):
        ReplayCursor(virtual_time_ms=1, source_sequence=-1)
    with pytest.raises(ValueError, match="virtual_time_ms"):
        ReplayCursor(virtual_time_ms=-1, source_sequence=0)
    with pytest.raises(ValueError, match="virtual_time_ms"):
        ReplayCursor(virtual_time_ms=MAX_TIMESTAMP_MS + 1, source_sequence=0)
    with pytest.raises(TypeError, match="source_sequence"):
        ReplayCursor(virtual_time_ms=1, source_sequence=True)


def test_command_parser_rejects_unknown_type_negative_revision_and_reused_shape() -> None:
    base = {
        "protocol": REPLAY_PROTOCOL,
        "command_id": "01J00000000000000000000000",
        "client_instance_id": "browser-tab-uuid",
        "expected_revision": 42,
        "type": "step",
        "payload": {"count": 1},
    }
    command = ReplayCommand.from_dict(base)
    assert command.type is CommandType.STEP
    assert command.to_dict() == base

    with pytest.raises(ValueError, match="command type"):
        ReplayCommand.from_dict({**base, "type": "teleport"})
    with pytest.raises(ValueError, match="expected_revision"):
        ReplayCommand.from_dict({**base, "expected_revision": -1})
    with pytest.raises(ValueError, match="unknown field"):
        ReplayCommand.from_dict({**base, "unexpected": True})


def test_event_parser_rejects_negative_sequence_bad_hash_and_unknown_protocol() -> None:
    digest = "sha256:" + ("a" * 64)
    base = {
        "type": "replay.status",
        "protocol": REPLAY_PROTOCOL,
        "session_id": "session-01",
        "sequence": 1,
        "revision": 0,
        "virtual_time_ms": 1_710_000_000_000,
        "state_hash": digest,
        "data_epoch": digest,
        "data": {"state": "PAUSED"},
    }
    assert ReplayEvent.from_dict(base).to_dict() == base
    with pytest.raises(ValueError, match="sequence"):
        ReplayEvent.from_dict({**base, "sequence": -1})
    with pytest.raises(ValueError, match="state_hash"):
        ReplayEvent.from_dict({**base, "state_hash": "sha256:not-a-hash"})
    with pytest.raises(ValueError, match="protocol"):
        ReplayEvent.from_dict({**base, "protocol": "replay.v2"})


def test_session_config_unknown_source_and_execution_model_fail_closed() -> None:
    payload = _fixture()["input"]
    assert isinstance(payload, dict)
    with pytest.raises(ValueError, match="source_kind"):
        ReplaySessionConfig.from_dict({**payload, "source_kind": "raw_trade"})
    with pytest.raises(ValueError, match="execution_model"):
        ReplaySessionConfig.from_dict({**payload, "execution_model": "exchange_exact"})


def test_canonical_payload_and_hash_match_golden_fixture() -> None:
    fixture = _fixture()
    payload = fixture["input"]
    assert isinstance(payload, dict)
    config = ReplaySessionConfig.from_dict(payload)

    assert canonical_json(config) == fixture["canonical_json"]
    assert canonical_sha256(config) == fixture["sha256"]
    assert config.initial_equity == "10000"
    assert config.fee_model.maker_bps == "2"
    assert config.slippage_model.market_bps == "1"


@pytest.mark.parametrize("value", [float("nan"), float("inf"), 1.25])
def test_canonical_json_rejects_all_binary_floats(value: float) -> None:
    with pytest.raises((TypeError, ValueError), match="float"):
        canonical_json({"unsafe": value})


def test_canonical_json_serializes_decimal_as_normalized_string() -> None:
    assert canonical_json({"value": Decimal("-0.5000")}) == '{"value":"-0.5"}'


def test_every_stable_error_code_has_transport_agnostic_http_mapping() -> None:
    expected_codes = {
        "REPLAY_DISABLED",
        "SESSION_NOT_FOUND",
        "SESSION_ENDED",
        "CONTROLLER_CONFLICT",
        "REVISION_CONFLICT",
        "COMMAND_ID_REUSED",
        "INVALID_STATE_TRANSITION",
        "UNSUPPORTED_SOURCE",
        "UNSUPPORTED_INTERVAL",
        "UNSUPPORTED_EXECUTION_MODEL",
        "NO_ELIGIBLE_WINDOW",
        "DATA_GAP",
        "DATASET_INCOMPLETE",
        "DATASET_MISMATCH",
        "ARCHIVE_DISABLED",
        "ARCHIVE_DEGRADED",
        "SCAN_LIMIT_EXCEEDED",
        "SEEK_REQUIRES_FORK_OR_RESET",
        "ORDER_REJECTED",
        "RISK_LIMIT_EXCEEDED",
        "PERSISTENCE_DEGRADED",
    }
    assert {code.value for code in ReplayErrorCode} == expected_codes
    assert set(ERROR_HTTP_STATUS) == set(ReplayErrorCode)
    assert all(400 <= status <= 599 for status in ERROR_HTTP_STATUS.values())


def test_replay_settings_defaults_match_frozen_resource_budget(tmp_path: Path) -> None:
    settings = load_replay_settings({}, data_dir=tmp_path, klines_db_path=tmp_path / "candlescope.db")
    assert settings.enabled is False
    assert settings.db_path == tmp_path / "replay.db"
    assert settings.max_active_sessions == 8
    assert settings.command_queue_size == 256
    assert settings.event_buffer_size == 10_000
    assert settings.max_emit_fps == 30
    assert settings.max_warmup_bars == 5_000
    assert settings.max_bar_dataset_rows == 100_000
    assert settings.max_horizon_days == 30
    assert settings.trade_page_rows == 50_000
    assert settings.checkpoint_event_interval == 10_000
    assert settings.checkpoint_virtual_ms == 300_000
    assert settings.event_subscriber_queue == 256
    assert settings.controller_ttl_seconds == 10
    assert settings.idle_ttl_seconds == 3_600
    assert settings.replay_account_history_enabled is False
    assert settings.replay_account_history_max_archive_bytes == 128 * 1024**3
    assert settings.replay_history_archive_dir == tmp_path / "replay-history"


@pytest.mark.parametrize(
    "name",
    [
        "REPLAY_MAX_ACTIVE_SESSIONS",
        "REPLAY_COMMAND_QUEUE_SIZE",
        "REPLAY_EVENT_BUFFER_SIZE",
        "REPLAY_MAX_EMIT_FPS",
        "REPLAY_MAX_WARMUP_BARS",
        "REPLAY_MAX_BAR_DATASET_ROWS",
        "REPLAY_MAX_HORIZON_DAYS",
        "REPLAY_TRADE_PAGE_ROWS",
        "REPLAY_CHECKPOINT_EVENT_INTERVAL",
        "REPLAY_CHECKPOINT_VIRTUAL_MS",
        "REPLAY_EVENT_SUBSCRIBER_QUEUE",
        "REPLAY_CONTROLLER_TTL_SECONDS",
        "REPLAY_IDLE_TTL_SECONDS",
        "REPLAY_ACCOUNT_HISTORY_MAX_ARCHIVE_BYTES",
    ],
)
def test_replay_settings_reject_each_non_positive_budget(name: str, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match=name):
        load_replay_settings(
            {name: "0"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
        )


def test_replay_settings_reject_invalid_bool_and_unsafe_ranges(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="REPLAY_ENABLED"):
        load_replay_settings(
            {"REPLAY_ENABLED": "sometimes"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
        )
    with pytest.raises(ValueError, match="REPLAY_MAX_EMIT_FPS"):
        load_replay_settings(
            {"REPLAY_MAX_EMIT_FPS": "31"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
        )
    with pytest.raises(ValueError, match="REPLAY_DB_PATH"):
        load_replay_settings(
            {"REPLAY_DB_PATH": str(tmp_path / "candlescope.db")},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
        )
    with pytest.raises(ValueError, match="REPLAY_HISTORY_ARCHIVE_DIR"):
        load_replay_settings(
            {"REPLAY_HISTORY_ARCHIVE_DIR": str(tmp_path / "candlescope.db")},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
        )
    with pytest.raises(ValueError, match="REPLAY_AGG_TRADE_ARCHIVE_DIR"):
        load_replay_settings(
            {
                "REPLAY_AGG_TRADE_ARCHIVE_DIR": str(tmp_path / "shared-agg"),
                "RAW_AGG_TRADE_ARCHIVE_DIR": str(tmp_path / "shared-agg"),
            },
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
        )


@pytest.mark.parametrize("retired_value", ["archive", "auto", "legacy_sqlite"])
def test_replay_settings_reject_retired_bar_source_selector(
    retired_value: str,
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match="REPLAY_BAR_SOURCE was removed"):
        load_replay_settings(
            {"REPLAY_BAR_SOURCE": retired_value},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
        )


@pytest.mark.parametrize(
    ("name", "unsafe_value"),
    [
        ("REPLAY_MAX_ACTIVE_SESSIONS", 9),
        ("REPLAY_COMMAND_QUEUE_SIZE", 257),
        ("REPLAY_EVENT_BUFFER_SIZE", 10_001),
        ("REPLAY_MAX_EMIT_FPS", 31),
        ("REPLAY_MAX_WARMUP_BARS", 5_001),
        ("REPLAY_MAX_BAR_DATASET_ROWS", 100_001),
        ("REPLAY_MAX_HORIZON_DAYS", 31),
        ("REPLAY_TRADE_PAGE_ROWS", 50_001),
        ("REPLAY_CHECKPOINT_EVENT_INTERVAL", 10_001),
        ("REPLAY_CHECKPOINT_VIRTUAL_MS", 300_001),
        ("REPLAY_EVENT_SUBSCRIBER_QUEUE", 257),
        ("REPLAY_CONTROLLER_TTL_SECONDS", 11),
        ("REPLAY_IDLE_TTL_SECONDS", 3_601),
        ("REPLAY_ACCOUNT_HISTORY_MAX_ARCHIVE_BYTES", 128 * 1024**3 + 1),
    ],
)
def test_replay_settings_cannot_widen_frozen_safety_limits(
    name: str,
    unsafe_value: int,
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match=name):
        load_replay_settings(
            {name: str(unsafe_value)},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
        )
