# Script Runtime

`PyneRuntime` executes scripts in five steps:

1. Validate security policy.
2. Build an OHLCV context.
3. Create runtime services for the current execution.
4. Build the script namespace from registered installers.
5. Execute the script and collect outputs into `PyneResult`.

Most users should call `pn.run()`. Host applications can use `PyneRuntime`
directly when they need tighter control over settings or executor choice.

## Namespace Registry

Batch execution builds its script globals through `pyne_runtime.namespace`.
`RuntimeServices` owns the per-run objects that must share the same context,
including `TaModule`, `InputModule`, `OutputCollector`, `StrategyModule`, and
runtime state cells. `build_script_namespace()` then applies small installers
for data fields, Pine-like API namespaces, plot/drawing helpers, utility
functions, compatibility names, and policy-controlled builtins.

This keeps `runtime.py` focused on execution flow:

- choose batch or incremental execution
- validate security policy and input limits
- build the OHLCV context
- call the namespace builder
- execute the script under timeout and output limits
- convert collector state into `PyneResult`

New top-level script names should be added through a namespace installer in
`namespace.py`, not by expanding `PyneRuntime.execute()`.

## Incremental Dispatch

Scripts that define incremental callbacks are detected before batch namespace
construction. `PyneRuntime` delegates those scripts to `PyneIncrementalSession`
and converts `IncrementalPyneResult` back into the normal `PyneResult` shape.
This keeps the public runtime entry point stable while allowing batch and
incremental execution to keep different internal lifecycles.

