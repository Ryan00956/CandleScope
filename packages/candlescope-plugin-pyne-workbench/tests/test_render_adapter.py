from __future__ import annotations

from candlescope_plugin_pyne_workbench import adapt_pyne_output


def test_adapter_projects_supported_geometry_and_reports_lossy_groups() -> None:
    adapted = adapt_pyne_output(
        {
            "lines": [
                {
                    "title": "Close",
                    "color": "#2196f3",
                    "linewidth": 2,
                    "style": "solid",
                    "data": [
                        {"time": 10, "value": 1},
                        {"time": 20, "value": 2},
                        {"time": 30, "value": 3},
                    ],
                }
            ],
            "hlines": [
                {"price": 2.5, "title": "Mid", "color": "#787b86", "linewidth": 1}
            ],
            "candles": [{"title": "Synthetic", "data": []}],
            "objects": {
                "boxes": [
                    {
                        "left": 0,
                        "right": 2,
                        "top": 4,
                        "bottom": 1,
                        "xloc": "bar_index",
                        "bgcolor": "rgba(33,150,243,0.2)",
                        "border_color": "#2196f3",
                    }
                ],
                "linefills": [{"id": "linefill-1"}],
            },
        },
        bar_times=[10, 20, 30],
    )

    assert adapted.render["schemaVersion"] == "candlescope.render/2"
    assert [item["type"] for item in adapted.render["items"]] == [
        "polyline",
        "price-line",
        "band",
    ]
    assert adapted.render["items"][2]["fillColor"] == "#2196F333"
    assert adapted.source_counts["candles"] == 1
    assert any("candles is preserved" in item for item in adapted.diagnostics)
    assert any("linefills" in item for item in adapted.diagnostics)


def test_adapter_maps_bar_index_polylines_to_strict_times() -> None:
    adapted = adapt_pyne_output(
        {
            "objects": {
                "polylines": [
                    {
                        "points": [{"x": 2, "y": 3}, {"x": 0, "y": 1}, {"x": 1, "y": 2}],
                        "xloc": "bar_index",
                        "line_color": "#00ff00",
                        "line_width": 3,
                        "line_style": "dotted",
                    }
                ]
            }
        },
        bar_times=[100, 200, 300],
    )

    assert adapted.render["items"][0]["points"] == [
        {"time": 100, "price": 1.0},
        {"time": 200, "price": 2.0},
        {"time": 300, "price": 3.0},
    ]
