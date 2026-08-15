from __future__ import annotations

import json
from pathlib import Path

from app.backtest.strategy import python_author_v1 as host
from candlescope_backtest_sdk import canonical_sha256 as sdk_hash
from candlescope_backtest_sdk.contract import (
    AUTHOR_CONTRACT,
    BUNDLE_SCHEMA,
    OUTPUT_KINDS,
    PROVIDER_PROTOCOL,
    REPRODUCIBILITY_CLASSES,
    SIGNAL_CLOCKS,
)
from candlescope_backtest_sdk.schema import bundle_schema, parameter_schema

REPO = Path(__file__).resolve().parents[2]
SDK_SCHEMAS = (
    REPO
    / "packages"
    / "candlescope-backtest-sdk"
    / "src"
    / "candlescope_backtest_sdk"
    / "schemas"
)
HOST_SCHEMAS = (
    REPO / "backend" / "app" / "backtest" / "strategy" / "python_author_schemas"
)
GOLDEN_DIR = REPO / "packages" / "candlescope-backtest-sdk" / "goldens"


def test_host_and_sdk_names_and_enums_match() -> None:
    assert host.AUTHOR_CONTRACT == AUTHOR_CONTRACT == "candlescope.python-strategy/1"
    assert host.PROVIDER_PROTOCOL == PROVIDER_PROTOCOL == "strategy-provider/1"
    assert host.BUNDLE_SCHEMA == BUNDLE_SCHEMA
    assert host.OUTPUT_KINDS == OUTPUT_KINDS
    assert host.SIGNAL_CLOCKS == SIGNAL_CLOCKS
    assert host.REPRODUCIBILITY_CLASSES == REPRODUCIBILITY_CLASSES


def test_host_and_sdk_schema_bytes_and_hashes_match() -> None:
    for name in (
        "python-strategy-bundle-v1.json",
        "python-strategy-parameters-v1.json",
    ):
        sdk = (SDK_SCHEMAS / name).read_bytes().replace(b"\r\n", b"\n")
        host_bytes = (HOST_SCHEMAS / name).read_bytes().replace(b"\r\n", b"\n")
        assert sdk == host_bytes
    assert host.canonical_sha256(bundle_schema()) == sdk_hash(bundle_schema())
    assert host.canonical_sha256(parameter_schema()) == sdk_hash(parameter_schema())
    identity = host.contract_identity()
    assert identity["bundleSchemaHash"].startswith("sha256:")
    assert identity["parameterSchemaHash"].startswith("sha256:")


def test_golden_wires_match_sdk_and_host_hashes() -> None:
    from candlescope_backtest_sdk import (
        Bar,
        Observation,
        OrderIntent,
        Signal,
        TargetPosition,
        encode_output,
    )

    observation = Observation(
        run_id="bt_golden",
        revision_id="rev_golden",
        generation=1,
        sequence=7,
        event_time_ms=1_700_000_420_000,
        watermark_ms=1_700_000_420_000,
        phase="STEP",
        market={"symbol": "ETHUSDT", "venue": "BINANCE"},
        bar=Bar(
            open_time_ms=1_700_000_360_000,
            close_time_ms=1_700_000_420_000,
            open="2000",
            high="2010",
            low="1990",
            close="2005",
            volume="12",
        ),
        features={"close": "2005"},
        account_view={"equity": "10000"},
        input_hash="sha256:" + "ab" * 32,
    )
    wires = {
        "observation": observation.to_wire(),
        "signal": encode_output(7, Signal(direction="LONG", score="0.25")),
        "target_position": encode_output(7, TargetPosition(quantity="1")),
        "order_intent": encode_output(
            7,
            OrderIntent(side="BUY", type="MARKET", quantity="1"),
        ),
    }
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    for name, payload in wires.items():
        path = GOLDEN_DIR / f"{name}.wire.json"
        if not path.exists():
            path.write_text(
                json.dumps(payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        frozen = json.loads(path.read_text(encoding="utf-8"))
        assert frozen == payload
        assert host.canonical_sha256(frozen) == sdk_hash(payload)
