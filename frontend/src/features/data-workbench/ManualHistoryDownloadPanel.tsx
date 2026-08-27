import { useMemo, useState } from "react";
import { useLocale } from "../../i18n/useLocale.js";
import {
  canStartDownload,
  createEmptyManualHistoryForm,
  formHasEndTime,
  isPlanFirstReady,
  parentStateTone,
  type ManualHistoryFormState,
} from "./manualHistoryForm.js";
import { manualHistoryText } from "./manualHistoryCopy.js";
import {
  createManualHistoryDownload,
  planManualHistoryDownload,
} from "../../services/manualHistoryApi.js";

interface ManualHistoryDownloadPanelProps {
  enabled?: boolean;
  symbols?: string[];
  intervals?: string[];
}

export function ManualHistoryDownloadPanel({
  enabled = false,
  symbols = [],
  intervals = [],
}: ManualHistoryDownloadPanelProps) {
  const [form, setForm] = useState<ManualHistoryFormState>(() => ({
    ...createEmptyManualHistoryForm(),
    symbols,
    intervals,
  }));
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [jobState, setJobState] = useState<string>("");
  const [error, setError] = useState<string>("");
  const locale = useLocale();

  const startEnabled = enabled && isPlanFirstReady(form) && canStartDownload(plan);
  const tone = parentStateTone(jobState);
  const hasEnd = formHasEndTime(form);
  const text = (key: Parameters<typeof manualHistoryText>[1], vars?: Readonly<Record<string, string>>) =>
    manualHistoryText(locale, key, vars);

  const summary = useMemo(() => {
    const targetCount = form.symbols.length * form.intervals.length;
    return `${form.symbols.length} × ${form.intervals.length} = ${targetCount}`;
  }, [form.symbols, form.intervals]);

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
    const job = (created.job || {}) as Record<string, unknown>;
    setJobState(String(job.state || ""));
  }

  if (!enabled) {
    return (
      <section data-testid="manual-history-download-disabled">
        {text("disabled")}
      </section>
    );
  }

  return (
    <section data-testid="manual-history-download-panel">
      <h3>{text("title")}</h3>
      <p>{text("hint")}</p>
      <p>{text("protected")}</p>
      <p data-testid="manual-history-target-count">{summary}</p>
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
      {error ? <p data-testid="manual-history-error">{error}</p> : null}
      {plan ? (
        <pre data-testid="manual-history-plan-json">{JSON.stringify(plan, null, 2)}</pre>
      ) : null}
      {jobState ? (
        <p data-testid="manual-history-job-state" data-tone={tone}>
          {tone === "success" ? text("succeeded") : text("jobState", { state: jobState })}
        </p>
      ) : null}
    </section>
  );
}
