# Development tests

Run the commands below from `frontend`. The runner resolves the physical checkout
path and prefers the repository's `.venv`, followed by `backend/.venv`. Override
the Python interpreter with `--python <executable>` when needed.

Install the backend test dependencies once with the project Python. Run pip from
`backend` so the existing editable SDK path resolves correctly:

```powershell
# Start at the repository root on Windows, using this checkout's root .venv:
cd backend
& ..\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
cd ../frontend
```

If you followed the README quick start, use
`.\.venv\Scripts\python.exe` in the pip command instead; the runner also discovers that environment.
On other platforms use the project Python with the same requirements file.
This adds pytest-xdist for bounded parallel runs; `--workers 1` also works without it.

## Choose the scope

| Command | Scope |
| --- | --- |
| `npm run test:dev -- manual-history` | Related backend and frontend tests for history downloads |
| `npm run test:dev -- drawings --frontend` | Drawing/export frontend tests |
| `npm run test:dev -- plugins --backend` | Plugin backend tests, with the listed expensive integration files deferred |
| `npm run test:dev -- plugins --include-integration` | Plugin tests including real installations and builds |
| `npm run test:check` | All fast host tests, desktop tests, and frontend architecture/plugin/i18n/type/lint checks |
| `npm run test:integration` | All explicitly separated backend installation/build/sandbox and capacity files |
| `npm run test:full` | All backend, frontend and desktop host tests, including integration |
| `npm run test:full -- --packages` | Also run each Python package's tests from its own directory |
| `npm run test:profile` | Complete serial backend run with per-test timing and JUnit evidence |
| `npm test` | Complete frontend suite, with four file processes |
| `npm run test:serial` | Same frontend suite, with one process for diagnosis |

The existing frontend `npm run check` retains its complete static checks, tests,
desktop tests and production build. `test:full` describes **test coverage**;
production builds, release verifiers and formal performance/soak commands retain
their existing separate entrypoints and requirements. A fast pass is not a full
regression or release result.

Add `--frontend` or `--backend` to restrict a runner command to one side. The
`--packages` option requires each package's test/runtime dependencies, including
the external Pyne runtime where its tests require it; missing dependencies remain
failures. Package runs are serial and use their own pytest configuration.

Use `npm run test:dev -- --help` for the area list and options. `--workers N`
sets the process limit; the default is four. Real reproducible builds that reserve
`Q:` and Windows CPU/memory sandbox tests run in a separate serial batch.

## Inspect or select changes

```bash
npm run test:dev -- manual-history --list
npm run test:dev -- --changed --list
npm run test:dev -- --changed
npm run test:dev -- --changed --base main
```

Without `--base`, changed selection includes staged, unstaged, deleted and
untracked files relative to HEAD. With `--base`, it includes changes since the
merge base plus current working-tree changes. Invalid references fail explicitly.

The mapping is in `frontend/scripts/test-suites.json`. Specific source prefixes
take precedence over broad directories. Frontend-only mapped changes select
frontend tests. Installer/runtime changes automatically include plugin integration
coverage. Shared configuration, SDKs and unmapped inputs broaden to complete host
tests; package changes additionally enable Python package suites unless the user
explicitly requested frontend-only coverage. Use `--list` to see the exact scope.

The one-million-bar reference run is a separate integration file. Fast backtest
tests retain the two-thousand-bar determinism check, cancellation and contracts.
Changes to the Python scale runner/provider or simulation kernel include capacity
integration automatically. The complete `pytest tests` and `test:full` still run
the full million bars, with all original assertions unchanged.

This is a conservative, maintained module map, not a complete dependency graph.
For cross-module behavior use multiple explicit areas, or run `test:check` and
`test:full`. Explicit areas are a developer selection, not evidence that other
modules cannot be affected.

## Evidence and coverage

Each run writes `plan.json`, per-step logs, backend JUnit files and `results.json`
under `output/test-runs/<timestamp>-<pid>`. The plan includes Git HEAD, working-tree
status, selected/deferred files and commands. Results retain each exit code and
elapsed time. Independent batches continue after failures, and the runner exits
nonzero if any batch fails. `--output <directory>` chooses another evidence folder.

Full discovery follows the existing host patterns: backend `tests/**/test_*.py`,
frontend `scripts/*.test.mjs` and `src/**/*.test.{ts,tsx}`, desktop
`desktop/*.test.mjs`. New files matching these patterns enter full runs
automatically. Fast backend and integration files form a disjoint partition of
the full backend file set, checked by runner tests. Installation identity's static
test moved from `test_plugin_installer_v2.py` to `test_plugin_activation_static.py`;
its identity assertions remain, with an additional missing-launcher assertion.
The million-bar case moved from `test_python_million_bar.py` to
`test_python_million_bar_reference.py`; only its scheduling changed.
The symbol-catalog startup-order test now restores its application state and
isolates unrelated plugin/alert initialization. Its previous monitor leaked into
later diagnostic tests when parallel scheduling changed file order.

Classify expensive files by observed work, not by a `performance` name or use of a
temporary database. Keep mutable registry/database/runtime state per test. Tests
that exercise installation, process isolation or recovery must retain real
environment coverage. Session fixtures are per worker under xdist; changing their
scope does not create a cross-worker cache.

The initial audit is in local `output/test-speed-audit-20260902/analysis.zh.md`.
It measured frontend serial/4-process runs at 255/52 seconds with identical test
results; this was one comparison with cache and background-load differences,
not a guaranteed speedup. New timings should be taken from each run's evidence.

## Local validation on 2026-09-02

| Scope | Passed | Observed time |
| --- | ---: | ---: |
| Original complete serial backend baseline | 4092 | 43m 56s in pytest |
| Final fast backend, four workers | 3938 | 2m 26s including process exit |
| Complete frontend tests, four workers | 3535 | 58s |
| Frontend static checks, tests and desktop combined | 3535 + 35 | 4m 21s |
| `test:dev -- manual-history`, installed project environment | 12 frontend + 66 backend | About 9s |

The other 154 backend cases remain in 22 integration files. The million-bar case
alone took 15m 54s in the serial baseline. These are different scopes; the fast
time does not describe a complete regression. Cache and background load varied.

Per-case reconciliation accounts for all 4092 backend cases exactly once using
the final fast run, 45 subsequently classified integration cases from the earlier
parallel run, 108 installation/sandbox cases from explicit parallel/serial batches,
and the unchanged million-bar case from the serial baseline. A new `test:full`
invocation was not repeated end to end. No failures or skips remain in that
reconciled coverage. Logs, JUnit, the intermediate order-dependency failure and
its successful repair checks are retained under local
`output/test-speed-implementation-20260902/`; `implementation-results.json`
records the scope and timing details.
