import { t } from "../../i18n/index.js";
import {
  LOCAL_ANALYSIS_KIND_COLORS,
  type LocalAnalysisEventDraft,
  type LocalAnalysisEventKind,
} from "./localAnalysisTypes.js";

export const MAX_EVENT_CSV_BYTES = 16 * 1024 * 1024;
export const MAX_EVENT_CSV_ROWS = 5_000;

export type EventCsvTimestampUnit = "auto" | "s" | "ms" | "iso";

export interface EventCsvRow {
  rowNumber: number;
  values: Readonly<Record<string, string>>;
}

export interface EventCsvDocument {
  headers: readonly string[];
  rows: readonly EventCsvRow[];
}

export interface EventCsvMapping {
  time: string | null;
  price: string | null;
  kind: string | null;
  label: string | null;
  note: string | null;
  color: string | null;
}

export interface PreparedEventCsvRow {
  rowNumber: number;
  inputTimeMs: number;
  draft: LocalAnalysisEventDraft;
  extra: Readonly<Record<string, unknown>>;
}

export interface EventCsvRejection {
  rowNumber: number;
  reason: string;
}

export interface PreparedEventCsv {
  accepted: readonly PreparedEventCsvRow[];
  rejected: readonly EventCsvRejection[];
}

const HEADER_ALIASES: Readonly<Record<keyof EventCsvMapping, readonly string[]>> = {
  time: ["time", "timestamp", "datetime", "date", "event_time", "时间", "开单时间"],
  price: ["price", "entry_price", "open_price", "成交价", "价格", "开仓价"],
  kind: ["kind", "type", "event", "event_type", "类型", "事件类型"],
  label: ["label", "title", "name", "标题", "名称", "信号"],
  note: ["note", "comment", "remarks", "description", "备注", "说明"],
  color: ["color", "colour", "颜色"],
};

const KIND_ALIASES: Readonly<Record<string, LocalAnalysisEventKind>> = {
  note: "note",
  notes: "note",
  remark: "note",
  备注: "note",
  signal: "signal",
  信号: "signal",
  entry: "entry",
  enter: "entry",
  open: "entry",
  buy: "entry",
  开仓: "entry",
  入场: "entry",
  exit: "exit",
  close: "exit",
  sell: "exit",
  平仓: "exit",
  出场: "exit",
  custom: "custom",
  自定义: "custom",
};

function pushRecord(records: string[][], cells: string[], field: string): void {
  records.push([...cells, field]);
}

