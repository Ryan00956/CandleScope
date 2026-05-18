# Script Runtime

`PyneRuntime` executes scripts in five steps:

1. Validate security policy.
2. Build an OHLCV context.
3. Inject helper namespaces: `ta`, `input`, `plot`, `color`, `math`, and utility functions.
4. Execute the script.
5. Collect outputs into `PyneResult`.

Most users should call `pn.run()`. Host applications can use `PyneRuntime` directly when they need tighter control over settings or executor choice.

