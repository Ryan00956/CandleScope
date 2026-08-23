import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type { BacktestApiClient, BacktestSnapshot, StrategyRevisionRecord } from "./backtestApi.js";
import { isPythonTrustedLocalEnabled } from "./backtestFlags.js";
import {
  PYTHON_TEMPLATES,
  PYTHON_UNSUPPORTED,
  TRUSTED_LOCAL_FACT_KEYS,
  trustedLocalConfirmLabel,
  assessCoverage,
  assertRequiredBundleFiles,
  canStartTrustedLocal,
  filesFromInput,
  generatedManifestPreview,
  hostOwnsOrdersCopy,
  mapStudioFailure,
  templateById,
  warmupRowsFromSchema,
  zipFilesToBase64,
  type PythonBundleFileMap,
  type PythonBundleIdentity,
  type PythonRuntimeMode,
  type PythonStudioGate,
  type StudioFailure,
} from "./pythonStudio.js";

interface PythonStudioPanelProps {
  api: BacktestApiClient;
  loading: boolean;
  snapshot: BacktestSnapshot | null;
  datasetId: string;
  startTimeMs: number;
  endTimeMs: number;
  schemaParameters: Record<string, string | number | boolean>;
  selectedRevisionId: string;
  restored?: {
    revisionId: string | null;
    bundleIdentity: PythonBundleIdentity | null;
    smokePassed: boolean;
    runtimeMode: PythonRuntimeMode;
    trustedConfirmed: boolean;
  } | null;
  trustedFlagEnabled?: boolean;
  onLoading: (loading: boolean) => void;
  onNotice: (notice: string | null) => void;
  onError: (error: string | null) => void;
  onRevisionReady: (revision: StrategyRevisionRecord, identity: PythonBundleIdentity) => void;
  onGateChange: (gate: PythonStudioGate) => void;
}

