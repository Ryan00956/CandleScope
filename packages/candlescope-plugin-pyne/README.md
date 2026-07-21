# CandleScope Pyne Runtime Plugin

`candlescope-plugin-pyne` is the public-protocol bridge between CandleScope and the
independently released `pyne-runtime` engine. It contains no CandleScope backend
imports and no copied Pyne source. CandleScope launches it in an isolated managed
virtual environment through `candlescope.script-runtime/1`.

## Compatibility contract

- Plugin: `candlescope-plugin-pyne==0.1.0`
- SDK: `candlescope-plugin-sdk==0.1.0`
- Engine: `pyne-runtime==0.2.0rc1`
- Python: `>=3.11,<3.14`
- Runtime ID: `candlescope.pyne`

The exact engine wheel is pinned by `release/release-lock.json`. A version mismatch
fails during packaging, installation probes, or descriptor startup instead of being
silently adapted.

The plugin process is already the hard process boundary owned by CandleScope, so the
bridge executes Pyne in `inline` mode inside that sidecar. Host timeouts can terminate
and restart the sidecar without creating a nested Pyne worker process.

## Render coverage

Protocol v1 transports line series only. Pyne markers, horizontal lines, fills,
backgrounds, bar colors, signals, and stateful realtime sessions are not claimed as
compatible. When an execution produces unsupported output kinds, their names are
reported in `output.meta.unsupportedOutputKinds`; their data is not smuggled through
private fields.

This is why installing this package does not by itself switch CandleScope from the
legacy Pyne route. Shadow comparison and cutover are separate release gates.

## Development

From this directory:

```powershell
python -m pytest -q
python -m ruff check src tests scripts
python -m ruff format --check src tests scripts
python -m build
```

Use `scripts/build_bundle.py` with the four locked wheels to build a platform-specific
`.cspkg`. See [README_zh.md](README_zh.md) for the complete release flow.

From this directory, a Windows target can be assembled with:

```powershell
$wheelhouse = 'C:\release\candlescope-pyne\wheelhouse'
New-Item -ItemType Directory -Force $wheelhouse | Out-Null
python -m build --wheel --outdir $wheelhouse .
python -m build --wheel --outdir $wheelhouse ..\candlescope-plugin-sdk
Invoke-WebRequest `
  -Uri 'https://github.com/Ryan00956/pyne-runtime/releases/download/v0.2.0rc1/pyne_runtime-0.2.0rc1-py3-none-any.whl' `
  -OutFile "$wheelhouse\pyne_runtime-0.2.0rc1-py3-none-any.whl"
python -m pip download --only-binary=:all: --no-deps `
  --dest $wheelhouse numpy==2.3.3

$bridge = (Get-ChildItem "$wheelhouse\candlescope_plugin_pyne-0.1.0-*.whl").FullName
$sdk = (Get-ChildItem "$wheelhouse\candlescope_plugin_sdk-0.1.0-*.whl").FullName
$pyne = (Get-ChildItem "$wheelhouse\pyne_runtime-0.2.0rc1-*.whl").FullName
$numpy = (Get-ChildItem "$wheelhouse\numpy-2.3.3-*.whl").FullName
python scripts\build_bundle.py `
  --wheel $bridge --wheel $sdk --wheel $pyne --wheel $numpy `
  --output C:\release\candlescope-pyne\candlescope-pyne-0.1.0.cspkg `
  --json
```

Publish the builder-reported outer digest through the same trusted release as the
bundle. Consumers must pass that published digest to the generic installer; hashing
an untrusted local bundle on demand does not establish publisher identity. A changed
wheel or probe requires a new plugin version and must never overwrite an existing
release artifact.
