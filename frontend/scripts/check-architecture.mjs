import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(projectRoot, "src");

const SOURCE_EXTENSIONS = new Set([".js", ".jsx"]);

const RULES = {
  componentNoServiceImport: "component-no-service-import",
  componentNoLocalStorage: "component-no-local-storage",
  sharedNoFeatureImport: "shared-no-feature-import",
  servicesNoReactImport: "services-no-react-import",
  featureRuntimeNoJsx: "feature-runtime-no-jsx",
  chartAdapterLightweightImport: "chart-adapter-lightweight-import",
};

const allowlist = [
  // Phase 4 removal plan: move custom indicator save/delete actions behind
  // the indicators feature runtime and remove this legacy component service import.
  {
    rule: RULES.componentNoServiceImport,
    path: "src/components/IndicatorPanel.jsx",
    target: "src/services/indicatorApi",
    reason: "legacy indicator panel still calls custom indicator API directly",
  },
  // Phase 10/11 follow-up: move pane height persistence out of the chart
  // rendering component once pane layout ownership is settled.
  {
    rule: RULES.componentNoLocalStorage,
    path: "src/components/MultiPaneChart.jsx",
    reason: "pane height persistence still lives in the chart container",
  },
  // Phase 3 removal plan: keep raw Lightweight Charts creation in chart
  // rendering components until the adapter owns the full chart surface.
  {
    rule: RULES.chartAdapterLightweightImport,
    path: "src/components/ChartPane.jsx",
    target: "lightweight-charts",
    reason: "current multi-pane chart renderer owns chart lifecycle during adapter migration",
  },
  // Phase 3 removal plan: delete this exception when the legacy single-pane
  // widget is removed or routed through the chart adapter.
  {
    rule: RULES.chartAdapterLightweightImport,
    path: "src/components/ChartWidget.jsx",
    target: "lightweight-charts",
    reason: "legacy chart widget still owns chart lifecycle during adapter migration",
  },
];

const usedAllowlistEntries = new Set();
const violations = [];

function toProjectPath(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function normalizeModulePath(modulePath) {
  return modulePath.replace(/\.(?:mjs|cjs|js|jsx)$/, "");
}

function allowlistKey(entry) {
  return [entry.rule, entry.path, entry.target || ""].join("|");
}

function findAllowlistEntry(rule, filePath, target = "") {
  const normalizedTarget = normalizeModulePath(target);
  return allowlist.find((entry) => {
    if (entry.rule !== rule || entry.path !== filePath) return false;
    if (!entry.target) return true;
    return normalizeModulePath(entry.target) === normalizedTarget;
  });
}

function isAllowed(rule, filePath, target = "") {
  const entry = findAllowlistEntry(rule, filePath, target);
  if (!entry) return false;
  usedAllowlistEntries.add(allowlistKey(entry));
  return true;
}

function addViolation({ rule, filePath, line, message, target = "" }) {
  if (isAllowed(rule, filePath, target)) return;
  violations.push({ rule, filePath, line, message });
}

function walkSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(entryPath));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r\n|\r|\n/).length;
}

function resolveImportSpecifier(importerPath, specifier) {
  if (specifier.startsWith(".")) {
    return toProjectPath(path.resolve(path.dirname(importerPath), specifier));
  }
  if (specifier.startsWith("src/")) {
    return specifier;
  }
  return specifier;
}

