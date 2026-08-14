import { useMemo, useState } from "react";
import type { MainSeriesCrosshairValue } from "../../chart-adapter/chartAdapterTypes.js";
import LocalAnalysisCsvImport from "./LocalAnalysisCsvImport.js";
import type { LocalAnalysisEventStore } from "./localAnalysisStore.js";
import {
  LOCAL_ANALYSIS_EVENT_KINDS,
  LOCAL_ANALYSIS_KIND_COLORS,
  LOCAL_ANALYSIS_KIND_LABELS,
  type LocalAnalysisEvent,
  type LocalAnalysisEventKind,
  type LocalAnalysisSnapshot,
} from "./localAnalysisTypes.js";
import type { LocalDatasetManifest } from "./localDataTypes.js";

interface EventAnchor {
  time: number;
  price: number | null;
}

function anchorFromCrosshair(value: MainSeriesCrosshairValue | null): EventAnchor | null {
  if (value === null || typeof value.time !== "number" || !Number.isFinite(value.time)) return null;
  return { time: value.time, price: Number.isFinite(value.close) ? value.close : null };
}

function formatEventTime(time: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: timezone,
      hour12: false,
    }).format(new Date(time * 1_000));
  } catch {
    return new Date(time * 1_000).toLocaleString("zh-CN");
  }
}

function formatPrice(price: number | null): string {
  return price === null
    ? "未记录价格"
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 12 }).format(price);
}

function eventTitle(event: LocalAnalysisEvent): string {
  return event.label || LOCAL_ANALYSIS_KIND_LABELS[event.kind];
}

