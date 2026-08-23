import { t, type MessageKey } from "../../i18n/index.js";

export const PYTHON_STUDIO_STORAGE_KEY = "candlescope.python-studio.v1";

export type PythonRuntimeMode = "SANDBOXED_LOCAL" | "TRUSTED_LOCAL";

export interface PythonBundleFileMap {
  [path: string]: string;
}

export interface PythonTemplate {
  id: "sma_cross" | "rsi_reversion" | "breakout";
  label: string;
  descriptionKey: MessageKey;
  files: PythonBundleFileMap;
}

export interface PythonBundleIdentity {
  bundle_id?: string;
  bundle_hash: string;
  manifest_hash: string;
  source_hash: string;
  sdk_hash?: string;
  requirements_lock_hash?: string;
  capability_hash?: string;
  parameter_schema_hash?: string;
  entrypoint?: string;
  signalClock?: string;
  outputModes?: string[];
}

export interface PythonStudioGate {
  revisionId: string | null;
  bundleIdentity: PythonBundleIdentity | null;
  smokePassed: boolean;
  runtimeMode: PythonRuntimeMode;
  trustedConfirmed: boolean;
  coverageReady: boolean;
  coverageReason: string;
  canCreateRun: boolean;
}

export interface PythonStudioPersisted {
  revisionId: string | null;
  runId: string | null;
  studyId: string | null;
  bundleId: string | null;
  bundleIdentity: PythonBundleIdentity | null;
  smokePassed: boolean;
  runtimeMode: PythonRuntimeMode;
  trustedConfirmed: boolean;
}

export interface StudioFailure {
  code: string;
  message: string;
  line: number | null;
  column: number | null;
  nextStep: string;
}

export interface CoverageAssessment {
  ready: boolean;
  warmupRows: number;
  snapshotRows: number;
  reason: string;
}

export const PYTHON_UNSUPPORTED = [
  "network access",
  "training during Run",
  "arbitrary Host file paths",
  "raw trade as execution truth",
  "queue exact / L2 queue position",
  "intrabar unique path on BAR_APPROX",
] as const;

export const TRUSTED_LOCAL_FACT_KEYS = [
  "python.fact.noSandbox",
  "python.fact.fsAccess",
  "python.fact.flagRequired",
  "python.fact.hostOwns",
  "python.fact.notContinue",
] as const satisfies readonly MessageKey[];

export function trustedLocalFacts(): readonly string[] {
  return TRUSTED_LOCAL_FACT_KEYS.map((key) => t(key));
}

export function trustedLocalConfirmLabel(): string {
  return t("python.confirmTrusted");
}

export const TRUSTED_LOCAL_FACTS = trustedLocalFacts();
export const TRUSTED_LOCAL_CONFIRM_LABEL = trustedLocalConfirmLabel();

const LOCK = `# V1 lock: standard library + candlescope-backtest-sdk only.
candlescope-backtest-sdk==0.1.0
`;

const SMA_PY = `from candlescope_backtest_sdk import Observation, StrategyContext, TargetPosition


class Strategy:
    def prepare(self, context: StrategyContext) -> None:
        self.fast = int(context.parameters["fast"])
        self.slow = int(context.parameters["slow"])
        self.closes: list[str] = []

    def warmup(self, observation: Observation) -> None:
        self.closes.append(observation.bar.close)

    def step(self, observation: Observation) -> TargetPosition:
        self.closes.append(observation.bar.close)
        fast = sum(map(float, self.closes[-self.fast :])) / self.fast
        slow = sum(map(float, self.closes[-self.slow :])) / self.slow
        return TargetPosition(quantity="1" if fast > slow else "-1")

    def on_execution_report(self, report) -> None:
        return None

    def snapshot(self) -> dict:
        return {"closes": list(self.closes)}

    def restore(self, payload: dict) -> None:
        self.closes = [str(value) for value in payload["closes"]]

    def close(self) -> None:
        return None
`;

