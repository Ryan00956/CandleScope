import { useMemo, useState } from "react";
import {
  canStartDownload,
  createEmptyManualHistoryForm,
  formHasEndTime,
  isPlanFirstReady,
  parentStateTone,
  type ManualHistoryFormState,
} from "./manualHistoryForm.js";
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

  const startEnabled = enabled && isPlanFirstReady(form) && canStartDownload(plan);
  const tone = parentStateTone(jobState);
  const hasEnd = formHasEndTime(form);

  const summary = useMemo(() => {
    const targetCount = form.symbols.length * form.intervals.length;
    return `${form.symbols.length} × ${form.intervals.length} = ${targetCount}`;
  }, [form.symbols, form.intervals]);

  async function onPlan() {
    setError("");
    if (form.startMs == null) {
      setError("Start time is required.");
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
        Manual history download is disabled.
      </section>
    );
  }

  return (
    <section data-testid="manual-history-download-panel">
      <h3>Manual continuous history</h3>
      <p>Select symbols, intervals, and a start time. The system fills to the last closed bar at seal time.</p>
      <p>Successful data joins the user dataset and is GC-protected.</p>
      <p data-testid="manual-history-target-count">{summary}</p>
      <label>
        Start time
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
      {hasEnd ? <p>Invalid form: end time is not allowed.</p> : null}
      <button type="button" data-testid="manual-history-plan" onClick={() => void onPlan()}>
        Preview plan
      </button>
      <button
        type="button"
        data-testid="manual-history-start-download"
        disabled={!startEnabled}
        onClick={() => void onStart()}
      >
        Start download
      </button>
      {error ? <p data-testid="manual-history-error">{error}</p> : null}
      {plan ? (
        <pre data-testid="manual-history-plan-json">{JSON.stringify(plan, null, 2)}</pre>
      ) : null}
      {jobState ? (
        <p data-testid="manual-history-job-state" data-tone={tone}>
          {tone === "success" ? "Download succeeded" : `Job ${jobState}`}
        </p>
      ) : null}
    </section>
  );
}
