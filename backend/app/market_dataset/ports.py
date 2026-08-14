from __future__ import annotations

from typing import Protocol

from .models import DatasetRef
from .snapshot import MarketDatasetSnapshot


class MarketDatasetSnapshotProvider(Protocol):
    def open(self, ref: DatasetRef) -> MarketDatasetSnapshot: ...
