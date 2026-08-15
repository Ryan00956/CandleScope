from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import jsonschema

from candlescope_backtest_sdk import (
    Bar,
    Observation,
    StrategyContext,
    encode_output,
)
from candlescope_backtest_sdk.schema import bundle_schema

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "templates"
GOLDENS = TEMPLATES / "goldens"
CATALOG = json.loads((TEMPLATES / "catalog.json").read_text(encoding="utf-8"))


def _load_strategy(directory: Path):
    spec = importlib.util.spec_from_file_location("official_strategy", directory / "strategy.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Strategy()


def _frame(sequence: int, close: str) -> Observation:
    return Observation(
        run_id="bt_1",
        revision_id="rev_1",
        generation=1,
        sequence=sequence,
        event_time_ms=sequence * 60_000,
        watermark_ms=sequence * 60_000,
        phase="STEP",
        market={"symbol": "BTCUSDT"},
        bar=Bar(
            open_time_ms=(sequence - 1) * 60_000,
            close_time_ms=sequence * 60_000,
            open=close,
            high=close,
            low=close,
            close=close,
            volume="1",
        ),
    )


def test_catalog_lists_required_first_wave() -> None:
    names = set(CATALOG["templates"])
    assert {"sma_cross", "rsi_wilder_24", "donchian_breakout", "mean_reversion", "buy_and_hold"}.issubset(names)
    assert "order_intents" in names
    assert (TEMPLATES / "study_parameter_space.json").is_file()


def test_official_templates_match_bundle_schema_and_docs() -> None:
    schema = bundle_schema()
    for name in CATALOG["templates"]:
        directory = TEMPLATES / name
        manifest = json.loads((directory / "strategy.json").read_text(encoding="utf-8"))
        jsonschema.validate(manifest, schema)
        readme = (directory / "README.md").read_text(encoding="utf-8")
        for token in ("假设", "signal clock", "warmup", "参数", "fidelity", "不能声称", "aggTrade", "golden"):
            assert token in readme
        source = (directory / "strategy.py").read_text(encoding="utf-8")
        assert "candlescope_backtest_sdk" in source
        assert "app." not in source
        assert "sqlite3" not in source
        assert "\r" not in source
        assert (directory / "requirements.lock").is_file()


def test_snapshot_restore_replays_identical_decision() -> None:
    strategy = _load_strategy(TEMPLATES / "snapshot_restore")
    strategy.prepare(StrategyContext(run_id="bt_1", revision_id="rev_1", parameters={"fast": 2, "slow": 3}))
    for index, close in enumerate(("10", "10", "11"), start=1):
        strategy.warmup(_frame(index, close))
    first = encode_output(4, strategy.step(_frame(4, "12")))
    frozen = strategy.snapshot()
    clone = _load_strategy(TEMPLATES / "snapshot_restore")
    clone.prepare(StrategyContext(run_id="bt_1", revision_id="rev_1", parameters={"fast": 2, "slow": 3}))
    clone.restore(frozen)
    second = encode_output(5, clone.step(_frame(5, "13")))
    resumed = encode_output(5, strategy.step(_frame(5, "13")))
    assert second["outputHash"] == resumed["outputHash"]
    assert first["kind"] == "TARGET_POSITION"


def test_order_intent_template_emits_all_four_types() -> None:
    strategy = _load_strategy(TEMPLATES / "order_intents")
    strategy.prepare(StrategyContext(run_id="bt_1", revision_id="rev_1", parameters={}))
    kinds = []
    for index in range(1, 5):
        kinds.append(encode_output(index, strategy.step(_frame(index, "10")))["payload"]["type"])
    assert kinds == ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]


def test_official_templates_install_and_run_from_fresh_offline_temp(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    site = tmp_path / "site"
    work = tmp_path / "work"
    dist.mkdir()
    site.mkdir()
    subprocess.run(
        [sys.executable, "-m", "pip", "wheel", "--no-deps", "-w", str(dist), str(ROOT)],
        check=True,
        capture_output=True,
        text=True,
    )
    wheels = list(dist.glob("candlescope_backtest_sdk-*.whl"))
    assert len(wheels) == 1
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-index",
            "--no-deps",
            "--target",
            str(site),
            str(wheels[0]),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import shutil; shutil.copytree(r'%s', r'%s')" % (TEMPLATES, work),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    script = (
        "import importlib.util, json, sys\n"
        "from pathlib import Path\n"
        "sys.path.insert(0, %r)\n"
        "from candlescope_backtest_sdk import Observation, StrategyContext, Bar, encode_output\n"
        "root = Path(%r)\n"
        "catalog = json.loads((root / 'catalog.json').read_text(encoding='utf-8'))\n"
        "for name in catalog['templates']:\n"
        "    path = root / name / 'strategy.py'\n"
        "    spec = importlib.util.spec_from_file_location('t', path)\n"
        "    module = importlib.util.module_from_spec(spec)\n"
        "    spec.loader.exec_module(module)\n"
        "    strategy = module.Strategy()\n"
        "    params = {'fast': 2, 'slow': 3, 'length': 3, 'lookback': 2, 'band': 0.5, 'oversold': 30, 'overbought': 70}\n"
        "    strategy.prepare(StrategyContext(run_id='bt', revision_id='r', parameters=params))\n"
        "    bar = Bar(0, 60_000, '10', '10', '10', '10', '1')\n"
        "    obs = Observation('bt', 'r', 1, 1, 60_000, 60_000, 'STEP', {'symbol': 'BTCUSDT'}, bar)\n"
        "    strategy.warmup(obs)\n"
        "    output = strategy.step(obs)\n"
        "    if output is not None:\n"
        "        encode_output(1, output)\n"
        "    strategy.restore(strategy.snapshot())\n"
        "print('offline-templates-ok', len(catalog['templates']))\n"
        % (str(site), str(work))
    )
    env = dict(__import__("os").environ)
    env["PYTHONPATH"] = str(site)
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONUTF8"] = "1"
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)
    assert "offline-templates-ok 8" in result.stdout
