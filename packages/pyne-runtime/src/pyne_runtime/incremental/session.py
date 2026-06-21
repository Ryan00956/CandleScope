"""Long-lived incremental execution session."""
from __future__ import annotations

import inspect
from types import SimpleNamespace
from typing import Any, Callable

from ..barstate import PyneIncrementalBarState
from ..cache import pyne as pyne_cache_namespace
from ..collections import ArrayNamespace, MapNamespace, MatrixNamespace, order_namespace
from ..color import color as color_singleton
from ..math_ext import PyneMath
from ..security import (
    PyneSecurityError,
    PyneSecurityPolicy,
    build_builtins,
    execution_timeout,
    validate_script_security,
)
from ..settings import PyneSettings
from .bar import IncrementalBar
from .context import IncrementalContext
from .limits import IncrementalLimits
from .result import IncrementalPyneResult


class PyneIncrementalSession:
    """Long-lived incremental Pyne execution session."""

    def __init__(
        self,
        *,
        script: str,
        params: dict[str, Any] | None = None,
        security_mode: str | None = None,
        policy: PyneSecurityPolicy | None = None,
        settings: PyneSettings | None = None,
    ) -> None:
        self.script = script
        self.params = params or {}
        self.settings = settings or PyneSettings.from_env()
        self.policy = policy or PyneSecurityPolicy.from_settings(self.settings, security_mode)
        self.security_mode = self.policy.mode
        self._limits = IncrementalLimits.for_policy(self.policy)
        self._globals: dict[str, Any] = {}
        self._meta: dict[str, Any] = {}
        self._init_func: Callable[..., Any] | None = None
        self._on_bar: Callable[..., Any] | None = None
        self._on_preview: Callable[..., Any] | None = None
        self._ctx: IncrementalContext | None = None
        self._active_ctx: IncrementalContext | None = None
        self._prepared = False
        self.last_closed_time: int | None = None
        self._closed_count = 0
        self._active_preview_time: int | None = None
        self._preview_varip_states: dict[str, Any] = {}

    def prepare(self) -> None:
        if self._prepared:
            return
        validate_script_security(self.script, self.policy)
        self._globals = self._build_namespace()
        with execution_timeout(self.policy.timeout_seconds):
            exec(self.script, self._globals)  # noqa: S102
        self._init_func = self._globals.get("init") if callable(self._globals.get("init")) else None
        self._on_bar = (
            self._globals.get("on_bar") if callable(self._globals.get("on_bar")) else None
        )
        self._on_preview = (
            self._globals.get("on_preview")
            if callable(self._globals.get("on_preview"))
            else None
        )
        if self._on_bar is None:
            raise PyneSecurityError("Incremental Pyne scripts must define on_bar(ctx, bar)")
        self._prepared = True

    def seed(
        self,
        ohlcv: list[dict[str, Any]],
        *,
        start_s: int | None = None,
        end_s: int | None = None,
    ) -> IncrementalPyneResult:
        self.prepare()
        self._ctx = IncrementalContext(
            params=self.params,
            meta=self._meta,
            limits=self._limits,
            syminfo=self.settings.syminfo,
            timeframe=self.settings.timeframe,
            session=self.settings.session,
            max_drawing_objects=self.settings.max_drawing_objects,
        )
        self._call_optional(self._init_func, self._ctx)
        self._closed_count = 0
        self._active_preview_time = None
        self._preview_varip_states = {}
        last_bar_index = len(ohlcv) - 1
        for index, item in enumerate(ohlcv):
            bar = IncrementalBar.from_dict(item, is_confirmed=True)
            self._run_bar(
                self._ctx,
                bar,
                preview=False,
                bar_index=index,
                last_bar_index=last_bar_index,
                barstate=PyneIncrementalBarState(
                    isfirst=index == 0,
                    islast=index == last_bar_index,
                    ishistory=True,
                    isrealtime=False,
                    isnew=True,
                    isconfirmed=True,
                    islastconfirmedhistory=index == last_bar_index,
                ),
            )
            self.last_closed_time = bar.time
            self._closed_count = index + 1
        return self._ctx.to_result(start_s=start_s, end_s=end_s)

    def on_bar_closed(self, item: dict[str, Any]) -> IncrementalPyneResult:
        self.prepare()
        if self._ctx is None:
            self._ctx = IncrementalContext(
                params=self.params,
                meta=self._meta,
                limits=self._limits,
                syminfo=self.settings.syminfo,
                timeframe=self.settings.timeframe,
                session=self.settings.session,
                max_drawing_objects=self.settings.max_drawing_objects,
            )
            self._call_optional(self._init_func, self._ctx)
        bar = IncrementalBar.from_dict(item, is_confirmed=True)
        bar_index = self._closed_count
        had_preview = self._active_preview_time == bar.time
        self._run_bar(
            self._ctx,
            bar,
            preview=False,
            bar_index=bar_index,
            last_bar_index=bar_index,
            barstate=PyneIncrementalBarState(
                isfirst=bar_index == 0,
                islast=True,
                ishistory=False,
                isrealtime=True,
                isnew=not had_preview,
                isconfirmed=True,
                islastconfirmedhistory=False,
            ),
        )
        self.last_closed_time = bar.time
        self._closed_count = bar_index + 1
        if had_preview:
            self._active_preview_time = None
            self._preview_varip_states = {}
        return self._ctx.to_result(start_s=bar.time, end_s=bar.time)

    def on_bar_updated(self, item: dict[str, Any]) -> IncrementalPyneResult:
        self.prepare()
        if self._ctx is None:
            self._ctx = IncrementalContext(
                params=self.params,
                meta=self._meta,
                limits=self._limits,
                syminfo=self.settings.syminfo,
                timeframe=self.settings.timeframe,
                session=self.settings.session,
                max_drawing_objects=self.settings.max_drawing_objects,
            )
            self._call_optional(self._init_func, self._ctx)
        bar = IncrementalBar.from_dict(item, is_confirmed=False)
        preview_ctx = self._ctx.clone_for_preview()
        bar_index = self._closed_count
        is_new = self._active_preview_time != bar.time
        if is_new:
            self._preview_varip_states = {}
        preview_ctx._varip_states = self._preview_varip_states
        self._run_bar(
            preview_ctx,
            bar,
            preview=True,
            bar_index=bar_index,
            last_bar_index=bar_index,
            barstate=PyneIncrementalBarState(
                isfirst=bar_index == 0,
                islast=True,
                ishistory=False,
                isrealtime=True,
                isnew=is_new,
                isconfirmed=False,
                islastconfirmedhistory=False,
            ),
        )
        self._active_preview_time = bar.time
        return preview_ctx.to_result(start_s=bar.time, end_s=bar.time)

    def _run_bar(
        self,
        ctx: IncrementalContext,
        bar: IncrementalBar,
        *,
        preview: bool,
        bar_index: int,
        last_bar_index: int,
        barstate: PyneIncrementalBarState,
    ) -> None:
        ctx.begin_bar(bar, bar_index=bar_index, last_bar_index=last_bar_index, barstate=barstate)
        func = self._on_preview if preview and self._on_preview is not None else self._on_bar
        previous_ctx = self._active_ctx
        self._active_ctx = ctx
        try:
            with execution_timeout(self.policy.timeout_seconds):
                self._call_required(func, ctx, bar)
        finally:
            self._active_ctx = previous_ctx
        ctx.strategy.end_bar()
        if barstate.isconfirmed and not preview:
            ctx.commit_state_history()

    def _build_namespace(self) -> dict[str, Any]:
        def indicator(title: str = "", overlay: bool = True, **kwargs: Any) -> None:
            self._meta = {"title": title, "overlay": overlay, **kwargs}

        def active_ctx(feature: str) -> IncrementalContext:
            if self._active_ctx is None:
                raise PyneSecurityError(
                    f"{feature} can only be used inside incremental callbacks"
                )
            return self._active_ctx

        def state(name: str, default: Any = None):
            return active_ctx("state()").state(name, default)

        def varip(name: str, default: Any = None):
            return active_ctx("varip()").varip(name, default)

        drawing_namespaces = self._drawing_namespaces()
        pyne_namespace = SimpleNamespace(
            cache=pyne_cache_namespace.cache,
            cache_clear=pyne_cache_namespace.cache_clear,
            cache_stats=pyne_cache_namespace.cache_stats,
            state=state,
            var=state,
            varip=varip,
        )
        return {
            "indicator": indicator,
            "params": self.params,
            "syminfo": self.settings.syminfo,
            "timeframe": self.settings.timeframe,
            "session": self.settings.session,
            "true": True,
            "false": False,
            "color": color_singleton,
            "math": PyneMath(mintick=getattr(self.settings.syminfo, "mintick", 0.01)),
            "array": ArrayNamespace(
                max_size=self.policy.max_array_size,
                max_depth=self.policy.max_collection_depth,
            ),
            "map": MapNamespace(
                max_size=self.policy.max_map_size,
                array_max_size=self.policy.max_array_size,
                max_depth=self.policy.max_collection_depth,
            ),
            "matrix": MatrixNamespace(
                max_cells=self.policy.max_matrix_cells,
                array_max_size=self.policy.max_array_size,
                max_depth=self.policy.max_collection_depth,
            ),
            "order": order_namespace,
            "pyne": pyne_namespace,
            "cache": pyne_cache_namespace.cache,
            "cache_clear": pyne_cache_namespace.cache_clear,
            "cache_stats": pyne_cache_namespace.cache_stats,
            "state": state,
            "var": state,
            "varip": varip,
            **drawing_namespaces,
            "__builtins__": build_builtins(self.policy),
        }

    def _drawing_namespaces(self) -> dict[str, Any]:
        def ctx() -> IncrementalContext:
            if self._active_ctx is None:
                raise PyneSecurityError(
                    "Drawing objects can only be mutated inside incremental callbacks"
                )
            return self._active_ctx

        line_namespace = SimpleNamespace(
            new=lambda *args, **kwargs: ctx().line_new(*args, **kwargs),
            set_xy1=lambda *args, **kwargs: ctx().line_set_xy1(*args, **kwargs),
            set_xy2=lambda *args, **kwargs: ctx().line_set_xy2(*args, **kwargs),
            set_x1=lambda *args, **kwargs: ctx().line_set_x1(*args, **kwargs),
            set_y1=lambda *args, **kwargs: ctx().line_set_y1(*args, **kwargs),
            set_x2=lambda *args, **kwargs: ctx().line_set_x2(*args, **kwargs),
            set_y2=lambda *args, **kwargs: ctx().line_set_y2(*args, **kwargs),
            set_color=lambda *args, **kwargs: ctx().line_set_color(*args, **kwargs),
            set_width=lambda *args, **kwargs: ctx().line_set_width(*args, **kwargs),
            set_style=lambda *args, **kwargs: ctx().line_set_style(*args, **kwargs),
            set_extend=lambda *args, **kwargs: ctx().line_set_extend(*args, **kwargs),
            delete=lambda *args, **kwargs: ctx().line_delete(*args, **kwargs),
            style_solid="solid",
            style_dashed="dashed",
            style_dotted="dotted",
            extend_none="none",
            extend_left="left",
            extend_right="right",
            extend_both="both",
        )
        label_namespace = SimpleNamespace(
            new=lambda *args, **kwargs: ctx().label_new(*args, **kwargs),
            set_xy=lambda *args, **kwargs: ctx().label_set_xy(*args, **kwargs),
            set_x=lambda *args, **kwargs: ctx().label_set_x(*args, **kwargs),
            set_y=lambda *args, **kwargs: ctx().label_set_y(*args, **kwargs),
            set_text=lambda *args, **kwargs: ctx().label_set_text(*args, **kwargs),
            set_color=lambda *args, **kwargs: ctx().label_set_color(*args, **kwargs),
            set_textcolor=lambda *args, **kwargs: ctx().label_set_textcolor(*args, **kwargs),
            set_style=lambda *args, **kwargs: ctx().label_set_style(*args, **kwargs),
            set_size=lambda *args, **kwargs: ctx().label_set_size(*args, **kwargs),
            set_xloc=lambda *args, **kwargs: ctx().label_set_xloc(*args, **kwargs),
            set_yloc=lambda *args, **kwargs: ctx().label_set_yloc(*args, **kwargs),
            delete=lambda *args, **kwargs: ctx().label_delete(*args, **kwargs),
            style_label_up="label_up",
            style_label_down="label_down",
            style_label_left="label_left",
            style_label_right="label_right",
            style_label_center="label_center",
        )
        box_namespace = SimpleNamespace(
            new=lambda *args, **kwargs: ctx().box_new(*args, **kwargs),
            set_left=lambda *args, **kwargs: ctx().box_set_left(*args, **kwargs),
            set_top=lambda *args, **kwargs: ctx().box_set_top(*args, **kwargs),
            set_right=lambda *args, **kwargs: ctx().box_set_right(*args, **kwargs),
            set_bottom=lambda *args, **kwargs: ctx().box_set_bottom(*args, **kwargs),
            set_lefttop=lambda *args, **kwargs: ctx().box_set_lefttop(*args, **kwargs),
            set_rightbottom=lambda *args, **kwargs: ctx().box_set_rightbottom(*args, **kwargs),
            set_bgcolor=lambda *args, **kwargs: ctx().box_set_bgcolor(*args, **kwargs),
            set_border_color=lambda *args, **kwargs: ctx().box_set_border_color(*args, **kwargs),
            set_border_width=lambda *args, **kwargs: ctx().box_set_border_width(*args, **kwargs),
            delete=lambda *args, **kwargs: ctx().box_delete(*args, **kwargs),
            border_style_solid="solid",
            border_style_dashed="dashed",
            border_style_dotted="dotted",
        )
        table_namespace = SimpleNamespace(
            new=lambda *args, **kwargs: ctx().table_new(*args, **kwargs),
            cell=lambda *args, **kwargs: ctx().table_cell(*args, **kwargs),
            clear=lambda *args, **kwargs: ctx().table_clear(*args, **kwargs),
            set_position=lambda *args, **kwargs: ctx().table_set_position(*args, **kwargs),
            set_bgcolor=lambda *args, **kwargs: ctx().table_set_bgcolor(*args, **kwargs),
            set_frame_color=lambda *args, **kwargs: ctx().table_set_frame_color(*args, **kwargs),
            set_border_color=lambda *args, **kwargs: ctx().table_set_border_color(*args, **kwargs),
            delete=lambda *args, **kwargs: ctx().table_delete(*args, **kwargs),
        )
        return {
            "line": line_namespace,
            "label": label_namespace,
            "box": box_namespace,
            "table": table_namespace,
            "plot": SimpleNamespace(
                style_line="line",
                style_histogram="histogram",
                style_columns="histogram",
            ),
            "position": SimpleNamespace(
                top_left="top_left",
                top_center="top_center",
                top_right="top_right",
                middle_left="middle_left",
                middle_center="middle_center",
                middle_right="middle_right",
                bottom_left="bottom_left",
                bottom_center="bottom_center",
                bottom_right="bottom_right",
            ),
            "shape": SimpleNamespace(
                circle="circle",
                cross="cross",
                triangleup="triangle_up",
                triangledown="triangle_down",
                flag="flag",
                arrowup="arrow_up",
                arrowdown="arrow_down",
                labelup="label_up",
                labeldown="label_down",
                square="square",
                diamond="diamond",
            ),
            "location": SimpleNamespace(
                abovebar="above",
                belowbar="below",
                top="above",
                bottom="below",
                absolute="absolute",
            ),
            "xloc": SimpleNamespace(bar_index="bar_index", bar_time="bar_time"),
            "yloc": SimpleNamespace(price="price", abovebar="abovebar", belowbar="belowbar"),
            "text": SimpleNamespace(
                align_left="left",
                align_center="center",
                align_right="right",
                align_top="top",
                align_middle="middle",
                align_bottom="bottom",
            ),
            "size": SimpleNamespace(
                tiny="tiny",
                small="small",
                normal="normal",
                large="large",
                huge="huge",
            ),
        }

    def _call_optional(self, func: Callable[..., Any] | None, ctx: IncrementalContext) -> None:
        if func is None:
            return
        with execution_timeout(self.policy.timeout_seconds):
            self._call_by_arity(func, ctx)

    def _call_required(
        self,
        func: Callable[..., Any] | None,
        ctx: IncrementalContext,
        bar: IncrementalBar,
    ) -> None:
        if func is None:
            raise PyneSecurityError("Incremental Pyne scripts must define on_bar(ctx, bar)")
        self._call_by_arity(func, ctx, bar)

    def _call_by_arity(
        self,
        func: Callable[..., Any],
        ctx: IncrementalContext,
        bar: IncrementalBar | None = None,
    ) -> None:
        signature = inspect.signature(func)
        params = list(signature.parameters.values())
        has_varargs = any(item.kind == inspect.Parameter.VAR_POSITIONAL for item in params)
        if bar is None:
            if len(params) == 0 and not has_varargs:
                func()
            else:
                func(ctx)
            return
        if has_varargs or len(params) >= 2:
            func(ctx, bar)
        elif len(params) == 1:
            func(bar)
        else:
            func()

    def snapshot_result(
        self,
        *,
        start_s: int | None = None,
        end_s: int | None = None,
    ) -> IncrementalPyneResult:
        self.prepare()
        if self._ctx is None:
            self._ctx = IncrementalContext(
                params=self.params,
                meta=self._meta,
                limits=self._limits,
                syminfo=self.settings.syminfo,
                timeframe=self.settings.timeframe,
                session=self.settings.session,
                max_drawing_objects=self.settings.max_drawing_objects,
            )
            self._call_optional(self._init_func, self._ctx)
        return self._ctx.to_result(start_s=start_s, end_s=end_s)
