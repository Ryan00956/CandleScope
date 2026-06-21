"""Opaque references returned by plot and drawing APIs."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class PlotRef:
    """Opaque reference to a plotted line, used by ``fill()``."""
    id: str
    title: str
    pane: str = "main"

@dataclass(frozen=True)
class ObjectRef:
    """Opaque reference to a mutable drawing object."""

    id: str
    kind: str
