# CandleScope Plugin SDK

[简体中文](README_zh.md)

`candlescope-plugin-sdk` is the dependency-free Python contract for building
CandleScope sidecar plugins. It now exposes two isolated public namespaces:

- the frozen top-level `candlescope.script-runtime/1` API for script/indicator
  runtimes;
- the additive `candlescope_plugin_sdk.platform_v2` API for general plugin
  manifests, contributions, permissions, lifecycle, cancellation, and bounded
  bidirectional Host calls.

Both use UTF-8 JSON-RPC 2.0 over newline-delimited stdin/stdout. Process
separation remains a dependency/transport boundary, not a complete OS sandbox.

The v1 protocol identifier is:

```text
candlescope.script-runtime/1
```

The general platform identifiers are `candlescope.plugin/2` and
`candlescope.host-api/1`. See
[`docs/protocol-v2.md`](docs/protocol-v2.md) and the packaged
[`Hello Command`](examples/platform-v2/hello-command.manifest.json) and
[`Scheduled Notification`](examples/platform-v2/scheduled-notification.manifest.json), plus the
packaged `platform_v2.examples.market_scanner` reference plugin. CandleScope
Phases 2–6 now provide the production Host, Installer,
permission/sandbox controls, and an opt-in core product composition root. The
SDK itself grants no Host capability; effective scopes and trust policy remain
owned by the installation target.

## What v1 freezes

- Required lifecycle methods: `handshake`, `describe`, `analyze`,
  `executeBatch`, and `shutdown`.
- Explicit feature negotiation before any runtime work.
- Typed chart context and OHLCV batch input.
- Structured diagnostics for source/runtime failures.
- CandleScope-owned `candlescope.render/1` output. Line series are the base;
  negotiated histogram and structured render collections are additive.
- Protocol-only stdout: plugins must send logs to stderr.

Realtime sessions, host data callbacks, secrets, trading actions, arbitrary
frontend JavaScript, and marketplace packaging are intentionally outside v1.
Process separation is a transport and dependency boundary, not a complete
security sandbox; the CandleScope Host remains responsible for resource
limits, process termination, permissions, and trust policy.

Plugins that need markers, horizontal lines, fills, backgrounds, bar colors,
signals, strategy reports, or drawing objects use the public
`render.structured-output/1` feature and `RenderCollections`. The collection
names and JSON-only validation belong to the SDK, so community runtimes do not
need a CandleScope-private serializer. See
[`docs/protocol-v1.md`](docs/protocol-v1.md) for the complete list.

## Minimal runtime

```python
from candlescope_plugin_sdk import (
    AnalyzeResult,
    BaseRuntimePlugin,
    ExecuteBatchResult,
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    FEATURE_SOURCE_ANALYSIS_V1,
    LanguageDescriptor,
    LinePoint,
    LineSeries,
    RenderOutput,
    RuntimeDescriptor,
    serve_runtime,
)


class MyRuntime(BaseRuntimePlugin):
    def describe(self) -> RuntimeDescriptor:
        return RuntimeDescriptor(
            id="my-runtime",
            name="My Runtime",
            version="0.1.0",
            package="candlescope-plugin-my-runtime",
            languages=(LanguageDescriptor(id="my", name="My Script"),),
            features=(
                FEATURE_SOURCE_ANALYSIS_V1,
                FEATURE_BATCH_EXECUTION_V1,
                FEATURE_RENDER_LINE_SERIES_V1,
            ),
            required_host_features=(
                FEATURE_BATCH_EXECUTION_V1,
                FEATURE_RENDER_LINE_SERIES_V1,
            ),
        )

    def analyze(self, request):
        return AnalyzeResult(ok=True, executable=True)

    def execute_batch(self, request):
        points = tuple(LinePoint(bar.time, bar.close) for bar in request.bars)
        return ExecuteBatchResult(
            ok=True,
            output=RenderOutput(
                series=(LineSeries(id="close", title="Close", points=points),)
            ),
        )


if __name__ == "__main__":
    raise SystemExit(serve_runtime(MyRuntime()))
```

The installed package also includes a working `candlescope-hello-runtime`
command. It accepts the tiny source `plot(close)` and returns one line series.

The frontend discovers languages from the runtime descriptor; it does not use
a closed runtime-ID union. A plugin may optionally advertise safe editor hints
under `RuntimeDescriptor.meta.ui.languages.<language-id>`:

