"""Frozen Wasmtime 47 policy shared by the Host and reproducible build gate."""

import os

WASM_COMPONENT_PROVIDER_VERSION = "1.0.0"
WASM_RUNTIME_ENABLED_ENV = "CANDLESCOPE_PLUGIN_RUNTIME_WASM_ENABLED"
WASMTIME_RUNTIME_ID = "wasmtime-47.0.3"
WASMTIME_VERSION = "47.0.3"
WASM_COMPONENT_HEADER = b"\x00asm\x0d\x00\x01\x00"
WASM_MAX_COMPONENT_BYTES = 64 * 1024 * 1024
WASM_LINEAR_MEMORY_BYTES = 64 * 1024 * 1024
WASM_PROCESS_FUEL = 1_000_000_000
_WASMTIME_POLICY_ARGUMENTS = (
    "-Ccache=n",
    f"-Wfuel={WASM_PROCESS_FUEL}",
    f"-Wmax-memory-size={WASM_LINEAR_MEMORY_BYTES}",
    "-Wmax-wasm-stack=2097152",
    "-Wmax-table-elements=100000",
    "-Wmax-instances=8",
    "-Wmax-tables=8",
    "-Wmax-memories=4",
    "-Wtrap-on-grow-failure=y",
    "-Wnan-canonicalization=y",
    "-Wrelaxed-simd-deterministic=y",
    "-Wthreads=n",
    "-Wshared-memory=n",
    "-Wmemory64=n",
    "-Wcomponent-model=y",
    "-Wcomponent-model-threading=n",
    "-Wconcurrency-support=y",
    "-Scli=y",
    "-Shttp=n",
    "-Snn=n",
    "-Sthreads=n",
    "-Sconfig=n",
    "-Skeyvalue=n",
    "-Stls=n",
    "-Spreview0=n",
    "-Sinherit-network=n",
    "-Sallow-ip-name-lookup=n",
    "-Stcp=n",
    "-Sudp=n",
    "-Sinherit-env=n",
    "-Sinherit-stdin=y",
    "-Sinherit-stdout=y",
    "-Sinherit-stderr=y",
    "-Smax-resources=1024",
    "-Shostcall-fuel=10000000",
)


def wasmtime_fixed_arguments(operating_system: str | None = None) -> tuple[str, ...]:
    target = operating_system or ("windows" if os.name == "nt" else "linux")
    if target not in {"linux", "windows"}:
        raise ValueError("Wasmtime policy supports only Linux and Windows")
    empty_config = "NUL" if target == "windows" else "/dev/null"
    return ("run", f"--config={empty_config}", *_WASMTIME_POLICY_ARGUMENTS)


WASMTIME_FIXED_ARGUMENTS = wasmtime_fixed_arguments()


__all__ = [
    "WASM_COMPONENT_HEADER",
    "WASM_COMPONENT_PROVIDER_VERSION",
    "WASM_LINEAR_MEMORY_BYTES",
    "WASM_MAX_COMPONENT_BYTES",
    "WASM_PROCESS_FUEL",
    "WASM_RUNTIME_ENABLED_ENV",
    "WASMTIME_FIXED_ARGUMENTS",
    "WASMTIME_RUNTIME_ID",
    "WASMTIME_VERSION",
    "wasmtime_fixed_arguments",
]
