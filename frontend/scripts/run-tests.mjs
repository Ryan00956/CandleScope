import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const SUITES = JSON.parse(fs.readFileSync(new URL("./test-suites.json", import.meta.url), "utf8"));
const PROFILES = ["dev", "check", "full", "integration", "profile"];
const slash = (value) => value.replaceAll("\\", "/");
const startsWithAny = (value, prefixes) => prefixes.some((prefix) => value.startsWith(prefix));

export function parseArgs(argv) {
  const options = { profile: "dev", areas: [], side: "both", workers: 4, list: false, changed: false, includeIntegration: false, packages: false };
  if (argv[0] && PROFILES.includes(argv[0])) options.profile = argv.shift();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--changed") options.changed = true;
    else if (arg === "--include-integration") options.includeIntegration = true;
    else if (arg === "--packages") options.packages = true;
    else if (arg === "--frontend" || arg === "--backend") {
      if (options.side !== "both") throw new Error("Choose only one of --frontend and --backend");
      options.side = arg.slice(2);
    } else if (["--workers", "--base", "--python", "--output"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = arg === "--workers" ? Number(value) : value;
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else options.areas.push(arg);
  }
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 32) throw new Error("--workers must be an integer from 1 to 32");
  for (const area of options.areas) if (!Object.hasOwn(SUITES.areas, area)) throw new Error(`Unknown area: ${area}. Available: ${Object.keys(SUITES.areas).join(", ")}`);
  if (options.base && !options.changed) throw new Error("--base requires --changed");
  if (options.changed && (options.profile !== "dev" || options.areas.length)) throw new Error("Use dev --changed without explicit areas");
  if (options.profile !== "dev" && options.areas.length) throw new Error("Area arguments belong to the dev profile");
  if (options.profile === "dev" && !options.changed && !options.areas.length && !options.help) throw new Error("Choose an area or --changed; use --help to list commands");
  if (options.profile === "profile") {
    if (options.side === "frontend") throw new Error("profile records the complete backend suite");
    options.side = "backend";
    options.workers = 1;
  }
  return options;
}

function walk(root, relative, predicate) {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === "node_modules") return [];
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) return walk(root, name, predicate);
    return entry.isFile() && predicate(name) ? [name] : [];
  });
}

export function inventory(root = REPO_ROOT) {
  return {
    backend: walk(root, "backend/tests", (name) => /\/test_[^/]+\.py$/.test(name)).sort(),
    frontend: [
      ...walk(root, "frontend/src", (name) => /\.test\.(?:ts|tsx)$/.test(name)),
      ...walk(root, "frontend/scripts", (name) => /^frontend\/scripts\/[^/]+\.test\.mjs$/.test(name)),
    ].sort(),
    desktop: walk(root, "frontend/desktop", (name) => /^frontend\/desktop\/[^/]+\.test\.mjs$/.test(name)).sort(),
  };
}

function matchesArea(file, area, side) {
  const relative = file.slice(side === "backend" ? "backend/tests/".length : "frontend/".length);
  return startsWithAny(relative, area[side]) || (side === "backend" && startsWithAny(path.posix.basename(relative), area.backend));
}

