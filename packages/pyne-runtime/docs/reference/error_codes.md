# Error Codes

Pyne errors use stable `code` values and structured `errorDetail` payloads.

## PYNE_SYNTAX_ERROR

The script is not valid Python/Pyne syntax.

## PYNE_RUNTIME_ERROR

The script raised an exception while running.

## PYNE_IMPORT_BLOCKED

The selected security mode blocked an import.

## PYNE_TIMEOUT

The script exceeded its configured timeout.

## PYNE_OUTPUT_LIMIT_EXCEEDED

The script emitted too many output series or points.

## PYNE_INVALID_OHLCV

The input data is empty or does not satisfy the OHLCV contract.

## PYNE_INVALID_PARAM

The provided parameter values are invalid.

## PYNE_LENGTH_MISMATCH

Custom output arrays do not align with the OHLCV input length.

## PYNE_UNSUPPORTED_FEATURE

The script requested a feature not supported by this runtime.

## PYNE_PROCESS_FAILED

The process executor failed or exited unexpectedly.

## PYNE_SECURITY_ERROR

The selected security policy rejected the script.

