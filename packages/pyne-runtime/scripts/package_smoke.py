"""Smoke test an installed Pyne Runtime wheel in an isolated virtualenv."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dist-dir",
        required=True,
        help="Directory containing built pyne_runtime wheel artifacts.",
    )
    parser.add_argument(
        "--repo-root",
        default=Path(__file__).resolve().parents[1],
        type=Path,
        help="Repository root containing examples used by the smoke test.",
    )
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Python interpreter used to create the temporary virtualenv.",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help=(
            "Create the smoke virtualenv with system site packages and install "
            "the wheel without resolving dependencies from an index."
        ),
    )
    args = parser.parse_args(argv)

    repo_root = args.repo_root.resolve()
    wheel = _find_wheel(Path(args.dist_dir))

    with tempfile.TemporaryDirectory(prefix="pyne-runtime-smoke-") as tmp:
        tmp_path = Path(tmp)
        venv_dir = tmp_path / "venv"
        _run(_venv_create_command(args.python, venv_dir, offline=args.offline))
        python = _venv_python(venv_dir)
        if not args.offline:
            _run([str(python), "-m", "pip", "install", "--upgrade", "pip"])
        _run(_wheel_install_command(python, wheel, offline=args.offline))

        _run(_type_marker_check_command(python))
        _run([str(python), "-m", "pyne_runtime", "--version"])
        schema = _run_json([str(python), "-m", "pyne_runtime", "schema"])
        if schema["output"]["schemaVersion"] != 1:
            raise RuntimeError("unexpected output schema version")

        script = repo_root / "examples" / "host_output_contract.py"
        ohlcv = repo_root / "examples" / "sample_ohlcv.csv"
        _run([str(python), "-m", "pyne_runtime", "validate", str(script)])

        out = tmp_path / "result.json"
        _run([
            str(python),
            "-m",
            "pyne_runtime",
            "run",
            str(script),
            "--ohlcv",
            str(ohlcv),
            "--executor-mode",
            "inline",
            "--out",
            str(out),
        ])
        payload = json.loads(out.read_text(encoding="utf-8"))
        if not payload.get("ok"):
            raise RuntimeError(f"smoke run failed: {payload.get('error')}")
        if "signals" not in payload.get("output", {}):
            raise RuntimeError("smoke run did not emit host signal output")

    return 0


def _find_wheel(dist_dir: Path) -> Path:
    wheels = sorted(dist_dir.resolve().glob("pyne_runtime-*.whl"))
    if not wheels:
        raise FileNotFoundError(f"No pyne_runtime wheel found in {dist_dir}")
    return wheels[-1]


def _venv_python(venv_dir: Path) -> Path:
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _venv_create_command(python: str, venv_dir: Path, *, offline: bool) -> list[str]:
    command = [python, "-m", "venv"]
    if offline:
        command.append("--system-site-packages")
    command.append(str(venv_dir))
    return command


def _wheel_install_command(python: Path, wheel: Path, *, offline: bool) -> list[str]:
    command = [str(python), "-m", "pip", "install"]
    if offline:
        command.append("--no-deps")
    command.append(str(wheel))
    return command


def _type_marker_check_command(python: Path) -> list[str]:
    return [
        str(python),
        "-c",
        (
            "from importlib.resources import files; "
            "raise SystemExit(0 if files('pyne_runtime').joinpath('py.typed').is_file() else 1)"
        ),
    ]


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, text=True)


def _run_json(command: list[str]) -> dict[str, object]:
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    if not isinstance(payload, dict):
        raise RuntimeError("expected JSON object")
    return payload


if __name__ == "__main__":
    raise SystemExit(main())
