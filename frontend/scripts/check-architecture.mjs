import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(projectRoot, "src");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const LEGACY_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const UNSUPPORTED_TYPESCRIPT_EXTENSIONS = new Set([".mts", ".cts"]);
const ALLOWED_NON_SOURCE_EXTENSIONS = new Set([".css", ".md", ".svg"]);

const RULES = {
  componentNoServiceImport: "component-no-service-import",
  componentNoLocalStorage: "component-no-local-storage",
  sharedNoFeatureImport: "shared-no-feature-import",
  servicesNoReactImport: "services-no-react-import",
  featureRuntimeNoJsx: "feature-runtime-no-jsx",
  chartAdapterLightweightImport: "chart-adapter-lightweight-import",
  appNoMarketDataRuntimeBridge: "app-no-market-data-runtime-bridge",
  appNoIndicatorRangeBridge: "app-no-indicator-range-bridge",
  appNoRawChartWidgetRef: "app-no-raw-chart-widget-ref",
  featureNoComponentPrimitivesImport: "feature-no-component-primitives-import",
  featureRuntimeNoLegacyCompatFields: "feature-runtime-no-legacy-compat-fields",
  marketDataKlineFetchOnlyFeed: "market-data-kline-fetch-only-feed",
  componentNoRawTimeScaleWrite: "component-no-raw-time-scale-write",
  drawingInteractionNoLocalStorageWrite: "drawing-interaction-no-local-storage-write",
  drawingPublicRuntimeNoRawChartSeries: "drawing-public-runtime-no-raw-chart-series",
  drawingWorkerNoChartRuntimeImport: "drawing-worker-no-chart-runtime-import",
  sourceTypescriptOnly: "source-typescript-only",
  replayComponentNoServiceImport: "replay-component-no-service-import",
  liveAppNoReplayBars: "live-app-no-replay-bars",
  replayAppNoLiveRuntimeImport: "replay-app-no-live-runtime-import",
  replayAppNoPrivateTradingImport: "replay-app-no-private-trading-import",
};

const allowlist = [];

const usedAllowlistEntries = new Set();
const violations = [];

const strictRuntimeContractFiles = new Set([
  "src/features/indicators/useIndicatorRuntime",
  "src/features/drawings/useDrawingRuntime",
  "src/features/market-data/useMarketDataRuntime",
  "src/features/watchlist/useWatchlistRuntime",
]);

const allowedRuntimeContractFields = new Set(["view", "actions", "status"]);

const drawingInteractionHotPathModules = new Set([
  "src/features/drawings/drawingCreationController",
  "src/features/drawings/drawingDragResizeController",
  "src/features/drawings/drawingEraseController",
  "src/features/drawings/drawingHoverController",
  "src/features/drawings/drawingInteractionController",
  "src/features/drawings/drawingKeyboardController",
  "src/features/drawings/drawingMoveBatch",
  "src/features/drawings/drawingPointerController",
  "src/features/drawings/drawingSelectionController",
  "src/features/drawings/drawingSnapController",
  "src/features/drawings/drawingTextEditController",
  "src/features/drawings/freehandStrokeModel",
  "src/features/drawings/rendering/DrawingInteractionOverlay",
]);

const drawingPublicContractDeclarations = new Map([
  ["src/features/drawings/useDrawingRuntime", new Set([
    "DrawingRuntime",
    "DrawingRuntimeActions",
  ])],
  ["src/features/drawings/drawingToolState", new Set([
    "DrawingToolStateRuntime",
  ])],
  ["src/features/drawings/DrawingEngineHost", new Set([
    "DrawingEngineApi",
  ])],
]);