function* importSpecifiers(content) {
  const importPattern = /\b(?:import|export)\b(?:[^'\"]*?\bfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gs;
  let match;
  while ((match = importPattern.exec(content))) {
    yield {
      specifier: match[1] || match[2],
      line: lineNumberAt(content, match.index),
    };
  }
}

function stripCommentsAndStrings(content) {
  let output = "";
  let state = "code";

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (state === "line-comment") {
      if (char === "\n") {
        state = "code";
        output += "\n";
      } else {
        output += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "single" || state === "double" || state === "template") {
      const quote = state === "single" ? "'" : state === "double" ? "\"" : "`";
      if (char === "\\") {
        output += " ";
        if (next) {
          output += next === "\n" ? "\n" : " ";
          index += 1;
        }
        continue;
      }
      if (char === quote) {
        output += " ";
        state = "code";
        continue;
      }
      output += char === "\n" ? "\n" : " ";
      continue;
    }

    if (char === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      index += 1;
      state = "block-comment";
      continue;
    }
    if (char === "'") {
      output += " ";
      state = "single";
      continue;
    }
    if (char === "\"") {
      output += " ";
      state = "double";
      continue;
    }
    if (char === "`") {
      output += " ";
      state = "template";
      continue;
    }

    output += char;
  }

  return output;
}

function hasJsx(content) {
  const stripped = stripCommentsAndStrings(content);
  return /<\/?[A-Za-z][A-Za-z0-9.:-]*(?:\s|>|\/|\{)/.test(stripped);
}

function isComponentOrAppPath(filePath) {
  return filePath.startsWith("src/components/") || filePath.startsWith("src/app/");
}

function isFeatureRuntimePath(filePath) {
  if (!filePath.startsWith("src/features/")) return false;
  const parts = filePath.split("/");
  if (parts[3] === "runtime") return true;
  return /Runtime\.jsx?$/.test(parts.at(-1));
}

function checkImports(absPath, filePath, content) {
  for (const { specifier, line } of importSpecifiers(content)) {
    const target = resolveImportSpecifier(absPath, specifier);
    const normalizedTarget = normalizeModulePath(target);

    if (isComponentOrAppPath(filePath) && normalizedTarget.startsWith("src/services/")) {
      addViolation({
        rule: RULES.componentNoServiceImport,
        filePath,
        line,
        target: normalizedTarget,
        message: `component/app layer imports service module ${specifier}`,
      });
    }

    if (filePath.startsWith("src/shared/") && normalizedTarget.startsWith("src/features/")) {
      addViolation({
        rule: RULES.sharedNoFeatureImport,
        filePath,
        line,
        target: normalizedTarget,
        message: `shared module imports feature module ${specifier}`,
      });
    }

    if (filePath.startsWith("src/services/") && (specifier === "react" || specifier.startsWith("react/"))) {
      addViolation({
        rule: RULES.servicesNoReactImport,
        filePath,
        line,
        target: specifier,
        message: `service module imports React package ${specifier}`,
      });
    }

    if (specifier === "lightweight-charts" && !filePath.startsWith("src/chart-adapter/")) {
      addViolation({
        rule: RULES.chartAdapterLightweightImport,
        filePath,
        line,
        target: specifier,
        message: "Lightweight Charts import must stay inside chart-adapter or a migration allowlist entry",
      });
    }
  }
}

function checkLocalStorage(filePath, content) {
  if (!isComponentOrAppPath(filePath)) return;
  const stripped = stripCommentsAndStrings(content);
  const localStoragePattern = /\blocalStorage\b/g;
  let match;
  while ((match = localStoragePattern.exec(stripped))) {
    addViolation({
      rule: RULES.componentNoLocalStorage,
      filePath,
      line: lineNumberAt(stripped, match.index),
      message: "component/app layer accesses localStorage directly",
    });
  }
}

function checkFeatureRuntimeJsx(filePath, content) {
  if (!isFeatureRuntimePath(filePath)) return;
  if (!hasJsx(content)) return;
  addViolation({
    rule: RULES.featureRuntimeNoJsx,
    filePath,
    line: 1,
    message: "feature runtime files must not render JSX",
  });
}

for (const absPath of walkSourceFiles(srcRoot)) {
  const filePath = toProjectPath(absPath);
  const content = fs.readFileSync(absPath, "utf8");
  checkImports(absPath, filePath, content);
  checkLocalStorage(filePath, content);
  checkFeatureRuntimeJsx(filePath, content);
}

for (const entry of allowlist) {
  const key = allowlistKey(entry);
  if (!usedAllowlistEntries.has(key)) {
    violations.push({
      rule: "stale-architecture-allowlist",
      filePath: entry.path,
      line: 1,
      message: `remove unused allowlist entry for ${entry.rule}: ${entry.reason}`,
    });
  }
}

if (violations.length > 0) {
  console.error(`Architecture check failed with ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`- ${violation.rule}: ${violation.filePath}:${violation.line} - ${violation.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Architecture check passed (${allowlist.length} migration allowlist entries active).`);
}