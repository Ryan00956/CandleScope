import React, { useState } from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type {
  PluginLiveConfirmationPreview,
  PluginLiveConfirmationReceipt,
  PluginLiveExecutionRecord,
  PluginPlatformRuntime,
} from "./pluginPlatformTypes.js";

function HostModal({
  title,
  onClose,
  children,
  testId,
}: React.PropsWithChildren<{
  title: string;
  onClose(): void;
  testId: string;
}>) {
  return (
    <div
      className="plugin-modal-overlay live-host-modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="plugin-modal live-host-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" aria-label={t("plugin.host.close")} onClick={onClose}>×</button>
        </header>
        <div className="plugin-modal-body">{children}</div>
      </section>
    </div>
  );
}

export function IntentFacts({ preview }: { preview: PluginLiveConfirmationPreview }) {
  const execution = preview.schemaVersion === "candlescope.live-confirmation-preview/2";
  return (
    <dl className="live-intent-facts" data-live-intent-facts>
      <dt>{t("plugin.live.environment")}</dt><dd>{execution ? t("plugin.live.demoSpot") : t("plugin.live.previewOnly")}</dd>
      {preview.action && <><dt>{t("plugin.live.action")}</dt><dd>{preview.action.toUpperCase()}</dd></>}
      <dt>{t("plugin.live.instrument")}</dt><dd>{preview.instrumentId}</dd>
      <dt>{t("plugin.live.side")}</dt><dd>{preview.side.toUpperCase()}</dd>
      <dt>{t("plugin.live.orderType")}</dt><dd>{preview.orderType}</dd>
      <dt>{t("plugin.live.quantity")}</dt><dd>{preview.quantity}</dd>
      <dt>{t("plugin.live.limitPrice")}</dt><dd>{preview.limitPrice}</dd>
      <dt>{t("plugin.live.clientOrderId")}</dt><dd>{preview.clientOrderId}</dd>
      <dt>{t("plugin.live.plugin")}</dt><dd>{preview.pluginId} · {preview.version}</dd>
      <dt>{t("plugin.host.publisher")}</dt><dd>{preview.publisherIdentity}</dd>
      <dt>{t("plugin.live.connector")}</dt><dd>{preview.connectorId}</dd>
      <dt>{t("plugin.live.intentDigest")}</dt><dd>{preview.intentSha256}</dd>
      {preview.orderIntentSha256 && <><dt>{t("plugin.live.orderIntentDigest")}</dt><dd>{preview.orderIntentSha256}</dd></>}
      {preview.notional && <><dt>{t("plugin.live.notional")}</dt><dd>{preview.notional} USDT</dd></>}
      <dt>{t("plugin.live.authority")}</dt><dd>{t("plugin.live.authorityValue", { epoch: preview.policyEpoch, generation: preview.controlGeneration })}</dd>
    </dl>
  );
}

function ExactIntentDialog({
  runtime,
  accountRef,
  shadowRef,
  preview,
  onClose,
  onIssued,
}: {
  runtime: PluginPlatformRuntime;
  accountRef: string;
  shadowRef: string;
  preview: PluginLiveConfirmationPreview;
  onClose(): void;
  onIssued(receipt: PluginLiveConfirmationReceipt): void;
}) {
  const phrase = "CONFIRM LIVE INTENT";
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <HostModal title={t("plugin.host.liveConfirm")} onClose={onClose} testId="live-intent-confirmation">
      <div className="live-warning-callout" role="alert">
        {t("plugin.live.receiptWarning")}
      </div>
      <IntentFacts preview={preview} />
      <label className="live-control-field">
        {t("plugin.live.typePhrase", { phrase })}
        <input
          autoFocus
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
          data-live-confirmation-phrase
        />
      </label>
      <div className="plugin-action-row">
        <button type="button" onClick={onClose} disabled={busy}>{t("plugin.host.cancel")}</button>
        <button
          type="button"
          className="live-danger-action"
          data-issue-live-confirmation
          disabled={typed !== phrase || busy}
          onClick={() => {
            setBusy(true);
            void runtime.actions.issueLiveConfirmation(accountRef, shadowRef, preview)
              .then((receipt) => {
                onIssued(receipt);
                onClose();
              })
              .catch(() => undefined)
              .finally(() => setBusy(false));
          }}
        >
          {busy ? t("plugin.live.issuing") : t("plugin.live.issueReceipt")}
        </button>
      </div>
    </HostModal>
  );
}

