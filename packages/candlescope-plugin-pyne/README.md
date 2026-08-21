# CandleScope Pyne Runtime Plugin

`candlescope-plugin-pyne` is the public-protocol bridge between CandleScope and the
independently released `pyne-runtime` engine. It contains no CandleScope backend
imports and no copied Pyne source. CandleScope launches it in an isolated managed
virtual environment through `candlescope.script-runtime/1`.

## Source candidate compatibility

- Plugin: `candlescope-plugin-pyne==0.3.0.dev0`
- SDK: `candlescope-plugin-sdk==0.2.0`
- Engine: `pyne-runtime==0.3.0rc2`
- Python: `>=3.11,<3.14`
- Runtime ID: `candlescope.pyne`

The unpublished engine candidate is pinned by
`release/release-lock.candidate.json`; it contains no public URL and cannot be
mistaken for a released artifact. The immutable `release/release-lock.json`
continues to describe the published `0.2.0` bridge and `0.2.0rc1` engine. A
version mismatch fails during packaging, installation probes, or descriptor
startup instead of being silently adapted.

## Published development bundle

The first public development bundle is
[`candlescope-plugin-pyne-v0.2.0-dev.1`](https://github.com/helenananaa/CandleScope/releases/tag/candlescope-plugin-pyne-v0.2.0-dev.1):

- asset: `candlescope-pyne-0.2.0-cp312-win_amd64.cspkg`;
- target: Windows AMD64, CPython 3.12;
- size: `13,006,218` bytes;
- SHA-256: `a1812e0e2b43670e75858b5f57d59f71a403350360ea58bf2822efba7d34a216`.

The Python packages support a broader interpreter range, but that specific
bundle contains a CPython 3.12 NumPy wheel and must not be installed on another
ABI. CandleScope's first-party bootstrap pins all four fields above. Community
installations can use the same public `.cspkg` installer with their own trusted
release assets; the generic installer performs no network access.

The plugin process is already the hard process boundary owned by CandleScope, so the
bridge executes Pyne in `inline` mode inside that sidecar. Host timeouts can terminate
and restart the sidecar without creating a nested Pyne worker process.

## Render coverage

Version 0.2.0 maps the Pyne output-schema v1 surface through the negotiated
`render.histogram-series/1` and `render.structured-output/1` features: lines,
histograms, markers, horizontal lines, fills, backgrounds, bar colors, signals,
legacy labels, strategy reports, and drawing objects. The bridge uses only the SDK's
JSON-only `RenderCollections`; unknown collections fail closed and no Pyne Python
object or CandleScope-private transport crosses the boundary. Collections added
in output-schema v2 intentionally fail closed on this legacy Render v1 path.

The Phase 0 HTTP compute, range, and WebSocket goldens can now be rebuilt exactly by
the sidecar. True stateful realtime sessions remain outside protocol v1; the sidecar
path performs batch execution over confirmed bars.

## Additive session and data-broker contracts

Development builds export `candlescope.pyne-session/2` and
`candlescope.pyne-data-broker/1` for the separate Pyne workbench adapter. The
session service supports bounded TTL/LRU incremental sessions, preview and
committed bar events, reconnect snapshots, rolling retention, and explicit
close. The brokered batch flow never gives Pyne a CandleScope database or
network object: it returns exact symbol/timeframe/start/end requests and accepts
only correlated Host-supplied OHLCV pages.
V2 consumers can request native Pyne output without narrowing it through the
frozen Render v1 collections; the independent
[`candlescope-plugin-pyne-workbench`](../candlescope-plugin-pyne-workbench/README.md)
then performs the explicit chart-layer/2 projection.

The installed `candlescope.pyne` runtime keeps the frozen
`candlescope.script-runtime/1` `executeBatch` path. That v1 path remains
stateless and has neither session nor brokered-data authority, so hosts that do
not use the additive workbench protocols retain the existing behavior.

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
  -Uri 'https://github.com/helenananaa/pyne-runtime/releases/download/v0.2.0rc1/pyne_runtime-0.2.0rc1-py3-none-any.whl' `
  -OutFile "$wheelhouse\pyne_runtime-0.2.0rc1-py3-none-any.whl"
python -m pip download --only-binary=:all: --no-deps `
  --dest $wheelhouse numpy==2.3.3

$bridge = (Get-ChildItem "$wheelhouse\candlescope_plugin_pyne-0.2.0-*.whl").FullName
$sdk = (Get-ChildItem "$wheelhouse\candlescope_plugin_sdk-0.2.0-*.whl").FullName
$pyne = (Get-ChildItem "$wheelhouse\pyne_runtime-0.2.0rc1-*.whl").FullName
$numpy = (Get-ChildItem "$wheelhouse\numpy-2.3.3-*.whl").FullName
python scripts\build_bundle.py `
  --wheel $bridge --wheel $sdk --wheel $pyne --wheel $numpy `
  --output C:\release\candlescope-pyne\candlescope-pyne-0.2.0.cspkg `
  --json
```

Publish the builder-reported outer digest through the same trusted release as the
bundle. Consumers must pass that published digest to the generic installer; hashing
an untrusted local bundle on demand does not establish publisher identity. A changed
wheel or probe requires a new plugin version and must never overwrite an existing
release artifact.