const rawDrawingPublicPropertyPattern = /\b(?:chart|series|rawChart|rawSeries|chartAdapter|chartApi|seriesApi|chartRef|seriesRef|chartInstance|seriesInstance|mainSeries|chartWidget|chartWidgetRef|getChart|getSeries|getRawChart|getRawSeries|getChartAdapter|getMainSeries)\s*(?:\?|!)?\s*(?::|\()/g;
const rawDrawingPublicTypePattern = /\b(?:DrawingChartAdapter|IChartApi|ISeriesApi|ChartApi|SeriesApi|ChartWidget|createLightweightChartAdapter)\b/g;

function toProjectPath(filePath, projectDirectory = projectRoot) {
  return path.relative(projectDirectory, filePath).split(path.sep).join("/");
}

function normalizeModulePath(modulePath) {
  return modulePath.replace(/\.(?:mjs|cjs|mts|cts|js|jsx|ts|tsx)$/, "");
}

function isTestSourcePath(filePath) {
  return filePath.includes("/__tests__/")
    || /\.(?:test|spec)\.(?:ts|tsx)$/.test(filePath);
}

function isDrawingWorkerModulePath(filePath) {
  return !isTestSourcePath(filePath)
    && filePath.startsWith("src/features/drawings/worker/");
}

function isChartAdapterModulePath(modulePath) {
  return modulePath === "src/chart-adapter"
    || modulePath.startsWith("src/chart-adapter/");
}

function isLightweightChartsImport(specifier) {
  return specifier === "lightweight-charts"
    || specifier.startsWith("lightweight-charts/");
}

function isDrawingInteractionHotPath(filePath) {
  if (isTestSourcePath(filePath)) return false;
  const modulePath = normalizeModulePath(filePath);
  return drawingInteractionHotPathModules.has(modulePath)
    || modulePath.startsWith("src/features/drawings/interaction/");
}

function isDrawingPersistenceBoundaryPath(filePath) {
  const modulePath = normalizeModulePath(filePath);
  return modulePath.startsWith("src/features/drawings/persistence/")
    || modulePath === "src/features/drawings/drawingPersistence"
    || modulePath === "src/features/drawings/useDrawingPersistenceLifecycle";
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
    if (sourceFileKind(entry.name) !== null) {
      files.push(entryPath);
    }
  }
  return files;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r\n|\r|\n/).length;
}

function resolveImportSpecifier(importerPath, specifier, projectDirectory) {
  if (specifier.startsWith(".")) {
    return toProjectPath(path.resolve(path.dirname(importerPath), specifier), projectDirectory);
  }
  if (specifier.startsWith("src/")) {
    return specifier;
  }
  return specifier;
}