export function parseEventCsvText(input: string): EventCsvDocument {
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const records: string[][] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (quoteClosed) {
      if (character === ",") {
        cells.push(field);
        field = "";
        quoteClosed = false;
      } else if (character === "\n" || character === "\r") {
        pushRecord(records, cells, field);
        cells = [];
        field = "";
        quoteClosed = false;
        if (character === "\r" && text[index + 1] === "\n") index += 1;
      } else {
        throw new Error(t("local.err.quoteAfter"));
      }
    } else if (character === "\"") {
      if (field.length > 0) throw new Error(t("local.err.unquotedQuote"));
      quoted = true;
    } else if (character === ",") {
      cells.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      pushRecord(records, cells, field);
      cells = [];
      field = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error(t("local.err.unclosedQuote"));
  if (field.length > 0 || cells.length > 0 || quoteClosed) pushRecord(records, cells, field);
  if (records.length === 0) throw new Error(t("local.err.empty"));

  const first = records[0];
  if (first === undefined) throw new Error(t("local.err.noHeader"));
  const headers = first.map((header) => header.trim());
  if (headers.length > 100) throw new Error(t("local.err.maxCols"));
  if (headers.some((header) => header.length === 0)) throw new Error(t("local.err.emptyHeader"));
  const normalized = headers.map((header) => header.toLocaleLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(t("local.err.dupHeader"));
  }

  const rows: EventCsvRow[] = [];
  for (let recordIndex = 1; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    if (record === undefined || record.every((value) => value.trim().length === 0)) continue;
    if (record.length > headers.length) {
      throw new Error(t("local.err.rowOverflow", { row: recordIndex + 1 }));
    }
    if (record.some((value) => value.length > 8_000)) {
      throw new Error(t("local.err.fieldTooLong", { row: recordIndex + 1 }));
    }
    const values: Record<string, string> = {};
    headers.forEach((header, columnIndex) => { values[header] = record[columnIndex] ?? ""; });
    rows.push({ rowNumber: recordIndex + 1, values: Object.freeze(values) });
    if (rows.length > MAX_EVENT_CSV_ROWS) {
      throw new Error(t("local.err.maxRows", { count: MAX_EVENT_CSV_ROWS }));
    }
  }
  if (rows.length === 0) throw new Error(t("local.err.noData"));
  return { headers: Object.freeze(headers), rows: Object.freeze(rows) };
}

export function suggestEventCsvMapping(headers: readonly string[]): EventCsvMapping {
  const byName = new Map(headers.map((header) => [header.toLocaleLowerCase(), header]));
  const mapping = {} as EventCsvMapping;
  for (const key of Object.keys(HEADER_ALIASES) as (keyof EventCsvMapping)[]) {
    mapping[key] = HEADER_ALIASES[key]
      .map((alias) => byName.get(alias.toLocaleLowerCase()))
      .find((header) => header !== undefined) ?? null;
  }
  return mapping;
}

function parseTimestamp(value: string, unit: EventCsvTimestampUnit): number {
  const text = value.trim();
  if (!text) throw new Error(t("local.err.timeEmpty"));
  const numeric = /^[+-]?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
  if (unit !== "iso" && numeric !== null) {
    if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(t("local.err.timeNotPositive"));
    const milliseconds = unit === "ms" || (unit === "auto" && numeric >= 100_000_000_000)
      ? numeric
      : numeric * 1_000;
    const rounded = Math.round(milliseconds);
    if (!Number.isSafeInteger(rounded)) throw new Error(t("local.err.timeUnsafe"));
    return rounded;
  }
  if (unit === "s" || unit === "ms") {
    throw new Error(t("local.err.timeNotUnix", {
      unit: t(unit === "s" ? "local.err.unitS" : "local.err.unitMs"),
    }));
  }
  if (!/(?:z|[+-]\d{2}(?::?\d{2})?)$/i.test(text)) {
    throw new Error(t("local.err.isoNeedTz"));
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(t("local.err.isoInvalid"));
  return parsed;
}

function resolveKind(value: string, fallback: LocalAnalysisEventKind): {
  kind: LocalAnalysisEventKind;
  original: string | null;
} {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return { kind: fallback, original: null };
  const kind = KIND_ALIASES[normalized];
  return kind === undefined
    ? { kind: "custom", original: value.trim() }
    : { kind, original: null };
}

export function prepareEventCsv(
  document: EventCsvDocument,
  mapping: EventCsvMapping,
  timestampUnit: EventCsvTimestampUnit,
  defaultKind: LocalAnalysisEventKind,
): PreparedEventCsv {
  if (mapping.time === null || !document.headers.includes(mapping.time)) {
    throw new Error(t("local.err.needTimeCol"));
  }
  const selected = Object.values(mapping).filter((value): value is string => value !== null);
  if (new Set(selected).size !== selected.length) throw new Error(t("local.err.dupMapping"));
  const accepted: PreparedEventCsvRow[] = [];
  const rejected: EventCsvRejection[] = [];
  const mappedHeaders = new Set(selected);

  for (const row of document.rows) {
    try {
      const rawKind = mapping.kind === null ? "" : row.values[mapping.kind] ?? "";
      const resolvedKind = resolveKind(rawKind, defaultKind);
      const rawPrice = mapping.price === null ? "" : row.values[mapping.price] ?? "";
      const price = rawPrice.trim() === "" ? null : Number(rawPrice);
      if (price !== null && !Number.isFinite(price)) throw new Error(t("local.err.priceNaN"));
      const label = mapping.label === null ? "" : (row.values[mapping.label] ?? "").trim();
      const note = mapping.note === null ? "" : (row.values[mapping.note] ?? "").trim();
      if (label.length > 160) throw new Error(t("local.err.labelLong"));
      if (note.length > 8_000) throw new Error(t("local.err.noteLong"));
      const rawColor = mapping.color === null ? "" : (row.values[mapping.color] ?? "").trim();
      const color = rawColor || LOCAL_ANALYSIS_KIND_COLORS[resolvedKind.kind];
      if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error(t("local.err.colorHex"));
      const originalTime = row.values[mapping.time] ?? "";
      const inputTimeMs = parseTimestamp(originalTime, timestampUnit);
      const extra: Record<string, unknown> = {
        csv_row: row.rowNumber,
        original_time: originalTime,
      };
      for (const header of document.headers) {
        if (!mappedHeaders.has(header)) extra[header] = row.values[header] ?? "";
      }
      if (resolvedKind.original !== null) extra.original_kind = resolvedKind.original;
      accepted.push({
        rowNumber: row.rowNumber,
        inputTimeMs,
        draft: { time: 1, price, kind: resolvedKind.kind, label, note, color },
        extra: Object.freeze(extra),
      });
    } catch (reason) {
      rejected.push({
        rowNumber: row.rowNumber,
        reason: reason instanceof Error ? reason.message : t("local.err.rowParse"),
      });
    }
  }
  return { accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) };
}

export async function sha256EventCsv(bytes: ArrayBuffer): Promise<string> {
  if (bytes.byteLength > MAX_EVENT_CSV_BYTES) {
    throw new Error(t("local.err.tooLarge", { mb: MAX_EVENT_CSV_BYTES / 1024 / 1024 }));
  }
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    throw new Error(t("local.err.noSha"));
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
