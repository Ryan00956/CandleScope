# `.cspkg` Runtime Plugin Installer

[简体中文](INSTALLER_zh.md)

Phase 3 provides a releaseable `.cspkg` format and a local management CLI. A
plugin author publishes one deterministic bundle. CandleScope gives each
bundle its own virtual environment and only atomically activates it after the
typed runtime probe passes.

Existing Indicator/Pyne routes remain on the legacy path. A successful install
means the generic Host can launch the plugin; production routing moves in
Phase 4.

## Release workflow

1. Implement `BaseRuntimePlugin` using only the public
   `candlescope-plugin-sdk` contract.
2. Build wheels for the plugin and every runtime dependency. Do not ship
   sdists, source directories, or dependencies that require online resolution.
3. Write a manifest template. Wheel `sha256` and `size` fields may be omitted.
4. Build the deterministic `.cspkg`.
5. Run `inspect` and publish its outer SHA-256 through a trusted release
   channel alongside the bundle.
6. Install the local artifact with that expected digest, then restart
   CandleScope so the Host reads the new registry.

The repository includes a Hello template at
`packages/candlescope-plugin-sdk/examples/hello-runtime.manifest.json`.

```powershell
cd backend

python scripts/candlescope_plugin.py build `
  --manifest ..\packages\candlescope-plugin-sdk\examples\hello-runtime.manifest.json `
  --wheel C:\release\candlescope_plugin_sdk-0.1.0-py3-none-any.whl `
  --output C:\release\hello-runtime-0.1.0.cspkg

python scripts/candlescope_plugin.py inspect C:\release\hello-runtime-0.1.0.cspkg

python scripts/candlescope_plugin.py install `
  C:\release\hello-runtime-0.1.0.cspkg `
  --sha256 sha256:<64-hex digest from inspect>

python scripts/candlescope_plugin.py check hello-runtime
python scripts/candlescope_plugin.py list
python scripts/candlescope_plugin.py rollback hello-runtime
```

All commands support the global `--json` flag. Use `--root <dir>` for a
portable/test root and `--registry <file>` for an explicit registry whose
parent becomes the managed root. If both are supplied, they must name the same
directory so every registry writer shares one lock. Install is enabled and
lazy-started by default. `--auto-start` starts the runtime during the next
application startup; `--required` must be paired with it.

The installer accepts local artifacts only. A release lock, downloader, or
marketplace must first materialize a digest-pinned file and then call this same
installation path.

## Manifest v1

The complete schema and a worked JSON example are in the
[Chinese reference](INSTALLER_zh.md#manifest-schema-v1) and the repository Hello
template. The contract requires:

- exact plugin ID, package, version, protocol, Python range, and `python -m`
  module;
- one primary plugin wheel plus every dependency wheel;
- a deterministic analyze/execute probe with canonical result SHA-256 values;
- no unknown fields or undeclared archive entries.

The builder audits each wheel's `METADATA`, `WHEEL`, and `RECORD`, fills its
actual size and digest, and writes a deterministic archive. Verification
rejects duplicate JSON keys, case-conflicting or unsafe paths, symlinks,
encrypted entries, extra files, size violations, and metadata drift.
The outer `.cspkg` never permits directory entries. A nested standards-compliant
wheel may contain canonical zero-byte directory entries, as official binary
wheels such as NumPy commonly do; all path, conflict, symlink, encryption, and
uncompressed-size checks still apply.

The module must launch as:

```text
<plugin-venv-python> -I -u -m your_plugin.sidecar
```

Installation is strictly offline and wheel-only:

```text
pip --isolated install --no-index --no-deps --only-binary=:all: <bundled wheels...>
pip --isolated check
```

The probe must be small and independent of network, wall clock, randomness, or
machine state. Hash `AnalyzeResult.to_wire()` and
`ExecuteBatchResult.to_wire()` as UTF-8 JSON with sorted keys, compact
separators, and no NaN/Infinity.

## Transaction and rollback model

The default root is `%LOCALAPPDATA%/CandleScope/plugins` on Windows and
`$XDG_DATA_HOME/candlescope/plugins` (or
`~/.local/share/candlescope/plugins`) on Linux.

Each immutable installation lives at
`installs/<runtime-id>/<full-bundle-sha256>/`. Under one cross-process lock, the
installer verifies the bundle, creates a staging venv, installs and checks all
distributions, runs the Host protocol probe, and renames the staging directory
into place. It records activation history before atomically replacing
`runtime-registry.json`; that registry replacement is the sole activation
commit point.

Reinstalling the same bundle with the same policy rechecks and reuses the
environment without creating another activation. An upgrade retains the old
installation. Rollback verifies the exact previous target and changes only
that runtime's registry entry, preserving every unrelated plugin. It never
deletes installations.

Bundle, wheel, pip, descriptor, or result-probe failure leaves the registry
unchanged. Install and rollback report `restartRequired=true`; v1 does not hot
reload a running application.

## Trust boundary

- The outer SHA-256 proves equality to caller-pinned bytes, not publisher
  identity. Obtain it from a trusted release or lock file.
- The runtime probe executes plugin code after wheel installation. Install
  trusted plugins only.
- Per-plugin venvs and sidecars are dependency, protocol, and failure
  boundaries, not hostile-code sandboxes.
- v1 does not provide signatures, transparency logs, permission declarations,
  network isolation, secrets, or arbitrary frontend code.
- Old installs and quarantine are not automatically deleted; a future explicit
  GC must preserve rollback reachability.
