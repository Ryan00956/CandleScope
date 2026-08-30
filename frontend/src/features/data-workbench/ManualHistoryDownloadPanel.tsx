import { useEffect, useMemo, useState } from "react";
import { useLocale } from "../../i18n/useLocale.js";
import {
  canStartDownload,
  createEmptyManualHistoryForm,
  formHasEndTime,
  isGreenCompleteState,
  isPlanFirstReady,
  MANUAL_HISTORY_INTERVAL_CHOICES,
  normalizeCustomInterval,
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
  listManualHistoryCollections,
  listManualHistoryJobs,
  planManualHistoryDownload,
  releaseManualHistoryCollection,
} from "../../services/manualHistoryApi.js";

interface ManualHistoryDownloadPanelProps {
  enabled?: boolean;
  symbols?: string[];
  intervals?: string[];
  exchange?: string;
  marketType?: string;
}

const ACTIVE_JOB_STATES = new Set([
  "QUEUED",
  "RUNNING",
  "SEALING",
  "BLOCKED_STORAGE",
  "CANCELLING",
]);

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
  const [customIntervalDraft, setCustomIntervalDraft] = useState("");
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [job, setJob] = useState<Record<string, unknown> | null>(null);
  const [recentJobs, setRecentJobs] = useState<Record<string, unknown>[]>([]);
  const [collections, setCollections] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<string>("");
  const [flagEnabled, setFlagEnabled] = useState(Boolean(enabled));
  const locale = useLocale();

  const startEnabled = flagEnabled && isPlanFirstReady(form) && canStartDownload(plan);
  const jobState = String(job?.state || "");
  const jobId = String(job?.job_id || "");
  const jobTargets = Array.isArray(job?.targets)
    ? job.targets.filter((item): item is Record<string, unknown> => (
      item != null && typeof item === "object" && !Array.isArray(item)
    ))
    : [];
  const tone = parentStateTone(jobState);
  const hasEnd = formHasEndTime(form);
  const text = (key: Parameters<typeof manualHistoryText>[1], vars?: Readonly<Record<string, string>>) =>
    manualHistoryText(locale, key, vars);

  const summary = useMemo(() => {
    const targetCount = form.symbols.length * form.intervals.length;
    return `${form.symbols.length} × ${form.intervals.length} = ${targetCount}`;
  }, [form.symbols, form.intervals]);

  const plannedTargets = Array.isArray(plan?.targets)
    ? plan.targets.filter((item): item is Record<string, unknown> => (
      item != null && typeof item === "object" && !Array.isArray(item)
    ))
    : [];
  const planStorage = plan?.storage != null && typeof plan.storage === "object" && !Array.isArray(plan.storage)
    ? plan.storage as Record<string, unknown>
    : null;

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
    const controller = new AbortController();
    void Promise.all([
      listManualHistoryJobs(controller.signal),
      listManualHistoryCollections(controller.signal),
    ]).then(([jobs, nextCollections]) => {
      setRecentJobs(jobs);
      setCollections(nextCollections);
      const active = jobs.find((item) => ACTIVE_JOB_STATES.has(String(item.state || "")));
      if (active) setJob(active);
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!jobId || !ACTIVE_JOB_STATES.has(jobState)) return undefined;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void getManualHistoryJob(jobId, controller.signal).then((payload) => {
        const next = (payload.job || payload) as Record<string, unknown>;
        if (next && typeof next === "object") {
          setJob(next);
          setRecentJobs((current) => [
            next,
            ...current.filter((item) => item.job_id !== next.job_id),
          ]);
          if (!ACTIVE_JOB_STATES.has(String(next.state || ""))) {
            void listManualHistoryCollections().then(setCollections).catch(() => undefined);
          }
        }
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
    try {
      const next = await planManualHistoryDownload({
        exchange: form.exchange,
        marketType: form.marketType,
        symbols: form.symbols,
        intervals: form.intervals,
        startMs: form.startMs,
      });
      setPlan(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function onStart() {
    if (!startEnabled || form.startMs == null) return;
    const hash = String(plan?.plan_hash || plan?.planHash || "");
    setError("");
    try {
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
      setRecentJobs((current) => [nextJob, ...current]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function onCancel() {
    if (!jobId) return;
    setError("");
    try {
      const next = await cancelManualHistoryJob(jobId);
      const nextJob = (next.job || next) as Record<string, unknown>;
      setJob(nextJob);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function onAddCustomInterval() {
    const normalized = normalizeCustomInterval(customIntervalDraft);
    if (!normalized) {
      setError(text("customIntervalInvalid"));
      return;
    }
    setError("");
    setForm((current) => ({
      ...current,
      intervals: current.intervals.includes(normalized)
        ? current.intervals
        : [...current.intervals, normalized],
    }));
    setCustomIntervalDraft("");
    setPlan(null);
  }

  async function onReleaseCollection(collectionId: string) {
    setError("");
    try {
      await releaseManualHistoryCollection(collectionId);
      setCollections((current) => current.map((item) => (
        item.collection_id === collectionId
          ? { ...item, status: "RELEASED" }
          : item
      )));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  if (!flagEnabled) {
    return (
      <section className="dw-manual dw-manual-disabled" data-testid="manual-history-download-disabled">
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
    <section className="dw-manual" data-testid="manual-history-download-panel">
      <h3>{text("title")}</h3>
      <p>{text("hint")}</p>
      <p>{text("protected")}</p>
      <p data-testid="manual-history-target-count">{summary}</p>
      <label>
        {text("exchange")}
        <select
          value={form.exchange}
          onChange={(event) => {
            setForm((current) => ({ ...current, exchange: event.target.value }));
            setPlan(null);
          }}
        >
          <option value="binance">{text("binance")}</option>
          <option value="okx">{text("okx")}</option>
        </select>
      </label>
      <label>
        {text("marketType")}
        <select
          value={form.marketType}
          onChange={(event) => {
            setForm((current) => ({ ...current, marketType: event.target.value }));
            setPlan(null);
          }}
        >
          <option value="spot">{text("spot")}</option>
          <option value="futures">{text("futures")}</option>
        </select>
      </label>
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
        {form.intervals
          .filter((interval) => !MANUAL_HISTORY_INTERVAL_CHOICES.includes(
            interval as typeof MANUAL_HISTORY_INTERVAL_CHOICES[number],
          ))
          .map((interval) => (
            <label key={interval}>
              <input
                type="checkbox"
                checked
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
        {text("customInterval")}
        <input
          data-testid="manual-history-custom-interval"
          value={customIntervalDraft}
          placeholder="89m"
          onChange={(event) => setCustomIntervalDraft(event.target.value)}
        />
      </label>
      <button
        type="button"
        data-testid="manual-history-add-custom-interval"
        onClick={onAddCustomInterval}
      >
        {text("addCustomInterval")}
      </button>
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
      <button className="dw-button dw-button-secondary" type="button" data-testid="manual-history-plan" onClick={() => void onPlan()}>
        {text("previewPlan")}
      </button>
      <button
        type="button"
        className="dw-button dw-button-primary"
        data-testid="manual-history-start-download"
        disabled={!startEnabled}
        onClick={() => void onStart()}
      >
        {text("startDownload")}
      </button>
      <button
        type="button"
        className="dw-button dw-button-secondary"
        data-testid="manual-history-cancel"
        disabled={!jobId}
        onClick={() => void onCancel()}
      >
        {text("cancel")}
      </button>
      {ACTIVE_JOB_STATES.has(jobState) ? <p data-testid="manual-history-polling">{text("polling")}</p> : null}
      {error ? <p data-testid="manual-history-error">{error}</p> : null}
      {plan ? (
        <div data-testid="manual-history-plan-summary">
          <h4>{text("planSummary")}</h4>
          <p>{text("planCanStart", { value: plan.can_start === true ? text("yes") : text("no") })}</p>
          {planStorage ? (
            <p>
              {text("estimatedStorage", {
                value: String(planStorage.estimated_db_growth_bytes ?? text("unknown")),
              })}
            </p>
          ) : null}
          <ul>
            {plannedTargets.map((target) => (
              <li key={`${String(target.symbol)}:${String(target.canonical_interval)}`}>
                {String(target.symbol)} · {String(target.canonical_interval)} · {String(target.route_kind)}
                {target.source_interval !== target.canonical_interval
                  ? ` ← ${String(target.source_interval)}`
                  : ""}
                {` · ${text("effectiveStart")}: ${String(target.effective_start_ms ?? text("unknown"))}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {jobState ? (
        <div>
          <p data-testid="manual-history-job-state" data-tone={tone}>
            {statusMessage}
          </p>
          {jobTargets.length > 0 ? (
            <ul data-testid="manual-history-job-targets">
              {jobTargets.map((target) => (
                <li key={`${String(target.symbol)}:${String(target.canonical_interval)}`}>
                  {String(target.symbol)} · {String(target.canonical_interval)} · {String(target.state)}
                  {` · ${text("sealedEnd")}: ${String(target.sealed_end_open_ms ?? text("unknown"))}`}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div data-testid="manual-history-recent-jobs">
        <h4>{text("recentJobs")}</h4>
        {recentJobs.length === 0 ? <p>{text("none")}</p> : (
          <ul>
            {recentJobs.map((item) => (
              <li key={String(item.job_id)}>
                {String(item.state)} · {String(item.ready_targets ?? 0)}/{String(item.total_targets ?? 0)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div data-testid="manual-history-collections">
        <h4>{text("protectedCollections")}</h4>
        {collections.length === 0 ? <p>{text("none")}</p> : (
          <ul>
            {collections.map((item) => {
              const collectionId = String(item.collection_id || "");
              const released = String(item.status || "") === "RELEASED";
              const targetLabels = Array.isArray(item.targets)
                ? item.targets.map((target) => {
                  const record = target as Record<string, unknown>;
                  return `${String(record.symbol)}@${String(record.canonical_interval)}`;
                })
                : [];
              return (
                <li key={collectionId}>
                  {String(item.exchange)} · {String(item.market_type)} · {String(item.status)}
                  {targetLabels.length > 0 ? ` · ${targetLabels.join(", ")}` : ""}
                  <button
                    type="button"
                    className="dw-button dw-button-secondary dw-manual-release"
                    disabled={released}
                    onClick={() => void onReleaseCollection(collectionId)}
                  >
                    {released ? text("released") : text("releaseProtection")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
