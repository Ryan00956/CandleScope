"""strategy-provider/1 entrypoint. Never reads live bars or publishes chart layers."""

from __future__ import annotations

from candlescope_plugin_pyne import PyneStrategyProvider

ENTRYPOINT_ID = "pyne-workbench"
CONTRIBUTION_ID = "pyne-strategy"


def create_provider() -> PyneStrategyProvider:
    return PyneStrategyProvider()