export function changedFiles(root = REPO_ROOT, base) {
  function git(args) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Cannot determine changes: ${result.error?.message || result.stderr}`);
    return result.stdout;
  }
  const ref = base ? git(["merge-base", base, "HEAD"]).trim() : "HEAD";
  return [...new Set([
    ...git(["diff", "--name-only", "-z", ref, "--"]).split("\0"),
    ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
  ].filter(Boolean).map(slash))];
}

export function selectTests(options, files, changes = []) {
  let complete = ["full", "profile"].includes(options.profile);
  let includeIntegration = complete || options.includeIntegration || options.profile === "integration";
  const areas = { backend: new Set(options.areas), frontend: new Set(options.areas) };
  const reasons = [];
  if (options.changed) {
    for (const file of changes) {
      if (startsWithAny(file, SUITES.fullSources)) {
        complete = true;
        reasons.push(`Shared input: ${file}; broaden to complete host tests`);
        continue;
      }
      const side = file.startsWith("backend/") ? "backend" : file.startsWith("frontend/") ? "frontend" : null;
      const sourceMatches = Object.entries(SUITES.areas).map(([name, area]) => [name, Math.max(0, ...area.sources.filter((prefix) => file.startsWith(prefix)).map((prefix) => prefix.length))]);
      const mostSpecific = Math.max(0, ...sourceMatches.map(([, length]) => length));
      const matched = mostSpecific
        ? sourceMatches.filter(([, length]) => length === mostSpecific)
        : Object.entries(SUITES.areas).filter(([, area]) => side && matchesArea(file, area, side));
      if (!side || matched.length === 0) {
        complete = true;
        reasons.push(`Unmapped input: ${file}; broaden to complete host tests`);
      } else {
        for (const [name] of matched) areas[side].add(name);
      }
      if (startsWithAny(file, SUITES.integrationSources) || Object.hasOwn(SUITES.integrationBackend, path.posix.basename(file))) includeIntegration = true;
    }
  }
  includeIntegration ||= complete;
  const all = complete || options.profile !== "dev";
  const selected = { backend: [], frontend: [], desktop: [], deferred: [], reasons, complete };
  for (const side of ["backend", "frontend"]) {
    if (options.side !== "both" && options.side !== side) continue;
    selected[side] = files[side].filter((file) => all || [...areas[side]].some((name) => matchesArea(file, SUITES.areas[name], side)));
  }
  if (options.profile === "integration") selected.frontend = [];
  selected.backend = selected.backend.filter((file) => {
    const heavy = Object.hasOwn(SUITES.integrationBackend, path.posix.basename(file));
    if (options.profile === "integration") return heavy;
    if (heavy && !includeIntegration) {
      selected.deferred.push(file);
      return false;
    }
    return true;
  });
  if (options.side !== "backend" && (complete || options.profile === "check")) selected.desktop = files.desktop;
  selected.parallelBackend = selected.backend.filter((file) => !Object.hasOwn(SUITES.serialBackend, path.posix.basename(file)));
  selected.serialBackend = selected.backend.filter((file) => Object.hasOwn(SUITES.serialBackend, path.posix.basename(file)));
  // An argument list over CreateProcess's Windows limit must broaden, never truncate.
  if (selected.frontend.join(" ").length > 22_000) {
    selected.frontend = files.frontend;
    reasons.push("Large frontend selection: run all frontend tests with discovery globs");
  }
  return selected;
}

export function pythonExecutable(root, explicit) {
  if (explicit) return /[/\\]/.test(explicit) ? path.resolve(explicit) : explicit;
  const suffix = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  for (const directory of [".venv", "backend/.venv"]) {
    const candidate = path.join(root, directory, suffix);
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.env.CANDLESCOPE_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

export function createSteps(options, selected, files, root, output) {
  const frontend = path.join(root, "frontend");
  const python = pythonExecutable(root, options.python);
  const steps = [];
  const node = (id, args) => steps.push({ id, command: process.execPath, args, cwd: frontend });
  const tsx = "node_modules/tsx/dist/cli.mjs";
  if (options.profile === "check" && options.side !== "backend") {
    node("architecture", ["scripts/check-architecture.mjs"]);
    node("plugin-contracts", ["scripts/check-plugin-platform.mjs"]);
    node("i18n", [tsx, "scripts/check-i18n.mts"]);
    node("typecheck-app", ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json"]);
    node("typecheck-tests", ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.node.json"]);
    node("lint", ["node_modules/eslint/bin/eslint.js", "."]);
  }
  if (selected.frontend.length) {
    const tests = selected.frontend.length === files.frontend.length
      ? ["scripts/*.test.mjs", "src/**/*.test.{ts,tsx}"]
      : selected.frontend.map((file) => file.slice("frontend/".length));
    node("frontend", [tsx, "--test", `--test-concurrency=${options.workers}`, ...tests]);
  }
  if (selected.desktop.length) node("desktop", ["--test", `--test-concurrency=${options.workers}`, "desktop/*.test.mjs"]);
  function backend(id, tests, workers) {
    if (!tests.length) return;
    const args = ["-u", "-m", "pytest", ...tests.map((file) => file.slice("backend/".length)), "-q", "--durations=30", `--junitxml=${path.join(output, `${id}.xml`)}`];
    if (workers > 1) args.push("-n", String(workers), "--dist=loadfile");
    steps.push({ id, command: python, args, cwd: path.join(root, "backend") });
  }
  if (options.workers === 1) backend("backend", selected.backend, 1);
  else {
    backend("backend-parallel", selected.parallelBackend, options.workers);
    backend("backend-serial", selected.serialBackend, 1);
  }
  if (options.packages) {
    for (const entry of fs.readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
      const directory = path.join(root, "packages", entry.name);
      if (entry.isDirectory() && fs.existsSync(path.join(directory, "pyproject.toml")) && fs.existsSync(path.join(directory, "tests"))) {
        steps.push({ id: entry.name, command: python, args: ["-u", "-m", "pytest", "tests", "-q", "--durations=10", `--junitxml=${path.join(output, `${entry.name}.xml`)}`], cwd: directory });
      }
    }
  }
  return steps;
}

export async function executeSteps(steps, output, { echo = true } = {}) {
  const results = [];
  for (const step of steps) {
    if (echo) process.stdout.write(`\n[${step.id}] ${step.command} ${step.args.join(" ")}\n`);
    const log = fs.openSync(path.join(output, `${step.id}.log`), "w");
    const started = performance.now();
    const result = await new Promise((resolve) => {
      const child = spawn(step.command, step.args, { cwd: step.cwd, windowsHide: true, stdio: ["inherit", "pipe", "pipe"] });
      for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
        stream.on("data", (chunk) => {
          fs.writeSync(log, chunk);
          if (echo) destination.write(chunk);
        });
      }
      child.on("error", (error) => resolve({ exitCode: 1, error: error.message }));
      child.on("close", (code, signal) => resolve({ exitCode: code ?? 1, signal }));
    });
    fs.closeSync(log);
    results.push({ ...step, ...result, durationMs: Math.round(performance.now() - started) });
    fs.writeFileSync(path.join(output, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  }
  return results;
}

function help() {
  process.stdout.write(`Usage: npm run test:dev -- <area> [--frontend | --backend] [--include-integration]\n` +
    `       npm run test:dev -- --changed [--base main] [--list]\n` +
    `       npm run test:check -- [--frontend | --backend]\n` +
    `       npm run test:full -- [--packages] [--workers 4]\n` +
    `       npm run test:integration\n` +
    `       npm run test:profile\n\n` +
    `Areas: ${Object.keys(SUITES.areas).join(", ")}\n` +
    `--list prints files without running them. --python selects the backend interpreter.\n` +
    `--output selects the evidence directory. Default: output/test-runs/<timestamp>-<pid>.\n` +
    `full covers all host tests; --packages also runs Python package suites in their own directories.\n` +
    `Release build/soak commands remain separate; this runner does not certify a release.\n`);
}

export async function main(argv) {
  const options = parseArgs([...argv]);
  if (options.help) { help(); return 0; }
  const root = fs.realpathSync(REPO_ROOT);
  const files = inventory(root);
  const changes = options.changed ? changedFiles(root, options.base) : [];
  if (options.changed && options.side !== "frontend" && changes.some((file) => file.startsWith("packages/"))) options.packages = true;
  const selected = selectTests(options, files, changes);
  const output = options.output ? path.resolve(options.output) : path.join(root, "output", "test-runs", `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
  const steps = createSteps(options, selected, files, root, output);
  for (const reason of selected.reasons) process.stdout.write(`${reason}\n`);
  process.stdout.write(`Scope: ${options.profile}; backend ${selected.backend.length}/${files.backend.length} files, frontend ${selected.frontend.length}/${files.frontend.length}, desktop ${selected.desktop.length}/${files.desktop.length}.\n`);
  if (options.packages) process.stdout.write(`Python package suites: ${steps.filter((step) => step.cwd.startsWith(path.join(root, "packages") + path.sep)).map((step) => step.id).join(", ")}\n`);
  if (selected.deferred.length) process.stdout.write(`Deferred integration files (${selected.deferred.length}):\n${selected.deferred.map((file) => `  ${file}: ${SUITES.integrationBackend[path.posix.basename(file)]}`).join("\n")}\nRun test:integration or add --include-integration to cover these.\n`);
  if (options.list) {
    process.stdout.write(`${[...selected.backend, ...selected.frontend, ...selected.desktop].join("\n")}\n`);
    return 0;
  }
  if (!steps.length) {
    process.stdout.write("No tests selected; no test result was produced. Choose an area or run test:check.\n");
    return options.changed && changes.length === 0 ? 0 : 2;
  }
  if (selected.parallelBackend.length && options.workers > 1) {
    const probe = spawnSync(pythonExecutable(root, options.python), ["-c", "import xdist"], { cwd: root, encoding: "utf8", windowsHide: true });
    if (probe.error || probe.status !== 0) throw new Error("pytest-xdist is unavailable in the selected Python. Install backend/requirements-test.txt, or use --workers 1.");
  }
  fs.mkdirSync(output, { recursive: true });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", windowsHide: true });
  fs.writeFileSync(path.join(output, "plan.json"), `${JSON.stringify({ head: head.stdout?.trim(), workingTreeStatus: status.stdout, nodeVersion: process.version, options, changes, selected, steps }, null, 2)}\n`);
  const results = await executeSteps(steps, output);
  for (const result of results) process.stdout.write(`${result.id}: exit=${result.exitCode}, ${(result.durationMs / 1000).toFixed(2)}s${result.error ? `, ${result.error}` : ""}\n`);
  process.stdout.write(`Evidence: ${output}\n`);
  return results.find((result) => result.exitCode !== 0)?.exitCode ?? 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