const RSI_PY = `from candlescope_backtest_sdk import Observation, Signal, StrategyContext


class Strategy:
    def prepare(self, context: StrategyContext) -> None:
        self.length = int(context.parameters["length"])
        self.oversold = float(context.parameters["oversold"])
        self.overbought = float(context.parameters["overbought"])
        self.closes: list[float] = []

    def warmup(self, observation: Observation) -> None:
        self.closes.append(float(observation.bar.close))

    def step(self, observation: Observation) -> Signal | None:
        self.closes.append(float(observation.bar.close))
        if len(self.closes) <= self.length:
            return None
        window = self.closes[-self.length - 1 :]
        gains = 0.0
        losses = 0.0
        for previous, current in zip(window, window[1:]):
            change = current - previous
            if change >= 0:
                gains += change
            else:
                losses -= change
        average_gain = gains / self.length
        average_loss = losses / self.length
        if average_loss == 0:
            rsi = 100.0
        else:
            rsi = 100.0 - (100.0 / (1.0 + average_gain / average_loss))
        if rsi <= self.oversold:
            return Signal(direction="LONG", score=str(rsi), confidence="1", horizon="1")
        if rsi >= self.overbought:
            return Signal(direction="SHORT", score=str(rsi), confidence="1", horizon="1")
        return None

    def on_execution_report(self, report) -> None:
        return None

    def snapshot(self) -> dict:
        return {"closes": [str(value) for value in self.closes]}

    def restore(self, payload: dict) -> None:
        self.closes = [float(value) for value in payload["closes"]]

    def close(self) -> None:
        return None
`;

const BREAKOUT_PY = `from candlescope_backtest_sdk import Observation, StrategyContext, TargetPosition


class Strategy:
    def prepare(self, context: StrategyContext) -> None:
        self.lookback = int(context.parameters["lookback"])
        self.highs: list[float] = []
        self.lows: list[float] = []

    def warmup(self, observation: Observation) -> None:
        self.highs.append(float(observation.bar.high))
        self.lows.append(float(observation.bar.low))

    def step(self, observation: Observation) -> TargetPosition:
        close = float(observation.bar.close)
        window_high = max(self.highs[-self.lookback :]) if self.highs else close
        window_low = min(self.lows[-self.lookback :]) if self.lows else close
        self.highs.append(float(observation.bar.high))
        self.lows.append(float(observation.bar.low))
        if close > window_high:
            return TargetPosition(quantity="1")
        if close < window_low:
            return TargetPosition(quantity="-1")
        return TargetPosition(quantity="0")

    def on_execution_report(self, report) -> None:
        return None

    def snapshot(self) -> dict:
        return {
            "highs": [str(value) for value in self.highs],
            "lows": [str(value) for value in self.lows],
        }

    def restore(self, payload: dict) -> None:
        self.highs = [float(value) for value in payload["highs"]]
        self.lows = [float(value) for value in payload["lows"]]

    def close(self) -> None:
        return None
`;

function manifest(name: string, extras: Record<string, unknown>): string {
  return `${JSON.stringify(
    {
      schemaVersion: "candlescope.python-strategy-bundle/1",
      name,
      entrypoint: "strategy:Strategy",
      signalClock: "BAR_CLOSE",
      ...extras,
      reproducibility: "DETERMINISTIC_CPU_LOCKED",
    },
    null,
    2,
  )}\n`;
}

export const PYTHON_TEMPLATES: readonly PythonTemplate[] = [
  {
    id: "sma_cross",
    label: "SMA Cross",
    descriptionKey: "python.tpl.sma",
    files: {
      "strategy.json": manifest("SMA Cross", {
        outputModes: ["TARGET_POSITION"],
        requiredFeatures: ["open", "high", "low", "close", "volume"],
        warmup: { kind: "PARAMETER_MAX", parameters: ["fast", "slow"] },
        parameters: [
          { name: "fast", type: "integer", default: 20, minimum: 2 },
          { name: "slow", type: "integer", default: 50, minimum: 3 },
        ],
      }),
      "strategy.py": SMA_PY,
      "requirements.lock": LOCK,
    },
  },
  {
    id: "rsi_reversion",
    label: "RSI Reversion",
    descriptionKey: "python.tpl.rsi",
    files: {
      "strategy.json": manifest("RSI Reversion", {
        outputModes: ["SIGNAL"],
        requiredFeatures: ["close"],
        warmup: { kind: "PARAMETER_MAX", parameters: ["length"] },
        parameters: [
          { name: "length", type: "integer", default: 14, minimum: 2 },
          { name: "oversold", type: "number", default: 30 },
          { name: "overbought", type: "number", default: 70 },
        ],
      }),
      "strategy.py": RSI_PY,
      "requirements.lock": LOCK,
    },
  },
  {
    id: "breakout",
    label: "Donchian Breakout",
    descriptionKey: "python.tpl.breakout",
    files: {
      "strategy.json": manifest("Donchian Breakout", {
        outputModes: ["TARGET_POSITION"],
        requiredFeatures: ["high", "low", "close"],
        warmup: { kind: "PARAMETER_MAX", parameters: ["lookback"] },
        parameters: [
          { name: "lookback", type: "integer", default: 20, minimum: 2 },
        ],
      }),
      "strategy.py": BREAKOUT_PY,
      "requirements.lock": LOCK,
    },
  },
];

