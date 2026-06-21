# Error Codes

Pyne errors use stable `code` values and structured `errorDetail` payloads.
When a failure comes from a host-backed `request.*` provider,
`errorDetail.requestProviderCategory` identifies the matching
`pn.schema()["requestProvider"]["errorCategories"]` entry, and
`errorDetail.requestProviderRequest` identifies the failed
`api/symbol/timeframe/start/end` request.

## PYNE_SYNTAX_ERROR

The script is not valid Python/Pyne syntax.

## PYNE_RUNTIME_ERROR

The script raised an exception while running, or a host request provider
callback such as `get_ohlcv()`, `capabilities()`, or request metadata failed.

## PYNE_IMPORT_BLOCKED

The selected security mode blocked an import.

## PYNE_TIMEOUT

The script exceeded its configured timeout.

## PYNE_OUTPUT_LIMIT_EXCEEDED

The script emitted too many output series or points.

## PYNE_INVALID_OHLCV

The input data is empty or does not satisfy the OHLCV contract.

## PYNE_INVALID_SYMBOL

The host data provider reported an invalid requested symbol. Use a supported
symbol or pass `ignore_invalid_symbol=True` when missing symbols are expected.

## PYNE_INVALID_PARAM

The provided parameter values are invalid. This is returned when an `input.*`
override has the wrong type, falls outside declared numeric bounds, is not in
declared `options`, names an unknown source, or passes an invalid timestamp.

## PYNE_MIGRATION_HINT

`pyne validate` found a syntactically valid Python expression that commonly
comes from Pine syntax but does not preserve Pine-like semantics in Python.
Follow the diagnostic hint or the Pine-to-Pyne cookbook.

## PYNE_LENGTH_MISMATCH

Custom output arrays do not align with the OHLCV input length.

## PYNE_UNSUPPORTED_FEATURE

The script requested a feature not supported by this runtime.
This is also returned when `request.security()` is used without a configured
host data provider.

## PYNE_PROCESS_FAILED

The process executor failed or exited unexpectedly.

## PYNE_SECURITY_ERROR

The selected security policy rejected the script.

