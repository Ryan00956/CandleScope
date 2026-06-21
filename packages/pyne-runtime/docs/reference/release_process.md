# Release Process

Pyne Runtime is currently pre-1.0. Releases should still be predictable for
host applications and script authors, especially around root imports, schema
contracts, CLI behavior, and packaged typing metadata.

## Version Policy

- Patch releases should not break public root imports, documented CLI commands,
  or existing schema contracts.
- Minor releases may add public APIs, script namespace helpers, schema fields,
  and provider capabilities.
- Any breaking change must include a version bump appropriate to the affected
  contract, a changelog entry, migration documentation, and focused tests.
- Schema contracts use independent schema versions. A package version bump does
  not replace `schemaVersion` checks in host applications.

## Release Checklist

Before cutting a release candidate:

1. Confirm `pyproject.toml` and [CHANGELOG.md](../../CHANGELOG.md) describe
   the intended release.
2. Run the full quality gate:

   ```bash
   scripts/check.ps1
   ```

   On POSIX shells:

   ```bash
   scripts/check.sh
   ```

   The check scripts use per-run subdirectories under the repository-local
   ignored `.pyne-check-tmp` directory for pytest and build artifacts. Set
   `PYNE_CHECK_TMP` to override that temporary root.
   They build with `python -m build --no-isolation`, so run the release gate
   from an environment that already has the project dev dependencies installed.
   The package smoke step runs in offline mode, reusing local site packages for
   dependencies while installing the built Pyne wheel itself.

3. Confirm the package smoke gate installs the built wheel and checks:
   - `pyne_runtime/py.typed` is present;
   - `python -m pyne_runtime --version` works;
   - `python -m pyne_runtime schema` prints the public schema bundle;
   - `python -m pyne_runtime validate` runs against a packaged example;
   - `python -m pyne_runtime run` writes a successful result payload.
4. Confirm public API changes are reflected in:
   - [Public API](../api/public_api.md);
   - [Pine-Like API Matrix](pine_like_api_matrix.md), when script behavior
     changes;
   - [Schema Migrations](schema_migrations.md), when host-facing schema
     contracts change.
5. Confirm no unrelated generated files or local artifacts are staged.

## Changelog Rules

Update [CHANGELOG.md](../../CHANGELOG.md) when a change affects any of these:

- public package-root imports;
- script-visible namespaces or helper behavior;
- CLI commands, flags, output shape, or exit codes;
- schema versions or schema fields;
- packaged examples or host integration fixtures;
- quality gates, build metadata, or release process.

Internal refactors with no public behavior change may be grouped, but should
still be mentioned when they affect maintenance or release risk.
