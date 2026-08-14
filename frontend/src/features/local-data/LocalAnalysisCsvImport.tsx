import { useState } from "react";
import { resolveLocalEventTimes } from "./localDataApi.js";
import {
  MAX_EVENT_CSV_BYTES,
  parseEventCsvText,
  prepareEventCsv,
  sha256EventCsv,
  suggestEventCsvMapping,
  type EventCsvDocument,
  type EventCsvMapping,
  type EventCsvRejection,
  type EventCsvTimestampUnit,
} from "./localAnalysisCsv.js";
import type { LocalAnalysisEventStore } from "./localAnalysisStore.js";
import {
  LOCAL_ANALYSIS_EVENT_KINDS,
  LOCAL_ANALYSIS_KIND_LABELS,
  type LocalAnalysisEventImportDraft,
  type LocalAnalysisEventKind,
} from "./localAnalysisTypes.js";
import type {
  LocalDatasetManifest,
  LocalEventTimeResolutionMode,
} from "./localDataTypes.js";

interface LoadedEventCsv {
  fileName: string;
  hash: string;
  document: EventCsvDocument;
}

interface ImportReport {
  imported: number;
  skipped: number;
  rejected: readonly EventCsvRejection[];
}

const MAPPING_LABELS: Readonly<Record<keyof EventCsvMapping, string>> = {
  time: "时间列（必选）",
  price: "价格列",
  kind: "类型列",
  label: "标题列",
  note: "备注列",
  color: "颜色列",
};

const EMPTY_MAPPING: EventCsvMapping = {
  time: null,
  price: null,
  kind: null,
  label: null,
  note: null,
  color: null,
};