export default function PythonStudioPanel({
  api,
  loading,
  snapshot,
  datasetId,
  startTimeMs,
  endTimeMs,
  schemaParameters,
  selectedRevisionId,
  restored,
  trustedFlagEnabled = isPythonTrustedLocalEnabled(),
  onLoading,
  onNotice,
  onError,
  onRevisionReady,
  onGateChange,
}: PythonStudioPanelProps) {
  const locale = useLocale();
  const defaultTemplate = PYTHON_TEMPLATES[0]!;
  const [templateId, setTemplateId] = useState(defaultTemplate.id);
  const [files, setFiles] = useState<PythonBundleFileMap>(defaultTemplate.files);
  const [inspectResult, setInspectResult] = useState<Record<string, unknown> | null>(null);
  const [bundleIdentity, setBundleIdentity] = useState<PythonBundleIdentity | null>(restored?.bundleIdentity ?? null);
  const [smokePassed, setSmokePassed] = useState(Boolean(restored?.smokePassed));
  const [runtimeMode, setRuntimeMode] = useState<PythonRuntimeMode>(restored?.runtimeMode ?? "SANDBOXED_LOCAL");
  const [trustedConfirmed, setTrustedConfirmed] = useState(Boolean(restored?.trustedConfirmed));
  const [showManifest, setShowManifest] = useState(false);
  const [failure, setFailure] = useState<StudioFailure | null>(null);
  const template = templateById(templateId);
  const missing = assertRequiredBundleFiles(files);
  const inspectedParameters = (inspectResult?.manifest as { parameters?: Array<Record<string, unknown>> } | undefined)?.parameters;
  const warmupRows = warmupRowsFromSchema(
    Array.isArray(inspectedParameters)
      ? inspectedParameters
      : Object.entries(schemaParameters).map(([name, value]) => ({ name, default: value })),
    schemaParameters,
  );
  const coverage = assessCoverage({
    snapshotRows: snapshot?.row_count ?? 0,
    startTimeMs,
    endTimeMs,
    warmupRows,
  });
  const trustedReady = runtimeMode !== "TRUSTED_LOCAL"
    || canStartTrustedLocal({ trustedFlagEnabled, confirmed: trustedConfirmed });
  const canCreateRun = Boolean(selectedRevisionId) && smokePassed && coverage.ready && trustedReady;

  useEffect(() => {
    onGateChange({
      revisionId: selectedRevisionId || null,
      bundleIdentity,
      smokePassed,
      runtimeMode,
      trustedConfirmed,
      coverageReady: coverage.ready,
      coverageReason: coverage.reason,
      canCreateRun,
    });
  }, [
    bundleIdentity,
    canCreateRun,
    coverage.ready,
    coverage.reason,
    onGateChange,
    runtimeMode,
    selectedRevisionId,
    smokePassed,
    trustedConfirmed,
  ]);

  const reportFailure = useCallback((reason: unknown) => {
    const mapped = mapStudioFailure(reason);
    setFailure(mapped);
    onError(`${mapped.code}: ${mapped.message} · ${mapped.nextStep}`);
  }, [onError]);

  const applyFiles = useCallback((next: PythonBundleFileMap) => {
    setFiles(next);
    setInspectResult(null);
    setSmokePassed(false);
    setFailure(null);
  }, []);

  const handleTemplate = useCallback(() => {
    const next = templateById(templateId);
    if (!next) return;
    applyFiles(next.files);
    onNotice(t("python.notice.template", { label: next.label }));
  }, [applyFiles, onNotice, templateId]);

  const handleImport = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    try {
      const next = await filesFromInput(list);
      const absent = assertRequiredBundleFiles(next);
      if (absent.length) {
        throw new Error(`BUNDLE_INCOMPLETE: missing ${absent.join(", ")}`);
      }
      applyFiles(next);
      onNotice(t("python.notice.imported"));
    } catch (reason) {
      reportFailure(reason);
    }
  }, [applyFiles, onNotice, reportFailure]);

  const handleInspect = useCallback(async () => {
    onLoading(true);
    onError(null);
    setFailure(null);
    try {
      const inspected = await api.inspectPythonBundle(zipFilesToBase64(files));
      setInspectResult(inspected);
      onNotice(t("python.notice.inspected"));
    } catch (reason) {
      reportFailure(reason);
    } finally {
      onLoading(false);
    }
  }, [api, files, onError, onLoading, onNotice, reportFailure]);

  const handleFreeze = useCallback(async () => {
    onLoading(true);
    onError(null);
    setFailure(null);
    try {
      const created = await api.createPythonBundle(zipFilesToBase64(files));
      const revision = await api.createPythonRevision(String(created.bundle_id));
      const identity: PythonBundleIdentity = {
        bundle_id: String(created.bundle_id),
        bundle_hash: String(created.bundle_hash),
        manifest_hash: String(created.manifest_hash),
        source_hash: String(created.source_hash),
      };
      if (created.sdk_hash) identity.sdk_hash = String(created.sdk_hash);
      if (created.requirements_lock_hash) {
        identity.requirements_lock_hash = String(created.requirements_lock_hash);
      }
      setBundleIdentity(identity);
      setSmokePassed(false);
      onRevisionReady(revision, identity);
      onNotice(t("python.notice.frozen", {
        bundle: identity.bundle_id ?? "",
        revision: revision.revision_id,
      }));
    } catch (reason) {
      reportFailure(reason);
    } finally {
      onLoading(false);
    }
  }, [api, files, onError, onLoading, onNotice, onRevisionReady, reportFailure]);

  const handleSmoke = useCallback(async () => {
    if (!snapshot || !selectedRevisionId) return;
    onLoading(true);
    onError(null);
    setFailure(null);
    try {
      const maxWindow = Math.min(endTimeMs, startTimeMs + 7 * 86_400_000);
      await api.smokeStrategyRevision(selectedRevisionId, {
        dataset_id: datasetId,
        snapshot_hash: snapshot.snapshot_hash,
        start_time_ms: startTimeMs,
        end_time_ms: maxWindow,
        parameters: schemaParameters,
        python_runtime_mode: runtimeMode,
        python_trusted_confirmed: runtimeMode === "TRUSTED_LOCAL" && trustedConfirmed,
      });
      setSmokePassed(true);
      onNotice(t("python.notice.smoke"));
    } catch (reason) {
      setSmokePassed(false);
      reportFailure(reason);
    } finally {
      onLoading(false);
    }
  }, [
    api,
    datasetId,
    endTimeMs,
    onError,
    onLoading,
    onNotice,
    reportFailure,
    runtimeMode,
    schemaParameters,
    selectedRevisionId,
    snapshot,
    startTimeMs,
    trustedConfirmed,
  ]);

  const inspectHashes = useMemo(() => {
    if (!inspectResult && !bundleIdentity) return null;
    return {
      bundle: String(inspectResult?.bundle_hash ?? bundleIdentity?.bundle_hash ?? ""),
      source: String(inspectResult?.source_hash ?? bundleIdentity?.source_hash ?? ""),
      manifest: String(inspectResult?.manifest_hash ?? bundleIdentity?.manifest_hash ?? ""),
    };
  }, [bundleIdentity, inspectResult]);

  return (
    <div className="backtest-strategy-help python-studio" data-testid="python-strategy-studio">
      <strong>{t("backtest.pythonStudio")}</strong>
      <p>{hostOwnsOrdersCopy()}</p>
      <div className="backtest-form-row">
        <label>
          {t("backtest.template")}
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value as typeof templateId)}>
            {PYTHON_TEMPLATES.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        <button type="button" disabled={loading} onClick={handleTemplate} data-testid="python-template-create">
          {t("backtest.fromTemplate")}
        </button>
      </div>
      {template && <p>{t(template.descriptionKey, {}, locale)}</p>}
      <div className="backtest-form-row">
        <label>
          {t("backtest.importZip")}
          <input
            type="file"
            accept=".zip,application/zip"
            data-testid="python-import-zip"
            onChange={(event) => void handleImport(event.target.files)}
          />
        </label>
        <label>
          {t("backtest.importDir")}
          <input
            type="file"
            data-testid="python-import-directory"
            multiple
            ref={(node) => {
              if (node) node.setAttribute("webkitdirectory", "");
            }}
            onChange={(event) => void handleImport(event.target.files)}
          />
        </label>
      </div>
      {missing.length > 0 && <p>{t("backtest.missingFiles", { list: missing.join("、") })}</p>}
      <label className="backtest-checkbox">
        <input type="checkbox" checked={showManifest} onChange={(event) => setShowManifest(event.target.checked)} />
        {t("backtest.viewManifest")}
      </label>
      {showManifest && (
        <textarea
          rows={8}
          readOnly
          value={generatedManifestPreview(files)}
          data-testid="python-generated-manifest"
        />
      )}
      <div className="backtest-form-row three">
        <button type="button" disabled={loading || missing.length > 0} onClick={() => void handleInspect()}>
          {t("backtest.inspect")}
        </button>
        <button type="button" disabled={loading || !inspectResult} onClick={() => void handleFreeze()}>
          {t("backtest.freeze")}
        </button>
        <button
          type="button"
          disabled={loading || !selectedRevisionId || !snapshot || !trustedReady}
          onClick={() => void handleSmoke()}
          data-testid="python-smoke"
        >
          {smokePassed ? t("backtest.smokeOk") : t("backtest.smokeRun")}
        </button>
      </div>
      {inspectHashes && (
        <div className="backtest-strategy-evidence" data-testid="python-bundle-identity">
          <strong>{t("backtest.bundleHash", { hash: `${inspectHashes.bundle.slice(0, 18)}…` })}</strong>
          <span>{t("backtest.sourceManifestHashes", {
            source: `${inspectHashes.source.slice(0, 18)}…`,
            manifest: `${inspectHashes.manifest.slice(0, 18)}…`,
          })}</span>
          <span>{t("backtest.unsupportedList", { list: PYTHON_UNSUPPORTED.join("；") })}</span>
        </div>
      )}
      <div className="backtest-strategy-evidence" data-testid="python-runtime-mode">
        <strong>{t("backtest.runtimeIso")}</strong>
        <label className="backtest-checkbox">
          <input
            type="radio"
            name="python-runtime-mode"
            checked={runtimeMode === "SANDBOXED_LOCAL"}
            onChange={() => { setRuntimeMode("SANDBOXED_LOCAL"); setTrustedConfirmed(false); }}
          />
          {t("backtest.sandboxed")}
        </label>
        <label className="backtest-checkbox">
          <input
            type="radio"
            name="python-runtime-mode"
            checked={runtimeMode === "TRUSTED_LOCAL"}
            onChange={() => setRuntimeMode("TRUSTED_LOCAL")}
          />
          {t("backtest.trusted")}
        </label>
        {runtimeMode === "TRUSTED_LOCAL" && (
          <div data-testid="python-trusted-facts">
            {TRUSTED_LOCAL_FACT_KEYS.map((key) => <span key={key}>{t(key, {}, locale)}</span>)}
            <small>{t("backtest.flagState", { state: trustedFlagEnabled ? t("backtest.flagOn") : t("backtest.flagOff") })}</small>
            <label className="backtest-checkbox">
              <input
                type="checkbox"
                checked={trustedConfirmed}
                onChange={(event) => setTrustedConfirmed(event.target.checked)}
                data-testid="python-trusted-confirm"
              />
              {trustedLocalConfirmLabel()}
            </label>
          </div>
        )}
      </div>
      <div className="backtest-snapshot" data-testid="python-coverage">
        <span className={coverage.ready ? "ready" : "pending"}>{coverage.ready ? t("backtest.coverOk") : t("backtest.coverNo")}</span>
        <div>
          <strong>{t("backtest.coverageRows", { rows: coverage.snapshotRows, warmup: coverage.warmupRows })}</strong>
          <small>{coverage.reason}</small>
        </div>
      </div>
      {failure && (
        <div className="backtest-strategy-evidence" data-testid="python-smoke-failure">
          <strong>{failure.code}{failure.line ? ` · ${failure.line}:${failure.column}` : ""}</strong>
          <span>{failure.message}</span>
          <small>{t("backtest.nextStep", { step: failure.nextStep })}</small>
        </div>
      )}
    </div>
  );
}
