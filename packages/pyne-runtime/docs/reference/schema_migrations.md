# Schema Migrations

Pyne exposes host-facing contracts through `pn.schema()`. Each schema section
owns an independent `schemaVersion` so hosts can branch on the specific contract
they consume.

Current schema versions:

- `input`: `PYNE_INPUT_SCHEMA_VERSION`
- `output`: `PYNE_OUTPUT_SCHEMA_VERSION`
- `params`: `PYNE_PARAM_SCHEMA_VERSION`
- `requestProvider`: `PYNE_REQUEST_PROVIDER_SCHEMA_VERSION`
- `strategyReport`: `PYNE_STRATEGY_REPORT_SCHEMA_VERSION`

## Output Schema

`pn.schema()["output"]["migration"]` is the machine-readable migration policy
for host renderers.

Version 1 is the current output schema. It defines:

- top-level result metadata and error fields;
- structured renderer collections under `result.output`;
- drawing object snapshots under `output["objects"]`;
- incremental drawing object events under `output["object_events"]`;
- strategy reports under `output["strategy"]`, with details in
  `pn.schema()["strategyReport"]`.

There are no breaking changes recorded for output schema version 1.

Compatibility notes:

- `result.lines` remains a backward-compatible flat plot view.
- `output["labels"]` is a legacy simple text label collection.
- Hosts should prefer `output["objects"]["labels"]` for Pine-like drawing
  labels.

## Request Provider Schema

`pn.schema()["requestProvider"]["migration"]` is the machine-readable migration
policy for host-backed `request.*` integrations.

Version 8 is the current request provider schema. It adds
`request.security_lower_tf()` `ignore_invalid_timeframe` discovery metadata and
the `ignoredInvalidTimeframe` diagnostic status. It preserves version 7
`supportedApis`, version 6 `errorDetail.requestProviderRequest` for failed
request calls, version 5 `meta.requestDiagnostics` entries, and version 4
structured `errorCategories` for host-facing request diagnostics.

Compatibility notes:

- Hosts that only read `errors` can continue doing so.
- Hosts can read `supportedApis` to decide which request APIs to expose in UI,
  editor help, and provider capability checks.
- Hosts that display request integration failures should prefer
  `errorCategories`, which records stable error codes, whether `get_ohlcv` is
  called, `ignore_invalid_symbol` behavior, and identifying message fragments.
- Runtime request failures include the matching category as
  `errorDetail.requestProviderCategory`.
- Runtime request failures include failed `api/symbol/timeframe/start/end`
  coordinates as `errorDetail.requestProviderRequest`.
- Successful request calls append one entry to `meta.requestDiagnostics`; cache
  reuse is indicated by `cacheHit`.
- Valid empty provider results are successful requested contexts: they report
  `status="ok"`, `bars=0`, and can be reused from the request cache.
- `invalidSymbol` remains the only provider-side error class that can be
  intentionally converted into empty request output by `ignore_invalid_symbol`.
  Those ignored invalid-symbol results report `status="ignoredInvalidSymbol"`
  and are not cached.
- `request.security_lower_tf(..., ignore_invalid_timeframe=True)` can convert a
  recognized invalid non-lower requested timeframe into empty lower-timeframe
  groups before `get_ohlcv()` is called. Those results report
  `status="ignoredInvalidTimeframe"` and are not cached.

## Breaking Change Checklist

Any breaking change to a host-facing schema must include all of these in the
same change set:

- bump the affected `schemaVersion`;
- add a migration note to the affected schema's migration policy;
- update the reference documentation;
- update or add a contract test;
- update the host consumption fixture when renderer output changes.

For output schema changes, the packaged
`examples/host_output_contract.py` fixture should continue to represent the
renderer collections and drawing object groups hosts are expected to consume.
