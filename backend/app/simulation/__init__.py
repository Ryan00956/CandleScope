"""Deterministic simulation kernel. No FastAPI, replay UI, or plugin-package imports."""

from .kernel import SimulationKernel, SimulationResult
from .trade_kernel import TRADE_FILL_POLICY, TradeSimulationKernel

__all__ = [
    "SimulationKernel",
    "SimulationResult",
    "TRADE_FILL_POLICY",
    "TradeSimulationKernel",
]