function* importSpecifiers(content) {
  const importPattern = /\b(?:import|export)\b(?:[^'"]*?\bfrom\s*|\s*)["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gs;
  let match;
  while ((match = importPattern.exec(content))) {
    const statement = match[0];
    const explicitTypeOnly = /^(?:import|export)\s+type\b/.test(statement);
    const namedClause = /^(?:import|export)\s*\{([\s\S]*?)\}\s*from\b/.exec(statement)?.[1];
    const namedTypeOnly = typeof namedClause === "string"
      && namedClause.split(",").filter((item) => item.trim().length > 0)
        .every((item) => /^type\b/.test(item.trim()));
    yield {
      specifier: match[1] || match[2],
      line: lineNumberAt(content, match.index),
      typeOnly: explicitTypeOnly || namedTypeOnly,
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
  return /Runtime\.(?:js|jsx|ts|tsx)$/.test(parts.at(-1));
}

function isReplayComponentPath(filePath) {
  return filePath.startsWith("src/features/replay/components/");
}

function isReplayAppPath(filePath) {
  const normalized = normalizeModulePath(filePath);
  return normalized === "src/replay-main"
    || normalized.startsWith("src/features/replay/");
}

function isForbiddenReplayLiveRuntimeTarget(target) {
  if (target === "src/features/market-data/useMarketDataRuntime") return true;
  if (target.startsWith("src/features/market-data/runtime/")) return true;
  return [
    "src/features/advanced-market/",
    "src/features/advanced-market-data/",
    "src/features/order-book/",
    "src/features/full-order-book/",
    "src/features/liquidation/",
    "src/features/liquidations/",
    "src/features/watchlist/",
    "src/features/watchlist-full-cache/",
    "src/features/alerts/",
  ].some((prefix) => target.startsWith(prefix));
}

function isForbiddenPrivateTradingTarget(target) {
  const normalized = target.toLowerCase();
  return normalized.startsWith("src/features/trading/")
    || normalized.startsWith("src/services/trading")
    || normalized.startsWith("src/services/private")
    || /(?:^|\/)(?:api-?keys?|credentials|private-trading|signing)(?:\/|$)/.test(normalized);
}

function checkImports(absPath, filePath, content, projectDirectory) {
  for (const { specifier, line, typeOnly } of importSpecifiers(content)) {
    const target = resolveImportSpecifier(absPath, specifier, projectDirectory);
    const normalizedTarget = normalizeModulePath(target);
    const lightweightChartsImport = isLightweightChartsImport(specifier);
    const drawingWorkerRuntimeImport = isDrawingWorkerModulePath(filePath)
      && (lightweightChartsImport || isChartAdapterModulePath(normalizedTarget));

    if (drawingWorkerRuntimeImport) {
      addViolation({
        rule: RULES.drawingWorkerNoChartRuntimeImport,
        filePath,
        line,
        target: normalizedTarget,
        message: `drawing worker module imports chart runtime dependency ${specifier}; workers must consume pure drawing protocol/geometry modules`,
      });
    }

    if (isComponentOrAppPath(filePath) && normalizedTarget.startsWith("src/services/")) {
      addViolation({
        rule: RULES.componentNoServiceImport,
        filePath,
        line,
        target: normalizedTarget,
        message: `component/app layer imports service module ${specifier}`,
      });
    }

    if (isReplayComponentPath(filePath) && normalizedTarget.startsWith("src/services/")) {
      addViolation({
        rule: RULES.replayComponentNoServiceImport,
        filePath,
        line,
        target: normalizedTarget,
        message: `replay component imports service module ${specifier}; send intent through feature-local actions`,
      });
    }

    if (isReplayAppPath(filePath) && !typeOnly
      && isForbiddenReplayLiveRuntimeTarget(normalizedTarget)) {
      addViolation({
        rule: RULES.replayAppNoLiveRuntimeImport,
        filePath,
        line,
        target: normalizedTarget,
        message: `replay entry graph value-imports live runtime ${specifier}`,
      });
    }

    if (isReplayAppPath(filePath) && !typeOnly
      && isForbiddenPrivateTradingTarget(normalizedTarget)) {
      addViolation({
        rule: RULES.replayAppNoPrivateTradingImport,
        filePath,
        line,
        target: normalizedTarget,
        message: `replay entry graph value-imports private trading dependency ${specifier}`,
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

    if (lightweightChartsImport
      && !filePath.startsWith("src/chart-adapter/")
      && !drawingWorkerRuntimeImport) {
      addViolation({
        rule: RULES.chartAdapterLightweightImport,
        filePath,
        line,
        target: specifier,
        message: "Lightweight Charts import must stay inside chart-adapter or a migration allowlist entry",
      });
    }

    if (filePath.startsWith("src/features/") && normalizedTarget.startsWith("src/components/primitives/")) {
      addViolation({
        rule: RULES.featureNoComponentPrimitivesImport,
        filePath,
        line,
        target: normalizedTarget,
        message: "drawing primitives belong under features/drawings/primitives, not components/primitives",
      });
    }

    if (
      filePath.startsWith("src/features/market-data/") &&
      !filePath.startsWith("src/features/market-data/feed/") &&
      normalizedTarget === "src/services/api" &&
      /\bfetchKlines(?:History|Before|Range|Latest)\b/.test(content)
    ) {
      addViolation({
        rule: RULES.marketDataKlineFetchOnlyFeed,
        filePath,
        line,
        target: normalizedTarget,
        message: "market-data K-line REST fetches must go through SeriesDataFeed",
      });
    }
  }
}

export function sourceFileKind(fileName) {
  const extension = path.extname(fileName);
  if (SOURCE_EXTENSIONS.has(extension)) return "typescript";
  const normalizedExtension = extension.toLowerCase();
  if (LEGACY_SOURCE_EXTENSIONS.has(normalizedExtension)) return "legacy-javascript";
  if (
    UNSUPPORTED_TYPESCRIPT_EXTENSIONS.has(normalizedExtension) ||
    SOURCE_EXTENSIONS.has(normalizedExtension)
  ) {
    return "unsupported-typescript";
  }
  if (ALLOWED_NON_SOURCE_EXTENSIONS.has(extension)) return null;
  return "unsupported-source";
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

function checkDrawingWorkerReachableImports(sourceModules, projectDirectory) {
  const resolveSourceModule = (importer, specifier) => {
    if (!specifier.startsWith(".") && !specifier.startsWith("src/")) return null;
    const normalized = normalizeModulePath(
      resolveImportSpecifier(importer.absPath, specifier, projectDirectory),
    );
    return sourceModules.get(normalized) ?? sourceModules.get(`${normalized}/index`) ?? null;
  };

  for (const root of sourceModules.values()) {
    if (!isDrawingWorkerModulePath(root.filePath)) continue;
    const visited = new Set();
    const reportedTargets = new Set();
    const visit = (module, chain) => {
      if (visited.has(module.filePath)) return;
      visited.add(module.filePath);
      for (const imported of importSpecifiers(module.content)) {
        if (imported.typeOnly) continue;
        const normalizedTarget = normalizeModulePath(resolveImportSpecifier(
          module.absPath,
          imported.specifier,
          projectDirectory,
        ));
        const forbidden = isLightweightChartsImport(imported.specifier)
          || isChartAdapterModulePath(normalizedTarget);
        if (forbidden && module.filePath !== root.filePath
          && !reportedTargets.has(normalizedTarget)) {
          reportedTargets.add(normalizedTarget);
          addViolation({
            rule: RULES.drawingWorkerNoChartRuntimeImport,
            filePath: root.filePath,
            line: chain[0]?.line ?? 1,
            target: normalizedTarget,
            message: `drawing worker reaches chart runtime dependency through ${[
              root.filePath,
              ...chain.map((item) => item.target),
              normalizedTarget,
            ].join(" -> ")}`,
          });
          continue;
        }
        const targetModule = resolveSourceModule(module, imported.specifier);
        if (!targetModule || isTestSourcePath(targetModule.filePath)) continue;
        visit(targetModule, [...chain, { line: imported.line, target: targetModule.filePath }]);
      }
    };
    visit(root, []);
  }
}

function checkReplayEntryReachableImports(sourceModules, projectDirectory) {
  const root = sourceModules.get("src/replay-main");
  if (!root) return;
  const visited = new Set();
  const reportedTargets = new Set();
  const resolveSourceModule = (importer, specifier) => {
    if (!specifier.startsWith(".") && !specifier.startsWith("src/")) return null;
    const normalized = normalizeModulePath(
      resolveImportSpecifier(importer.absPath, specifier, projectDirectory),
    );
    return sourceModules.get(normalized) ?? sourceModules.get(`${normalized}/index`) ?? null;
  };

  const report = (rule, imported, normalizedTarget, chain, label) => {
    const reportKey = `${rule}:${normalizedTarget}`;
    if (reportedTargets.has(reportKey)) return;
    reportedTargets.add(reportKey);
    addViolation({
      rule,
      filePath: root.filePath,
      line: chain[0]?.line ?? imported.line,
      target: normalizedTarget,
      message: `replay entry reaches ${label} through ${[
        root.filePath,
        ...chain.map((item) => item.target),
        normalizedTarget,
      ].join(" -> ")}`,
    });
  };

  const visit = (module, chain) => {
    if (visited.has(module.filePath) || isTestSourcePath(module.filePath)) return;
    visited.add(module.filePath);
    for (const imported of importSpecifiers(module.content)) {
      if (imported.typeOnly) continue;
      const normalizedTarget = normalizeModulePath(resolveImportSpecifier(
        module.absPath,
        imported.specifier,
        projectDirectory,
      ));
      // Replay-local modules are already covered by the direct rule. This
      // graph check closes the shared-helper escape hatch without duplicating
      // the same violation.
      if (!isReplayAppPath(module.filePath)
        && isForbiddenReplayLiveRuntimeTarget(normalizedTarget)) {
        report(
          RULES.replayAppNoLiveRuntimeImport,
          imported,
          normalizedTarget,
          chain,
          "live runtime dependency",
        );
        continue;
      }
      if (!isReplayAppPath(module.filePath)
        && isForbiddenPrivateTradingTarget(normalizedTarget)) {
        report(
          RULES.replayAppNoPrivateTradingImport,
          imported,
          normalizedTarget,
          chain,
          "private trading dependency",
        );
        continue;
      }
      const targetModule = resolveSourceModule(module, imported.specifier);
      if (!targetModule) continue;
      visit(targetModule, [...chain, { line: imported.line, target: targetModule.filePath }]);
    }
  };

  visit(root, []);
}

function checkDrawingHotPathReachableLocalStorageWrites(sourceModules, projectDirectory) {
  const resolveSourceModule = (importer, specifier) => {
    if (!specifier.startsWith(".") && !specifier.startsWith("src/")) return null;
    const normalized = normalizeModulePath(
      resolveImportSpecifier(importer.absPath, specifier, projectDirectory),
    );
    return sourceModules.get(normalized) ?? sourceModules.get(`${normalized}/index`) ?? null;
  };

  for (const root of sourceModules.values()) {
    if (!isDrawingInteractionHotPath(root.filePath)) continue;
    const visited = new Set();
    const visit = (module, chain) => {
      if (visited.has(module.filePath) || isDrawingPersistenceBoundaryPath(module.filePath)) return;
      visited.add(module.filePath);
      const writes = drawingLocalStorageWriteIndexes(module.content);
      if (module.filePath !== root.filePath && writes.indexes.length > 0) {
        addViolation({
          rule: RULES.drawingInteractionNoLocalStorageWrite,
          filePath: root.filePath,
          line: chain[0]?.line ?? 1,
          target: module.filePath,
          message: `drawing interaction hot path reaches a synchronous localStorage write through ${[
            root.filePath,
            ...chain.map((item) => item.target),
          ].join(" -> ")}; isolate persistence behind the explicit boundary`,
        });
        return;
      }
      for (const imported of importSpecifiers(module.content)) {
        if (imported.typeOnly) continue;
        const targetModule = resolveSourceModule(module, imported.specifier);
        if (!targetModule || isTestSourcePath(targetModule.filePath)) continue;
        visit(targetModule, [...chain, { line: imported.line, target: targetModule.filePath }]);
      }
    };
    visit(root, []);
  }
}

function drawingLocalStorageWriteIndexes(content) {
  const stripped = stripCommentsAndStrings(content);
  const indexes = [];
  const directSetItemPattern = /(?:(?:window|globalThis|self)\s*(?:\?\.|\.)\s*)?\blocalStorage\s*(?:\?\.|\.)\s*setItem\s*(?:\?\.)?\s*\(/g;
  let match;
  while ((match = directSetItemPattern.exec(stripped))) indexes.push(match.index);
  const storageAliases = new Set();
  const aliasPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:window|globalThis|self)\s*(?:\?\.|\.)\s*)?localStorage\b/g;
  while ((match = aliasPattern.exec(stripped))) storageAliases.add(match[1]);
  for (const alias of storageAliases) {
    const aliasWritePattern = new RegExp(`\\b${alias}\\s*(?:\\?\\.|\\.)\\s*setItem\\s*(?:\\?\\.)?\\s*\\(`, "g");
    while ((match = aliasWritePattern.exec(stripped))) indexes.push(match.index);
  }
  return { indexes: [...new Set(indexes)].sort((left, right) => left - right), stripped };
}

function checkDrawingInteractionLocalStorageWrites(filePath, content) {
  if (!isDrawingInteractionHotPath(filePath)) return;
  const { indexes, stripped } = drawingLocalStorageWriteIndexes(content);
  for (const index of indexes) {
    addViolation({
      rule: RULES.drawingInteractionNoLocalStorageWrite,
      filePath,
      line: lineNumberAt(stripped, index),
      message: "drawing interaction hot path writes localStorage directly; commit through the drawing persistence boundary",
    });
  }
}

function checkComponentRawTimeScaleWrites(filePath, content) {
  if (!isComponentOrAppPath(filePath)) return;
  const stripped = stripCommentsAndStrings(content);
  const rawTimeScaleWritePattern = /(?:\.timeScale\s*\(\s*\)|\btimeScale)\s*\.\s*(applyOptions|setVisibleRange|setVisibleLogicalRange|scrollToPosition|fitContent)\b/g;
  let match;
  while ((match = rawTimeScaleWritePattern.exec(stripped))) {
    addViolation({
      rule: RULES.componentNoRawTimeScaleWrite,
      filePath,
      line: lineNumberAt(stripped, match.index),
      message: `component/app layer writes chart viewport via ${match[1]}; use ViewportController`,
    });
  }
}

function checkFeatureRuntimeJsx(filePath, content) {
  if (!isFeatureRuntimePath(filePath)) return;
  // Plain .ts files cannot contain JSX syntax. Running the text heuristic on
  // them mistakes generic types such as Partial<MarketSeries> for JSX tags.
  if (path.extname(filePath) === ".ts") return;
  if (!hasJsx(content)) return;
  addViolation({
    rule: RULES.featureRuntimeNoJsx,
    filePath,
    line: 1,
    message: "feature runtime files must not render JSX",
  });
}

function checkAppRuntimeBridge(filePath, content) {
  if (normalizeModulePath(filePath) !== "src/app/App") return;
  const stripped = stripCommentsAndStrings(content);
  const appBridgePatterns = [
    {
      pattern: /\bruntimeBridgeRef\b/g,
      rule: RULES.appNoMarketDataRuntimeBridge,
      message: "App must not bridge chart-session to market-data with runtimeBridgeRef; use session transition events instead",
    },
    {
      pattern: /\bindicatorRangeRequestRef\b/g,
      rule: RULES.appNoIndicatorRangeBridge,
      message: "App must not bridge market-data to indicators with indicatorRangeRequestRef; use market-data range request events instead",
    },
    {
      pattern: /\bchartWidgetRef\b/g,
      rule: RULES.appNoRawChartWidgetRef,
      message: "App must not create or pass raw chartWidgetRef; use chart surface runtime instead",
    },
  ];
  let match;
  for (const { pattern, rule, message } of appBridgePatterns) {
    while ((match = pattern.exec(stripped))) {
      addViolation({
        rule,
        filePath,
        line: lineNumberAt(stripped, match.index),
        message,
      });
    }
  }
}

function checkLiveAppReplayOwnership(filePath, content) {
  if (normalizeModulePath(filePath) !== "src/app/App") return;
  const stripped = stripCommentsAndStrings(content);
  const replayOwnershipPattern = /\b(?:replayBars|setReplayBars|replayBarStore|replaySeriesStore)\b|\buseState\s*<\s*(?:ReadonlyArray\s*<\s*)?ReplayBar\b/g;
  const match = replayOwnershipPattern.exec(stripped);
  if (!match) return;
  addViolation({
    rule: RULES.liveAppNoReplayBars,
    filePath,
    line: lineNumberAt(stripped, match.index),
    message: "live App must not own replay bars or replay series state",
  });
}

function findMatchingBrace(content, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findTypeAliasTerminator(content, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === ";" && depth === 0) return index + 1;
  }
  return content.length;
}

function exportedDrawingContractSegments(content, declarationNames) {
  const stripped = stripCommentsAndStrings(content);
  const declarationPattern = /\bexport\s+(interface|type)\s+([A-Za-z_$][\w$]*)\b/g;
  const segments = [];
  let match;
  while ((match = declarationPattern.exec(stripped))) {
    const [, declarationKind, declarationName] = match;
    if (!declarationNames.has(declarationName)) continue;
    let endIndex = stripped.length;
    if (declarationKind === "interface") {
      const openIndex = stripped.indexOf("{", declarationPattern.lastIndex);
      if (openIndex === -1) continue;
      const closeIndex = findMatchingBrace(stripped, openIndex);
      if (closeIndex === -1) continue;
      endIndex = closeIndex + 1;
    } else {
      endIndex = findTypeAliasTerminator(stripped, declarationPattern.lastIndex);
    }
    segments.push({
      declarationName,
      startIndex: match.index,
      text: stripped.slice(match.index, endIndex),
    });
  }
  return { segments, stripped };
}

function firstPatternMatch(pattern, content) {
  pattern.lastIndex = 0;
  return pattern.exec(content);
}

function checkDrawingPublicRuntimeRawChartSeries(filePath, content) {
  const declarationNames = drawingPublicContractDeclarations.get(normalizeModulePath(filePath));
  if (!declarationNames) return;
  const { segments, stripped } = exportedDrawingContractSegments(content, declarationNames);
  for (const segment of segments) {
    const propertyMatch = firstPatternMatch(rawDrawingPublicPropertyPattern, segment.text);
    const typeMatch = firstPatternMatch(rawDrawingPublicTypePattern, segment.text);
    const matches = [propertyMatch, typeMatch].filter(Boolean);
    if (matches.length === 0) continue;
    const firstMatch = matches.reduce((earliest, candidate) => (
      candidate.index < earliest.index ? candidate : earliest
    ));
    addViolation({
      rule: RULES.drawingPublicRuntimeNoRawChartSeries,
      filePath,
      line: lineNumberAt(stripped, segment.startIndex + firstMatch.index),
      message: `public drawing contract ${segment.declarationName} exposes raw chart/series capability ${firstMatch[0].trim()}`,
    });
  }
}

function findLastReturnObject(content) {
  const returnPattern = /\breturn\s*\{/g;
  let match;
  let last = null;
  while ((match = returnPattern.exec(content))) {
    const openIndex = content.indexOf("{", match.index);
    const closeIndex = findMatchingBrace(content, openIndex);
    if (closeIndex !== -1) {
      last = { openIndex, closeIndex };
    }
  }
  return last;
}

function topLevelObjectSegments(objectBody) {
  const segments = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < objectBody.length; index += 1) {
    const char = objectBody[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      segments.push({ text: objectBody.slice(start, index), start });
      start = index + 1;
    }
  }
  segments.push({ text: objectBody.slice(start), start });
  return segments;
}

function objectPropertyName(segment) {
  const trimmed = segment.trim();
  if (!trimmed || trimmed.startsWith("...")) return null;
  const namedProperty = /^([A-Za-z_$][\w$]*)\s*:/.exec(trimmed);
  if (namedProperty) return namedProperty[1];
  const shorthandProperty = /^([A-Za-z_$][\w$]*)\b/.exec(trimmed);
  return shorthandProperty?.[1] || null;
}

function checkFeatureRuntimeLegacyCompatFields(filePath, content) {
  if (!strictRuntimeContractFiles.has(normalizeModulePath(filePath))) return;
  const stripped = stripCommentsAndStrings(content);
  const returnObject = findLastReturnObject(stripped);
  if (!returnObject) return;
  const objectBody = stripped.slice(returnObject.openIndex + 1, returnObject.closeIndex);
  for (const segment of topLevelObjectSegments(objectBody)) {
    const field = objectPropertyName(segment.text);
    if (field && !allowedRuntimeContractFields.has(field)) {
      addViolation({
        rule: RULES.featureRuntimeNoLegacyCompatFields,
        filePath,
        line: lineNumberAt(stripped, returnObject.openIndex + 1 + segment.start),
        message: `feature runtime must not re-expose legacy compat field ${field}; use view/actions/status`,
      });
    }
  }
}

export function runArchitectureCheck({
  sourceDirectory = srcRoot,
  projectDirectory = projectRoot,
  logger = console,
  setExitCode = true,
} = {}) {
  usedAllowlistEntries.clear();
  violations.length = 0;

  const sourceFiles = walkSourceFiles(sourceDirectory);
  const sourceModules = new Map();
  for (const absPath of sourceFiles) {
    if (sourceFileKind(absPath) !== "typescript") continue;
    const filePath = toProjectPath(absPath, projectDirectory);
    sourceModules.set(normalizeModulePath(filePath), {
      absPath,
      content: fs.readFileSync(absPath, "utf8"),
      filePath,
    });
  }

  for (const absPath of sourceFiles) {
    const filePath = toProjectPath(absPath, projectDirectory);
    const fileKind = sourceFileKind(absPath);
    if (fileKind !== "typescript") {
      addViolation({
        rule: RULES.sourceTypescriptOnly,
        filePath,
        line: 1,
        message:
          fileKind === "legacy-javascript"
            ? "src must contain only TypeScript source files; migrate this file to .ts or .tsx"
            : fileKind === "unsupported-typescript"
              ? "src TypeScript files must use the lowercase .ts or .tsx extensions supported by tsconfig"
              : "src contains an unapproved file extension; use .ts/.tsx or explicitly approve the non-source asset type",
      });
      continue;
    }
    const content = sourceModules.get(normalizeModulePath(filePath))?.content
      ?? fs.readFileSync(absPath, "utf8");
    checkImports(absPath, filePath, content, projectDirectory);
    checkLocalStorage(filePath, content);
    checkDrawingInteractionLocalStorageWrites(filePath, content);
    checkComponentRawTimeScaleWrites(filePath, content);
    checkFeatureRuntimeJsx(filePath, content);
    checkAppRuntimeBridge(filePath, content);
    checkLiveAppReplayOwnership(filePath, content);
    checkFeatureRuntimeLegacyCompatFields(filePath, content);
    checkDrawingPublicRuntimeRawChartSeries(filePath, content);
  }
  checkDrawingWorkerReachableImports(sourceModules, projectDirectory);
  checkDrawingHotPathReachableLocalStorageWrites(sourceModules, projectDirectory);
  checkReplayEntryReachableImports(sourceModules, projectDirectory);

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

  const result = {
    ok: violations.length === 0,
    violations: violations.map((violation) => ({ ...violation })),
  };

  if (!result.ok) {
    logger.error(`Architecture check failed with ${violations.length} violation(s):`);
    for (const violation of violations) {
      logger.error(`- ${violation.rule}: ${violation.filePath}:${violation.line} - ${violation.message}`);
    }
    if (setExitCode) process.exitCode = 1;
  } else {
    logger.log(`Architecture check passed (${allowlist.length} migration allowlist entries active).`);
  }

  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runArchitectureCheck();
