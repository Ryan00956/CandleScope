"""Trusted actor commands that are deliberately absent from replay.v1."""

from __future__ import annotations

from enum import Enum


REVEALED_REFERENCE_CLOSE_FIDELITY = "TOUCH_OR_TAPE_MARK_SLIPPAGE_V1"


class InternalCommandType(str, Enum):
    """Non-transport command types available only to the training adapter."""

    ADJUST_CAPITAL = "_training_adjust_capital"
    EXECUTE_HISTORICAL_BOOK_CLOSE = "_training_execute_historical_book_close"
    EXECUTE_REVEALED_REFERENCE_CLOSE = "_training_execute_revealed_reference_close"
    REVEAL_HISTORY_AUTHORIZED = "_training_reveal_history"
    FAST_FORWARD_EMPTY_ACCOUNT = "_training_fast_forward_empty_account"
    FAST_FORWARD_FINAL_STATE = "_training_fast_forward_final_state"
    STEP_DEFER_TERMINAL = "_training_step_defer_terminal"
    FINALIZE_DEFERRED_TERMINAL = "_training_finalize_deferred_terminal"

    def __str__(self) -> str:
        return self.value


__all__ = ["InternalCommandType", "REVEALED_REFERENCE_CLOSE_FIDELITY"]
