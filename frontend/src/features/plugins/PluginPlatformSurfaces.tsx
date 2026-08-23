import React, { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import { PluginNativeField } from "./PluginNativeFields.js";
import SandboxPluginFrame from "./SandboxPluginFrame.js";
import { defaultForPluginSchema } from "./pluginSchemaDefaults.js";
import { formatPluginValue } from "./pluginViewFormatting.js";
import { localizePluginContribution } from "./pluginLocalization.js";
import type {
  JsonValue,
  PluginCommandContribution,
  PluginCommandFileInput,
  PluginDeclarativeViewContribution,
  PluginManagementDetail,
  PluginLocalInstallCandidate,
  PluginJsonSchema,
  PluginMarketplaceStatus,
  PluginPlatformRuntime,
  PluginPaperContribution,
  PluginProviderContribution,
  PluginRuntimeRegistryStatus,
  PluginTrustReview,
  PluginTrustSummary,
  PluginTrustChangeReview,
  PluginSandboxViewContribution,
  PluginSettingsContribution,
  PluginViewContribution,
  PluginViewProjection,
  PluginV1CompatibilityPreview,
} from "./pluginPlatformTypes.js";

function isSandboxView(
  contribution: PluginViewContribution,
): contribution is PluginSandboxViewContribution {
  return contribution.configuration.renderer === "sandbox";
}

export class PluginUiErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error("Plugin UI failed safely", error);
  }

  render() {
    return this.state.failed
      ? <div className="plugin-ui-fallback" role="alert">{t("plugin.host.uiUnavailable")}</div>
      : this.props.children;
  }
}

