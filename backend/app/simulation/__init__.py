"""Deterministic simulation kernel. No FastAPI, replay UI, or plugin-package imports."""

from .kernel import SimulationKernel, SimulationResult

__all__ = ["SimulationKernel", "SimulationResult"]
