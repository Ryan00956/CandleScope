from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk import (
    AnalyzeRequest,
    Bar,
    ExecuteBatchRequest,
    MarketContext,
)
from candlescope_plugin_sdk.examples.hello_runtime import HelloRuntime

from app.plugin_runtime.bundle import (
    VerifiedBundle,
    build_plugin_bundle,
    canonical_sha256,
)


REPOSITORY_ROOT = Path(__file__).parents[2]
SDK_SOURCE = (
    REPOSITORY_ROOT
    / "packages"
    / "candlescope-plugin-sdk"
    / "src"
    / "candlescope_plugin_sdk"
)


@dataclass(frozen=True, slots=True)
class HelloBundleFixture:
    bundle: VerifiedBundle
    wheel_path: Path
    manifest_path: Path


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def _record_hash(data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return f"sha256={digest.decode('ascii')}"


def build_hello_wheel(
    directory: Path,
    *,
    version: str = "0.1.0",
    runtime_id: str = "hello-runtime",
) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"candlescope_plugin_sdk-{version}-py3-none-any.whl"
    output = directory / filename
    entries: dict[str, bytes] = {}
    for source in sorted(SDK_SOURCE.rglob("*.py")):
        relative = source.relative_to(SDK_SOURCE).as_posix()
        data = source.read_bytes()
        if relative in {
            "__init__.py",
            "examples/hello_runtime.py",
        }:
            data = data.replace(b'"0.2.0"', f'"{version}"'.encode("ascii"))
        if relative == "examples/hello_runtime.py":
            data = data.replace(b'"hello-runtime"', f'"{runtime_id}"'.encode("ascii"))
        entries[f"candlescope_plugin_sdk/{relative}"] = data

    dist_info = f"candlescope_plugin_sdk-{version}.dist-info"
    entries[f"{dist_info}/METADATA"] = (
        "Metadata-Version: 2.4\n"
        "Name: candlescope-plugin-sdk\n"
        f"Version: {version}\n"
        "Requires-Python: >=3.11\n"
        "\n"
    ).encode("utf-8")
    entries[f"{dist_info}/WHEEL"] = (
        "Wheel-Version: 1.0\n"
        "Generator: CandleScope tests\n"
        "Root-Is-Purelib: true\n"
        "Tag: py3-none-any\n"
        "\n"
    ).encode("utf-8")

    record_path = f"{dist_info}/RECORD"
    record_output = io.StringIO(newline="")
    writer = csv.writer(record_output, lineterminator="\n")
    for path, data in sorted(entries.items()):
        writer.writerow((path, _record_hash(data), len(data)))
    writer.writerow((record_path, "", ""))
    entries[record_path] = record_output.getvalue().encode("utf-8")

    with zipfile.ZipFile(output, "w", allowZip64=True) as archive:
        for path, data in sorted(entries.items()):
            archive.writestr(_zip_info(path), data)
    return output


def hello_probe(*, runtime_id: str = "hello-runtime") -> dict[str, Any]:
    context = MarketContext(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
    )
    bars = (
        Bar(
            time=1_700_000_000,
            open=100,
            high=102,
            low=99,
            close=101,
            volume=10,
        ),
        Bar(
            time=1_700_000_060,
            open=101,
            high=103,
            low=100,
            close=102,
            volume=11,
        ),
    )
    source = "plot(close)"
    analyze_request = AnalyzeRequest(source=source, context=context)
    execute_request = ExecuteBatchRequest(
        source=source,
        context=context,
        bars=bars,
    )
    runtime = HelloRuntime()
    execution = runtime.execute_batch(execute_request).to_wire()
    execution["output"]["meta"]["runtime"] = runtime_id
    return {
        "source": source,
        "context": context.to_wire(),
        "bars": [bar.to_wire() for bar in bars],
        "params": {},
        "options": {},
        "analysisSha256": canonical_sha256(runtime.analyze(analyze_request).to_wire()),
        "executionSha256": canonical_sha256(execution),
    }


def hello_manifest(
    wheel_path: Path,
    *,
    version: str = "0.1.0",
    analysis_sha256: str | None = None,
    runtime_id: str = "hello-runtime",
) -> dict[str, Any]:
    probe = hello_probe(runtime_id=runtime_id)
    if analysis_sha256 is not None:
        probe["analysisSha256"] = analysis_sha256
    return {
        "schemaVersion": 1,
        "plugin": {
            "id": runtime_id,
            "name": "Hello Runtime",
            "version": version,
            "package": "candlescope-plugin-sdk",
            "protocol": "candlescope.script-runtime/1",
        },
        "python": {
            "requires": ">=3.11,<3.14",
            "module": "candlescope_plugin_sdk.examples.hello_runtime",
        },
        "wheels": [
            {
                "path": f"wheels/{wheel_path.name}",
                "package": "candlescope-plugin-sdk",
                "version": version,
            }
        ],
        "probe": probe,
    }


def build_hello_bundle(
    directory: Path,
    *,
    version: str = "0.1.0",
    analysis_sha256: str | None = None,
    output_name: str | None = None,
    runtime_id: str = "hello-runtime",
) -> HelloBundleFixture:
    directory.mkdir(parents=True, exist_ok=True)
    wheel_path = build_hello_wheel(
        directory / "wheelhouse",
        version=version,
        runtime_id=runtime_id,
    )
    manifest_path = directory / f"manifest-{version}.json"
    manifest_path.write_text(
        json.dumps(
            hello_manifest(
                wheel_path,
                version=version,
                analysis_sha256=analysis_sha256,
                runtime_id=runtime_id,
            ),
            indent=2,
        ),
        encoding="utf-8",
    )
    output = directory / (output_name or f"{runtime_id}-{version}.cspkg")
    bundle = build_plugin_bundle(manifest_path, (wheel_path,), output)
    return HelloBundleFixture(
        bundle=bundle,
        wheel_path=wheel_path,
        manifest_path=manifest_path,
    )