function objectDefault(command: PluginCommandContribution): Record<string, JsonValue> {
  const schema = command.configuration.inputSchema;
  if (!schema) return {};
  const value = defaultForPluginSchema(schema);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

interface NativeSaveDestination {
  createWritable(): Promise<{
    write(value: Blob): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}

type NativeSavePicker = (options: { suggestedName: string }) => Promise<NativeSaveDestination>;

interface FileDownloadReceipt {
  downloadId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
}

function commandNativeSchema(command: PluginCommandContribution): PluginJsonSchema | null {
  const schema = command.configuration.inputSchema;
  if (!schema || schema.type !== "object") return schema ?? null;
  const hidden = new Set((command.configuration.fileInputs ?? []).map((item) => item.field));
  const properties = Object.fromEntries(
    Object.entries(schema.properties ?? {}).filter(([key]) => !hidden.has(key)),
  );
  if (!Object.keys(properties).length) return null;
  return {
    ...schema,
    properties,
    required: (schema.required ?? []).filter((key) => !hidden.has(key)),
  };
}

function fileDownloadReceipt(value: JsonValue): FileDownloadReceipt | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value.fileDownload;
  if (candidate == null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (
    Object.keys(candidate).sort().join(",") !== "downloadId,mediaType,name,sha256,size"
    || typeof candidate.downloadId !== "string"
    || !/^ufd_[A-Za-z0-9_-]{40,128}$/.test(candidate.downloadId)
    || typeof candidate.name !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(candidate.name)
    || typeof candidate.mediaType !== "string"
    || !/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(candidate.mediaType)
    || typeof candidate.size !== "number"
    || !Number.isSafeInteger(candidate.size)
    || candidate.size < 0
    || candidate.size > 128 * 1024
    || typeof candidate.sha256 !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(candidate.sha256)
  ) throw new Error("Plugin returned an invalid file download receipt");
  return candidate as unknown as FileDownloadReceipt;
}

async function writeSelectedDestination(
  runtime: PluginPlatformRuntime,
  pluginId: string,
  config: PluginCommandFileInput,
  destination: NativeSaveDestination,
  receipt: FileDownloadReceipt,
): Promise<void> {
  if (
    config.mode !== "save"
    || receipt.name !== config.suggestedName
    || !config.accept.includes(receipt.mediaType)
    || receipt.size > config.maxBytes
  ) throw new Error(t("plugin.host.fileDownloadContract"));
  const blob = await runtime.actions.downloadUserFile(pluginId, receipt.downloadId);
  if (blob.size !== receipt.size || blob.size > config.maxBytes) {
    throw new Error(t("plugin.host.fileReceiptMismatch"));
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  const actual = `sha256:${[...digest].map((item) => item.toString(16).padStart(2, "0")).join("")}`;
  if (actual !== receipt.sha256) throw new Error(t("plugin.host.fileIntegrityFailed"));
  const writable = await destination.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => undefined);
    throw error;
  }
}

function Modal({ title, onClose, children, testId }: React.PropsWithChildren<{
  title: string;
  onClose(): void;
  testId: string;
}>) {
  return (
    <div className="plugin-modal-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="plugin-modal" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <header><h2>{title}</h2><button type="button" aria-label={t("plugin.host.close")} onClick={onClose}>×</button></header>
        <div className="plugin-modal-body">{children}</div>
      </section>
    </div>
  );
}

function CommandPalette({ runtime }: { runtime: PluginPlatformRuntime }) {
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState<Record<string, JsonValue>>({});
  const [running, setRunning] = useState(false);
  const [fileBusy, setFileBusy] = useState<string | null>(null);
  const [fileStatus, setFileStatus] = useState<Record<string, string>>({});
  const saveDestinations = useRef(new Map<string, NativeSaveDestination>());
  const commands = runtime.view.registries.commandPalette.filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));
  const selected = runtime.view.registries.commandPalette.find((item) => item.id === selectedId) ?? null;
  useEffect(() => {
    if (!runtime.view.paletteOpen) {
      setQuery("");
      setSelectedId(null);
      setFileBusy(null);
      setFileStatus({});
      saveDestinations.current.clear();
    }
  }, [runtime.view.paletteOpen]);
  if (!runtime.view.paletteOpen) return null;
  const fileInputs = selected?.configuration.fileInputs ?? [];
  const nativeSchema = selected ? commandNativeSchema(selected) : null;
  const filesReady = fileInputs.every((item) => typeof input[item.field] === "string" && String(input[item.field]).length > 0);
  return (
    <Modal title={t("plugin.host.paletteTitle")} onClose={runtime.actions.closePalette} testId="plugin-command-palette">
      <input autoFocus className="plugin-command-search" placeholder={t("plugin.host.searchCommands")} value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="plugin-command-layout">
        <nav>
          {commands.map((command) => (
            <button
              type="button"
              key={command.id}
              className={selectedId === command.id ? "active" : ""}
              onClick={() => {
                setSelectedId(command.id);
                setInput(objectDefault(command));
                setFileBusy(null);
                setFileStatus({});
                saveDestinations.current.clear();
              }}
            >
              <strong>{command.title}</strong><small>{command.id}</small>
            </button>
          ))}
        </nav>
        <div className="plugin-command-form">
          {!selected && <p>{t("plugin.host.selectCommand")}</p>}
          {selected && (
            <>
              {nativeSchema && (
                <PluginNativeField
                  name="root"
                  schema={nativeSchema}
                  value={input}
                  locale={locale}
                  onChange={(value) => {
                    if (value && typeof value === "object" && !Array.isArray(value)) setInput(value);
                  }}
                />
              )}
              {fileInputs.map((fileInput) => (
                <div className="plugin-command-file" key={fileInput.field} data-plugin-file-mode={fileInput.mode}>
                  <strong>{fileInput.mode === "open" ? t("plugin.host.selectInputFile") : t("plugin.host.selectSaveDestination")}</strong>
                  <small>{t("plugin.host.fileContract", { types: fileInput.accept.join(", "), bytes: fileInput.maxBytes })}</small>
                  {fileInput.mode === "open" ? (
                    <input
                      type="file"
                      accept={fileInput.accept.join(",")}
                      disabled={fileBusy !== null || running}
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (!file) return;
                        if (!fileInput.accept.includes(file.type) || file.size < 1 || file.size > fileInput.maxBytes) {
                          setFileStatus((current) => ({ ...current, [fileInput.field]: t("plugin.host.fileOutOfScope") }));
                          return;
                        }
                        setFileBusy(fileInput.field);
                        try {
                          const selection = await runtime.actions.stageUserFile(selected.id, fileInput.field, file);
                          setInput((current) => ({ ...current, [fileInput.field]: selection.handle }));
                          setFileStatus((current) => ({ ...current, [fileInput.field]: t("plugin.host.fileSelectedRead", { name: selection.name }) }));
                        } catch (error) {
                          setFileStatus((current) => ({ ...current, [fileInput.field]: error instanceof Error ? error.message : t("plugin.host.fileSelectionFailed") }));
                        } finally {
                          setFileBusy(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={fileBusy !== null || running}
                      onClick={async () => {
                        const picker = (window as unknown as { showSaveFilePicker?: NativeSavePicker }).showSaveFilePicker;
                        if (!picker || !fileInput.suggestedName) {
                          setFileStatus((current) => ({ ...current, [fileInput.field]: t("plugin.host.nativeSaveRequired") }));
                          return;
                        }
                        setFileBusy(fileInput.field);
                        try {
                          const destination = await picker.call(window, { suggestedName: fileInput.suggestedName });
                          const selection = await runtime.actions.prepareUserFileSave(selected.id, fileInput.field);
                          saveDestinations.current.set(fileInput.field, destination);
                          setInput((current) => ({ ...current, [fileInput.field]: selection.handle }));
                          setFileStatus((current) => ({ ...current, [fileInput.field]: t("plugin.host.fileSelectedWrite", { name: selection.name }) }));
                        } catch (error) {
                          setFileStatus((current) => ({ ...current, [fileInput.field]: error instanceof Error ? error.message : t("plugin.host.saveNotSelected") }));
                        } finally {
                          setFileBusy(null);
                        }
                      }}
                    >
                      {t("plugin.host.chooseDestination")}
                    </button>
                  )}
                  {fileStatus[fileInput.field] && <span role="status">{fileStatus[fileInput.field]}</span>}
                </div>
              ))}
              <button
                type="button"
                disabled={!runtime.view.managementAvailable || running || fileBusy !== null || !filesReady}
                onClick={async () => {
                  setRunning(true);
                  let commandInvoked = false;
                  try {
                    const result = await runtime.actions.invokeCommand(selected.id, input);
                    commandInvoked = true;
                    const receipt = fileDownloadReceipt(result);
                    const output = fileInputs.find((item) => item.mode === "save");
                    if (output && !receipt) throw new Error("Plugin did not return the selected file output");
                    if (receipt) {
                      const destination = output ? saveDestinations.current.get(output.field) : undefined;
                      if (!output || !destination) throw new Error("Plugin returned a file without a selected destination");
                      await writeSelectedDestination(runtime, selected.pluginId, output, destination, receipt);
                    }
                    runtime.actions.closePalette();
                  } catch (error) {
                    if (commandInvoked) runtime.actions.clearNotice();
                    const statusField = fileInputs.find((item) => item.mode === "save")?.field
                      ?? fileInputs[0]?.field;
                    if (statusField) {
                      setFileStatus((current) => ({
                        ...current,
                        [statusField]: error instanceof Error
                          ? error.message
                          : t("plugin.host.commandFileFailed"),
                      }));
                    }
                    setInput((current) => {
                      const next = { ...current };
                      for (const item of fileInputs) delete next[item.field];
                      return next;
                    });
                    saveDestinations.current.clear();
                  } finally {
                    setRunning(false);
                  }
                }}
              >
                {running ? t("plugin.host.running") : t("plugin.host.runCommand")}
              </button>
              {!runtime.view.managementAvailable && <small>{t("plugin.host.managementRequired")}</small>}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SettingsSurface({ runtime, contribution }: {
  runtime: PluginPlatformRuntime;
  contribution: PluginSettingsContribution;
}) {
  const locale = useLocale();
  const [value, setValue] = useState<Record<string, JsonValue>>(contribution.configuration.defaults);
  const [loading, setLoading] = useState(runtime.view.managementAvailable);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const readSettings = runtime.actions.readSettings;
  useEffect(() => {
    let active = true;
    if (!runtime.view.managementAvailable) return () => { active = false; };
    setLoading(true);
    setLoadError(null);
    readSettings(contribution.id)
      .then((next) => { if (active) setValue(next); })
      .catch(() => { if (active) setLoadError(t("plugin.host.settingsLoadFailed")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [contribution.id, readSettings, runtime.view.managementAvailable]);
  return (
    <Modal title={contribution.title} onClose={runtime.actions.closeSettings} testId="plugin-settings">
      {!runtime.view.managementAvailable && <p>{t("plugin.host.settingsReadonly")}</p>}
      {loadError && <p role="alert">{loadError}</p>}
      {loading ? <p>{t("plugin.host.settingsLoading")}</p> : (
        <PluginNativeField
          name="root"
          schema={contribution.configuration.schema}
          value={value}
          locale={locale}
          onChange={(next) => {
            if (next && typeof next === "object" && !Array.isArray(next)) setValue(next);
          }}
        />
      )}
      <button
        type="button"
        disabled={!runtime.view.managementAvailable || loading || saving || loadError !== null}
        onClick={async () => {
          setSaving(true);
          try { setValue(await runtime.actions.writeSettings(contribution.id, value)); } catch { /* notice published */ }
          finally { setSaving(false); }
        }}
      >
        {saving ? t("plugin.host.saving") : t("plugin.host.saveSettings")}
      </button>
    </Modal>
  );
}

function ViewContent({ contribution, projection }: {
  contribution: PluginDeclarativeViewContribution;
  projection: PluginViewProjection | undefined;
}) {
  if (!projection || projection.state === "empty") return <p>{contribution.configuration.emptyState}</p>;
  if (projection.state === "error") return <p role="alert">{t("plugin.host.viewInvalid")}</p>;
  if ("rows" in projection.data) {
    if (contribution.configuration.renderer === "list") {
      return (
        <ul className="plugin-native-list">
          {projection.data.rows.map((row, index) => (
            <li key={index}>{contribution.configuration.fields.map((field) => (
              <span key={field.field}><strong>{field.label}</strong> {formatPluginValue(row[field.field], field.format)}</span>
            ))}</li>
          ))}
        </ul>
      );
    }
    return (
      <div className="plugin-native-table-wrap">
        <table className="plugin-native-table">
          <thead><tr>{contribution.configuration.fields.map((field) => <th key={field.field}>{field.label}</th>)}</tr></thead>
          <tbody>{projection.data.rows.map((row, index) => (
            <tr key={index}>{contribution.configuration.fields.map((field) => <td key={field.field}>{formatPluginValue(row[field.field], field.format)}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    );
  }
  const values = projection.data.values;
  return (
    <dl className="plugin-native-detail">
      {contribution.configuration.fields.map((field) => (
        <React.Fragment key={field.field}>
          <dt>{field.label}</dt><dd>{formatPluginValue(values[field.field], field.format)}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function ViewSurface({ runtime, contribution }: {
  runtime: PluginPlatformRuntime;
  contribution: PluginViewContribution;
}) {
  if (isSandboxView(contribution)) {
    return (
      <aside
        className={`plugin-view-surface plugin-view-${contribution.configuration.slot}`}
        data-plugin-slot={contribution.configuration.slot}
        data-plugin-view={contribution.id}
        data-plugin-renderer="sandbox"
        aria-label={contribution.title}
      >
        <header><h2>{contribution.title}</h2><button type="button" aria-label={t("plugin.host.close")} onClick={runtime.actions.closeView}>×</button></header>
        <PluginUiErrorBoundary>
          <SandboxPluginFrame runtime={runtime} contribution={contribution} />
        </PluginUiErrorBoundary>
      </aside>
    );
  }
  const candidate = runtime.view.snapshot?.views.find((item) => item.id === contribution.id);
  const projection = candidate
    && candidate.pluginId === contribution.pluginId
    && candidate.slot === contribution.configuration.slot
    && candidate.renderer === contribution.configuration.renderer
    ? candidate
    : undefined;
  const projectionMismatch = candidate !== undefined && projection === undefined;
  const primaryCommand = contribution.configuration.primaryCommand
    ? runtime.view.registries.commandPalette.find((item) => item.pluginId === contribution.pluginId && item.localId === contribution.configuration.primaryCommand)
      ?? runtime.view.registries.topToolbar.find((item) => item.pluginId === contribution.pluginId && item.localId === contribution.configuration.primaryCommand)
      ?? runtime.view.registries.chartContextMenu.find((item) => item.pluginId === contribution.pluginId && item.localId === contribution.configuration.primaryCommand)
    : null;
  return (
    <aside
      className={`plugin-view-surface plugin-view-${contribution.configuration.slot}`}
      data-plugin-slot={contribution.configuration.slot}
      data-plugin-view={contribution.id}
      aria-label={contribution.title}
    >
      <header><h2>{contribution.title}</h2><button type="button" aria-label={t("plugin.host.close")} onClick={runtime.actions.closeView}>×</button></header>
      <PluginUiErrorBoundary>
        {projectionMismatch
          ? <p role="alert">{t("plugin.host.viewMetadataMismatch")}</p>
          : <ViewContent contribution={contribution} projection={projection} />}
      </PluginUiErrorBoundary>
      {primaryCommand && (
        <button
          type="button"
          data-plugin-primary-command={primaryCommand.id}
          disabled={!runtime.view.managementAvailable}
          onClick={() => void runtime.actions.invokeCommand(primaryCommand.id, {}).catch(() => undefined)}
        >
          {primaryCommand.title}
        </button>
      )}
    </aside>
  );
}

function PermissionRows({ runtime, detail, reload }: {
  runtime: PluginPlatformRuntime;
  detail: PluginManagementDetail;
  reload(): Promise<void>;
}) {
  const permissions = detail.permissions.flatMap((item) => item.permissions);
  const decide = async (
    permissionId: string,
    decision: "grant" | "deny" | "revoke",
    scope?: Record<string, JsonValue>,
  ) => {
    try {
      await runtime.actions.decidePermission(detail.plugin.id, permissionId, decision, scope);
      await reload();
    } catch {
      // Runtime publishes a bounded notice and leaves the prior detail visible.
    }
  };
  if (!permissions.length) return <p>{t("plugin.host.noPermissions")}</p>;
  return (
    <div className="plugin-permissions">
      {permissions.map((permission) => (
        <article key={permission.permissionId}>
          <div><strong>{permission.permissionId}</strong><span>{permission.kind} · {permission.decision}</span></div>
          <pre>{JSON.stringify(permission.requestedScope, null, 2)}</pre>
          <div className="plugin-action-row">
            {permission.decision !== "granted" && <button type="button" onClick={() => void decide(permission.permissionId, "grant", permission.requestedScope)}>{t("plugin.host.grantScope")}</button>}
            {permission.decision === "granted" && <button type="button" onClick={() => void decide(permission.permissionId, "revoke")}>{t("plugin.host.revoke")}</button>}
            {permission.decision !== "denied" && <button type="button" onClick={() => void decide(permission.permissionId, "deny")}>{t("plugin.host.deny")}</button>}
          </div>
        </article>
      ))}
    </div>
  );
}

function ProviderRows({ providers }: { providers: PluginProviderContribution[] }) {
  if (!providers.length) return null;
  return (
    <>
      <h4>{t("plugin.host.providersTitle")}</h4>
      <p>{t("plugin.host.providersHint")}</p>
      <div className="plugin-provider-list">
        {providers.map((provider) => {
          if (provider.kind === "symbol-provider/1") {
            const config = provider.configuration;
            return (
              <article key={provider.id} data-plugin-provider-exchange={config.exchange}>
                <div><strong>{config.displayName}</strong><span>{t("plugin.host.exchangeSymbols", { exchange: config.exchange })}</span></div>
                <p>
                  {t("plugin.host.markets", { markets: config.marketTypes.map((item) => item.label).join(", ") })}
                  {` · ${t("plugin.host.providerBounds", { page: config.maxPageSize, seconds: config.cacheTtlSeconds })}`}
                </p>
              </article>
            );
          }
          const config = provider.configuration;
          return (
            <article key={provider.id} data-plugin-provider-exchange={config.exchange}>
              <div><strong>{t("plugin.host.exchangeMarketData", { exchange: config.exchange.toUpperCase() })}</strong><span>{config.dataPlane}</span></div>
              <p>
                {t("plugin.host.sourceFinality", { quality: config.sourceQuality.quality, finality: config.sourceQuality.finality })}
              </p>
              <ul>
                {config.channels.map((channel) => (
                  <li key={channel.kind}>
                    {channel.kind === "full_depth" ? t("plugin.host.fullDepth") : t("plugin.host.kline")}
                    {` · ${[channel.history && t("plugin.host.history"), channel.realtime && t("plugin.host.realtime")].filter(Boolean).join(" + ")}`}
                    {channel.intervals.length ? ` · ${channel.intervals.join(", ")}` : ""}
                    {` · ${channel.delivery} · ${channel.finality}`}
                    {channel.corrections ? ` · ${t("plugin.host.corrections")}` : ""}
                    {` · ${t("plugin.host.channelBounds", { rate: channel.ratePerMinute, concurrency: channel.maxConcurrent })}`}
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </>
  );
}

function PaperRows({
  contributions,
  detail,
  runtime,
  reload,
}: {
  contributions: PluginPaperContribution[];
  detail: PluginManagementDetail | null;
  runtime: PluginPlatformRuntime;
  reload(): Promise<void>;
}) {
  if (!contributions.length) return null;
  const account = contributions.find((item) => item.kind === "account-provider/1");
  const executor = contributions.find((item) => item.kind === "order-executor/1");
  const paper = detail?.paperTrading;
  const toggleKillSwitch = async () => {
    if (!paper) return;
    const next = !paper.killSwitchEnabled;
    if (!next && !window.confirm(t("plugin.host.paperResumeConfirm"))) return;
    try {
      await runtime.actions.setPaperKillSwitch(next);
      await reload();
    } catch { /* notice published */ }
  };
  return (
    <section className="plugin-paper-panel" data-plugin-paper-only>
      <h4>{t("plugin.host.paperTitle")}</h4>
      <p>{t("plugin.host.paperHint")}</p>
      {account?.kind === "account-provider/1" && (
        <p>
          <strong>{account.configuration.displayName}</strong>
          {` · ${account.configuration.accounts.map((item) => `${item.label} (${item.baseCurrency})`).join(", ")}`}
        </p>
      )}
      {executor?.kind === "order-executor/1" && (
        <>
          <p>
            {executor.configuration.orderTypes.join(" + ")}
            {` · ${executor.configuration.symbols.map((item) => `${item.symbol}/${item.marketType}`).join(", ")}`}
          </p>
          <p>
            {`Order ≤ ${executor.configuration.limits.maxOrderNotional} · position ≤ ${executor.configuration.limits.maxPositionNotional}`}
            {` · ${executor.configuration.limits.maxOrdersPerMinute}/min · no short selling`}
          </p>
        </>
      )}
      {paper && (
        <div className="plugin-action-row">
          <strong data-paper-kill-switch-state>
            {t("plugin.host.globalKillSwitch", { state: paper.killSwitchEnabled ? "ON" : "OFF" })}
          </strong>
          <button
            type="button"
            data-paper-kill-switch
            disabled={!runtime.view.managementAvailable}
            onClick={() => void toggleKillSwitch()}
          >
            {paper.killSwitchEnabled ? t("plugin.host.resumePaperOrders") : t("plugin.host.stopPaperOrders")}
          </button>
        </div>
      )}
    </section>
  );
}

function MarketplacePanel({
  runtime,
  status,
  busy,
  run,
}: {
  runtime: PluginPlatformRuntime;
  status: PluginMarketplaceStatus | null;
  busy: string | null;
  run(key: string, operation: () => Promise<void>): Promise<void>;
}) {
  useLocale();
  const catalog = runtime.view.marketplaceCatalog;
  if (catalog === null) {
    return (
      <section className="plugin-marketplace-panel plugin-settings-card">
        <p>{t("plugin.market.loading")}</p>
      </section>
    );
  }
  return (
    <section className="plugin-marketplace-panel plugin-settings-card" data-plugin-marketplace>
      <header className="plugin-settings-card-header">
        <div>
          <h3>{t("plugin.marketplace")}</h3>
          <p>{t("plugin.market.desc")}</p>
        </div>
        <span
          className={`plugin-state-pill ${catalog.enabled ? "is-ready" : "is-muted"}`}
          data-plugin-marketplace-state
        >
          {catalog.enabled ? t("plugin.on") : t("plugin.unconfigured")}
        </span>
      </header>
      {!catalog.enabled && !catalog.marketplaces.length && (
        <div className="plugin-empty-state plugin-marketplace-empty">
          <strong>{t("plugin.market.missing")}</strong>
          <p>{t("plugin.market.missingHint")}</p>
        </div>
      )}
      <details className="plugin-technical-details">
        <summary>{t("plugin.market.policy")}</summary>
        <p>{t("plugin.market.policyHint")}</p>
        {catalog.rollout && <p>{t("plugin.market.channel", { channel: catalog.rollout.channel })}</p>}
        {status?.telemetry && (
          <p data-marketplace-telemetry={status.telemetry.enabled ? "enabled" : "disabled"}>
            {t("plugin.market.telemetry", {
              state: status.telemetry.enabled ? t("plugin.market.telemetryOn") : t("plugin.market.telemetryOff"),
            })}
          </p>
        )}
      </details>
      <div className="plugin-marketplace-roots">
        {catalog.marketplaces.map((marketplace) => (
          <article key={marketplace.marketplaceId}>
            <div>
              <strong>{marketplace.marketplaceId}</strong>
              <small>
                {marketplace.cache.status === "valid"
                  ? t("plugin.market.cacheVerified", { sequence: marketplace.cache.sequence, expires: marketplace.cache.expiresAt })
                  : t("plugin.market.cacheUnavailable", { reason: marketplace.cache.reason ?? t("plugin.market.noVerifiedIndex") })}
              </small>
            </div>
            <button
              type="button"
              data-marketplace-refresh={marketplace.marketplaceId}
              disabled={!runtime.view.managementAvailable || !catalog.enabled || !marketplace.enabled || busy !== null}
              onClick={() => void run(
                `refresh:${marketplace.marketplaceId}`,
                () => runtime.actions.refreshMarketplace(marketplace.marketplaceId),
              )}
            >
              {busy === `refresh:${marketplace.marketplaceId}` ? t("plugin.market.verifying") : t("plugin.market.refreshIndex")}
            </button>
          </article>
        ))}
      </div>
      <div className="plugin-marketplace-list">
        {catalog.plugins.map((entry) => {
          const candidate = status?.candidates.find((item) => item.pluginId === entry.pluginId) ?? null;
          const update = status?.updates.find((item) => item.pluginId === entry.pluginId) ?? null;
          const installed = runtime.view.catalog?.plugins.find((item) => item.id === entry.pluginId) ?? null;
          const prepareAvailable = entry.installedVersion === null || update?.available === true;
          const activationReady = installed?.permissions.activationReady === true;
          const selectedArtifact = entry.latest.artifacts?.find(
            (artifact) => artifact.artifactId === entry.assurances?.platform.artifactId,
          ) ?? entry.latest.artifact;
          return (
            <article key={entry.pluginId} data-marketplace-plugin={entry.pluginId}>
              <div className="plugin-marketplace-title">
                <div>
                  <strong>{entry.pluginId}</strong>
                  <small>{t("plugin.market.publisherKey", { publisher: entry.publisher.displayName, key: entry.publisher.keyId.slice(0, 24), boundary: t("plugin.market.notCodeSafety") })}</small>
                </div>
                <span>
                  {entry.latest.version} · {entry.latest.licenseExpression}
                  {entry.latest.revoked ? t("plugin.market.revokedSuffix") : ""}
                </span>
              </div>
              {entry.assurances && (
                <div className="plugin-marketplace-assurances" data-marketplace-assurances={entry.pluginId}>
                  <span data-marketplace-publisher-verified={entry.assurances.publisherVerified}>
                    {t("plugin.market.publisher", {
                      state: entry.assurances.publisherVerified ? t("plugin.market.verified") : t("plugin.market.unverified"),
                    })}
                  </span>
                  <span data-marketplace-official-maintained={entry.assurances.officialMaintained}>
                    {t("plugin.market.maintainer", {
                      who: entry.assurances.officialMaintained ? t("plugin.market.official") : t("plugin.market.community"),
                    })}
                  </span>
                  <span data-marketplace-sandbox-available={entry.assurances.sandbox.available}>
                    {t("plugin.market.sandbox", {
                      state: entry.assurances.sandbox.available ? t("plugin.market.sandboxLocal") : t("plugin.market.sandboxUnavailable"),
                    })}
                    {` · ${entry.assurances.sandbox.runtimeKinds.join(", ") || t("plugin.market.noRuntime")}`}
                  </span>
                  <span data-marketplace-rollout-stage={entry.assurances.rolloutStage}>
                    {t("plugin.market.stage", { stage: entry.assurances.rolloutStage })}
                  </span>
                  <details data-marketplace-permission-scope>
                    <summary>
                      {t("plugin.market.permScope", {
                        required: entry.assurances.permissions.required.length,
                        optional: entry.assurances.permissions.optional.length,
                      })}
                    </summary>
                    <pre>{JSON.stringify(entry.assurances.permissions, null, 2)}</pre>
                  </details>
                </div>
              )}
              <p>{t("plugin.market.artifact", {
                sha: selectedArtifact.sha256,
                size: selectedArtifact.size,
                index: entry.latest.transparency.logIndex,
              })}</p>
              <p>
                {t("plugin.market.installed", { version: entry.installedVersion ?? t("plugin.market.notInstalled") })}
                {candidate ? t("plugin.market.candidate", { version: candidate.version, phase: candidate.phase }) : ""}
              </p>
              {candidate && (
                <div className="plugin-marketplace-candidate" data-marketplace-candidate-phase={candidate.phase}>
                  <p>
                    {t("plugin.market.compatibility", { host: candidate.compatibility.hostVersion, migration: candidate.migration.policy })}
                    {t("plugin.market.permissionConfirmation", { state: candidate.permissionDiff.requiresConfirmation ? t("plugin.market.required") : t("plugin.market.notRequired") })}
                    {candidate.compatibility.runtimeKinds ? ` · ${candidate.compatibility.runtimeKinds.join(", ")}` : ""}
                    {candidate.compatibility.cacheReuse === true ? t("plugin.market.offlineCache") : ""}
                  </p>
                  {candidate.permissionDiff.permissions.length > 0 && (
                    <ul>
                      {candidate.permissionDiff.permissions.map((permission) => (
                        <li key={permission.permissionId}>
                          {permission.permissionId} · {permission.change}
                          {permission.requiresConfirmation ? t("plugin.market.confirmationRequired") : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {candidate.observation.status !== "not-started" && (
                    <p>{t("plugin.market.healthObservation", { status: candidate.observation.status, detail: candidate.observation.detail ? ` · ${candidate.observation.detail}` : "" })}</p>
                  )}
                  {candidate.phase === "quarantined" && (
                    <p role="alert">{t("plugin.market.revoked")}</p>
                  )}
                </div>
              )}
              <div className="plugin-action-row">
                <button
                  type="button"
                  data-marketplace-prepare={entry.pluginId}
                  disabled={!runtime.view.managementAvailable || !catalog.enabled || !entry.installable || !prepareAvailable || busy !== null}
                  onClick={() => void run(
                    `prepare:${entry.pluginId}`,
                    () => runtime.actions.prepareMarketplaceRelease(entry.pluginId, entry.latest.version),
                  )}
                >
                  {busy === `prepare:${entry.pluginId}` ? t("plugin.market.downloading") : t("plugin.market.downloadStage")}
                </button>
                {candidate?.phase === "verified-staged" && (
                  <button
                    type="button"
                    data-marketplace-apply={entry.pluginId}
                    disabled={!runtime.view.managementAvailable || busy !== null}
                    onClick={() => void run(
                      `apply:${entry.pluginId}`,
                      () => runtime.actions.applyMarketplaceRelease(entry.pluginId),
                    )}
                  >
                    {busy === `apply:${entry.pluginId}` ? t("plugin.market.probing") : t("plugin.market.applyStaged")}
                  </button>
                )}
                {candidate?.phase === "activation-staged" && (
                  <button
                    type="button"
                    data-marketplace-activate={entry.pluginId}
                    disabled={!runtime.view.managementAvailable || !activationReady || busy !== null}
                    onClick={() => {
                      if (!window.confirm(t("plugin.market.activateConfirm", { plugin: entry.pluginId, version: candidate.version }))) return;
                      void run(
                        `activate:${entry.pluginId}`,
                        () => runtime.actions.activateMarketplaceRelease(entry.pluginId),
                      );
                    }}
                  >
                    {busy === `activate:${entry.pluginId}` ? t("plugin.market.activating") : t("plugin.market.activateObserve")}
                  </button>
                )}
              </div>
              {candidate?.phase === "activation-staged" && !activationReady && (
                <small>{t("plugin.host.grantEveryPermission")}</small>
              )}
            </article>
          );
        })}
        {status?.quarantine && status.quarantine.length > 0 && (
          <details className="plugin-technical-details" data-marketplace-quarantine>
            <summary>{t("plugin.market.quarantine", { count: status.quarantine.length })}</summary>
            {status.quarantine.map((item) => (
              <p key={`${item.bundleSha256}:${item.quarantinedAt}`}>
                {item.pluginId} {item.version} · {item.reason} · {item.quarantinedAt}
              </p>
            ))}
          </details>
        )}
        {catalog.enabled && !catalog.plugins.length && <p>{t("plugin.market.emptyIndex")}</p>}
      </div>
    </section>
  );
}

function RuntimeRegistryPanel({ status }: { status: PluginRuntimeRegistryStatus }) {
  useLocale();
  const size = (value: number) => `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return (
    <section className="plugin-settings-card plugin-runtime-registry-card" data-runtime-registry-revision={status.active.revision}>
      <header className="plugin-settings-card-header">
        <div>
          <h3>{t("plugin.runtime.hostManaged")}</h3>
          <p>
            {t("plugin.host.registryRevision", { id: status.active.registryId, revision: status.active.revision })} · {t("plugin.runtime.autoUpdateOff")}
          </p>
        </div>
        <span className="plugin-state-pill is-muted">{t("plugin.count", { count: status.runtimes.length })}</span>
      </header>
      {status.runtimes.map((item) => (
        <article key={`${item.runtimeId}:${item.kind}:${item.os}:${item.arch}`} className="plugin-runtime-registry-row">
          <strong>{item.runtimeId} · {item.version}</strong>
          <p>{item.kind} · {item.os}/{item.arch} · {size(item.size)} · {item.verificationStatus}</p>
          <small>
            {t("plugin.host.runtimeFingerprint", {
              owner: t("plugin.host.hostManaged"),
              license: item.license,
              refs: t("plugin.runtime.refs", { count: item.referenceCount }),
              hash: `${item.sha256.slice(7, 19)}…`,
            })}
          </small>
        </article>
      ))}
      {status.systemRuntimes.map((item) => (
        <article key={`${item.runtimeId}:${item.kind}`} className="plugin-runtime-registry-row is-system">
          <strong>{item.runtimeId} · {item.version}</strong>
          <p>{t("plugin.host.systemRuntime", { kind: item.kind, size: size(item.artifactSize), state: t("plugin.runtime.probed") })}</p>
          <small>{t("plugin.runtime.devLocal", { path: item.executable })}</small>
        </article>
      ))}
    </section>
  );
}

function changedLabel(changed: boolean): string {
  return t(changed ? "plugin.trust.changed" : "plugin.trust.same");
}

function trustAcknowledgementLabel(value: string): string {
  if (value === "execute-local-code") return t("plugin.ack.execute");
  if (value === "sandbox-status") return t("plugin.ack.sandbox");
  if (value === "live-authority-separate") return t("plugin.ack.authority");
  if (value.startsWith("runtime:")) {
    return t("plugin.ack.runtime", { runtime: value.slice("runtime:".length).replaceAll(":", " · ") });
  }
  if (value.startsWith("permission:")) {
    return t("plugin.ack.permission", { permission: value.slice("permission:".length) });
  }
  return value;
}

function TrustRequestMatrix({ trust }: { trust: PluginTrustSummary["requests"] }) {
  useLocale();
  const rows = [
    [t("plugin.trust.network"), trust.network],
    [t("plugin.trust.files"), trust.files],
    [t("plugin.trust.secrets"), trust.secrets],
    [t("plugin.trust.accounts"), trust.accounts],
    [t("plugin.trust.trading"), trust.trading],
  ] as const;
  return (
    <div className="plugin-trust-risk-grid">
      {rows.map(([label, value]) => (
        <div key={label} data-requested={value.requested ? "true" : "false"}>
          <strong>{label}</strong>
          <span>{value.requested ? value.permissionIds.join("、") : t("plugin.trust.notRequested")}</span>
        </div>
      ))}
      <div data-requested="false">
        <strong>{t("plugin.trust.subprocess")}</strong>
        <span>{t("plugin.trust.subprocessLimit", { count: trust.subprocess.maxProcesses })}</span>
      </div>
    </div>
  );
}

function LocalTrustInstallPanel({ runtime }: { runtime: PluginPlatformRuntime }) {
  useLocale();
  const [candidate, setCandidate] = useState<PluginLocalInstallCandidate | null>(null);
  const [reason, setReason] = useState("");
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<PluginTrustReview | null>(null);
  const [busy, setBusy] = useState<"prepare" | "review" | "confirm" | null>(null);

  const resetReview = () => setReview(null);
  const prepare = async (file: File) => {
    setBusy("prepare");
    setCandidate(null);
    setReason("");
    setAccepted(new Set());
    setReview(null);
    try { setCandidate(await runtime.actions.prepareLocalInstall(file)); } catch { /* notice published */ }
    finally { setBusy(null); }
  };
  const required = candidate?.preview.requiredAcknowledgements ?? [];
  const allAccepted = required.length > 0 && required.every((item) => accepted.has(item));
  const firstConfirmation = async () => {
    if (!candidate || !allAccepted) return;
    setBusy("review");
    try {
      setReview(await runtime.actions.reviewLocalInstall(
        candidate.candidateId,
        candidate.previewSha256,
        reason.trim(),
        [...accepted].sort(),
      ));
    } catch { setReview(null); }
    finally { setBusy(null); }
  };
  const secondConfirmation = async () => {
    if (!candidate || !review) return;
    setBusy("confirm");
    try {
      await runtime.actions.confirmLocalInstall(
        candidate.candidateId,
        candidate.previewSha256,
        review.confirmationToken,
      );
      setCandidate(null);
      setReview(null);
      setAccepted(new Set());
      setReason("");
    } catch { setReview(null); }
    finally { setBusy(null); }
  };

  return (
    <section className="plugin-settings-card plugin-install-card plugin-trust-install-card" data-plugin-trust-flow="itemized-double-confirmation">
      <header className="plugin-settings-card-header">
        <div>
          <h3>{t("plugin.localInstall")}</h3>
          <p>{t("plugin.trust.localHint")}</p>
        </div>
        <span className="plugin-state-pill is-warn">{t("plugin.trust.localCode")}</span>
      </header>
      <div className="plugin-install-row">
        <label className="plugin-install-button">
          <input
            type="file"
            accept=".cspkg,application/vnd.candlescope.plugin+zip"
            data-plugin-install-input
            disabled={!runtime.view.managementAvailable || busy !== null}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void prepare(file);
            }}
          />
          <span>{busy === "prepare" ? t("plugin.trust.verifying") : t("plugin.trust.pickReview")}</span>
        </label>
        <small>{t("plugin.trust.prepareHint")}</small>
      </div>
      {candidate && (
        <div className="plugin-trust-review" data-preview-sha256={candidate.previewSha256}>
          <div className="plugin-trust-source">
            <strong>{candidate.preview.plugin.name} {candidate.preview.plugin.version}</strong>
            <span>{candidate.preview.plugin.publisher} · {candidate.preview.source.source}</span>
            <small>
              {t("plugin.trust.publisherId", { identity: candidate.preview.source.publisherIdentity })}
              {candidate.preview.source.signatureRoot
                ? t("plugin.signedRoot", { root: candidate.preview.source.signatureRoot })
                : t("plugin.unsignedLocal")}
            </small>
            <code>{candidate.preview.plugin.bundleSha256}</code>
          </div>
          <p className="plugin-trust-warning">{candidate.preview.warning}</p>
          <h4>{t("plugin.trust.whatRuns")}</h4>
          {candidate.preview.authorization.entrypoints.map((entrypoint) => (
            <div className="plugin-trust-runtime" key={entrypoint.entrypointId}>
              <strong>{entrypoint.entrypointId}</strong>
              <span>{entrypoint.runtimeKind} · {entrypoint.runtimeId} · {entrypoint.supplySource}</span>
              <small>
                  {entrypoint.hostManaged ? t("plugin.host.hostManaged") : t("plugin.bundledRuntime")}
                {` · ${entrypoint.profile.profileId} · maxProcesses=${entrypoint.profile.limits.maxProcesses}`}
              </small>
              {entrypoint.systemRuntimePath && <code>{entrypoint.systemRuntimePath}</code>}
            </div>
          ))}
          <p data-sandbox-status={candidate.preview.authorization.sandbox.status}>
            {t("plugin.trust.sandboxMode", {
              status: candidate.preview.authorization.sandbox.status,
              mode: candidate.preview.authorization.mode,
            })}
          </p>
          <TrustRequestMatrix trust={candidate.preview.requests} />
          <div className="plugin-trust-diffs">
            <div>
              <strong>{t("plugin.host.runtimeDiff")}</strong>
              <span>{candidate.preview.runtimeDiff.changed ? t("plugin.trust.changedMustConfirm") : t("plugin.trust.unchanged")}</span>
              <small>
                {t("plugin.host.kindOrId", { state: changedLabel(candidate.preview.runtimeDiff.kindOrIdChanged) })}
                {` · ${t("plugin.diff.sigRoot", { state: changedLabel(candidate.preview.runtimeDiff.signatureRootChanged) })}`}
                {` · ${t("plugin.diff.sysPath", { state: changedLabel(candidate.preview.runtimeDiff.systemRuntimePathChanged) })}`}
              </small>
            </div>
            <div>
              <strong>{t("plugin.host.permissionDiff")}</strong>
              <span>{candidate.preview.permissionDiff.requiresConfirmation ? t("plugin.trust.needReconfirm") : t("plugin.trust.noExpansion")}</span>
              <small>{candidate.preview.permissionDiff.permissions.map((item) => `${item.permissionId}: ${item.change}`).join(" · ") || t("plugin.trust.noHostApi")}</small>
            </div>
          </div>
          <label className="plugin-trust-reason">
            <span>{t("plugin.trust.reason")}</span>
            <textarea
              value={reason}
              maxLength={500}
              onChange={(event) => { setReason(event.target.value); resetReview(); }}
              placeholder={t("plugin.trust.reasonPh")}
            />
          </label>
          <fieldset className="plugin-trust-acknowledgements">
            <legend>{t("plugin.trust.itemized")}</legend>
            {required.map((item) => (
              <label key={item}>
                <input
                  type="checkbox"
                  checked={accepted.has(item)}
                  onChange={(event) => {
                    const next = new Set(accepted);
                    if (event.target.checked) next.add(item); else next.delete(item);
                    setAccepted(next);
                    resetReview();
                  }}
                />
                <span>{trustAcknowledgementLabel(item)}</span>
              </label>
            ))}
          </fieldset>
          <div className="plugin-action-row plugin-trust-confirmations">
            <button
              type="button"
              data-trust-confirmation-step="1"
              disabled={!allAccepted || reason.trim().length < 12 || busy !== null || review !== null}
              onClick={() => void firstConfirmation()}
            >
              {busy === "review" ? t("plugin.trust.recording") : t("plugin.trust.firstReview")}
            </button>
            <button
              type="button"
              data-trust-confirmation-step="2"
              className="is-danger"
              disabled={review === null || busy !== null}
              onClick={() => void secondConfirmation()}
            >
              {busy === "confirm" ? t("plugin.trust.installing") : t("plugin.trust.secondInstall")}
            </button>
          </div>
          {review && <small>{t("plugin.trust.firstRecorded", { expires: review.expiresAt })}</small>}
        </div>
      )}
    </section>
  );
}

function TrustModeControl({
  runtime,
  pluginId,
  trust,
  onComplete,
}: {
  runtime: PluginPlatformRuntime;
  pluginId: string;
  trust: PluginTrustSummary;
  onComplete: () => Promise<void>;
}) {
  useLocale();
  const target = trust.mode === "trusted-local" ? "marketplace-sandboxed" : "trusted-local";
  const acknowledgements = useMemo(() => {
    const values = new Set<string>(["execute-local-code", "sandbox-status", "live-authority-separate"]);
    trust.authorization.entrypoints.forEach((item) => values.add(`runtime:${item.entrypointId}:${item.runtimeKind}:${item.runtimeId}`));
    trust.requests.permissions.forEach((item) => values.add(`permission:${item.permissionId}`));
    return [...values].sort();
  }, [trust.authorization.entrypoints, trust.requests.permissions]);
  const [reason, setReason] = useState("");
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<PluginTrustChangeReview | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(""); setAccepted(new Set()); setReview(null); }, [pluginId, trust.mode]);
  const allAccepted = acknowledgements.every((item) => accepted.has(item));
  const begin = async () => {
    setBusy(true);
    try { setReview(await runtime.actions.reviewTrustChange(pluginId, target, reason.trim(), [...accepted].sort())); }
    catch { setReview(null); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!review) return;
    setBusy(true);
    try {
      await runtime.actions.confirmTrustChange(pluginId, review.changeId, review.previewSha256, review.confirmationToken);
      setReview(null);
      await onComplete();
    } catch { setReview(null); }
    finally { setBusy(false); }
  };
  return (
    <div className="plugin-trust-mode-control">
      <p className="plugin-trust-warning">{t("plugin.trust.signedWarning")}</p>
      <label className="plugin-trust-reason">
        <span>{t("plugin.trust.changeReason")}</span>
        <textarea value={reason} maxLength={500} onChange={(event) => { setReason(event.target.value); setReview(null); }} />
      </label>
      <fieldset className="plugin-trust-acknowledgements">
        <legend>{target === "trusted-local" ? t("plugin.trust.promote") : t("plugin.trust.revoke")}</legend>
        {acknowledgements.map((item) => (
          <label key={item}>
            <input type="checkbox" checked={accepted.has(item)} onChange={(event) => {
              const next = new Set(accepted);
              if (event.target.checked) next.add(item); else next.delete(item);
              setAccepted(next);
              setReview(null);
            }} />
            <span>{trustAcknowledgementLabel(item)}</span>
          </label>
        ))}
      </fieldset>
      {review && (
        <div className="plugin-trust-diffs" data-trust-change-preview={review.previewSha256}>
          <div>
            <strong>{t("plugin.trust.frozenBoundary")}</strong>
            <span>{review.preview.to.mode} · {review.preview.to.sandbox.status}</span>
            <small>
              {t("plugin.diff.runtime", { state: changedLabel(review.preview.runtimeDiff.changed) })}
              {` · kind/id ${changedLabel(review.preview.runtimeDiff.kindOrIdChanged)}`}
              {` · ${t("plugin.diff.sigRoot", { state: changedLabel(review.preview.runtimeDiff.signatureRootChanged) })}`}
              {` · ${t("plugin.diff.sysPath", { state: changedLabel(review.preview.runtimeDiff.systemRuntimePathChanged) })}`}
            </small>
          </div>
          <div>
            <strong>{t("plugin.trust.frozenDiff")}</strong>
            <span>{review.preview.permissionDiff.requiresConfirmation ? t("plugin.trust.noInherit") : t("plugin.trust.noAuthExpand")}</span>
            <small>
              {review.preview.permissionDiff.permissions.map((item) => `${item.permissionId}: ${item.change}`).join(" · ") || t("plugin.trust.noHostApi")}
            </small>
          </div>
        </div>
      )}
      <div className="plugin-action-row">
        <button type="button" disabled={busy || !allAccepted || reason.trim().length < 12 || review !== null} onClick={() => void begin()}>
          {t("plugin.trust.firstReviewTarget", { target })}
        </button>
        <button type="button" disabled={busy || review === null} onClick={() => void confirm()}>
          {t("plugin.trust.secondApply")}
        </button>
      </div>
    </div>
  );
}

export function PluginSettingsPanel({ runtime }: { runtime: PluginPlatformRuntime }) {
  const locale = useLocale();
  const { closeManager, openManager } = runtime.actions;
  useEffect(() => {
    openManager();
    return closeManager;
  }, [closeManager, openManager]);
  const plugins = useMemo(
    () => (runtime.view.catalog?.plugins ?? []).map((plugin) => ({
      ...plugin,
      contributions: plugin.contributions.map((contribution) => (
        localizePluginContribution(contribution, locale)
      )),
    })),
    [locale, runtime.view.catalog?.plugins],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PluginManagementDetail | null>(null);
  const [marketplaceStatus, setMarketplaceStatus] = useState<PluginMarketplaceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [marketplaceBusy, setMarketplaceBusy] = useState<string | null>(null);
  const [compatibilityPreview, setCompatibilityPreview] = useState<PluginV1CompatibilityPreview | null>(null);
  const [compatibilityBusy, setCompatibilityBusy] = useState<"import" | "rollback" | null>(null);
  const compatibility = runtime.view.catalog?.compatibility ?? null;
  const platformEnabled = runtime.view.catalog?.platform.enabled === true;
  useEffect(() => {
    if (!selectedId || !plugins.some((item) => item.id === selectedId)) setSelectedId(plugins[0]?.id ?? null);
  }, [plugins, selectedId]);
  const reload = async () => {
    if (!selectedId || !runtime.view.managementAvailable) return;
    setLoading(true);
    try { setDetail(await runtime.actions.loadDetail(selectedId)); } catch { setDetail(null); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    setDetail(null);
    void reload();
    // reload is intentionally keyed by the selected plugin and management availability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.view.managementAvailable, selectedId]);
  const reloadMarketplace = async () => {
    if (!runtime.view.managementAvailable || !platformEnabled) {
      setMarketplaceStatus(null);
      return;
    }
    try {
      setMarketplaceStatus(await runtime.actions.loadMarketplaceStatus());
    } catch {
      setMarketplaceStatus(null);
    }
  };
  useEffect(() => {
    void reloadMarketplace();
    // Marketplace mutations explicitly reload protected state after the public refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.view.managementAvailable, platformEnabled]);
  useEffect(() => {
    setCompatibilityPreview(null);
  }, [compatibility?.import.sourceSha256]);
  const selected = plugins.find((item) => item.id === selectedId) ?? null;
  const mutate = async (action: "enable" | "disable" | "rollback" | "uninstall") => {
    if (!selected) return;
    if (action === "uninstall" && !window.confirm(t("plugin.host.uninstallConfirm", { name: selected.name }))) return;
    try {
      await runtime.actions.changeState(selected.id, action);
      if (action !== "uninstall") await reload();
    } catch { /* notice published */ }
  };
  const runMarketplace = async (key: string, operation: () => Promise<void>) => {
    setMarketplaceBusy(key);
    try {
      await operation();
      await reloadMarketplace();
      await reload();
    } catch {
      // Runtime publishes a bounded notice and leaves the last verified state visible.
    } finally {
      setMarketplaceBusy(null);
    }
  };
  const previewCompatibility = async (action: "import" | "rollback") => {
    setCompatibilityBusy(action);
    try {
      setCompatibilityPreview(
        action === "import"
          ? await runtime.actions.previewV1CompatibilityImport()
          : await runtime.actions.previewV1CompatibilityRollback(),
      );
    } catch {
      setCompatibilityPreview(null);
    } finally {
      setCompatibilityBusy(null);
    }
  };
  const applyCompatibility = async () => {
    if (!compatibilityPreview?.available || !compatibilityPreview.previewSha256) return;
    const action = compatibilityPreview.action;
    if (!window.confirm(
      action === "import"
        ? t("plugin.host.v1ImportConfirm")
        : t("plugin.host.v1RollbackConfirm"),
    )) return;
    setCompatibilityBusy(action);
    try {
      if (action === "import") {
        await runtime.actions.applyV1CompatibilityImport(compatibilityPreview.previewSha256);
      } else {
        await runtime.actions.applyV1CompatibilityRollback(compatibilityPreview.previewSha256);
      }
      setCompatibilityPreview(null);
    } catch {
      // Runtime publishes the fail-closed Host response.
    } finally {
      setCompatibilityBusy(null);
    }
  };
  const runtimeCount = compatibility?.contributions.length ?? 0;
  const marketplaceEnabled = runtime.view.marketplaceCatalog?.enabled === true;
  return (
    <div className="plugin-settings-page" data-testid="plugin-manager">
      <section className="plugin-settings-hero">
        <div>
          <span className="plugin-settings-eyebrow">{t("plugin.eyebrow")}</span>
          <h3>{t("plugin.title")}</h3>
          <p>{t("plugin.subtitle")}</p>
        </div>
        <span className={`plugin-state-pill ${platformEnabled ? "is-ready" : "is-compatibility"}`}>
          {platformEnabled ? t("plugin.platformOn") : t("plugin.compatMode")}
        </span>
      </section>
      <div className="plugin-settings-summary" aria-label={t("plugin.overviewAria")}>
        <div><strong>{plugins.length}</strong><span>{t("plugin.installedCount")}</span></div>
        <div><strong>{runtimeCount}</strong><span>{t("plugin.scriptRuntimes")}</span></div>
        <div>
          <strong>{marketplaceEnabled ? t("plugin.on") : t("plugin.unconfigured")}</strong>
          <span>{t("plugin.marketplace")}</span>
        </div>
      </div>
      {compatibility && (
        <section className="plugin-settings-card plugin-v1-compatibility" data-v1-compatibility-status={compatibility.import.status}>
          <header className="plugin-settings-card-header">
            <div>
              <h3>{t("plugin.scriptRuntimes")}</h3>
              <p>{t("plugin.runtimeDesc")}</p>
            </div>
            <span className="plugin-state-pill is-ready">{t("plugin.availableCount", { count: runtimeCount })}</span>
          </header>
          <div className="plugin-runtime-list">
            {compatibility.contributions.map((contribution) => (
              <article key={contribution.id} data-v1-runtime={contribution.runtimeId}>
                <div className="plugin-runtime-main">
                  <div>
                    <strong>{contribution.title}</strong>
                    <span>
                      {contribution.version}
                      {` · ${contribution.languages.map((item) => item.name).join("、")}`}
                      {contribution.imported ? t("plugin.imported") : t("plugin.liveDiscover")}
                    </span>
                  </div>
                  <span className={`plugin-state-pill ${contribution.available ? "is-ready" : "is-muted"}`}>
                    {contribution.available ? t("plugin.available") : t("plugin.unavailable")}
                  </span>
                </div>
                <details className="plugin-technical-details">
                  <summary>{t("plugin.techDetails")}</summary>
                  <dl>
                    <div><dt>{t("plugin.runtime")}</dt><dd>{contribution.runtimeId}</dd></div>
                    <div><dt>{t("plugin.protocol")}</dt><dd>{compatibility.protocol}</dd></div>
                    {contribution.release.bundleSha256 && (
                      <div><dt>{t("plugin.bundleDigest")}</dt><dd>{contribution.release.bundleSha256}</dd></div>
                    )}
                  </dl>
                </details>
              </article>
            ))}
          </div>
          {!compatibility.contributions.length && (
            <div className="plugin-empty-state">
              <strong>{t("plugin.noRuntimes")}</strong>
              <p>{t("plugin.noRuntimesHint")}</p>
            </div>
          )}
          <div className="plugin-action-row">
            <button
              type="button"
              data-v1-compatibility-preview="import"
              disabled={!platformEnabled || !runtime.view.managementAvailable || compatibilityBusy !== null}
              onClick={() => void previewCompatibility("import")}
            >
              {compatibilityBusy === "import" ? t("plugin.previewing") : t("plugin.previewImport")}
            </button>
            <button
              type="button"
              data-v1-compatibility-preview="rollback"
              disabled={
                !platformEnabled
                || !runtime.view.managementAvailable
                || !compatibility.import.rollbackAvailable
                || compatibilityBusy !== null
              }
              onClick={() => void previewCompatibility("rollback")}
            >
              {compatibilityBusy === "rollback" ? t("plugin.previewing") : t("plugin.previewRollback")}
            </button>
          </div>
          {!platformEnabled && <small>{t("plugin.enableToSave")}</small>}
          {compatibilityPreview && (
            <div className="plugin-v1-compatibility-preview" data-v1-compatibility-action={compatibilityPreview.action}>
              <p>
                {t("plugin.host.compatPreview", {
                  hash: compatibilityPreview.previewSha256 ?? t("plugin.unavailable"),
                  revision: compatibilityPreview.stateRevision,
                })}
                {compatibilityPreview.targetSnapshotRevision == null ? "" : ` · target ${compatibilityPreview.targetSnapshotRevision}`}
              </p>
              {compatibilityPreview.changes.length
                ? (
                  <ul>
                    {compatibilityPreview.changes.map((change) => (
                      <li key={change.id}>{change.action}: {change.id}</li>
                    ))}
                  </ul>
                )
                : (
                  <p>{t("plugin.host.compatNoChanges")}</p>
                )}
              <button
                type="button"
                data-v1-compatibility-apply={compatibilityPreview.action}
                disabled={!compatibilityPreview.available || compatibilityBusy !== null}
                onClick={() => void applyCompatibility()}
              >
                {t("plugin.host.compatApply", { action: compatibilityPreview.action })}
              </button>
            </div>
          )}
        </section>
      )}
      {platformEnabled && runtime.view.catalog?.runtimeRegistry && (
        <RuntimeRegistryPanel status={runtime.view.catalog.runtimeRegistry} />
      )}
      {platformEnabled && (
        runtime.view.catalog?.trustUx?.enabled
          ? <LocalTrustInstallPanel runtime={runtime} />
          : <section className="plugin-settings-card plugin-install-card">
          <header className="plugin-settings-card-header">
            <div>
              <h3>{t("plugin.localInstall")}</h3>
              <p>{t("plugin.localInstallHint")}</p>
            </div>
          </header>
          <div className="plugin-install-row">
            <label className="plugin-install-button">
              <input
                type="file"
                accept=".cspkg,application/vnd.candlescope.plugin+zip"
              data-plugin-install-input
              disabled={!runtime.view.managementAvailable}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                try { await runtime.actions.installBundle(file); } catch { /* notice published */ }
              }}
              />
              <span>{t("plugin.pickCspkg")}</span>
            </label>
            <div>
              <strong>{t("plugin.hashedLocal")}</strong>
              <small>{t("plugin.hashHint")}</small>
            </div>
          </div>
        </section>
      )}
      {platformEnabled && (
        <MarketplacePanel
          runtime={runtime}
          status={marketplaceStatus}
          busy={marketplaceBusy}
          run={runMarketplace}
        />
      )}
      {platformEnabled && (
        <section className="plugin-settings-card plugin-installed-card">
          <header className="plugin-settings-card-header">
            <div>
              <h3>{t("plugin.installedCount")}</h3>
              <p>{t("plugin.installedHint")}</p>
            </div>
            <span className="plugin-state-pill is-muted">{t("plugin.count", { count: plugins.length })}</span>
          </header>
          {!plugins.length && (
            <div className="plugin-empty-state">
              <strong>{t("plugin.empty")}</strong>
              <p>{t("plugin.emptyHint")}</p>
            </div>
          )}
          {plugins.length > 0 && (
            <div className="plugin-manager-layout">
              <nav aria-label={t("plugin.installedCount")}>
                {plugins.map((plugin) => (
                  <button type="button" key={plugin.id} className={selectedId === plugin.id ? "active" : ""} onClick={() => setSelectedId(plugin.id)}>
                    <strong>{plugin.name}</strong><small>{plugin.version} · {plugin.state}</small>
                  </button>
                ))}
              </nav>
              <section className="plugin-manager-detail">
                {selected && (
                  <>
                    <h3>{selected.name}</h3>
                    <p>
                      {selected.id} · {selected.publisher} · {selected.trust?.mode ?? selected.trustLevel}
                    </p>
                    <div className="plugin-action-row">
                      {selected.state === "active"
                        ? <button type="button" disabled={!runtime.view.managementAvailable} onClick={() => void mutate("disable")}>{t("plugin.disable")}</button>
                        : <button type="button" disabled={!runtime.view.managementAvailable || !selected.permissions.activationReady} onClick={() => void mutate("enable")}>{t("plugin.enable")}</button>}
                      <button type="button" disabled={!runtime.view.managementAvailable || !detail?.rollback.available} onClick={() => void mutate("rollback")}>{t("plugin.rollback")}</button>
                      <button type="button" disabled={!runtime.view.managementAvailable} onClick={() => void mutate("uninstall")}>{t("plugin.uninstall")}</button>
                    </div>
                    {!runtime.view.managementAvailable && <p>{t("plugin.readonly")}</p>}
                    {loading && <p>{t("plugin.loadingDetail")}</p>}
                    {(detail?.trust ?? selected.trust) && (() => {
                      const trust = (detail?.trust ?? selected.trust)!;
                      return (
                        <section className="plugin-trust-installed-summary" data-trust-mode={trust.mode}>
                          <h4>{t("plugin.trustRuntime")}</h4>
                          <p>
                            {t("plugin.sourceLine", { source: trust.source.source, identity: trust.source.publisherIdentity })}
                            {trust.source.signatureRoot ? t("plugin.signedRoot", { root: trust.source.signatureRoot }) : t("plugin.unsignedLocal")}
                          </p>
                          <p>
                            {t("plugin.modeSandbox", { mode: trust.mode, status: trust.authorization.sandbox.status })}
                            {` · ${trust.decisionRecorded ? t("plugin.hasDecision") : t("plugin.defaultPolicy")}`}
                          </p>
                          {trust.authorization.entrypoints.map((item) => (
                            <div className="plugin-trust-runtime" key={item.entrypointId}>
                              <strong>{item.entrypointId}</strong>
                              <span>{item.runtimeKind} · {item.runtimeId} · {item.supplySource}</span>
                              <small>{item.hostManaged ? t("plugin.host.hostManaged") : t("plugin.bundledRuntime")} · {item.profile.profileId}</small>
                            </div>
                          ))}
                          <TrustRequestMatrix trust={trust.requests} />
                          <small>{t("plugin.authorityHint")}</small>
                          {trust.changeAllowed && runtime.view.managementAvailable && (
                            <TrustModeControl runtime={runtime} pluginId={selected.id} trust={trust} onComplete={reload} />
                          )}
                        </section>
                      );
                    })()}
                    <ProviderRows providers={selected.contributions.filter(
                      (item): item is PluginProviderContribution => (
                        item.kind === "symbol-provider/1" || item.kind === "market-data-provider/1"
                      ),
                    )} />
                    <PaperRows
                      contributions={selected.contributions.filter(
                        (item): item is PluginPaperContribution => (
                          item.kind === "account-provider/1" || item.kind === "order-executor/1"
                        ),
                      )}
                      detail={detail}
                      runtime={runtime}
                      reload={reload}
                    />
                    {detail && (
                      <>
                        {detail.health.entrypoints.some((item) => item.runtimeSupply !== undefined) && (
                          <>
                            <h4>{t("plugin.runtimeSupply")}</h4>
                            {detail.health.entrypoints.filter((item) => item.runtimeSupply !== undefined).map((item) => {
                              const supply = item.runtimeSupply!;
                              return (
                                <p key={item.entrypointId} data-runtime-supply={supply.source}>
                                  {item.entrypointId} · {supply.runtimeId} {supply.version} · {supply.source}
                                  · {supply.verificationStatus} · {supply.reproducible ? t("plugin.reproducible") : t("plugin.unreproducible")}
                                </p>
                              );
                            })}
                          </>
                        )}
                        <h4>{t("plugin.health")}</h4>
                        <p>{detail.health.available ? t("plugin.available") : t("plugin.unavailableReason", { reason: detail.health.unavailableReason ?? t("plugin.unknownReason") })}</p>
                        <h4>{t("plugin.updateRollback")}</h4>
                        <p>
                          {t("plugin.updateSource")}
                          {detail.update.latest ? t("plugin.verifiedAvailable", { version: detail.update.latest.version }) : ""}
                          {detail.update.reason ? ` · ${detail.update.reason}` : ""}
                        </p>
                        {detail.update.candidate && <p>{t("plugin.candidate", { version: detail.update.candidate.version, phase: detail.update.candidate.phase })}</p>}
                        <p>{detail.rollback.available
                          ? t("plugin.rollbackAvailable", { target: detail.rollback.target?.version ?? detail.rollback.target?.state ?? t("plugin.previousActive") })
                          : t("plugin.rollbackUnavailable", { reason: detail.rollback.reason ?? t("plugin.unavailable") })}</p>
                        <h4>{t("plugin.dataRetention")}</h4>
                        <p>{t("plugin.dataRetentionHint")}</p>
                        <pre>{JSON.stringify(detail.dataRetention.storage, null, 2)}</pre>
                        <h4>{t("plugin.permissions")}</h4>
                        <PermissionRows runtime={runtime} detail={detail} reload={reload} />
                      </>
                    )}
                  </>
                )}
              </section>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default function PluginPlatformSurfaces({ runtime }: { runtime: PluginPlatformRuntime }) {
  useLocale();
  const openView = useMemo(
    () => [...runtime.view.registries.sidePanel, ...runtime.view.registries.bottomPanel].find((item) => item.id === runtime.view.openViewId) ?? null,
    [runtime.view.openViewId, runtime.view.registries.bottomPanel, runtime.view.registries.sidePanel],
  );
  const openSettings = runtime.view.registries.settings.find((item) => item.id === runtime.view.openSettingsId) ?? null;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "p" && runtime.view.registries.commandPalette.length) {
        event.preventDefault();
        runtime.actions.openPalette();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runtime.actions, runtime.view.registries.commandPalette.length]);
  return (
    <PluginUiErrorBoundary>
      <CommandPalette runtime={runtime} />
      {openSettings && <SettingsSurface runtime={runtime} contribution={openSettings} />}
      {openView && <ViewSurface key={openView.id} runtime={runtime} contribution={openView} />}
      {runtime.view.error && <div className="plugin-platform-notice plugin-platform-error" role="alert">{t("plugin.host.platformUnavailable", { error: runtime.view.error })}</div>}
      {runtime.view.notice && (
        <button type="button" className="plugin-platform-notice" onClick={runtime.actions.clearNotice}>{runtime.view.notice}</button>
      )}
    </PluginUiErrorBoundary>
  );
}
