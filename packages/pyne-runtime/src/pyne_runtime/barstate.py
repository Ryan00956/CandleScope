"""Pine-like bar clock and barstate helpers."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .series import PyneSeries


@dataclass(frozen=True)
class PyneBarState:
    """Batch-runtime barstate namespace.

    Values are represented as series so they can be plotted, combined with
    other conditions, and used by marker/signal helpers.
    """

    isfirst: PyneSeries
    islast: PyneSeries
    ishistory: PyneSeries
    isrealtime: PyneSeries
    isnew: PyneSeries
    isconfirmed: PyneSeries
    islastconfirmedhistory: PyneSeries

    @classmethod
    def for_batch(cls, bar_count: int) -> "PyneBarState":
        first = np.zeros(bar_count, dtype=bool)
        last = np.zeros(bar_count, dtype=bool)
        if bar_count:
            first[0] = True
            last[-1] = True

        history = np.ones(bar_count, dtype=bool)
        realtime = np.zeros(bar_count, dtype=bool)
        new = np.ones(bar_count, dtype=bool)
        confirmed = np.ones(bar_count, dtype=bool)

        return cls(
            isfirst=PyneSeries(first, name="barstate.isfirst"),
            islast=PyneSeries(last, name="barstate.islast"),
            ishistory=PyneSeries(history, name="barstate.ishistory"),
            isrealtime=PyneSeries(realtime, name="barstate.isrealtime"),
            isnew=PyneSeries(new, name="barstate.isnew"),
            isconfirmed=PyneSeries(confirmed, name="barstate.isconfirmed"),
            islastconfirmedhistory=PyneSeries(last.copy(), name="barstate.islastconfirmedhistory"),
        )


@dataclass(frozen=True)
class PyneIncrementalBarState:
    """Scalar barstate namespace for incremental callbacks."""

    isfirst: bool = False
    islast: bool = False
    ishistory: bool = False
    isrealtime: bool = False
    isnew: bool = False
    isconfirmed: bool = False
    islastconfirmedhistory: bool = False
