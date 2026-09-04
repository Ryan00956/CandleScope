import { LOCALES, t, type LocaleId, type MessageKey } from "../../i18n/index.js";
import {
  FROZEN_RESEARCH_CONTEXT_SCHEMA,
  FORBIDDEN_ORDINARY_UI_TERMS,
  ORDINARY_RESEARCH_TERMS,
  RESEARCH_CAPABILITY_IDS,
  RESEARCH_SOURCE_KINDS,
  RESEARCH_SOURCE_SCHEMA,
  type FrozenResearchContextV1,
  type ResearchCapabilityDecisionV1,
  type ResearchCapabilityId,
  type ResearchCapabilitySummaryV1,
  type ResearchDataErrorShape,
  type ResearchQualitySummaryV1,
  type ResearchRuntimeMode,
  type ResearchSourceKind,
  type ResearchSourceRefV1,
} from "./researchDataTypes.js";

const RESEARCH_ERROR_ACTION_KEYS = {
  INVALID_RESEARCH_SOURCE: "research.errorAction.chooseSourceAgain",
  UNKNOWN_SOURCE_KIND: "research.errorAction.chooseSourceAgain",
  MISSING_DATASET_IDENTITY: "research.errorAction.chooseDataVersion",
  MISSING_SNAPSHOT_HASH: "research.errorAction.reopenCompletedResult",
  INVALID_FROZEN_CONTEXT: "research.errorAction.freezeAgain",
  CONTEXT_HASH_MISMATCH: "research.errorAction.freezeAgain",
  FRONTEND_MUST_NOT_INVENT_SNAPSHOT: "research.errorAction.waitForFrozenIdentity",
} as const satisfies Record<string, MessageKey>;

const RESEARCH_CAPABILITY_KEYS = {
  viewKlines: "research.capability.viewKlines",
  importCsv: "research.capability.importCsv",
  importDenied: "research.capability.importDenied",
  switchLibrary: "research.capability.switchLibrary",
  activateVersion: "research.capability.activateVersion",
  versionDenied: "research.capability.versionDenied",
  manageVersions: "research.capability.manageVersions",
  barApprox: "research.capability.barApprox",
  gapDenied: "research.capability.gapDenied",
  shortenOrImport: "research.capability.shortenOrImport",
  frozenTape: "research.capability.frozenTape",
  tapeDenied: "research.capability.tapeDenied",
  useBarsOrTape: "research.capability.useBarsOrTape",
  offlineLive: "research.capability.offlineLive",
  chooseLibrary: "research.capability.chooseLibrary",
  prepareHistory: "research.capability.prepareHistory",
  noNetworkBackfill: "research.capability.noNetworkBackfill",
  useImportedOrShorten: "research.capability.useImportedOrShorten",
  readOnlyResults: "research.capability.readOnlyResults",
  localBars: "research.capability.localBars",
  liveIndicators: "research.capability.liveIndicators",
  offlineIndicators: "research.capability.offlineIndicators",
  independentReview: "research.capability.independentReview",
  bindVersion: "research.capability.bindVersion",
  bindChart: "research.capability.bindChart",
  offlineChartStrategy: "research.capability.offlineChartStrategy",
} as const satisfies Record<string, MessageKey>;

function errorAction(code: string, locale?: LocaleId): string {
  const key = RESEARCH_ERROR_ACTION_KEYS[code as keyof typeof RESEARCH_ERROR_ACTION_KEYS]
    ?? "research.errorAction.chooseSourceAgain";
  return t(key, {}, locale);
}

function capabilityCopy(key: keyof typeof RESEARCH_CAPABILITY_KEYS, locale?: LocaleId): string {
  return t(RESEARCH_CAPABILITY_KEYS[key], {}, locale);
}

