import { useEffect, useMemo, useState } from "react";
import { useLocale } from "../../i18n/useLocale.js";
import {
  canStartDownload,
  createEmptyManualHistoryForm,
  formHasEndTime,
  isGreenCompleteState,
  isPlanFirstReady,
  MANUAL_HISTORY_INTERVAL_CHOICES,
  parentStateTone,
  parseSymbolList,
  toggleInterval,
  type ManualHistoryFormState,
} from "./manualHistoryForm.js";
import { manualHistoryText } from "./manualHistoryCopy.js";
import {
  cancelManualHistoryJob,
  createManualHistoryDownload,
  fetchManualHistoryCapabilities,
  getManualHistoryJob,
  planManualHistoryDownload,
} from "../../services/manualHistoryApi.js";

interface ManualHistoryDownloadPanelProps {
  enabled?: boolean;
  symbols?: string[];
  intervals?: string[];
  exchange?: string;
  marketType?: string;
}

const ACTIVE_JOB_STATES = new Set(["QUEUED", "RUNNING", "SEALING", "CANCELLING"]);

export function ManualHistoryDownloadPanel({
  enabled,
  symbols = [],
  intervals = [],
  exchange = "binance",
  marketType = "spot",
}: ManualHistoryDownloadPanelProps) {
  const [form, setForm] = useState<ManualHistoryFormState>(() => ({
    ...createEmptyManualHistoryForm(),
    exchange,
    marketType,
    symbols,
    intervals,
  }));
  const [symbolDraft, setSymbolDraft] = useState(symbols.join(", "));
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [job, setJob] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string>("");
  const [flagEnabled, setFlagEnabled] = useState(Boolean(enabled));
  const locale = useLocale();

  const startEnabled = flagEnabled && isPlanFirstReady(form) && canStartDownload(plan);
  const jobState = String(job?.state || "");
  const jobId = String(job?.job_id || "");
  const tone = parentStateTone(jobState);
  const hasEnd = formHasEndTime(form);
  const text = (key: Parameters<typeof manualHistoryText>[1], vars?: Readonly<Record<string, string>>) =>
    manualHistoryText(locale, key, vars);

  const summary = useMemo(() => {
    const targetCount = form.symbols.length * form.intervals.length;
    return `${form.symbols.length} × ${form.intervals.length} = ${targetCount}`;
  }, [form.symbols, form.intervals]);

  useEffect(() => {
    if (enabled !== undefined) {
      setFlagEnabled(Boolean(enabled));
      return;
    }
    const controller = new AbortController();
    void fetchManualHistoryCapabilities(controller.signal).then((payload) => {
      setFlagEnabled(payload.enabled === true);
    }).catch(() => {
      setFlagEnabled(false);
    });
    return () => controller.abort();
  }, [enabled]);

  useEffect(() => {
    if (!jobId || !ACTIVE_JOB_STATES.has(jobState)) return undefined;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void getManualHistoryJob(jobId, controller.signal).then((payload) => {
        const next = (payload.job || payload) as Record<string, unknown>;
        if (next && typeof next === "object") setJob(next);
      }).catch(() => undefined);
    }, 1000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [jobId, jobState]);

  async function onPlan() {
    setError("");
    if (form.startMs == null) {
      setError(text("startRequired"));
      return;
    }
    const next = await planManualHistoryDownload({
      exchange: form.exchange,
      marketType: form.marketType,
      symbols: form.symbols,
      intervals: form.intervals,
      startMs: form.startMs,
    });
    setPlan(next);
  }

  async function onStart() {
    if (!startEnabled || form.startMs == null) return;
    const hash = String(plan?.plan_hash || plan?.planHash || "");
    const created = await createManualHistoryDownload({
      exchange: form.exchange,
      marketType: form.marketType,
      symbols: form.symbols,
      intervals: form.intervals,
      startMs: form.startMs,
      planHash: hash,
      idempotencyKey: crypto.randomUUID(),
    });
    const nextJob = (created.job || {}) as Record<string, unknown>;
    setJob(nextJob);
  }

  async function onCancel() {
    if (!jobId) return;
    const next = await cancelManualHistoryJob(jobId);
    const nextJob = (next.job || next) as Record<string, unknown>;
    setJob(nextJob);
  }

  if (!flagEnabled) {
    return (
      <section data-testid="manual-history-download-disabled">
        {text("disabled")}
      </section>
    );
  }

  const statusMessage = !jobState
    ? null
    : isGreenCompleteState(jobState)
      ? text("succeeded")
      : jobState === "PARTIAL"
        ? text("partialNotComplete")
        : jobState === "BLOCKED_STORAGE"
          ? text("blocked")
          : jobState === "FAILED"
            ? text("failed")
            : text("jobState", { state: jobState });

  return (
    <section data-testid="manual-history-download-panel">
      <h3>{text("title")}</h3>
      <p>{text("hint")}</p>
      <p>{text("protected")}</p>
      <p data-testid="manual-history-target-count">{summary}</p>
      <label>
        {text("symbols")}
        <textarea
          data-testid="manual-history-symbols"
          value={symbolDraft}
          onChange={(event) => {
            const value = event.target.value;
            setSymbolDraft(value);
            setForm((current) => ({ ...current, symbols: parseSymbolList(value) }));
            setPlan(null);
          }}
        />
      </label>
      <fieldset data-testid="manual-history-intervals">
        <legend>{text("intervals")}</legend>
        {MANUAL_HISTORY_INTERVAL_CHOICES.map((interval) => (
          <label key={interval}>
            <input
              type="checkbox"
              checked={form.intervals.includes(interval)}
              onChange={() => {
                setForm((current) => ({
                  ...current,
                  intervals: toggleInterval(current.intervals, interval),
                }));
                setPlan(null);
              }}
            />
            {interval}
          </label>
        ))}
      </fieldset>
      <label>
        {text("startTime")}
        <input
          data-testid="manual-history-start"
          type="datetime-local"
          onChange={(event) => {
            const value = event.target.value;
            setForm((current) => ({
              ...current,
              startMs: value ? Date.parse(value) : null,
            }));
            setPlan(null);
          }}
        />
      </label>
      {hasEnd ? <p>{text("endNotAllowed")}</p> : null}
      <button type="button" data-testid="manual-history-plan" onClick={() => void onPlan()}>
        {text("previewPlan")}
      </button>
      <button
        type="button"
        data-testid="manual-history-start-download"
        disabled={!startEnabled}
        onClick={() => void onStart()}
      >
        {text("startDownload")}
      </button>
      <button
        type="button"
        data-testid="manual-history-cancel"
        disabled={!jobId}
        onClick={() => void onCancel()}
      >
        {text("cancel")}
      </button>
      {ACTIVE_JOB_STATES.has(jobState) ? <p data-testid="manual-history-polling">{text("polling")}</p> : null}
      {error ? <p data-testid="manual-history-error">{error}</p> : null}
      {plan ? (
        <pre data-testid="manual-history-plan-json">{JSON.stringify(plan, null, 2)}</pre>
      ) : null}
      {jobState ? (
        <p data-testid="manual-history-job-state" data-tone={tone}>
          {statusMessage}
        </p>
      ) : null}
    </section>
  );
}