function TypedActionDialog({
  title,
  phrase,
  detail,
  onClose,
  onConfirm,
}: {
  title: string;
  phrase: string;
  detail: string;
  onClose(): void;
  onConfirm(): Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <HostModal title={title} onClose={onClose} testId="live-control-action-confirmation">
      <div className="live-warning-callout" role="alert">{detail}</div>
      <label className="live-control-field">
        {t("plugin.live.typePhrase", { phrase })}
        <input
          autoFocus
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
        />
      </label>
      <div className="plugin-action-row">
        <button type="button" disabled={busy} onClick={onClose}>{t("plugin.host.cancel")}</button>
        <button
          type="button"
          className="live-danger-action"
          disabled={typed !== phrase || busy}
          onClick={() => {
            setBusy(true);
            void onConfirm().then(onClose).catch(() => undefined).finally(() => setBusy(false));
          }}
        >
          {busy ? t("plugin.live.applying") : title}
        </button>
      </div>
    </HostModal>
  );
}

type PendingAction =
  | { kind: "arm" }
  | { kind: "disarm" }
  | { kind: "kill" }
  | { kind: "revoke"; scopeType: "grant" | "plugin" | "publisher" | "credential"; subject: string; reason: string };

function LiveControlPanel({ runtime }: { runtime: PluginPlatformRuntime }) {
  const status = runtime.view.liveControl;
  const [accountRef, setAccountRef] = useState("");
  const [shadowRef, setShadowRef] = useState("");
  const [preview, setPreview] = useState<PluginLiveConfirmationPreview | null>(null);
  const [receipt, setReceipt] = useState<PluginLiveConfirmationReceipt | null>(null);
  const [execution, setExecution] = useState<PluginLiveExecutionRecord | null>(null);
  const [executePending, setExecutePending] = useState(false);
  const [scopeType, setScopeType] = useState<"grant" | "plugin" | "publisher" | "credential">("plugin");
  const [subject, setSubject] = useState("");
  const [reason, setReason] = useState("operator-revoke");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const management = runtime.view.managementAvailable;
  const demoExecution = status.liveSubmitAvailable && status.liveCancelAvailable;
  const canPreview = management && status.mode === "armed" && accountRef.length > 0 && shadowRef.length > 0;
  const pendingContract = pending == null ? null : (
    pending.kind === "arm"
      ? {
          title: t("plugin.live.armTitle"),
          phrase: "ARM LIVE CONTROL",
          detail: demoExecution
            ? t("plugin.live.armExecutionDetail")
            : t("plugin.live.armReceiptDetail"),
          run: () => runtime.actions.setLiveControlMode("armed", "host-native-user-arm", status.mode === "killed"),
        }
      : pending.kind === "disarm"
        ? {
            title: t("plugin.live.disarmTitle"),
            phrase: "DISARM LIVE CONTROL",
            detail: t("plugin.live.disarmDetail"),
            run: () => runtime.actions.setLiveControlMode("disarmed", "host-native-user-disarm", false),
          }
        : pending.kind === "kill"
          ? {
              title: t("plugin.live.killTitle"),
              phrase: "KILL LIVE AUTHORITY",
              detail: t("plugin.live.killDetail"),
              run: () => runtime.actions.killLiveControl("host-native-global-kill"),
            }
          : {
              title: t("plugin.live.revokeTitle"),
              phrase: "REVOKE LIVE AUTHORITY",
              detail: t("plugin.live.revokeDetail"),
              run: () => runtime.actions.revokeLiveAuthority(
                pending.scopeType,
                pending.subject,
                pending.reason,
              ),
            }
  );
  return (
    <>
      <HostModal title={t("plugin.host.liveAuthority")} onClose={runtime.actions.closeLiveControl} testId="live-control-panel">
        <section className={`live-control-summary live-control-${status.mode}`}>
          <div>
            <span>{t("plugin.live.persistentControl")}</span>
            <strong>{status.mode.toUpperCase()}</strong>
          </div>
          <p>
            {t("plugin.live.summary", { epoch: status.policyEpoch, generation: status.generation, count: status.outstandingConfirmationCount })}
          </p>
          <p>
            {demoExecution
              ? t("plugin.live.executionEnabled")
              : t("plugin.live.executionUnavailable")}
          </p>
        </section>
        {!management && <p role="alert">{t("plugin.live.readonly")}</p>}
        <div className="plugin-action-row live-control-primary-actions">
          <button
            type="button"
            disabled={!management || !status.available || status.mode === "armed"}
            onClick={() => setPending({ kind: "arm" })}
          >
            {t("plugin.live.arm")}
          </button>
          <button
            type="button"
            disabled={!management || status.mode !== "armed"}
            onClick={() => setPending({ kind: "disarm" })}
          >
            {t("plugin.live.disarm")}
          </button>
          <button
            type="button"
            className="live-danger-action"
            disabled={!management || !status.available}
            onClick={() => setPending({ kind: "kill" })}
            data-live-global-kill
          >
            {t("plugin.live.globalKill")}
          </button>
          <button type="button" disabled={!management || !status.available} onClick={() => void runtime.actions.downloadLiveAudit()}>
            {t("plugin.live.downloadAudit")}
          </button>
        </div>

        <section className="live-control-section">
          <h3>{t("plugin.live.reviewTitle")}</h3>
          <p>
            {t("plugin.live.reviewHint")}
          </p>
          <label className="live-control-field">
            {t("plugin.live.accountRef")}
            <input value={accountRef} onChange={(event) => setAccountRef(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className="live-control-field">
            {t("plugin.live.shadowRef")}
            <input value={shadowRef} onChange={(event) => setShadowRef(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <button
            type="button"
            disabled={!canPreview}
            data-preview-live-confirmation
            onClick={() => {
              setPreview(null);
              setReceipt(null);
              void runtime.actions.previewLiveConfirmation(accountRef, shadowRef).then(setPreview).catch(() => undefined);
            }}
          >
            {t("plugin.live.loadPreview")}
          </button>
          {receipt && (
            <div className="live-receipt-summary" data-live-receipt-issued>
              <strong>{t("plugin.live.receiptIssued")}</strong>
              <span>{t("plugin.live.receiptMeta", { id: receipt.receiptId, expires: receipt.expiresAt })}</span>
              {receipt.schemaVersion === "candlescope.live-confirmation/2" && receipt.action && (
                <>
                  <span>{t("plugin.live.boundAction", { action: receipt.action.toUpperCase() })}</span>
                  <button
                    type="button"
                    className="live-danger-action"
                    data-execute-live-action
                    onClick={() => setExecutePending(true)}
                  >
                    {receipt.action === "submit" ? t("plugin.live.submitDemo") : t("plugin.live.cancelDemo")}
                  </button>
                </>
              )}
              <button type="button" onClick={() => void runtime.actions.revokeLiveConfirmation(receipt.receiptRef, "host-native-receipt-revoke").then(() => setReceipt(null)).catch(() => undefined)}>
                {t("plugin.live.revokeReceipt")}
              </button>
            </div>
          )}
          {execution && (
            <div className="live-receipt-summary" data-live-execution-result>
              <strong>{t("plugin.live.executionResult", { state: execution.state })}</strong>
              <span>
                {execution.clientOrderId} · {execution.notional} USDT
                {execution.terminal ? ` · ${t("plugin.live.terminal")}` : ""}
              </span>
              {execution.reconciliationRequired && (
                <button
                  type="button"
                  data-reconcile-live-execution
                  onClick={() => {
                    void runtime.actions.reconcileLiveExecution(accountRef, shadowRef)
                      .then((record) => {
                        setExecution(record);
                        setPreview(null);
                      })
                      .catch(() => undefined);
                  }}
                >
                  {t("plugin.live.reconcile")}
                </button>
              )}
              {!execution.reconciliationRequired && !execution.terminal && (
                <span>{t("plugin.live.freshPreview")}</span>
              )}
            </div>
          )}
        </section>

        <section className="live-control-section">
          <h3>{t("plugin.live.emergencyRevoke")}</h3>
          <div className="live-revoke-grid">
            <label className="live-control-field">
              {t("plugin.live.scope")}
              <select value={scopeType} onChange={(event) => setScopeType(event.target.value as typeof scopeType)}>
                <option value="grant">{t("plugin.live.grant")}</option>
                <option value="plugin">{t("plugin.live.plugin")}</option>
                <option value="publisher">{t("plugin.host.publisher")}</option>
                <option value="credential">{t("plugin.live.credential")}</option>
              </select>
            </label>
            <label className="live-control-field">
              {t("plugin.live.subject")}
              <input value={subject} onChange={(event) => setSubject(event.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label className="live-control-field">
              {t("plugin.live.reason")}
              <input value={reason} onChange={(event) => setReason(event.target.value)} autoComplete="off" />
            </label>
          </div>
          <button
            type="button"
            className="live-danger-action"
            disabled={!management || !status.available || !subject.trim() || !reason.trim()}
            onClick={() => setPending({ kind: "revoke", scopeType, subject: subject.trim(), reason: reason.trim() })}
          >
            {t("plugin.live.revokeEpoch")}
          </button>
        </section>
      </HostModal>
      {preview && (
        <ExactIntentDialog
          runtime={runtime}
          accountRef={accountRef}
          shadowRef={shadowRef}
          preview={preview}
          onClose={() => setPreview(null)}
          onIssued={setReceipt}
        />
      )}
      {pendingContract && (
        <TypedActionDialog
          title={pendingContract.title}
          phrase={pendingContract.phrase}
          detail={pendingContract.detail}
          onClose={() => setPending(null)}
          onConfirm={pendingContract.run}
        />
      )}
      {executePending
        && receipt?.schemaVersion === "candlescope.live-confirmation/2"
        && receipt.action && (
          <TypedActionDialog
            title={receipt.action === "submit" ? t("plugin.live.submitDemo") : t("plugin.live.cancelDemo")}
            phrase={receipt.action === "submit" ? "EXECUTE DEMO SUBMIT" : "EXECUTE DEMO CANCEL"}
            detail={
              receipt.action === "submit"
                ? t("plugin.live.submitDetail")
                : t("plugin.live.cancelDetail")
            }
            onClose={() => setExecutePending(false)}
            onConfirm={async () => {
              const result = receipt.action === "submit"
                ? await runtime.actions.submitLiveExecution(accountRef, shadowRef, receipt)
                : await runtime.actions.cancelLiveExecution(accountRef, shadowRef, receipt);
              setExecution(result);
              setReceipt(null);
              setPreview(null);
            }}
          />
        )}
    </>
  );
}

export default function PluginLiveControl({ runtime }: { runtime: PluginPlatformRuntime }) {
  useLocale();
  const status = runtime.view.liveControl;
  if (status.mode === "disabled") return null;
  return (
    <>
      <button
        type="button"
        className={`live-control-banner live-control-${status.mode}`}
        data-live-control-banner
        data-live-control-mode={status.mode}
        onClick={runtime.actions.openLiveControl}
      >
        <strong>{t("plugin.live.banner", { mode: status.mode.toUpperCase() })}</strong>
        <span>
          {status.mode === "armed"
            ? status.liveSubmitAvailable
              ? t("plugin.live.bannerArmedExecution")
              : t("plugin.live.bannerArmedReceipt")
            : status.mode === "killed"
              ? t("plugin.live.bannerKilled")
              : status.mode === "unavailable"
                ? t("plugin.live.bannerUnavailable")
                : t("plugin.live.bannerDisarmed")}
        </span>
      </button>
      {runtime.view.liveControlOpen && <LiveControlPanel runtime={runtime} />}
    </>
  );
}
