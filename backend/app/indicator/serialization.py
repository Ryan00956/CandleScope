"""Serialization helpers for indicator HTTP and WebSocket payloads."""

from __future__ import annotations

from typing import Any

from candlescope_plugin_sdk import ExecuteBatchResult

from app.indicator.errors import error_detail


PYNE_EXTENDED_OUTPUT_KEYS = (
    "markers",
    "fills",
    "hlines",
    "bgcolors",
    "barcolors",
    "signals",
)
INDICATOR_PAYLOAD_SCHEMA_VERSION = 1
INDICATOR_OUTPUT_SCHEMA_VERSION = 2


def build_error_payload(
    code: str,
    message: str,
    *,
    line: int | None = None,
    column: int | None = None,
    hint: str | None = None,
    lines: list[dict[str, Any]] | None = None,
    result: Any = None,
) -> dict[str, Any]:
    """Build a backward-compatible error payload with structured detail."""
    return {
        "schemaVersion": INDICATOR_PAYLOAD_SCHEMA_VERSION,
        "ok": False,
        "code": code,
        "error": message,
        "errorDetail": error_detail(
            code,
            message,
            line=line,
            column=column,
            hint=hint,
        ),
        "lines": lines or [],
        "result": result,
    }


def build_ws_error_payload(
    code: str,
    message: str,
    *,
    client_id: str | None = None,
    detail: Any = None,
    line: int | None = None,
    column: int | None = None,
    hint: str | None = None,
) -> dict[str, Any]:
    """Build a WebSocket error message that uses the same errorDetail shape."""
    payload: dict[str, Any] = {
        "type": "error",
        "schemaVersion": INDICATOR_PAYLOAD_SCHEMA_VERSION,
        "code": code,
        "error": message,
        "detail": detail if detail is not None else message,
        "errorDetail": error_detail(
            code,
            message,
            line=line,
            column=column,
            hint=hint,
        ),
    }
    if client_id:
        payload["clientId"] = client_id
    return payload