export class ResearchDataError extends Error {
  readonly code: string;
  readonly action: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ResearchDataError";
    this.code = code;
    this.action = errorAction(code);
    this.details = details;
  }

  toJSON(): ResearchDataErrorShape {
    return {
      code: this.code,
      message: this.message,
      action: this.action,
      ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(values: Record<string, unknown>, key: string, code: string, label = key): string {
  const raw = values[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ResearchDataError(code, `${label} is required`);
  }
  return raw.trim();
}

function requireInt(values: Record<string, unknown>, key: string, code: string): number {
  const raw = values[key];
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new ResearchDataError(code, `${key} must be an integer`);
  }
  return raw;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new ResearchDataError("INVALID_FROZEN_CONTEXT", "numbers must be integers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  throw new ResearchDataError("INVALID_FROZEN_CONTEXT", "unsupported canonical value");
}

export function researchCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256HexUtf8(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export function parseResearchSourceRef(value: unknown): ResearchSourceRefV1 {
  if (!isRecord(value)) {
    throw new ResearchDataError("INVALID_RESEARCH_SOURCE", "research source must be an object");
  }
  const schema = requireString(value, "schemaVersion", "INVALID_RESEARCH_SOURCE");
  if (schema !== RESEARCH_SOURCE_SCHEMA) {
    throw new ResearchDataError("INVALID_RESEARCH_SOURCE", `unsupported schemaVersion ${schema}`);
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !(RESEARCH_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new ResearchDataError("UNKNOWN_SOURCE_KIND", "unknown research source kind", { kind });
  }
  if (kind === "CURRENT_CHART") {
    return {
      schemaVersion: RESEARCH_SOURCE_SCHEMA,
      kind: "CURRENT_CHART",
      workspaceId: requireString(value, "workspaceId", "INVALID_RESEARCH_SOURCE"),
      cellId: requireString(value, "cellId", "INVALID_RESEARCH_SOURCE"),
      exchange: requireString(value, "exchange", "INVALID_RESEARCH_SOURCE"),
      marketType: requireString(value, "marketType", "INVALID_RESEARCH_SOURCE"),
      symbol: requireString(value, "symbol", "INVALID_RESEARCH_SOURCE"),
      interval: requireString(value, "interval", "INVALID_RESEARCH_SOURCE"),
    };
  }
  if (kind === "IMPORTED_DATASET") {
    const datasetId = value.datasetId;
    const dataEpoch = value.dataEpoch;
    if (typeof datasetId !== "string" || datasetId.trim() === "" || typeof dataEpoch !== "string" || dataEpoch.trim() === "") {
      throw new ResearchDataError(
        "MISSING_DATASET_IDENTITY",
        "imported data requires dataset and data version from the library",
      );
    }
    return {
      schemaVersion: RESEARCH_SOURCE_SCHEMA,
      kind: "IMPORTED_DATASET",
      datasetId: datasetId.trim(),
      dataEpoch: dataEpoch.trim(),
      interval: requireString(value, "interval", "INVALID_RESEARCH_SOURCE"),
    };
  }
  const snapshotHash = value.snapshotHash;
  if (typeof snapshotHash !== "string" || snapshotHash.trim() === "") {
    throw new ResearchDataError(
      "MISSING_SNAPSHOT_HASH",
      "completed results require a backend snapshot hash",
    );
  }
  return {
    schemaVersion: RESEARCH_SOURCE_SCHEMA,
    kind: "COMPLETED_RUN",
    runId: requireString(value, "runId", "INVALID_RESEARCH_SOURCE"),
    datasetId: requireString(value, "datasetId", "MISSING_DATASET_IDENTITY"),
    dataEpoch: requireString(value, "dataEpoch", "MISSING_DATASET_IDENTITY"),
    snapshotHash: snapshotHash.trim(),
  };
}

export function parseQualitySummary(value: unknown): ResearchQualitySummaryV1 {
  if (!isRecord(value)) {
    throw new ResearchDataError("INVALID_FROZEN_CONTEXT", "qualitySummary must be an object");
  }
  const status = value.status;
  if (status !== "ok" && status !== "gap" && status !== "failed") {
    throw new ResearchDataError("INVALID_FROZEN_CONTEXT", "unknown quality status");
  }
  const volumeAvailable = value.volumeAvailable;
  if (typeof volumeAvailable !== "boolean") {
    throw new ResearchDataError("INVALID_FROZEN_CONTEXT", "volumeAvailable must be a boolean");
  }
  const rows = requireInt(value, "rows", "INVALID_FROZEN_CONTEXT");
  const excludedRangeCount = requireInt(value, "excludedRangeCount", "INVALID_FROZEN_CONTEXT");
  if (rows < 0 || excludedRangeCount < 0) {
    throw new ResearchDataError("INVALID_FROZEN_CONTEXT", "quality counts cannot be negative");
  }
  return { status, rows, excludedRangeCount, volumeAvailable };
}

export function frozenContextIdentityWire(
  input: Omit<FrozenResearchContextV1, "capabilitySummary" | "contextHash"> & {
    capabilitySummary?: FrozenResearchContextV1["capabilitySummary"];
    contextHash?: string;
  },
): Record<string, unknown> {
  return {
    schemaVersion: input.schemaVersion,
    sourceKind: input.sourceKind,
    datasetId: input.datasetId,
    dataEpoch: input.dataEpoch,
    snapshotHash: input.snapshotHash,
    interval: input.interval,
    startTimeMs: input.startTimeMs,
    endTimeMs: input.endTimeMs,
    symbol: input.symbol,
    qualitySummary: input.qualitySummary,
  };
}

export function frozenContextCanonicalJson(
  input: Omit<FrozenResearchContextV1, "capabilitySummary" | "contextHash">,
): string {
  return researchCanonicalJson(frozenContextIdentityWire(input));
}

function allow(userReason: string): ResearchCapabilityDecisionV1 {
  return { available: true, reasonCode: null, userReason, userAction: "" };
}

function deny(reasonCode: string, userReason: string, userAction: string): ResearchCapabilityDecisionV1 {
  return { available: false, reasonCode, userReason, userAction };
}

export function projectResearchCapabilities(input: {
  sourceKind: ResearchSourceKind;
  runtimeMode?: ResearchRuntimeMode;
  quality?: ResearchQualitySummaryV1 | null;
  hasFrozenTrades?: boolean;
  hasResultCapabilities?: boolean | null;
  locale?: LocaleId;
}): ResearchCapabilitySummaryV1 {
  const runtimeMode = input.runtimeMode ?? "LIVE";
  const kind = input.sourceKind;
  const qualityOk = input.quality?.status === "ok";
  const imported = kind === "IMPORTED_DATASET";
  const completed = kind === "COMPLETED_RUN";
  const chart = kind === "CURRENT_CHART";
  const offline = runtimeMode === "LOCAL_OFFLINE";
  const hasFrozenTrades = input.hasFrozenTrades === true;
  const fidelityCeiling = hasFrozenTrades ? "TRADE_TAPE" : "BAR_APPROX";
  const copy = (key: keyof typeof RESEARCH_CAPABILITY_KEYS) => capabilityCopy(key, input.locale);

  const capabilities: ResearchCapabilitySummaryV1["capabilities"] = {
    viewKlines: allow(copy("viewKlines")),
    importNewData: imported
      ? allow(copy("importCsv"))
      : deny("IMPORT_NOT_AVAILABLE", copy("importDenied"), copy("switchLibrary")),
    modifyRevisionPointer: imported
      ? allow(copy("activateVersion"))
      : deny(
        "REVISION_POINTER_NOT_AVAILABLE",
        copy("versionDenied"),
        copy("manageVersions"),
      ),
    barApprox: imported || completed || qualityOk
      ? allow(copy("barApprox"))
      : deny("DATA_GAP", copy("gapDenied"), copy("shortenOrImport")),
    tradeTape: hasFrozenTrades
      ? allow(copy("frozenTape"))
      : deny("UNSUPPORTED_FIDELITY", copy("tapeDenied"), copy("useBarsOrTape")),
    onlineBackfill: offline
      ? deny("OFFLINE_LIVE_SOURCE_UNAVAILABLE", copy("offlineLive"), copy("chooseLibrary"))
      : chart
        ? allow(copy("prepareHistory"))
        : deny(
          "IMPORTED_DATASET_NEVER_NETWORKS",
          copy("noNetworkBackfill"),
          copy("useImportedOrShorten"),
        ),
    indicators: completed
      ? allow(copy("readOnlyResults"))
      : imported
        ? allow(copy("localBars"))
        : !offline
          ? allow(copy("liveIndicators"))
          : deny(
            "OFFLINE_LIVE_SOURCE_UNAVAILABLE",
            copy("offlineIndicators"),
            copy("chooseLibrary"),
          ),
    drawingsEvents: completed
      ? allow(copy("independentReview"))
      : imported
        ? allow(copy("bindVersion"))
        : allow(copy("bindChart")),
  };

  if (offline && chart) {
    capabilities.viewKlines = deny(
      "OFFLINE_LIVE_SOURCE_UNAVAILABLE",
      copy("offlineLive"),
      copy("chooseLibrary"),
    );
    capabilities.barApprox = deny(
      "OFFLINE_LIVE_SOURCE_UNAVAILABLE",
      copy("offlineChartStrategy"),
      copy("chooseLibrary"),
    );
  }

  return { sourceKind: kind, runtimeMode, fidelityCeiling, capabilities };
}

export function isCapabilityAvailable(
  summary: ResearchCapabilitySummaryV1 | Record<string, unknown> | null | undefined,
  capabilityId: ResearchCapabilityId | string,
): boolean {
  if (summary == null || typeof summary !== "object") return false;
  const capabilities = "capabilities" in summary ? summary.capabilities : undefined;
  if (capabilities == null || typeof capabilities !== "object") return false;
  const decision = (capabilities as Record<string, unknown>)[capabilityId];
  if (decision == null || typeof decision !== "object") return false;
  return (decision as ResearchCapabilityDecisionV1).available === true;
}

export async function assembleFrozenResearchContext(
  values: Record<string, unknown>,
  capabilitySummary: ResearchCapabilitySummaryV1,
  snapshotHash?: string,
): Promise<FrozenResearchContextV1> {
  const schema = typeof values.schemaVersion === "string" && values.schemaVersion
    ? values.schemaVersion
    : FROZEN_RESEARCH_CONTEXT_SCHEMA;
  if (schema !== FROZEN_RESEARCH_CONTEXT_SCHEMA) {
    throw new ResearchDataError("INVALID_FROZEN_CONTEXT", `unsupported schemaVersion ${schema}`);
  }
  const sourceKind = values.sourceKind;
  if (typeof sourceKind !== "string" || !(RESEARCH_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    throw new ResearchDataError("UNKNOWN_SOURCE_KIND", "unknown frozen source kind");
  }
  const providedSnapshot = snapshotHash ?? values.snapshotHash;
  if (typeof providedSnapshot !== "string" || providedSnapshot.trim() === "") {
    throw new ResearchDataError(
      "FRONTEND_MUST_NOT_INVENT_SNAPSHOT",
      "snapshot hash must come from the backend freeze step",
    );
  }
  const qualitySummary = parseQualitySummary(values.qualitySummary);
  const startTimeMs = requireInt(values, "startTimeMs", "INVALID_FROZEN_CONTEXT");
  const endTimeMs = requireInt(values, "endTimeMs", "INVALID_FROZEN_CONTEXT");
  if (endTimeMs < startTimeMs) {
    throw new ResearchDataError("INVALID_FROZEN_CONTEXT", "endTimeMs must be >= startTimeMs");
  }
  const identity = {
    schemaVersion: FROZEN_RESEARCH_CONTEXT_SCHEMA,
    sourceKind: sourceKind as ResearchSourceKind,
    datasetId: requireString(values, "datasetId", "MISSING_DATASET_IDENTITY"),
    dataEpoch: requireString(values, "dataEpoch", "MISSING_DATASET_IDENTITY"),
    snapshotHash: providedSnapshot.trim(),
    interval: requireString(values, "interval", "INVALID_FROZEN_CONTEXT"),
    startTimeMs,
    endTimeMs,
    symbol: requireString(values, "symbol", "INVALID_FROZEN_CONTEXT"),
    qualitySummary,
  };
  const contextHash = `sha256:${await sha256HexUtf8(frozenContextCanonicalJson(identity))}`;
  const declared = values.contextHash;
  if (typeof declared === "string" && declared.trim() !== "" && declared.trim() !== contextHash) {
    throw new ResearchDataError("CONTEXT_HASH_MISMATCH", "frozen context hash does not match identity");
  }
  return { ...identity, capabilitySummary, contextHash };
}

export async function parseFrozenResearchContext(value: unknown): Promise<FrozenResearchContextV1> {
  if (!isRecord(value)) {
    throw new ResearchDataError("INVALID_FROZEN_CONTEXT", "frozen research context must be an object");
  }
  const capability = value.capabilitySummary;
  if (!isRecord(capability) || typeof capability.sourceKind !== "string") {
    throw new ResearchDataError("INVALID_FROZEN_CONTEXT", "capabilitySummary must be an object");
  }
  return assembleFrozenResearchContext(value, capability as unknown as ResearchCapabilitySummaryV1);
}

export function ordinarySourceLabel(
  kind: ResearchSourceKind,
  locale?: LocaleId,
): string {
  const key = kind === "CURRENT_CHART"
    ? "research.source.currentChart"
    : kind === "IMPORTED_DATASET"
      ? "research.source.importedLibrary"
      : "research.source.completedResult";
  return t(key, {}, locale);
}

export function ordinaryTermsContainInternalIdentity(): string[] {
  const hits: string[] = [];
  const forbidden = FORBIDDEN_ORDINARY_UI_TERMS.map((item) => item.toLowerCase());
  for (const [key, pair] of Object.entries(ORDINARY_RESEARCH_TERMS)) {
    for (const text of Object.values(pair)) {
      const lower = text.toLowerCase();
      if (forbidden.some((term) => lower.includes(term))) hits.push(`${key}:${text}`);
    }
  }
  for (const locale of LOCALES) {
    for (const kind of RESEARCH_SOURCE_KINDS) {
      const text = ordinarySourceLabel(kind, locale);
      if (forbidden.some((term) => text.toLowerCase().includes(term))) {
        hits.push(`${locale}:${kind}:${text}`);
      }
    }
  }
  return hits;
}

export { RESEARCH_CAPABILITY_IDS };
