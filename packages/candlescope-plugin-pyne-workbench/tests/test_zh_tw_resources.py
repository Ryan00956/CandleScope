from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "src" / "candlescope_plugin_pyne_workbench"


def test_manifest_and_sandbox_ship_zh_tw_copy() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    titles = {
        item["id"]: item["configuration"]["localizations"]["zh-TW"]["title"]
        for item in manifest["contributions"]
    }
    assert titles["run"] == "在當前圖表執行 Pyne"
    assert titles["workbench-view"] == "Pyne 工作台"
    assert titles["pyne-output"] == "Pyne 輸出"
    javascript = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    assert '"zh-TW": {' in javascript
    assert "等待 CandleScope 連線" in javascript
    assert "已連線 · 命令從外掛面板執行" in javascript
