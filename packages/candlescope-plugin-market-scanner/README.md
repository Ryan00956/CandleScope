# CandleScope Market Scanner plugin

This package turns the SDK's audited read-only Market Scanner reference into an
installable first-party Plugin Platform v2 sidecar.

It can only read Host-brokered public symbol and bar data inside the scopes in
`manifest.json`. Results are written to plugin-private storage and optionally
published as bounded chart markers. It has no account, credential, arbitrary
filesystem, subprocess, or live-trading permission.

The manifest owns its English defaults and `zh-CN` contribution localizations,
including localized enum labels. Invocation locale is delivered through
`requestContext.locale`; validation failures produced by this package follow
that locale.

```powershell
python -m pip install -e .\packages\candlescope-plugin-sdk
python -m pip install -e .\packages\candlescope-plugin-market-scanner
candlescope-market-scanner
```

For development:

```powershell
python -m pytest .\packages\candlescope-plugin-market-scanner\tests -q
python -m build .\packages\candlescope-plugin-market-scanner
```
