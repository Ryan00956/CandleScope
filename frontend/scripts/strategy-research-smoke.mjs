import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, "..");
const repoRoot = path.resolve(frontendRoot, "..");

export function runStrategyResearchSmoke(root = repoRoot) {
  const files = [
    "frontend/strategy.html",
    "frontend/local.html",
    "frontend/backtest.html",
    "frontend/src/strategy-main.tsx",
    "frontend/src/local-main.tsx",
    "frontend/src/backtest-main.tsx",
  ];
  for (const file of files) {
    if (!existsSync(path.join(root, file))) {
      throw new Error(`missing ${file}`);
    }
  }
  const topBar = readFileSync(path.join(root, "frontend/src/app/TopBar.tsx"), "utf8");
  if (!topBar.includes('href="/strategy.html"')) {
    throw new Error("TopBar must link /strategy.html");
  }
  if (topBar.includes('href="/backtest.html"')) {
    throw new Error("TopBar must not keep a sibling /backtest.html entry");
  }
  const backtestApp = readFileSync(path.join(root, "frontend/src/features/backtest/BacktestApp.tsx"), "utf8");
  if (!backtestApp.includes("BacktestResearchApp")) {
    throw new Error("BacktestApp must be a thin research bootstrap");
  }
  if (/setInterval\(/.test(backtestApp)) {
    throw new Error("BacktestApp must not poll Runs");
  }
  const flags = readFileSync(
    path.join(root, "frontend/src/features/research-data/researchDataFlags.ts"),
    "utf8",
  );
  if (!flags.includes('raw === true || raw === 1 || raw === "1"')) {
    throw new Error("library flag must default off");
  }
  const bootstrap = readFileSync(
    path.join(root, "frontend/src/features/strategy-research/strategyResearchBootstrap.tsx"),
    "utf8",
  );
  if (!bootstrap.includes('mode === "local-legacy"') || !bootstrap.includes("<LocalApp")) {
    throw new Error("flag-off must restore LocalApp compatibility shell");
  }
  const launch = readFileSync(
    path.join(root, "frontend/src/features/strategy-research/strategyResearchLaunch.ts"),
    "utf8",
  );
  if (!launch.includes('file === "local.html"') || !launch.includes('file === "backtest.html"')) {
    throw new Error("legacy URLs must parse");
  }
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  if (/Pine\/Pyne custom scripts are available in the LOCAL_OFFLINE/.test(readme)) {
    throw new Error("README must not claim unverified Pine/Pyne offline capability");
  }
  return {
    ok: true,
    canonical: "/strategy.html",
    compatibility: ["/local.html", "/backtest.html"],
    libraryFlagDefault: 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runStrategyResearchSmoke();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
