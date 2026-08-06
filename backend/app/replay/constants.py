"""Frozen replay.v1 protocol literals.

This module intentionally contains no runtime, transport, persistence, or live
market-data dependencies. Both source implementations must use these names.
"""

from enum import Enum


REPLAY_PROTOCOL = "replay.v1"
REPLAY_CORE_VERSION = "replay-core.v1"


class _StringEnum(str, Enum):
    def __str__(self) -> str:
        return self.value


class SourceKind(_StringEnum):
    BAR = "bar"
    AGG_TRADE = "agg_trade"


class QualityMode(_StringEnum):
    EXACT = "exact"
    BEST_EFFORT = "best_effort"


class DataFidelity(_StringEnum):
    EXACT_BAR_COVERAGE = "EXACT_BAR_COVERAGE"
    # Legacy response literal retained so older persisted/exported payloads parse.
    # New aggregate-trade sessions must use the explicit approximate-bars value.
    EXACT_AGG_TRADE_COVERAGE = "EXACT_AGG_TRADE_COVERAGE"
    VERIFIED_AGG_TRADE_APPROXIMATE_BARS = (
        "VERIFIED_AGG_TRADE_APPROXIMATE_BARS"
    )
    BEST_EFFORT = "BEST_EFFORT"


class ExecutionFidelity(_StringEnum):
    BAR_CONSERVATIVE = "BAR_CONSERVATIVE"
    AGG_TRADE_TAPE = "AGG_TRADE_TAPE"


class ExecutionModel(_StringEnum):
    PAPER_LINEAR_V1 = "paper_linear_v1"


class SessionState(_StringEnum):
    INITIALIZING = "INITIALIZING"
    PAUSED = "PAUSED"
    PLAYING = "PLAYING"
    ENDED = "ENDED"
    ERROR = "ERROR"


class StartPolicy(_StringEnum):
    RANDOM_ELIGIBLE = "random_eligible"
    MANUAL = "manual"


class SlippageKind(_StringEnum):
    FIXED_BPS = "fixed_bps"


class CommandType(_StringEnum):
    ACQUIRE_CONTROLLER = "acquire_controller"
    RELEASE_CONTROLLER = "release_controller"
    PLAY = "play"
    PAUSE = "pause"
    SET_SPEED = "set_speed"
    STEP = "step"
    ADVANCE_BY = "advance_by"
    SEEK_TO = "seek_to"
    PLACE_ORDER = "place_order"
    REPLACE_ORDER = "replace_order"
    CANCEL_ORDER = "cancel_order"
    CANCEL_ORDERS = "cancel_orders"
    CLOSE_POSITION = "close_position"
    EXECUTE_POSITION_INTENT = "execute_position_intent"
    SET_POSITION_PROTECTION = "set_position_protection"
    SET_POSITION_LEVERAGE = "set_position_leverage"
    ADD_JOURNAL_NOTE = "add_journal_note"
    REVEAL_HISTORY = "reveal_history"
    END_SESSION = "end_session"


class ReplayEventType(_StringEnum):
    DELTA = "replay.delta"
    FINAL_STATE = "replay.final_state"
    SNAPSHOT = "replay.snapshot"
    STATUS = "replay.status"
    BAR_REPLACE = "replay.bar.replace"
    BAR_APPEND = "replay.bar.append"
    BAR_TICK = "replay.bar.tick"
    ORDER = "replay.order"
    FILL = "replay.fill"
    POSITION = "replay.position"
    ACCOUNT = "replay.account"
    JOURNAL = "replay.journal"
    WARNING = "replay.warning"
    RESYNC_REQUIRED = "replay.resync_required"
    ENDED = "replay.ended"


PLAYBACK_SPEEDS: tuple[int | str, ...] = (
    1,
    5,
    15,
    30,
    60,
    120,
    300,
    600,
    "MAX",
)
