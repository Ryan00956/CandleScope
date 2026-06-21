"""Script namespace assembly for batch Pyne runtime execution."""
from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType, SimpleNamespace
from typing import Any

import numpy as np

from . import utils
from .cache import pyne_cache
from .collections import ArrayNamespace, MapNamespace, MatrixNamespace, order_namespace
from .color import color as color_singleton
from .context import PyneContext
from .input import InputModule
from .math_ext import PyneMath
from .plot import OutputCollector, create_plot_functions
from .request import RequestModule, barmerge
from .security import PyneSecurityPolicy, build_builtins
from .series import switch as series_switch
from .series import when as series_when
from .series import where as series_where
from .settings import PyneSettings
from .state import PyneStateNamespace
from .strategy import StrategyModule
from .string_ext import string_namespace
from .ta import TaModule
from .ticker import TickerNamespace
from .time_ext import time_namespace


@dataclass
class RuntimeServices:
    """Runtime-scoped services used to build a script namespace."""

    ctx: PyneContext
    settings: PyneSettings
    params: dict[str, Any]
    policy: PyneSecurityPolicy
    ta: TaModule = field(init=False)
    input: InputModule = field(init=False)
    state: PyneStateNamespace = field(init=False)
    collector: OutputCollector = field(init=False)
    plot_functions: dict[str, Any] = field(init=False)
    request: RequestModule = field(init=False)
    strategy: StrategyModule = field(init=False)

    def __post_init__(self) -> None:
        self.ta = TaModule(self.ctx)
        self.input = InputModule(params=self.params, context=self.ctx)
        self.state = PyneStateNamespace()
        self.collector = OutputCollector(
            times=self.ctx.times,
            max_drawing_objects=self.settings.max_drawing_objects,
        )
        self.plot_functions = create_plot_functions(self.collector)
        self.request = RequestModule(self.ctx, provider=self.settings.data_provider)
        self.strategy = StrategyModule(self.ctx, self.collector)


def build_script_namespace(services: RuntimeServices) -> dict[str, Any]:
    """Build the global namespace injected into user scripts."""
    namespace: dict[str, Any] = {}
    for installer in (
        install_data_namespace,
        install_api_namespace,
        install_plot_namespace,
        install_utility_namespace,
        install_compat_namespace,
        install_builtins_namespace,
    ):
        _run_namespace_installer(namespace, services, installer)
    return namespace


def _run_namespace_installer(
    namespace: dict[str, Any],
    services: RuntimeServices,
    installer: Any,
) -> None:
    before = dict(namespace)
    installer(namespace, services)
    overwritten = [key for key, value in before.items() if namespace.get(key) is not value]
    if overwritten:
        names = ", ".join(sorted(overwritten))
        raise RuntimeError(f"Pyne namespace installer overwrote existing keys: {names}")


def install_data_namespace(namespace: dict[str, Any], services: RuntimeServices) -> None:
    """Install OHLCV and derived source names."""
    ctx = services.ctx
    namespace["open"] = ctx.open
    namespace["high"] = ctx.high
    namespace["low"] = ctx.low
    namespace["close"] = ctx.close
    namespace["volume"] = ctx.volume
    namespace["time"] = time_namespace(ctx.time)
    namespace["time_close"] = ctx.time_close
    namespace["bar_index"] = ctx.bar_index
    namespace["last_bar_index"] = ctx.last_bar_index
    namespace["barstate"] = ctx.barstate
    namespace["bar_count"] = ctx.bar_count
    namespace["syminfo"] = ctx.syminfo
    namespace["timeframe"] = ctx.timeframe
    namespace["session"] = ctx.session
    namespace["hl2"] = ctx.hl2
    namespace["hlc3"] = ctx.hlc3
    namespace["ohlc4"] = ctx.ohlc4
    namespace["hlcc4"] = ctx.hlcc4


