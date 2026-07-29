import React, { useEffect, useMemo, useRef, useState } from "react";
import { PluginNativeField } from "./PluginNativeFields.js";
import SandboxPluginFrame from "./SandboxPluginFrame.js";
import { defaultForPluginSchema } from "./pluginSchemaDefaults.js";
import { formatPluginValue } from "./pluginViewFormatting.js";
import type {
  JsonValue,
  PluginCommandContribution,
  PluginCommandFileInput,
  PluginDeclarativeViewContribution,
  PluginManagementDetail,
  PluginJsonSchema,
  PluginMarketplaceStatus,
  PluginPlatformRuntime,
  PluginPaperContribution,
  PluginProviderContribution,
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
      ? <div className="plugin-ui-fallback" role="alert">Plugin UI unavailable. CandleScope remains operational.</div>
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
  ) throw new Error("Plugin file download exceeds the selected destination contract");
  const blob = await runtime.actions.downloadUserFile(pluginId, receipt.downloadId);
  if (blob.size !== receipt.size || blob.size > config.maxBytes) {
    throw new Error("Plugin file download size does not match its receipt");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  const actual = `sha256:${[...digest].map((item) => item.toString(16).padStart(2, "0")).join("")}`;
  if (actual !== receipt.sha256) throw new Error("Plugin file download failed integrity validation");
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
        <header><h2>{title}</h2><button type="button" aria-label="Close" onClick={onClose}>×</button></header>
        <div className="plugin-modal-body">{children}</div>
      </section>
    </div>
  );
}

