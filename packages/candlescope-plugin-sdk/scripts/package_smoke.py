"""Install the built wheel offline and verify the real console sidecar."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "hello_transcript_v1.json"


def _canonical_sha256(value: Any) -> str:
    payload = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _venv_python(venv_path: Path) -> Path:
    if os.name == "nt":
        return venv_path / "Scripts" / "python.exe"
    return venv_path / "bin" / "python"


def _venv_command(venv_path: Path) -> Path:
    if os.name == "nt":
        return venv_path / "Scripts" / "candlescope-hello-runtime.exe"
    return venv_path / "bin" / "candlescope-hello-runtime"


def _select_wheel(dist_dir: Path) -> Path:
    wheels = sorted(dist_dir.glob("candlescope_plugin_sdk-*.whl"))
    if len(wheels) != 1:
        raise RuntimeError(
            f"expected exactly one candlescope-plugin-sdk wheel in {dist_dir}, found {len(wheels)}"
        )
    return wheels[0].resolve()


def run_smoke(*, dist_dir: Path, python: str) -> None:
    wheel = _select_wheel(dist_dir)
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    stdin_payload = "".join(
        json.dumps(request, separators=(",", ":")) + "\n" for request in fixture["requests"]
    )

    with tempfile.TemporaryDirectory(prefix="candlescope-plugin-sdk-smoke-") as raw:
        venv_path = Path(raw) / "venv"
        subprocess.run([python, "-m", "venv", str(venv_path)], check=True)
        venv_python = _venv_python(venv_path)
        subprocess.run(
            [
                str(venv_python),
                "-m",
                "pip",
                "install",
                "--no-index",
                "--no-deps",
                str(wheel),
            ],
            check=True,
        )
        imported = subprocess.run(
            [
                str(venv_python),
                "-c",
                ("import candlescope_plugin_sdk as sdk; print(sdk.__version__, sdk.PROTOCOL_V1)"),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        if imported.stdout.strip() != "0.2.0 candlescope.script-runtime/1":
            raise RuntimeError(f"unexpected installed import output: {imported.stdout!r}")

        completed = subprocess.run(
            [str(_venv_command(venv_path))],
            input=stdin_payload,
            check=True,
            capture_output=True,
            text=True,
        )
        if completed.stderr:
            raise RuntimeError(f"sidecar wrote unexpected stderr: {completed.stderr!r}")
        responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
        expected = fixture["expected"]
        if [_canonical_sha256(item) for item in responses] != expected["responseSha256"]:
            raise RuntimeError("installed sidecar response hashes do not match fixture")
        if _canonical_sha256(responses) != expected["transcriptSha256"]:
            raise RuntimeError("installed sidecar transcript hash does not match fixture")

    print(f"package smoke passed: {wheel.name}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist-dir", type=Path, default=ROOT / "dist")
    parser.add_argument("--python", default=sys.executable)
    args = parser.parse_args()
    run_smoke(dist_dir=args.dist_dir.resolve(), python=args.python)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
