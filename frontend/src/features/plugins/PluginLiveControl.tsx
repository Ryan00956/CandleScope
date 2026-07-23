import React, { useState } from "react";
import type {
  PluginLiveConfirmationPreview,
  PluginLiveConfirmationReceipt,
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
          <button type="button" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div className="plugin-modal-body">{children}</div>
      </section>
    </div>
  );
}

export function IntentFacts({ preview }: { preview: PluginLiveConfirmationPreview }) {
  return (
    <dl className="live-intent-facts" data-live-intent-facts>
      <dt>Environment</dt><dd>Live authority preview (execution unavailable in WP-E)</dd>
      <dt>Instrument</dt><dd>{preview.instrumentId}</dd>
      <dt>Side</dt><dd>{preview.side.toUpperCase()}</dd>
      <dt>Order type</dt><dd>{preview.orderType}</dd>
      <dt>Quantity</dt><dd>{preview.quantity}</dd>
      <dt>Limit price</dt><dd>{preview.limitPrice}</dd>
      <dt>Client order ID</dt><dd>{preview.clientOrderId}</dd>
      <dt>Plugin</dt><dd>{preview.pluginId} · {preview.version}</dd>
      <dt>Publisher</dt><dd>{preview.publisherIdentity}</dd>
      <dt>Connector</dt><dd>{preview.connectorId}</dd>
      <dt>Intent SHA-256</dt><dd>{preview.intentSha256}</dd>
      <dt>Authority</dt><dd>epoch {preview.policyEpoch} · generation {preview.controlGeneration}</dd>
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
    <HostModal title="Confirm exact Live intent" onClose={onClose} testId="live-intent-confirmation">
      <div className="live-warning-callout" role="alert">
        This Host-native receipt is short-lived and single-use. WP-E still has no Live submit or cancel method.
      </div>
      <IntentFacts preview={preview} />
      <label className="live-control-field">
        Type <strong>{phrase}</strong>
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
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
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
          {busy ? "Issuing…" : "Issue one-shot receipt"}
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
        Type <strong>{phrase}</strong>
        <input
          autoFocus
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
        />
      </label>
      <div className="plugin-action-row">
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="live-danger-action"
          disabled={typed !== phrase || busy}
          onClick={() => {
            setBusy(true);
            void onConfirm().then(onClose).catch(() => undefined).finally(() => setBusy(false));
          }}
        >
          {busy ? "Applying…" : title}
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
  const [scopeType, setScopeType] = useState<"grant" | "plugin" | "publisher" | "credential">("plugin");
  const [subject, setSubject] = useState("");
  const [reason, setReason] = useState("operator-revoke");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const management = runtime.view.managementAvailable;
  const canPreview = management && status.mode === "armed" && accountRef.length > 0 && shadowRef.length > 0;
  const pendingContract = pending == null ? null : (
    pending.kind === "arm"
      ? {
          title: "Arm Live control",
          phrase: "ARM LIVE CONTROL",
          detail: "Arming permits short-lived confirmation receipts only. WP-E has no execution method.",
          run: () => runtime.actions.setLiveControlMode("armed", "host-native-user-arm", status.mode === "killed"),
        }
      : pending.kind === "disarm"
        ? {
            title: "Disarm Live control",
            phrase: "DISARM LIVE CONTROL",
            detail: "Disarming revokes every outstanding confirmation receipt.",
            run: () => runtime.actions.setLiveControlMode("disarmed", "host-native-user-disarm", false),
          }
        : pending.kind === "kill"
          ? {
              title: "Apply global Live kill",
              phrase: "KILL LIVE AUTHORITY",
              detail: "This advances the policy epoch and revokes credentials, accounts, and all outstanding receipts.",
              run: () => runtime.actions.killLiveControl("host-native-global-kill"),
            }
          : {
              title: "Revoke Live authority",
              phrase: "REVOKE LIVE AUTHORITY",
              detail: "This conservative revoke advances the global policy epoch before the next network-capable action.",
              run: () => runtime.actions.revokeLiveAuthority(
                pending.scopeType,
                pending.subject,
                pending.reason,
              ),
            }
  );
  return (
    <>
      <HostModal title="Live authority control" onClose={runtime.actions.closeLiveControl} testId="live-control-panel">
        <section className={`live-control-summary live-control-${status.mode}`}>
          <div>
            <span>Persistent Host control</span>
            <strong>{status.mode.toUpperCase()}</strong>
          </div>
          <p>
            policy epoch {status.policyEpoch} · control generation {status.generation}
            {" · "}{status.outstandingConfirmationCount} outstanding receipt(s)
          </p>
          <p>Live submit, cancel, transfer, and withdrawal remain unavailable in WP-E.</p>
        </section>
        {!management && <p role="alert">Trusted desktop management session unavailable. Controls are read-only.</p>}
        <div className="plugin-action-row live-control-primary-actions">
          <button
            type="button"
            disabled={!management || !status.available || status.mode === "armed"}
            onClick={() => setPending({ kind: "arm" })}
          >
            Arm receipt control
          </button>
          <button
            type="button"
            disabled={!management || status.mode !== "armed"}
            onClick={() => setPending({ kind: "disarm" })}
          >
            Disarm
          </button>
          <button
            type="button"
            className="live-danger-action"
            disabled={!management || !status.available}
            onClick={() => setPending({ kind: "kill" })}
            data-live-global-kill
          >
            Global kill
          </button>
          <button type="button" disabled={!management || !status.available} onClick={() => void runtime.actions.downloadLiveAudit()}>
            Download redacted audit
          </button>
        </div>

        <section className="live-control-section">
          <h3>Review an exact prepared intent</h3>
          <p>
            These opaque references come from the Host-owned WP-D preparation flow. They are not credentials.
          </p>
          <label className="live-control-field">
            Account reference
            <input value={accountRef} onChange={(event) => setAccountRef(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className="live-control-field">
            Shadow reference
            <input value={shadowRef} onChange={(event) => setShadowRef(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <button
            type="button"
            disabled={!canPreview}
            data-preview-live-confirmation
            onClick={() => {
              setPreview(null);
              void runtime.actions.previewLiveConfirmation(accountRef, shadowRef).then(setPreview).catch(() => undefined);
            }}
          >
            Load Host preview
          </button>
          {receipt && (
            <div className="live-receipt-summary" data-live-receipt-issued>
              <strong>One-shot receipt issued</strong>
              <span>ID {receipt.receiptId} · expires {receipt.expiresAt}</span>
              <button type="button" onClick={() => void runtime.actions.revokeLiveConfirmation(receipt.receiptRef, "host-native-receipt-revoke").then(() => setReceipt(null)).catch(() => undefined)}>
                Revoke receipt
              </button>
            </div>
          )}
        </section>

        <section className="live-control-section">
          <h3>Emergency authority revoke</h3>
          <div className="live-revoke-grid">
            <label className="live-control-field">
              Scope
              <select value={scopeType} onChange={(event) => setScopeType(event.target.value as typeof scopeType)}>
                <option value="grant">Grant</option>
                <option value="plugin">Plugin</option>
                <option value="publisher">Publisher</option>
                <option value="credential">Credential</option>
              </select>
            </label>
            <label className="live-control-field">
              Subject
              <input value={subject} onChange={(event) => setSubject(event.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label className="live-control-field">
              Reason
              <input value={reason} onChange={(event) => setReason(event.target.value)} autoComplete="off" />
            </label>
          </div>
          <button
            type="button"
            className="live-danger-action"
            disabled={!management || !status.available || !subject.trim() || !reason.trim()}
            onClick={() => setPending({ kind: "revoke", scopeType, subject: subject.trim(), reason: reason.trim() })}
          >
            Revoke and advance epoch
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
    </>
  );
}

export default function PluginLiveControl({ runtime }: { runtime: PluginPlatformRuntime }) {
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
        <strong>LIVE AUTHORITY · {status.mode.toUpperCase()}</strong>
        <span>
          {status.mode === "armed"
            ? "Receipt control armed; execution still unavailable"
            : status.mode === "killed"
              ? "Global kill active"
              : status.mode === "unavailable"
                ? "Control status unavailable — fail closed"
                : "Receipt control disarmed"}
        </span>
      </button>
      {runtime.view.liveControlOpen && <LiveControlPanel runtime={runtime} />}
    </>
  );
}