def install_api_namespace(namespace: dict[str, Any], services: RuntimeServices) -> None:
    """Install Pine-like module namespaces."""
    ctx = services.ctx
    namespace["ta"] = services.ta
    namespace["input"] = services.input
    namespace["request"] = services.request
    namespace["barmerge"] = barmerge
    namespace["strategy"] = services.strategy
    namespace["array"] = ArrayNamespace(
        max_size=services.policy.max_array_size,
        max_depth=services.policy.max_collection_depth,
    )
    namespace["map"] = MapNamespace(
        max_size=services.policy.max_map_size,
        array_max_size=services.policy.max_array_size,
        max_depth=services.policy.max_collection_depth,
    )
    namespace["matrix"] = MatrixNamespace(
        max_cells=services.policy.max_matrix_cells,
        array_max_size=services.policy.max_array_size,
        max_depth=services.policy.max_collection_depth,
    )
    namespace["order"] = order_namespace
    namespace["str"] = string_namespace
    namespace["ticker"] = TickerNamespace(ctx.syminfo)
    namespace["color"] = color_singleton
    namespace["math"] = PyneMath(mintick=getattr(ctx.syminfo, "mintick", 1.0))
    namespace["pyne"] = _pyne_namespace(services)
    namespace["cache"] = namespace["pyne"].cache
    namespace["cache_clear"] = namespace["pyne"].cache_clear
    namespace["cache_stats"] = namespace["pyne"].cache_stats
    namespace["var"] = services.state.var
    namespace["state"] = services.state.state


def install_plot_namespace(namespace: dict[str, Any], services: RuntimeServices) -> None:
    """Install plot, drawing, and display helper functions."""
    namespace.update(services.plot_functions)


def install_utility_namespace(namespace: dict[str, Any], services: RuntimeServices) -> None:
    """Install top-level utility functions and common TA aliases."""
    ta = services.ta
    namespace["crossover"] = utils.crossover
    namespace["cross"] = utils.cross
    namespace["crossunder"] = utils.crossunder
    namespace["when"] = series_when
    namespace["iff"] = series_when
    namespace["where"] = series_where
    namespace["switch"] = series_switch
    namespace["ref"] = utils.shift
    namespace["highest"] = utils.highest
    namespace["highestbars"] = utils.highestbars
    namespace["lowest"] = utils.lowest
    namespace["lowestbars"] = utils.lowestbars
    namespace["change"] = utils.change
    namespace["roc"] = utils.roc
    namespace["barssince"] = utils.barssince
    namespace["valuewhen"] = utils.valuewhen
    namespace["shift"] = utils.shift
    namespace["na"] = utils.na
    namespace["nz"] = utils.nz
    namespace["fixnan"] = utils.fixnan
    namespace["na_check"] = utils.na_check
    namespace["cum"] = utils.cum
    namespace["rising"] = utils.rising
    namespace["falling"] = utils.falling
    namespace["true"] = True
    namespace["false"] = False
    namespace["sma"] = ta.sma
    namespace["ema"] = ta.ema
    namespace["wma"] = ta.wma
    namespace["rma"] = ta.rma
    namespace["vwma"] = ta.vwma
    namespace["rsi"] = ta.rsi
    namespace["macd"] = ta.macd
    namespace["atr"] = ta.atr
    namespace["bb"] = ta.bb


def install_compat_namespace(namespace: dict[str, Any], services: RuntimeServices) -> None:
    """Install Python and legacy compatibility names."""
    namespace["np"] = np
    namespace["numpy"] = np
    namespace["params"] = MappingProxyType(dict(services.params))


def install_builtins_namespace(namespace: dict[str, Any], services: RuntimeServices) -> None:
    """Install policy-controlled builtins."""
    namespace["__builtins__"] = build_builtins(services.policy)


def _pyne_namespace(services: RuntimeServices) -> SimpleNamespace:
    return SimpleNamespace(
        cache=pyne_cache.get_or_load,
        cache_clear=pyne_cache.clear,
        cache_stats=pyne_cache.stats,
        var=services.state.var,
        state=services.state.state,
        state_snapshot=services.state.snapshot,
    )