function CommandPalette({ runtime }: { runtime: PluginPlatformRuntime }) {
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
    <Modal title="Plugin commands" onClose={runtime.actions.closePalette} testId="plugin-command-palette">
      <input autoFocus className="plugin-command-search" placeholder="Search commands" value={query} onChange={(event) => setQuery(event.target.value)} />
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
          {!selected && <p>Select a command.</p>}
          {selected && (
            <>
              {nativeSchema && (
                <PluginNativeField
                  name="root"
                  schema={nativeSchema}
                  value={input}
                  onChange={(value) => {
                    if (value && typeof value === "object" && !Array.isArray(value)) setInput(value);
                  }}
                />
              )}
              {fileInputs.map((fileInput) => (
                <div className="plugin-command-file" key={fileInput.field} data-plugin-file-mode={fileInput.mode}>
                  <strong>{fileInput.mode === "open" ? "Select input file" : "Select save destination"}</strong>
                  <small>{fileInput.accept.join(", ")} · maximum {fileInput.maxBytes} bytes · one use</small>
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
                          setFileStatus((current) => ({ ...current, [fileInput.field]: "File type or size is outside the declared scope." }));
                          return;
                        }
                        setFileBusy(fileInput.field);
                        try {
                          const selection = await runtime.actions.stageUserFile(selected.id, fileInput.field, file);
                          setInput((current) => ({ ...current, [fileInput.field]: selection.handle }));
                          setFileStatus((current) => ({ ...current, [fileInput.field]: `${selection.name} selected for one read.` }));
                        } catch (error) {
                          setFileStatus((current) => ({ ...current, [fileInput.field]: error instanceof Error ? error.message : "File selection failed." }));
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
                          setFileStatus((current) => ({ ...current, [fileInput.field]: "A native save picker is required." }));
                          return;
                        }
                        setFileBusy(fileInput.field);
                        try {
                          const destination = await picker.call(window, { suggestedName: fileInput.suggestedName });
                          const selection = await runtime.actions.prepareUserFileSave(selected.id, fileInput.field);
                          saveDestinations.current.set(fileInput.field, destination);
                          setInput((current) => ({ ...current, [fileInput.field]: selection.handle }));
                          setFileStatus((current) => ({ ...current, [fileInput.field]: `${selection.name} selected for one write.` }));
                        } catch (error) {
                          setFileStatus((current) => ({ ...current, [fileInput.field]: error instanceof Error ? error.message : "Save destination was not selected." }));
                        } finally {
                          setFileBusy(null);
                        }
                      }}
                    >
                      Choose destination…
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
                          : "The command or selected file operation failed.",
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
                {running ? "Running…" : "Run command"}
              </button>
              {!runtime.view.managementAvailable && <small>Trusted desktop management session required.</small>}
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
      .catch(() => { if (active) setLoadError("Plugin settings could not be loaded. Saving is disabled."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [contribution.id, readSettings, runtime.view.managementAvailable]);
  return (
    <Modal title={contribution.title} onClose={runtime.actions.closeSettings} testId="plugin-settings">
      {!runtime.view.managementAvailable && <p>Settings are read-only until a trusted desktop management session is injected.</p>}
      {loadError && <p role="alert">{loadError}</p>}
      {loading ? <p>Loading settings…</p> : (
        <PluginNativeField
          name="root"
          schema={contribution.configuration.schema}
          value={value}
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
        {saving ? "Saving…" : "Save settings"}
      </button>
    </Modal>
  );
}

function ViewContent({ contribution, projection }: {
  contribution: PluginDeclarativeViewContribution;
  projection: PluginViewProjection | undefined;
}) {
  if (!projection || projection.state === "empty") return <p>{contribution.configuration.emptyState}</p>;
  if (projection.state === "error") return <p role="alert">This plugin view returned invalid data and was isolated.</p>;
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
        <header><h2>{contribution.title}</h2><button type="button" aria-label="Close" onClick={runtime.actions.closeView}>×</button></header>
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
      <header><h2>{contribution.title}</h2><button type="button" aria-label="Close" onClick={runtime.actions.closeView}>×</button></header>
      <PluginUiErrorBoundary>
        {projectionMismatch
          ? <p role="alert">This plugin view returned mismatched metadata and was isolated.</p>
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
  if (!permissions.length) return <p>No requested permissions.</p>;
  return (
    <div className="plugin-permissions">
      {permissions.map((permission) => (
        <article key={permission.permissionId}>
          <div><strong>{permission.permissionId}</strong><span>{permission.kind} · {permission.decision}</span></div>
          <pre>{JSON.stringify(permission.requestedScope, null, 2)}</pre>
          <div className="plugin-action-row">
            {permission.decision !== "granted" && <button type="button" onClick={() => void decide(permission.permissionId, "grant", permission.requestedScope)}>Grant requested scope</button>}
            {permission.decision === "granted" && <button type="button" onClick={() => void decide(permission.permissionId, "revoke")}>Revoke</button>}
            {permission.decision !== "denied" && <button type="button" onClick={() => void decide(permission.permissionId, "deny")}>Deny</button>}
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
      <h4>Public market-data providers</h4>
      <p>Host-owned ingestion only · public data · no account, secrets, or trading access.</p>
      <div className="plugin-provider-list">
        {providers.map((provider) => {
          if (provider.kind === "symbol-provider/1") {
            const config = provider.configuration;
            return (
              <article key={provider.id} data-plugin-provider-exchange={config.exchange}>
                <div><strong>{config.displayName}</strong><span>{config.exchange} · symbols</span></div>
                <p>
                  Markets: {config.marketTypes.map((item) => item.id).join(", ")}
                  {` · page ≤ ${config.maxPageSize} · cache ${config.cacheTtlSeconds}s`}
                </p>
              </article>
            );
          }
          const config = provider.configuration;
          return (
            <article key={provider.id} data-plugin-provider-exchange={config.exchange}>
              <div><strong>{config.exchange.toUpperCase()} market data</strong><span>{config.dataPlane}</span></div>
              <p>
                Source: {config.sourceQuality.quality} · finality {config.sourceQuality.finality}
              </p>
              <ul>
                {config.channels.map((channel) => (
                  <li key={channel.kind}>
                    {channel.kind === "full_depth" ? "Full depth" : "Kline"}
                    {` · ${[channel.history && "history", channel.realtime && "realtime"].filter(Boolean).join(" + ")}`}
                    {channel.intervals.length ? ` · ${channel.intervals.join(", ")}` : ""}
                    {` · ${channel.delivery} · ${channel.finality}`}
                    {channel.corrections ? " · corrections" : ""}
                    {` · ${channel.ratePerMinute}/min · concurrency ${channel.maxConcurrent}`}
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
    if (!next && !window.confirm("Resume Paper order submission? Host risk checks and limits remain active.")) return;
    try {
      await runtime.actions.setPaperKillSwitch(next);
      await reload();
    } catch { /* notice published */ }
  };
  return (
    <section className="plugin-paper-panel" data-plugin-paper-only>
      <h4>Paper trading only</h4>
      <p>Host-owned balances, fills, risk, idempotency and audit. No live credentials, live submission, or plugin network access.</p>
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
            Global kill switch: {paper.killSwitchEnabled ? "ON" : "OFF"}
          </strong>
          <button
            type="button"
            data-paper-kill-switch
            disabled={!runtime.view.managementAvailable}
            onClick={() => void toggleKillSwitch()}
          >
            {paper.killSwitchEnabled ? "Resume Paper orders" : "Stop Paper orders"}
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
  const catalog = runtime.view.marketplaceCatalog;
  if (catalog === null) {
    return (
      <section className="plugin-marketplace-panel plugin-settings-card">
        <p>正在读取可信插件市场配置…</p>
      </section>
    );
  }
  return (
    <section className="plugin-marketplace-panel plugin-settings-card" data-plugin-marketplace>
      <header className="plugin-settings-card-header">
        <div>
          <h3>可信插件市场</h3>
          <p>仅接收 Host 验证过签名、构建摘要与透明度记录的插件版本。</p>
        </div>
        <span
          className={`plugin-state-pill ${catalog.enabled ? "is-ready" : "is-muted"}`}
          data-plugin-marketplace-state
        >
          {catalog.enabled ? "已开启" : "未配置"}
        </span>
      </header>
      {!catalog.enabled && !catalog.marketplaces.length && (
        <div className="plugin-empty-state plugin-marketplace-empty">
          <strong>尚未配置可信插件市场</strong>
          <p>当前仍可通过上方的本地安装加入经 SHA-256 校验的 .cspkg 插件包。</p>
        </div>
      )}
      <details className="plugin-technical-details">
        <summary>安全与更新策略</summary>
        <p>市场元数据不会自动授予权限。下载只会生成已验证的候选版本，应用与激活均需显式操作，自动更新保持关闭。</p>
      </details>
      <div className="plugin-marketplace-roots">
        {catalog.marketplaces.map((marketplace) => (
          <article key={marketplace.marketplaceId}>
            <div>
              <strong>{marketplace.marketplaceId}</strong>
              <small>
                {marketplace.cache.status === "valid"
                  ? `verified index #${marketplace.cache.sequence} · expires ${marketplace.cache.expiresAt}`
                  : `cache unavailable · ${marketplace.cache.reason ?? "no verified index"}`}
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
              {busy === `refresh:${marketplace.marketplaceId}` ? "Verifying…" : "Refresh signed index"}
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
          return (
            <article key={entry.pluginId} data-marketplace-plugin={entry.pluginId}>
              <div className="plugin-marketplace-title">
                <div>
                  <strong>{entry.pluginId}</strong>
                  <small>{entry.publisher.displayName} · verified key {entry.publisher.keyId.slice(0, 24)}…</small>
                </div>
                <span>
                  {entry.latest.version} · {entry.latest.licenseExpression}
                  {entry.latest.revoked ? " · revoked" : ""}
                </span>
              </div>
              <p>
                {entry.latest.artifact.sha256}
                {` · ${entry.latest.artifact.size} bytes · transparency #${entry.latest.transparency.logIndex}`}
              </p>
              <p>
                Installed: {entry.installedVersion ?? "no"}
                {candidate ? ` · candidate ${candidate.version}: ${candidate.phase}` : ""}
              </p>
              {candidate && (
                <div className="plugin-marketplace-candidate" data-marketplace-candidate-phase={candidate.phase}>
                  <p>
                    Compatibility: Host {candidate.compatibility.hostVersion} verified · migration {candidate.migration.policy}
                    {` · permission confirmation ${candidate.permissionDiff.requiresConfirmation ? "required" : "not required"}`}
                  </p>
                  {candidate.permissionDiff.permissions.length > 0 && (
                    <ul>
                      {candidate.permissionDiff.permissions.map((permission) => (
                        <li key={permission.permissionId}>
                          {permission.permissionId} · {permission.change}
                          {permission.requiresConfirmation ? " · confirmation required" : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {candidate.observation.status !== "not-started" && (
                    <p>Health observation: {candidate.observation.status}{candidate.observation.detail ? ` · ${candidate.observation.detail}` : ""}</p>
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
                  {busy === `prepare:${entry.pluginId}` ? "Downloading and verifying…" : "Download, verify & stage"}
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
                    {busy === `apply:${entry.pluginId}` ? "Probing in sandbox…" : "Apply as inactive staged"}
                  </button>
                )}
                {candidate?.phase === "activation-staged" && (
                  <button
                    type="button"
                    data-marketplace-activate={entry.pluginId}
                    disabled={!runtime.view.managementAvailable || !activationReady || busy !== null}
                    onClick={() => {
                      if (!window.confirm(`Activate ${entry.pluginId} ${candidate.version} and begin immediate Host health observation?`)) return;
                      void run(
                        `activate:${entry.pluginId}`,
                        () => runtime.actions.activateMarketplaceRelease(entry.pluginId),
                      );
                    }}
                  >
                    {busy === `activate:${entry.pluginId}` ? "Activating and observing…" : "Activate & observe"}
                  </button>
                )}
              </div>
              {candidate?.phase === "activation-staged" && !activationReady && (
                <small>Grant every required permission in the installed-plugin detail before activation.</small>
              )}
            </article>
          );
        })}
        {catalog.enabled && !catalog.plugins.length && <p>已验证的插件索引中暂无可安装版本。</p>}
      </div>
    </section>
  );
}

export function PluginSettingsPanel({ runtime }: { runtime: PluginPlatformRuntime }) {
  const plugins = useMemo(
    () => runtime.view.catalog?.plugins ?? [],
    [runtime.view.catalog?.plugins],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PluginManagementDetail | null>(null);
  const [marketplaceStatus, setMarketplaceStatus] = useState<PluginMarketplaceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
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
    if (action === "uninstall" && !window.confirm(`Uninstall ${selected.name}? Plugin data and immutable artifacts will be retained.`)) return;
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
        ? "Import this exact v1 registry preview into the compatibility catalog? The v1 registry itself will not be modified."
        : "Roll back the compatibility catalog to this exact preview? The v1 registry itself will not be modified.",
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
          <span className="plugin-settings-eyebrow">扩展能力</span>
          <h3>插件中心</h3>
          <p>集中管理脚本运行时、插件安装与可信扩展来源。</p>
        </div>
        <span className={`plugin-state-pill ${platformEnabled ? "is-ready" : "is-compatibility"}`}>
          {platformEnabled ? "平台已启用" : "兼容模式"}
        </span>
      </section>
      <div className="plugin-settings-summary" aria-label="插件平台概览">
        <div><strong>{plugins.length}</strong><span>已安装插件</span></div>
        <div><strong>{runtimeCount}</strong><span>脚本运行时</span></div>
        <div>
          <strong>{marketplaceEnabled ? "已开启" : "未配置"}</strong>
          <span>可信插件市场</span>
        </div>
      </div>
      {compatibility && (
        <section className="plugin-settings-card plugin-v1-compatibility" data-v1-compatibility-status={compatibility.import.status}>
          <header className="plugin-settings-card-header">
            <div>
              <h3>脚本运行时</h3>
              <p>已接入的指标语言运行时，可直接为图表提供计算与渲染能力。</p>
            </div>
            <span className="plugin-state-pill is-ready">{runtimeCount} 个可用</span>
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
                      {contribution.imported ? " · 已导入" : " · 实时发现"}
                    </span>
                  </div>
                  <span className={`plugin-state-pill ${contribution.available ? "is-ready" : "is-muted"}`}>
                    {contribution.available ? "可用" : "不可用"}
                  </span>
                </div>
                <details className="plugin-technical-details">
                  <summary>技术详情</summary>
                  <dl>
                    <div><dt>运行时</dt><dd>{contribution.runtimeId}</dd></div>
                    <div><dt>协议</dt><dd>{compatibility.protocol}</dd></div>
                    {contribution.release.bundleSha256 && (
                      <div><dt>构建摘要</dt><dd>{contribution.release.bundleSha256}</dd></div>
                    )}
                  </dl>
                </details>
              </article>
            ))}
          </div>
          {!compatibility.contributions.length && (
            <div className="plugin-empty-state">
              <strong>暂未发现脚本运行时</strong>
              <p>已安装并可路由的运行时会显示在这里。</p>
            </div>
          )}
          <div className="plugin-action-row">
            <button
              type="button"
              data-v1-compatibility-preview="import"
              disabled={!platformEnabled || !runtime.view.managementAvailable || compatibilityBusy !== null}
              onClick={() => void previewCompatibility("import")}
            >
              {compatibilityBusy === "import" ? "正在生成预览…" : "预览注册表导入"}
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
              {compatibilityBusy === "rollback" ? "正在生成预览…" : "预览兼容层回滚"}
            </button>
          </div>
          {!platformEnabled && <small>启用插件平台后，才可保存兼容层导入快照。</small>}
          {compatibilityPreview && (
            <div className="plugin-v1-compatibility-preview" data-v1-compatibility-action={compatibilityPreview.action}>
              <p>
                Preview {compatibilityPreview.previewSha256 ?? "unavailable"} · state revision {compatibilityPreview.stateRevision}
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
                  <p>
                    No public contribution changes. Applying can refresh a changed source identity;
                    an already-current repeat remains idempotent.
                  </p>
                )}
              <button
                type="button"
                data-v1-compatibility-apply={compatibilityPreview.action}
                disabled={!compatibilityPreview.available || compatibilityBusy !== null}
                onClick={() => void applyCompatibility()}
              >
                Apply exact {compatibilityPreview.action} preview
              </button>
            </div>
          )}
        </section>
      )}
      {platformEnabled && (
        <section className="plugin-settings-card plugin-install-card">
          <header className="plugin-settings-card-header">
            <div>
              <h3>从本地安装</h3>
              <p>安装经过摘要校验的 CandleScope 插件包，安装后仍需显式授权与启用。</p>
            </div>
          </header>
          <div className="plugin-install-row">
            <label className="plugin-install-button">
              <input
                type="file"
                accept=".cspkg,application/vnd.candlescope.plugin+zip"
              data-plugin-install-input
              disabled={!runtime.view.managementAvailable || installing}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setInstalling(true);
                try { await runtime.actions.installBundle(file); } catch { /* notice published */ }
                finally { setInstalling(false); }
              }}
              />
              <span>{installing ? "正在校验并安装…" : "选择 .cspkg 文件"}</span>
            </label>
            <div>
              <strong>经过摘要校验的本地插件包</strong>
              <small>浏览器与 Host 会分别复算 SHA-256，文件最大 16 MiB。</small>
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
              <h3>已安装插件</h3>
              <p>查看运行状态、权限、更新与回滚信息。</p>
            </div>
            <span className="plugin-state-pill is-muted">{plugins.length} 个</span>
          </header>
          {!plugins.length && (
            <div className="plugin-empty-state">
              <strong>还没有安装插件</strong>
              <p>可以从上方选择本地插件包，或在配置可信插件市场后安装扩展。</p>
            </div>
          )}
          {plugins.length > 0 && (
            <div className="plugin-manager-layout">
              <nav aria-label="已安装插件">
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
                    <p>{selected.id} · {selected.publisher} · {selected.trustLevel}</p>
                    <div className="plugin-action-row">
                      {selected.state === "active"
                        ? <button type="button" disabled={!runtime.view.managementAvailable} onClick={() => void mutate("disable")}>停用</button>
                        : <button type="button" disabled={!runtime.view.managementAvailable || !selected.permissions.activationReady} onClick={() => void mutate("enable")}>启用</button>}
                      <button type="button" disabled={!runtime.view.managementAvailable || !detail?.rollback.available} onClick={() => void mutate("rollback")}>回滚</button>
                      <button type="button" disabled={!runtime.view.managementAvailable} onClick={() => void mutate("uninstall")}>卸载</button>
                    </div>
                    {!runtime.view.managementAvailable && <p>当前为只读模式：缺少受信任的桌面管理会话。</p>}
                    {loading && <p>正在读取受保护的插件详情…</p>}
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
                        <h4>健康状态</h4>
                        <p>{detail.health.available ? "可用" : `不可用：${detail.health.unavailableReason ?? "原因未知"}`}</p>
                        <h4>更新与回滚</h4>
                        <p>
                          更新来源：签名插件市场或本地构建 · 自动更新已关闭
                          {detail.update.latest ? ` · 已验证 ${detail.update.latest.version} 可用` : ""}
                          {detail.update.reason ? ` · ${detail.update.reason}` : ""}
                        </p>
                        {detail.update.candidate && <p>候选版本：{detail.update.candidate.version} · {detail.update.candidate.phase}</p>}
                        <p>回滚：{detail.rollback.available ? `可用 → ${detail.rollback.target?.version ?? detail.rollback.target?.state ?? "上一个激活版本"}` : detail.rollback.reason ?? "不可用"}</p>
                        <h4>数据保留</h4>
                        <p>停用或卸载后保留插件私有数据，不会自动删除。</p>
                        <pre>{JSON.stringify(detail.dataRetention.storage, null, 2)}</pre>
                        <h4>权限</h4>
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
      {runtime.view.error && <div className="plugin-platform-notice plugin-platform-error" role="alert">Plugin Platform unavailable: {runtime.view.error}</div>}
      {runtime.view.notice && (
        <button type="button" className="plugin-platform-notice" onClick={runtime.actions.clearNotice}>{runtime.view.notice}</button>
      )}
    </PluginUiErrorBoundary>
  );
}