```python
meta={
    "ui": {
        "languages": {
            "my": {
                "monacoLanguage": "plaintext",
                "starterSource": "plot(close)\n",
            }
        }
    }
}
```

These fields select a built-in Monaco grammar and initial text only. Plugins
cannot inject frontend JavaScript, components, themes, or network resources;
unknown or missing hints safely fall back to a plain-text editor.

See [docs/protocol-v1.md](docs/protocol-v1.md) for the wire contract.

## Package for CandleScope

Phase 3 does not require community authors to maintain a private CandleScope
adapter. Build wheels for the plugin and every runtime dependency, copy and
edit
[`examples/hello-runtime.manifest.json`](examples/hello-runtime.manifest.json),
then use CandleScope's `scripts/candlescope_plugin.py build` command to create a
`.cspkg`. The installer creates one isolated venv per bundle, installs wheels
offline, and validates the descriptor plus deterministic analyze/execute
results from the manifest probe.

See
[`backend/app/plugin_runtime/INSTALLER.md`](../../backend/app/plugin_runtime/INSTALLER.md)
for the format, SHA-256 release workflow, install, and rollback model. Plugins
must not import `app.*` or depend on a CandleScope source snapshot; integration
stays on the public SDK protocol and Render IR.

General `candlescope.plugin/2` plugins use the explicit v2 package namespace.
Prepare a directory containing `manifest.json`, `wheels/`, `probes/`, and
`sbom/cyclonedx.json`, then run:

```powershell
python backend\scripts\candlescope_plugin.py v2 --json build `
  C:\path\to\plugin-source C:\path\to\plugin.cspkg
python backend\scripts\candlescope_plugin.py v2 --json inspect `
  C:\path\to\plugin.cspkg
```

The v2 parser never guesses a migration from a v1 bundle. See the
[`Plugin Platform v2 Phase 3 record`](../../docs/PLUGIN_PLATFORM_V2_PHASE3_zh.md)
for the layout, pinned SHA-256, staged state, installation, and rollback
contracts.

The installed wheel also exposes:

```powershell
candlescope-hello-command
candlescope-scheduled-notification
candlescope-market-scanner
candlescope-integration-gateway
candlescope-mock-exchange-provider
candlescope-paper-broker
```

The latter declares `notification/1` plus `job/1` and completes a no-UI
scheduled notification through the `notifications.show` Host call. It only
demonstrates Phase 5 capabilities. `candlescope-market-scanner` demonstrates
Phase 6 chained Host calls, scoped live symbol/bar reads, private document
storage, and a marker-only `candlescope.render/1` chart layer. Plugins still
cannot access `DataManager` or replay data through a live handle.
`candlescope-integration-gateway` demonstrates Phase 9 credential-free,
Host-mediated HTTPS, one-shot user-selected file handles, and a loopback-only
namespaced HTTP endpoint. `candlescope-mock-exchange-provider` demonstrates the
paired Phase 10 `symbol-provider/1` and `market-data-provider/1` contributions,
bounded history plus `candlescope.stream/1` Kline/full-depth sessions. Provider
output always returns to the Host-owned ingestion and storage path. These
contracts do not grant direct network or filesystem access, secrets, accounts,
or trading APIs. `candlescope-paper-broker` is the Phase 11A reference for paired
`account-provider/1` and `order-executor/1` contributions. It exchanges strict
Paper intents and acknowledgements only; the Host owns balances, positions,
quotes, fills, risk, idempotency, audit, and the global kill switch. Live
credentials, `trade.submit`, `trade.cancel`, and plugin network access remain
unavailable.

## Development checks

```powershell
python -m ruff check .
python -m ruff format --check .
python -m pytest -q
python -m build
python scripts/package_smoke.py --dist-dir dist
```

`package_smoke.py` installs the wheel into a fresh offline venv, replays both
the frozen v1 Hello Runtime transcript and the v2 Hello Command transcript, and
checks that the Scheduled Notification, Market Scanner, Integration Gateway, and
Mock Exchange Provider modules, manifest resources, and console entry points were packaged. Run it once
with Python 3.12 and once with Python 3.13 before promoting a release.

Use `python -m build --no-isolation` only when the selected interpreter already
has the declared build backend installed.
