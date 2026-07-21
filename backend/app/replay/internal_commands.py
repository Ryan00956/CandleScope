"""Trusted actor commands that are deliberately absent from replay.v1."""

from __future__ import annotations

from enum import Enum


class InternalCommandType(str, Enum):
    """Non-transport command types available only to the training adapter."""

    ADJUST_CAPITAL = "_training_adjust_capital"
    REVEAL_HISTORY_AUTHORIZED = "_training_reveal_history"

    def __str__(self) -> str:
        return self.value


__all__ = ["InternalCommandType"]