export default function LocalAnalysisPanel({
  manifest,
  snapshot,
  eventStore,
  crosshair,
  onFocus,
  onError,
}: {
  manifest: LocalDatasetManifest;
  snapshot: LocalAnalysisSnapshot;
  eventStore: LocalAnalysisEventStore;
  crosshair: MainSeriesCrosshairValue | null;
  onFocus(event: LocalAnalysisEvent): void;
  onError(message: string): void;
}) {
  const [kind, setKind] = useState<LocalAnalysisEventKind>("note");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [color, setColor] = useState(LOCAL_ANALYSIS_KIND_COLORS.note);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingAnchor, setEditingAnchor] = useState<EventAnchor | null>(null);
  const [filter, setFilter] = useState<"all" | LocalAnalysisEventKind>("all");
  const liveAnchor = anchorFromCrosshair(crosshair);
  const activeAnchor = editingId === null ? liveAnchor : editingAnchor;
  const visibleEvents = useMemo(() => [...snapshot.events]
    .filter((event) => filter === "all" || event.kind === filter)
    .sort((left, right) => right.time - left.time || right.created_at.localeCompare(left.created_at)), [filter, snapshot.events]);

  const resetForm = () => {
    setEditingId(null);
    setEditingAnchor(null);
    setKind("note");
    setLabel("");
    setNote("");
    setColor(LOCAL_ANALYSIS_KIND_COLORS.note);
  };

  const startEdit = (event: LocalAnalysisEvent) => {
    setEditingId(event.id);
    setEditingAnchor({ time: event.time, price: event.price });
    setKind(event.kind);
    setLabel(event.label);
    setNote(event.note);
    setColor(event.color);
  };

  const submit = () => {
    if (activeAnchor === null) {
      onError("请先把鼠标移到要标记的 K 线上");
      return;
    }
    try {
      const draft = {
        time: activeAnchor.time,
        price: activeAnchor.price,
        kind,
        label,
        note,
        color,
      };
      if (editingId === null) eventStore.create(draft);
      else eventStore.update(editingId, draft);
      resetForm();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "分析标记保存失败");
    }
  };

  return (
    <section className="local-analysis-panel" aria-label="分析标记">
      <header>
        <div>
          <span>ANALYSIS</span>
          <strong>事件标记</strong>
        </div>
        <small>{snapshot.events.length} 个 · 自动保存</small>
      </header>

      {snapshot.storage_error !== null && (
        <div className="local-analysis-storage-error" role="alert">
          <span>{snapshot.storage_error}</span>
          <button
            type="button"
            onClick={() => {
              try { eventStore.resetCorruptDocument(); }
              catch (reason) { onError(reason instanceof Error ? reason.message : "重置失败"); }
            }}
          >
            重置标记文件
          </button>
        </div>
      )}

      <div className="local-analysis-anchor" data-ready={activeAnchor !== null ? "true" : "false"}>
        <span>{editingId === null ? "当前选点" : "标记位置"}</span>
        <strong>{activeAnchor === null ? "将鼠标移到一根 K 线上" : formatEventTime(activeAnchor.time, manifest.timezone)}</strong>
        <small>{activeAnchor === null ? "十字光标离开图表后仍会保留最后一个选点" : formatPrice(activeAnchor.price)}</small>
        {editingId !== null && liveAnchor !== null && (
          <button type="button" onClick={() => setEditingAnchor(liveAnchor)}>移动到当前选点</button>
        )}
      </div>

      <div className="local-analysis-form">
        <div className="local-analysis-form-grid">
          <label>
            类型
            <select
              value={kind}
              onChange={(event) => {
                const next = event.target.value as LocalAnalysisEventKind;
                setKind(next);
                setColor(LOCAL_ANALYSIS_KIND_COLORS[next]);
              }}
            >
              {LOCAL_ANALYSIS_EVENT_KINDS.map((value) => (
                <option value={value} key={value}>{LOCAL_ANALYSIS_KIND_LABELS[value]}</option>
              ))}
            </select>
          </label>
          <label className="local-analysis-color-field">
            颜色
            <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
          </label>
        </div>
        <label>
          标题
          <input
            value={label}
            maxLength={160}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={`${LOCAL_ANALYSIS_KIND_LABELS[kind]}（可选）`}
          />
        </label>
        <label>
          备注
          <textarea
            value={note}
            maxLength={8_000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="记录为什么关注这里、当时看到了什么……"
          />
        </label>
        <div className="local-analysis-form-actions">
          {editingId !== null && <button type="button" className="secondary" onClick={resetForm}>取消</button>}
          <button
            type="button"
            onClick={submit}
            disabled={activeAnchor === null || snapshot.storage_error !== null}
          >
            {editingId === null ? "添加到图表" : "保存修改"}
          </button>
        </div>
      </div>

      <LocalAnalysisCsvImport
        manifest={manifest}
        eventStore={eventStore}
        storageError={snapshot.storage_error}
        onError={onError}
      />

      <div className="local-analysis-list-head">
        <strong>项目事件</strong>
        <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
          <option value="all">全部类型</option>
          {LOCAL_ANALYSIS_EVENT_KINDS.map((value) => (
            <option value={value} key={value}>{LOCAL_ANALYSIS_KIND_LABELS[value]}</option>
          ))}
        </select>
      </div>
      <div className="local-analysis-event-list">
        {visibleEvents.length === 0 ? (
          <div className="local-analysis-event-empty">
            {snapshot.events.length === 0 ? "还没有标记。移动十字光标选择 K 线后即可添加。" : "当前筛选条件下没有标记。"}
          </div>
        ) : visibleEvents.map((event) => (
          <article className={event.id === editingId ? "editing" : ""} key={event.id}>
            <button type="button" className="local-analysis-event-main" onClick={() => onFocus(event)}>
              <i style={{ background: event.color }} />
              <span>
                <strong>{eventTitle(event)}{event.source === "csv" ? " · CSV" : ""}</strong>
                <small>{formatEventTime(event.time, manifest.timezone)} · {formatPrice(event.price)}</small>
                {event.note && <em>{event.note}</em>}
              </span>
            </button>
            <div className="local-analysis-event-actions">
              <button type="button" onClick={() => onFocus(event)}>定位</button>
              <button type="button" onClick={() => startEdit(event)}>编辑</button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  try {
                    eventStore.delete(event.id);
                    if (editingId === event.id) resetForm();
                  } catch (reason) {
                    onError(reason instanceof Error ? reason.message : "删除标记失败");
                  }
                }}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