export function templateById(id: string): PythonTemplate | null {
  return PYTHON_TEMPLATES.find((item) => item.id === id) ?? null;
}

export function isPythonRevision(strategy: { provider_kind?: string } | null | undefined): boolean {
  return strategy?.provider_kind === "PYTHON_SOURCE";
}

export function hostOwnsOrdersCopy(): string {
  return t("python.hostOwns");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

export function encodeZipStore(files: PythonBundleFileMap): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    if (text.includes("\r")) {
      throw new Error("BUNDLE_ENCODING: bundle files must use LF newlines");
    }
    const nameBytes = writeUtf8(name.replaceAll("\\", "/"));
    const data = writeUtf8(text);
    const crc = crc32(data);
    const local = concatBytes([
      writeUtf8("PK\u0003\u0004"),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    ]);
    const central = concatBytes([
      writeUtf8("PK\u0001\u0002"),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = concatBytes(centrals);
  const end = concatBytes([
    writeUtf8("PK\u0005\u0006"),
    u16(0),
    u16(0),
    u16(centrals.length),
    u16(centrals.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return concatBytes([...locals, centralDir, end]);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function zipFilesToBase64(files: PythonBundleFileMap): string {
  return bytesToBase64(encodeZipStore(files));
}

export async function filesFromInput(fileList: FileList | readonly File[]): Promise<PythonBundleFileMap> {
  const files = Array.from(fileList);
  const only = files[0];
  if (files.length === 1 && only && only.name.toLowerCase().endsWith(".zip")) {
    const buffer = new Uint8Array(await only.arrayBuffer());
    return unzipStore(buffer);
  }
  const collected: PythonBundleFileMap = {};
  for (const file of files) {
    const relative = (file.webkitRelativePath || file.name).replaceAll("\\", "/");
    const base = relative.split("/").pop() ?? file.name;
    if (!["strategy.json", "strategy.py", "requirements.lock"].includes(base)) continue;
    collected[base] = (await file.text()).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  }
  return collected;
}

export function unzipStore(bytes: Uint8Array): PythonBundleFileMap {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files: PythonBundleFileMap = {};
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const size = view.getUint32(offset + 18, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    if (method !== 0) {
      throw new Error("BUNDLE_ZIP_INVALID: studio import only accepts stored zip members");
    }
    files[name] = new TextDecoder().decode(bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return files;
}

export function assertRequiredBundleFiles(files: PythonBundleFileMap): string[] {
  return ["strategy.json", "strategy.py", "requirements.lock"].filter((name) => !files[name]);
}

export function generatedManifestPreview(files: PythonBundleFileMap): string {
  return files["strategy.json"] ?? "";
}

export function mapStudioFailure(error: unknown): StudioFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const matched = raw.match(/^([A-Z0-9_]+):\s*([\s\S]+)$/);
  const code = matched?.[1] ?? "STUDIO_FAILURE";
  const message = matched?.[2] ?? raw;
  let line: number | null = null;
  let column: number | null = null;
  let nextStep = "fix the located source or contract error and inspect again";
  try {
    const parsed = JSON.parse(message) as Array<{ line?: number; column?: number; message?: string }>;
    if (Array.isArray(parsed) && parsed[0]) {
      line = Number(parsed[0].line ?? 1);
      column = Number(parsed[0].column ?? 1);
      nextStep = parsed[0].message
        ? `fix ${parsed[0].message} at ${line}:${column}`
        : nextStep;
    }
  } catch {
    if (code === "SANDBOX_UNAVAILABLE") {
      nextStep = t("python.next.sandbox");
    } else if (code === "TRUSTED_LOCAL_DISABLED" || code === "TRUSTED_LOCAL_UNCONFIRMED") {
      nextStep = t("python.next.trusted");
    } else if (code === "FLAG_DISABLED") {
      nextStep = t("python.next.flag");
    }
  }
  return { code, message, line, column, nextStep };
}

export function warmupRowsFromSchema(
  schema: ReadonlyArray<Record<string, unknown>>,
  parameters: Record<string, string | number | boolean>,
): number {
  const names = new Set(["fast", "slow", "length", "lookback"]);
  const values = schema
    .filter((field) => names.has(String(field.name)))
    .map((field) => Number(parameters[String(field.name)] ?? field.default ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) + 1 : 0;
}

export function assessCoverage(input: {
  snapshotRows: number;
  startTimeMs: number;
  endTimeMs: number;
  warmupRows: number;
}): CoverageAssessment {
  const windowOk = input.endTimeMs > input.startTimeMs;
  const ready = windowOk && input.snapshotRows > input.warmupRows && input.snapshotRows > 0;
  return {
    ready,
    warmupRows: input.warmupRows,
    snapshotRows: input.snapshotRows,
    reason: !windowOk
      ? t("python.cover.badWindow")
      : input.snapshotRows <= 0
        ? t("python.cover.noSnapshot")
        : input.snapshotRows <= input.warmupRows
          ? t("python.cover.warmup", {
            snapshot: input.snapshotRows,
            warmup: input.warmupRows,
          })
          : t("python.cover.ok", {
            snapshot: input.snapshotRows,
            warmup: input.warmupRows,
          }),
  };
}

export function canStartTrustedLocal(input: {
  trustedFlagEnabled: boolean;
  confirmed: boolean;
}): boolean {
  return input.trustedFlagEnabled && input.confirmed;
}

export function persistPythonStudioState(
  enabled: boolean,
  state: PythonStudioPersisted,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = typeof sessionStorage === "undefined" ? null : sessionStorage,
): void {
  if (!storage) return;
  if (!enabled) {
    storage.removeItem(PYTHON_STUDIO_STORAGE_KEY);
    return;
  }
  storage.setItem(PYTHON_STUDIO_STORAGE_KEY, JSON.stringify(state));
}

export function restorePythonStudioState(
  enabled: boolean,
  storage: Pick<Storage, "getItem"> | null = typeof sessionStorage === "undefined" ? null : sessionStorage,
): PythonStudioPersisted | null {
  if (!enabled || !storage) return null;
  const raw = storage.getItem(PYTHON_STUDIO_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PythonStudioPersisted;
    return {
      revisionId: parsed.revisionId ?? null,
      runId: parsed.runId ?? null,
      studyId: parsed.studyId ?? null,
      bundleId: parsed.bundleId ?? null,
      bundleIdentity: parsed.bundleIdentity ?? null,
      smokePassed: Boolean(parsed.smokePassed),
      runtimeMode: parsed.runtimeMode === "TRUSTED_LOCAL" ? "TRUSTED_LOCAL" : "SANDBOXED_LOCAL",
      trustedConfirmed: Boolean(parsed.trustedConfirmed),
    };
  } catch {
    return null;
  }
}

export function composePythonExport(input: {
  bundleIdentity: PythonBundleIdentity | null;
  runExport: Record<string, unknown>;
}): Record<string, unknown> {
  const manifest = (input.runExport.manifest ?? {}) as Record<string, unknown>;
  return {
    bundleIdentity: input.bundleIdentity,
    manifest,
    reportHash: manifest.reportHash ?? null,
    report: input.runExport.report ?? null,
    csv: input.runExport.csv ?? null,
  };
}

export function emptyReportIsHidden(input: { error: string | null; report: unknown }): boolean {
  return Boolean(input.error) && input.report == null;
}

export function pythonStudyParameterSpace(schema: ReadonlyArray<Record<string, unknown>>): string {
  const space: Record<string, unknown[]> = {};
  for (const field of schema) {
    const name = String(field.name);
    const fallback = field.default;
    if (typeof fallback === "number") {
      space[name] = [fallback];
    } else if (fallback !== undefined) {
      space[name] = [fallback];
    }
  }
  return JSON.stringify(space);
}