def build_unified_output(
    *,
    indicator_id: str | None = None,
    lines: list[dict[str, Any]] | None = None,
    markers: list[dict[str, Any]] | None = None,
    hlines: list[dict[str, Any]] | None = None,
    bgcolors: list[dict[str, Any]] | None = None,
    fills: list[dict[str, Any]] | None = None,
    barcolors: list[dict[str, Any]] | None = None,
    signals: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the v2 normalized output model while preserving legacy fields."""
    output = {
        "outputSchemaVersion": INDICATOR_OUTPUT_SCHEMA_VERSION,
        "series": _build_series(indicator_id, lines or []),
        "annotations": _build_annotations(
            indicator_id,
            markers or [],
            hlines or [],
            bgcolors or [],
            barcolors or [],
            signals or [],
        ),
        "fills": _build_fills(indicator_id, fills or []),
    }
    output["paneLayout"] = _build_pane_layout(output["series"], output["annotations"])
    return output


def _scoped_id(indicator_id: str | None, local_id: Any, fallback: str) -> str:
    local = str(local_id or fallback)
    return f"{indicator_id}:{local}" if indicator_id else local


def _pane_value(item: dict[str, Any], fallback: str = "main") -> str:
    return str(item.get("pane") or fallback)


def _build_series(
    indicator_id: str | None, lines: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    series: list[dict[str, Any]] = []
    for idx, line in enumerate(lines):
        local_id = (
            line.get("id")
            or line.get("outputName")
            or line.get("name")
            or f"series_{idx + 1}"
        )
        pane = _pane_value(line)
        series.append(
            {
                "id": _scoped_id(indicator_id, local_id, f"series_{idx + 1}"),
                "localId": str(local_id),
                "indicatorId": indicator_id,
                "pane": pane,
                "type": line.get("type") or "line",
                "data": line.get("data") or [],
                "style": {
                    "title": line.get("title") or line.get("name") or str(local_id),
                    "color": line.get("color") or "#f59e0b",
                    "lineWidth": line.get("lineWidth", 2),
                    "lineStyle": line.get("lineStyle", 0),
                    **(
                        {"colorData": line.get("colorData")}
                        if line.get("colorData")
                        else {}
                    ),
                    **(
                        {"visible": line["visible"]}
                        if isinstance(line.get("visible"), bool)
                        else {}
                    ),
                    **(
                        {"trackPrice": line["trackPrice"]}
                        if isinstance(line.get("trackPrice"), bool)
                        else {}
                    ),
                    **(
                        {"base": line["base"]}
                        if (
                            isinstance(line.get("base"), (int, float))
                            and not isinstance(line.get("base"), bool)
                        )
                        else {}
                    ),
                },
                "scale": line.get("scale") or "right",
                "zIndex": line.get("zIndex", 10),
            }
        )
    return series


def _build_annotations(
    indicator_id: str | None,
    markers: list[dict[str, Any]],
    hlines: list[dict[str, Any]],
    bgcolors: list[dict[str, Any]],
    barcolors: list[dict[str, Any]],
    signals: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    annotations: list[dict[str, Any]] = []
    for idx, marker in enumerate(markers):
        pane = _pane_value(marker)
        annotations.append(
            {
                "id": _scoped_id(indicator_id, marker.get("id"), f"marker_{idx + 1}"),
                "indicatorId": indicator_id,
                "pane": pane,
                "type": "marker",
                "data": marker.get("data") or [],
                "style": {
                    "shape": marker.get("shape") or "circle",
                    "color": marker.get("color") or "#f59e0b",
                    "text": marker.get("text") or "",
                    "position": marker.get("position") or "above",
                    "size": marker.get("size") or "normal",
                },
                "scale": "series",
                "zIndex": marker.get("zIndex", 30),
            }
        )
    for idx, hline in enumerate(hlines):
        pane = _pane_value(hline, "separate")
        annotations.append(
            {
                "id": _scoped_id(indicator_id, hline.get("id"), f"hline_{idx + 1}"),
                "indicatorId": indicator_id,
                "pane": pane,
                "type": "hline",
                "data": [{"value": hline.get("price")}],
                "style": {
                    "title": hline.get("title") or "",
                    "color": hline.get("color") or "#787b86",
                    "lineStyle": hline.get("linestyle", "dashed"),
                    "lineWidth": hline.get("linewidth", 1),
                },
                "scale": "right",
                "zIndex": hline.get("zIndex", 20),
            }
        )
    for idx, bgcolor in enumerate(bgcolors):
        pane = _pane_value(bgcolor)
        annotations.append(
            {
                "id": _scoped_id(indicator_id, bgcolor.get("id"), f"bgcolor_{idx + 1}"),
                "indicatorId": indicator_id,
                "pane": pane,
                "type": "bgcolor",
                "data": bgcolor.get("regions") or [],
                "style": {
                    "title": bgcolor.get("title") or "",
                    "color": bgcolor.get("color") or "rgba(59,130,246,0.1)",
                },
                "scale": "pane",
                "zIndex": bgcolor.get("zIndex", 0),
            }
        )
    for idx, barcolor in enumerate(barcolors):
        annotations.append(
            {
                "id": _scoped_id(
                    indicator_id, barcolor.get("id"), f"barcolor_{idx + 1}"
                ),
                "indicatorId": indicator_id,
                "pane": "main",
                "type": "barcolor",
                "data": barcolor.get("data") or [],
                "style": {},
                "scale": "price",
                "zIndex": barcolor.get("zIndex", 5),
            }
        )
    for idx, signal in enumerate(signals):
        pane = _pane_value(signal)
        annotations.append(
            {
                "id": _scoped_id(indicator_id, signal.get("id"), f"signal_{idx + 1}"),
                "indicatorId": indicator_id,
                "pane": pane,
                "type": "signal",
                "data": signal.get("data") or [],
                "style": {
                    "name": signal.get("name") or signal.get("side") or "signal",
                    "side": signal.get("side") or "alert",
                    "message": signal.get("message") or "",
                },
                "scale": "event",
                "zIndex": signal.get("zIndex", 40),
            }
        )
    return annotations


def _build_fills(
    indicator_id: str | None, fills: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for idx, fill in enumerate(fills):
        plot1 = fill.get("plot1_id")
        plot2 = fill.get("plot2_id")
        normalized.append(
            {
                "id": _scoped_id(indicator_id, fill.get("id"), f"fill_{idx + 1}"),
                "indicatorId": indicator_id,
                "pane": _pane_value(fill, "separate"),
                "type": "betweenSeries",
                "seriesIds": [
                    _scoped_id(indicator_id, plot1, "plot_1"),
                    _scoped_id(indicator_id, plot2, "plot_2"),
                ],
                "localSeriesIds": [plot1, plot2],
                "style": {
                    "title": fill.get("title") or "",
                    "color": fill.get("color") or "rgba(59,130,246,0.1)",
                },
                "scale": "right",
                "zIndex": fill.get("zIndex", 1),
            }
        )
    return normalized


def _build_pane_layout(
    series: list[dict[str, Any]], annotations: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    panes: dict[str, dict[str, Any]] = {}
    for item in series:
        pane = item.get("pane") or "main"
        if pane not in panes:
            panes[pane] = {
                "id": pane,
                "type": "main" if pane == "main" else "indicator",
                "seriesIds": [],
                "annotationIds": [],
            }
        panes[pane]["seriesIds"].append(item["id"])
    for item in annotations:
        pane = item.get("pane") or "main"
        if pane not in panes:
            panes[pane] = {
                "id": pane,
                "type": "main" if pane == "main" else "indicator",
                "seriesIds": [],
                "annotationIds": [],
            }
        panes[pane]["annotationIds"].append(item["id"])
    if "main" not in panes:
        panes["main"] = {
            "id": "main",
            "type": "main",
            "seriesIds": [],
            "annotationIds": [],
        }
    return list(panes.values())


def serialize_pyne_result(
    result: Any, *, lines_on_error: bool = True
) -> dict[str, Any]:
    """Serialize a PyneResult into the frontend-facing compute shape."""
    output = result.output or {}
    payload: dict[str, Any] = {
        "schemaVersion": INDICATOR_PAYLOAD_SCHEMA_VERSION,
        "ok": result.ok,
        "error": result.error,
        "lines": result.lines if (result.ok or lines_on_error) else [],
        "result": output if output else None,
    }
    payload.update(
        build_unified_output(
            lines=payload["lines"],
            markers=output.get("markers") or [],
            hlines=output.get("hlines") or [],
            bgcolors=output.get("bgcolors") or [],
            fills=output.get("fills") or [],
            barcolors=output.get("barcolors") or [],
            signals=output.get("signals") or [],
        )
    )
    if not result.ok:
        code = result.code or "PYNE_EXECUTION_FAILED"
        payload["code"] = code
        payload["errorDetail"] = error_detail(
            code,
            result.error or "Pyne execution failed",
            line=result.line,
            column=result.column,
            hint=_pyne_hint(code, result.hint),
        )

    for key in PYNE_EXTENDED_OUTPUT_KEYS:
        if output.get(key):
            if key == "fills":
                payload["legacyFills"] = output[key]
                continue
            payload[key] = output[key]

    if result.param_schema:
        payload["param_schema"] = result.param_schema
    if result.meta:
        payload["meta"] = result.meta

    return payload


def _legacy_line_style(value: Any) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return {
        "solid": 0,
        "line": 0,
        "dashed": 2,
        "dotted": 1,
    }.get(str(value or "solid"), 0)


def _flat_lines_from_render_collections(
    collections: dict[str, Any],
) -> list[dict[str, Any]]:
    """Build the stable flat-series view from public structured Render IR."""
    lines: list[dict[str, Any]] = []
    for item in collections.get("lines") or []:
        line = {
            "name": item.get("title", ""),
            "color": item.get("color", "#f59e0b"),
            "type": "line",
            "pane": item.get("pane", "main"),
            "lineWidth": item.get("linewidth", 2),
            "lineStyle": _legacy_line_style(item.get("style", "solid")),
            "data": item.get("data", []),
        }
        if "id" in item:
            line["id"] = item["id"]
        if isinstance(item.get("visible"), bool):
            line["visible"] = item["visible"]
        if isinstance(item.get("trackPrice"), bool):
            line["trackPrice"] = item["trackPrice"]
        if isinstance(item.get("base"), (int, float)) and not isinstance(
            item.get("base"), bool
        ):
            line["base"] = item["base"]
        if item.get("per_bar_color"):
            line["per_bar_color"] = True
        lines.append(line)
    for item in collections.get("histograms") or []:
        line = {
            "name": item.get("title", ""),
            "color": item.get("color_up", "#26a69a"),
            "type": "histogram",
            "pane": item.get("pane", "separate"),
            "lineWidth": item.get("linewidth", 2),
            "lineStyle": _legacy_line_style(
                item.get("linestyle", item.get("style", "solid"))
            ),
            "data": item.get("data", []),
        }
        if "id" in item:
            line["id"] = item["id"]
        if isinstance(item.get("visible"), bool):
            line["visible"] = item["visible"]
        if isinstance(item.get("trackPrice"), bool):
            line["trackPrice"] = item["trackPrice"]
        if isinstance(item.get("base"), (int, float)) and not isinstance(
            item.get("base"), bool
        ):
            line["base"] = item["base"]
        if item.get("colorData"):
            line["colorData"] = item["colorData"]
        if item.get("per_bar_color"):
            line["per_bar_color"] = True
        lines.append(line)
    return lines


def _flat_lines_from_render_series(result: ExecuteBatchResult) -> list[dict[str, Any]]:
    """Build the stable flat-series view from public RenderOutput.series."""
    if result.output is None:
        return []
    lines: list[dict[str, Any]] = []
    for item in result.output.series:
        style = dict(item.style)
        line = {
            "id": item.id,
            "outputName": item.id,
            "name": item.title,
            "title": item.title,
            "type": item.series_type,
            "pane": item.pane,
            "scale": item.scale,
            "data": [point.to_wire() for point in item.points],
            "color": style.get("color", "#f59e0b"),
            "lineWidth": style.get("lineWidth", 2),
            "lineStyle": style.get("lineStyle", 0),
            "zIndex": style.get("zIndex", 10),
        }
        if style.get("colorData"):
            line["colorData"] = style["colorData"]
        if isinstance(style.get("visible"), bool):
            line["visible"] = style["visible"]
        if isinstance(style.get("trackPrice"), bool):
            line["trackPrice"] = style["trackPrice"]
        if isinstance(style.get("base"), (int, float)) and not isinstance(
            style.get("base"), bool
        ):
            line["base"] = style["base"]
        lines.append(line)
    return lines


def _merge_flat_render_lines(
    public_series: list[dict[str, Any]],
    structured_series: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge both legal Render IR series sources without rendering an id twice.

    Structured entries retain precedence for duplicate explicit ids because
    compatibility collections can carry richer renderer-specific metadata than
    the public LineSeries projection.
    """
    merged: list[dict[str, Any]] = []
    index_by_id: dict[str, int] = {}
    for line in (*public_series, *structured_series):
        explicit_id = line.get("id")
        identity = (
            str(explicit_id) if explicit_id is not None and str(explicit_id) else None
        )
        if identity is not None and identity in index_by_id:
            merged[index_by_id[identity]] = line
            continue
        if identity is not None:
            index_by_id[identity] = len(merged)
        merged.append(line)
    return merged


def _structured_render_payload(result: ExecuteBatchResult) -> dict[str, Any] | None:
    output = result.output
    if output is None or output.collections is None:
        return None
    collections = output.collections.to_wire()
    if "objectEvents" in collections:
        collections["object_events"] = collections.pop("objectEvents")
    structured = dict(collections)
    if output.meta:
        structured["meta"] = dict(output.meta)
    return structured


def serialize_plugin_runtime_result(result: ExecuteBatchResult) -> dict[str, Any]:
    """Translate public Render IR into CandleScope's stable Indicator envelope.

    The adapter depends only on the SDK model. Runtime-specific packages never
    import CandleScope serializers or transport modules.
    """
    if not result.ok or result.output is None:
        diagnostic = next(
            (item for item in result.diagnostics if item.severity == "error"),
            None,
        )
        code = diagnostic.code if diagnostic is not None else "RUNTIME_EXECUTION_FAILED"
        message = (
            diagnostic.message
            if diagnostic is not None
            else "Script runtime execution failed."
        )
        payload = build_error_payload(
            code,
            message,
            line=(diagnostic.span or {}).get("line") if diagnostic else None,
            column=(diagnostic.span or {}).get("column") if diagnostic else None,
            hint=diagnostic.hint if diagnostic else None,
        )
        payload.update(build_unified_output(lines=[]))
        return payload

    structured = _structured_render_payload(result)
    public_series = _flat_lines_from_render_series(result)
    structured_series = (
        _flat_lines_from_render_collections(structured)
        if structured is not None
        else []
    )
    lines = _merge_flat_render_lines(public_series, structured_series)
    payload: dict[str, Any] = {
        "schemaVersion": INDICATOR_PAYLOAD_SCHEMA_VERSION,
        "ok": True,
        "error": None,
        "lines": lines,
        "result": (
            (structured or None) if structured is not None else result.output.to_wire()
        ),
    }
    collections = structured or {}
    payload.update(
        build_unified_output(
            lines=lines,
            markers=collections.get("markers") or [],
            hlines=collections.get("hlines") or [],
            bgcolors=collections.get("bgcolors") or [],
            fills=collections.get("fills") or [],
            barcolors=collections.get("barcolors") or [],
            signals=collections.get("signals") or [],
        )
    )
    if structured is not None:
        for key in PYNE_EXTENDED_OUTPUT_KEYS:
            if collections.get(key):
                if key == "fills":
                    payload["legacyFills"] = collections[key]
                else:
                    payload[key] = collections[key]
    if result.inputs:
        payload["param_schema"] = [dict(item) for item in result.inputs]
    meta = {**result.output.meta, **result.meta}
    if meta:
        payload["meta"] = meta
    return payload


def build_script_runtime_snapshot_payload(
    *,
    client_id: str,
    indicator_id: str,
    exchange: str,
    symbol: str,
    interval: str,
    market_type: str,
    name: str,
    params: dict[str, Any],
    payload: dict[str, Any],
    bar_time: int = 0,
    script_hash: str | None = None,
) -> dict[str, Any]:
    """Wrap an already-adapted script result for range and WS transports."""
    execution = dict(payload)
    execution.update(
        build_unified_output(
            indicator_id=indicator_id,
            lines=execution.get("lines") or [],
            markers=execution.get("markers") or [],
            hlines=execution.get("hlines") or [],
            bgcolors=execution.get("bgcolors") or [],
            fills=execution.get("legacyFills") or execution.get("fills") or [],
            barcolors=execution.get("barcolors") or [],
            signals=execution.get("signals") or [],
        )
    )
    return {
        "type": "indicator.snapshot",
        "kind": "script",
        "clientId": client_id,
        "indicatorId": indicator_id,
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "market_type": market_type,
        "name": name,
        "params": params,
        **({"scriptHash": script_hash} if script_hash else {}),
        "barTime": bar_time,
        **execution,
    }


def rebind_indicator_payload_identity(
    payload: dict[str, Any],
    indicator_id: str,
) -> dict[str, Any]:
    """Re-scope a cached script payload for the requesting client identity."""
    old_id = str(payload.get("indicatorId") or "")
    if not indicator_id or old_id == indicator_id:
        return payload

    def _scoped(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        if old_id and value.startswith(f"{old_id}:"):
            return f"{indicator_id}:{value[len(old_id) + 1 :]}"
        return value

    payload["indicatorId"] = indicator_id
    for key in ("series", "annotations", "fills"):
        for item in payload.get(key) or []:
            if not isinstance(item, dict):
                continue
            item["indicatorId"] = indicator_id
            item["id"] = _scoped(item.get("id"))
            if isinstance(item.get("seriesIds"), list):
                item["seriesIds"] = [_scoped(value) for value in item["seriesIds"]]
    for pane in payload.get("paneLayout") or []:
        if not isinstance(pane, dict):
            continue
        for key in ("seriesIds", "annotationIds"):
            if isinstance(pane.get(key), list):
                pane[key] = [_scoped(value) for value in pane[key]]
    return payload


def _pyne_hint(code: str, fallback: str | None) -> str | None:
    """Keep CandleScope-facing Pyne errors localized across runtime backends."""
    if code == "PYNE_SYNTAX_ERROR":
        return (
            "这是 Python/Pyne 语法错误，请检查报错行附近的括号、缩进、逗号或赋值写法。"
        )
    if code == "PYNE_IMPORT_BLOCKED":
        return "当前安全模式不允许该 import。可切换 research/unsafe，或配置 PYNE_ALLOWED_IMPORTS。"
    return fallback


def serialize_indicator_result(result: Any) -> dict[str, Any]:
    """Serialize an IndicatorResult into the frontend-facing compute shape."""
    if result is None:
        return build_error_payload(
            "INDICATOR_RESULT_EMPTY",
            "Indicator computation returned None",
        )
    if result.error:
        payload = build_error_payload(
            "INDICATOR_COMPUTE_FAILED",
            result.error,
            result=result.to_dict(),
        )
        payload.update(build_unified_output(lines=[]))
        return payload
    output = {
        "schemaVersion": INDICATOR_PAYLOAD_SCHEMA_VERSION,
        "ok": True,
        "error": None,
        "lines": result.lines,
        "result": result.to_dict(),
    }
    output.update(build_unified_output(lines=result.lines))
    return output


def build_indicator_snapshot_payload(
    *,
    client_id: str,
    indicator_id: str,
    exchange: str,
    symbol: str,
    interval: str,
    market_type: str,
    name: str,
    params: dict[str, Any],
    result: Any,
    bar_time: int = 0,
) -> dict[str, Any]:
    """Build a WebSocket snapshot payload for a builtin indicator."""
    payload = serialize_indicator_result(result)
    payload.update(
        build_unified_output(
            indicator_id=indicator_id,
            lines=payload.get("lines") or [],
        )
    )
    return {
        "type": "indicator.snapshot",
        "kind": "builtin",
        "clientId": client_id,
        "indicatorId": indicator_id,
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "market_type": market_type,
        "name": name,
        "params": params,
        "barTime": bar_time,
        **payload,
    }


def build_pyne_snapshot_payload(
    *,
    client_id: str,
    indicator_id: str,
    exchange: str,
    symbol: str,
    interval: str,
    market_type: str,
    name: str,
    params: dict[str, Any],
    result: Any,
    bar_time: int = 0,
    script_hash: str | None = None,
) -> dict[str, Any]:
    """Build a WebSocket snapshot payload for a backend-hosted Pyne script."""
    payload = serialize_pyne_result(result, lines_on_error=False)
    payload.update(
        build_unified_output(
            indicator_id=indicator_id,
            lines=payload.get("lines") or [],
            markers=payload.get("markers") or [],
            hlines=payload.get("hlines") or [],
            bgcolors=payload.get("bgcolors") or [],
            fills=payload.get("legacyFills") or payload.get("fills") or [],
            barcolors=payload.get("barcolors") or [],
            signals=payload.get("signals") or [],
        )
    )
    return {
        "type": "indicator.snapshot",
        "kind": "script",
        "clientId": client_id,
        "indicatorId": indicator_id,
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "market_type": market_type,
        "name": name,
        "params": params,
        **({"scriptHash": script_hash} if script_hash else {}),
        "barTime": bar_time,
        **payload,
    }