export default function LocalAnalysisCsvImport({
  manifest,
  eventStore,
  storageError,
  onError,
}: {
  manifest: LocalDatasetManifest;
  eventStore: LocalAnalysisEventStore;
  storageError: string | null;
  onError(message: string): void;
}) {
  const [loaded, setLoaded] = useState<LoadedEventCsv | null>(null);
  const [mapping, setMapping] = useState<EventCsvMapping>(EMPTY_MAPPING);
  const [timestampUnit, setTimestampUnit] = useState<EventCsvTimestampUnit>("auto");
  const [resolutionMode, setResolutionMode] = useState<LocalEventTimeResolutionMode>("containing");
  const [defaultKind, setDefaultKind] = useState<LocalAnalysisEventKind>("note");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  const loadFile = async (file: File) => {
    setBusy(true);
    setReport(null);
    try {
      if (file.size > MAX_EVENT_CSV_BYTES) throw new Error("事件 CSV 不能超过 16 MB");
      const bytes = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("事件 CSV 必须使用 UTF-8 编码");
      }
      const document = parseEventCsvText(text);
      const hash = await sha256EventCsv(bytes);
      setLoaded({ fileName: file.name, hash, document });
      setMapping(suggestEventCsvMapping(document.headers));
    } catch (reason) {
      setLoaded(null);
      setMapping(EMPTY_MAPPING);
      onError(reason instanceof Error ? reason.message : "事件 CSV 读取失败");
    } finally {
      setBusy(false);
    }
  };

  const importEvents = async () => {
    if (loaded === null) return;
    setBusy(true);
    setReport(null);
    try {
      const prepared = prepareEventCsv(loaded.document, mapping, timestampUnit, defaultKind);
      if (prepared.accepted.length === 0) {
        setReport({ imported: 0, skipped: 0, rejected: prepared.rejected });
        return;
      }
      const resolution = await resolveLocalEventTimes(
        manifest,
        prepared.accepted.map((row) => row.inputTimeMs),
        resolutionMode,
      );
      const rejected = [...prepared.rejected];
      const drafts: LocalAnalysisEventImportDraft[] = [];
      prepared.accepted.forEach((row, index) => {
        const resolved = resolution.results[index];
        if (resolved === undefined || !resolved.matched || resolved.bar_open_ms === undefined) {
          rejected.push({ rowNumber: row.rowNumber, reason: "时间没有对应到数据集中的 K 线（可能位于缺口或范围外）" });
          return;
        }
        drafts.push({
          id: `csv:${loaded.hash}:${row.rowNumber}`,
          ...row.draft,
          time: resolved.bar_open_ms / 1_000,
          source: "csv",
          extra: Object.freeze({
            ...row.extra,
            csv_file: loaded.fileName,
            csv_sha256: loaded.hash,
            input_time_ms: row.inputTimeMs,
            resolved_bar_open_ms: resolved.bar_open_ms,
            resolution_mode: resolutionMode,
            resolution_delta_ms: resolved.delta_ms ?? 0,
          }),
        });
      });
      const result = eventStore.importBatch(drafts);
      setReport({ imported: result.imported, skipped: result.skipped, rejected });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "事件 CSV 导入失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="local-analysis-csv-import">
      <summary>导入事件 CSV</summary>
      <div className="local-analysis-csv-body">
        <p>只要求时间列。价格、类型、标题、备注和颜色均可选，其他列会原样保留。</p>
        <label className="local-analysis-csv-file">
          事件文件
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file !== undefined) void loadFile(file);
            }}
          />
        </label>

        {loaded !== null && (
          <>
            <div className="local-analysis-csv-meta">
              <strong>{loaded.fileName}</strong>
              <small>{loaded.document.rows.length} 条 · SHA-256 {loaded.hash.slice(0, 12)}</small>
            </div>
            <div className="local-analysis-csv-grid">
              {(Object.keys(MAPPING_LABELS) as (keyof EventCsvMapping)[]).map((key) => (
                <label key={key}>
                  {MAPPING_LABELS[key]}
                  <select
                    aria-label={MAPPING_LABELS[key]}
                    value={mapping[key] ?? ""}
                    onChange={(event) => setMapping({ ...mapping, [key]: event.target.value || null })}
                  >
                    <option value="">{key === "time" ? "请选择" : "不映射"}</option>
                    {loaded.document.headers.map((header) => <option value={header} key={header}>{header}</option>)}
                  </select>
                </label>
              ))}
              <label>
                时间格式
                <select value={timestampUnit} onChange={(event) => setTimestampUnit(event.target.value as EventCsvTimestampUnit)}>
                  <option value="auto">自动：秒 / 毫秒 / 带时区 ISO</option>
                  <option value="s">Unix 秒</option>
                  <option value="ms">Unix 毫秒</option>
                  <option value="iso">ISO（必须带 Z 或偏移）</option>
                </select>
              </label>
              <label>
                K 线对应方式
                <select value={resolutionMode} onChange={(event) => setResolutionMode(event.target.value as LocalEventTimeResolutionMode)}>
                  <option value="containing">归到所在 K 线（推荐）</option>
                  <option value="exact">只接受 K 线开盘时间</option>
                </select>
              </label>
              <label>
                无类型时使用
                <select value={defaultKind} onChange={(event) => setDefaultKind(event.target.value as LocalAnalysisEventKind)}>
                  {LOCAL_ANALYSIS_EVENT_KINDS.map((kind) => (
                    <option value={kind} key={kind}>{LOCAL_ANALYSIS_KIND_LABELS[kind]}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="local-analysis-csv-preview" aria-label="事件 CSV 预览">
              <table>
                <thead><tr>{loaded.document.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
                <tbody>{loaded.document.rows.slice(0, 3).map((row) => (
                  <tr key={row.rowNumber}>{loaded.document.headers.map((header) => <td key={header}>{row.values[header]}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
            <small className="local-analysis-csv-time-note">不带时区的日期文本会被拒绝，避免因电脑时区不同而把事件放错 K 线。</small>
            <button
              type="button"
              className="local-analysis-csv-submit"
              disabled={busy || storageError !== null || mapping.time === null}
              onClick={() => { void importEvents(); }}
            >
              {busy ? "正在校验…" : "校验并导入"}
            </button>
          </>
        )}

        {report !== null && (
          <div className="local-analysis-csv-report" role="status">
            <strong>已导入 {report.imported} 条</strong>
            <span>重复跳过 {report.skipped} 条 · 拒绝 {report.rejected.length} 条</span>
            {report.rejected.length > 0 && (
              <ul>{report.rejected.slice(0, 20).map((item) => (
                <li key={`${item.rowNumber}:${item.reason}`}>第 {item.rowNumber} 行：{item.reason}</li>
              ))}</ul>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
