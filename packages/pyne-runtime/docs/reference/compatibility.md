# Compatibility

Pyne Runtime is currently pre-1.0.

Compatibility goals:

- Patch versions should not break public root imports.
- Minor versions may add new public APIs.
- Breaking changes should be documented in `CHANGELOG.md`.
- `pn.__version__` follows the installed package version.

Stable root imports are documented in [Public API](../api/public_api.md).

The output schema has its own version: `PYNE_OUTPUT_SCHEMA_VERSION`.
