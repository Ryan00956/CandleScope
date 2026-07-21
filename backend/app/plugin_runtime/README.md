# Script Runtime Plugin Host

[简体中文](README_zh.md)

`app.plugin_runtime` is CandleScope's generic script-runtime sidecar host. It
depends only on the public `candlescope-plugin-sdk` protocol models. It imports
neither Pyne nor Pine Compatibility and does not participate in current
Indicator routing.

Phases 2 and 3 own:

- a strict, versioned runtime activation registry;
- direct absolute executable plus argv launch, never a shell;
- `handshake` and `describe` verification of runtime ID, package, version, and
  feature negotiation;
- serialized JSON-RPC with message, stderr, startup, request, and shutdown
  bounds;
- session disposal after timeout, crash, stdout contamination, or protocol
  failure;
- lazy restart within a bounded attempt window, followed by an open circuit;
- FastAPI lifecycle ownership and a summary-only `/health` projection.
- strict deterministic `.cspkg` and caller-pinned outer SHA-256 verification;
- one isolated, offline wheel-only environment per bundle;
- atomic activation and a per-runtime rollback chain after descriptor and
  deterministic result probes pass.

Existing `/api/v1/indicators/*` and WebSocket paths still use legacy Pyne.
`legacy/shadow/sidecar` routing belongs to Phase 4, so enabling this host alone
does not change indicator results.

## Activation registry v1

The default registry is stored under user data:

- Windows: `%LOCALAPPDATA%/CandleScope/plugins/runtime-registry.json`;
- Linux: `$XDG_DATA_HOME/candlescope/plugins/runtime-registry.json`, falling
  back to `~/.local/share/candlescope/plugins/runtime-registry.json`.

A missing default path means zero plugins. Once
`CANDLESCOPE_RUNTIME_REGISTRY` is explicitly set, a missing or malformed file
fails closed.

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "hello-runtime",
      "package": "candlescope-plugin-sdk",
      "version": "0.1.0",
      "enabled": true,
      "autoStart": true,
      "required": false,
      "launch": {
        "executable": "C:/absolute/plugin-venv/Scripts/python.exe",
        "args": [
          "-I",
          "-u",
          "-m",
          "candlescope_plugin_sdk.examples.hello_runtime"
        ],
        "workingDirectory": "C:/absolute/plugin-venv"
      },
      "timeouts": {
        "startupSeconds": 5,
        "requestSeconds": 30,
        "shutdownSeconds": 2
      },
      "limits": {
        "maxMessageBytes": 16777216,
        "maxStderrBytes": 65536
      },
      "restart": {
        "maxAttempts": 3,
        "windowSeconds": 60
      }
    }
  ]
}
```

This registry is resolved activation state, not a download manifest. The Phase
3 `.cspkg` installer verifies a caller-pinned hash, creates an isolated
environment, and writes this file atomically. The host never downloads or
guesses an entry point. Hand-written registries remain useful for local
development, but unmanaged entries cannot use the installer's exact
`check`/`rollback` operations.

Installer-created entries also carry `managed.installationId`,
`managed.activationId`, and `managed.bundleSha256`, binding activation state to
an immutable install and exact history record. Manual entries omit them.

`required=true` also requires `autoStart`. A required startup failure aborts
application startup. An optional failure remains diagnosable and marks the
plugin summary as `degraded`.

## Run, install, and roll back

The normal backend dependency install also installs the repository SDK:

```powershell
cd backend
python -m pip install -r requirements.txt
```

Inspect, install, check, and roll back one runtime:

```powershell
python scripts/candlescope_plugin.py inspect C:\release\runtime.cspkg
python scripts/candlescope_plugin.py install C:\release\runtime.cspkg `
  --sha256 sha256:<trusted release digest>
python scripts/candlescope_plugin.py check <runtime-id>
python scripts/candlescope_plugin.py rollback <runtime-id>
```

See [`INSTALLER.md`](INSTALLER.md) for the manifest, release workflow, and
atomic transaction model. Restart the app after a successful install or
rollback; Phase 3 does not hot reload the registry.

Select a development registry:

```powershell
$env:CANDLESCOPE_RUNTIME_REGISTRY = "C:\absolute\runtime-registry.json"
python -m uvicorn app.main:app --host 127.0.0.1 --port 18080
```

Emergency-disable the entire host without reading the registry or launching a
sidecar:

```powershell
$env:CANDLESCOPE_PLUGIN_HOST_ENABLED = "0"
```

`GET /health` returns only `status/configured/enabled/ready/failed`; it never
exposes commands, the registry path, or stderr. Internal
`RuntimeHostService.diagnostics()` provides full diagnostics and excludes
stderr unless explicitly requested.

## Security boundary

- Plugins inherit a small allowlist of OS, temporary-directory, locale,
  certificate, and PATH variables. Arbitrary application API keys and custom
  environment variables do not cross the boundary.
- stdout is JSON-RPC only; logs are kept in a bounded stderr tail.
- POSIX termination targets a dedicated process group. Windows currently
  guarantees termination of the primary sidecar, not a malicious descendant
  tree.
- v1 provides no secrets, network permission declaration, trading action, or
  host filesystem capability.
- A sidecar and isolated environment are dependency and fault boundaries, not
  a hostile-code sandbox. Activate trusted packages only.
- Phase 3 verifies caller-pinned SHA-256 and wheel contents, but a digest does
  not authenticate a publisher. v1 has no signatures, transparency log, or OS
  permission sandbox.

## Focused gate

```powershell
cd backend
$env:PYTHONPATH = (Resolve-Path '..\packages\candlescope-plugin-sdk\src').Path
python -m pytest -q `
  tests/test_plugin_runtime_*.py `
  tests/test_plugin_bundle.py `
  tests/test_plugin_installer.py
```

The suite covers bundle path and metadata negatives, isolated environments,
idempotent install, probe failure, upgrade, and per-runtime rollback. Host
coverage still includes a real Hello session plus crash, timeout, duplicate
keys, wrong IDs, invalid JSON, message/stderr limits, environment isolation,
restart circuits, and application lifecycle cases.
