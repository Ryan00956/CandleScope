import React, { useEffect, useMemo, useState } from "react";
import { PluginNativeField } from "./PluginNativeFields.js";
import SandboxPluginFrame from "./SandboxPluginFrame.js";
import { defaultForPluginSchema } from "./pluginSchemaDefaults.js";
import { formatPluginValue } from "./pluginViewFormatting.js";
import type {
  JsonValue,
  PluginCommandContribution,
  PluginDeclarativeViewContribution,
  PluginManagementDetail,
  PluginPlatformRuntime,
  PluginSandboxViewContribution,
  PluginSettingsContribution,
  PluginViewContribution,
  PluginViewProjection,
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
  const commands = runtime.view.registries.commandPalette.filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));
  const selected = runtime.view.registries.commandPalette.find((item) => item.id === selectedId) ?? null;
  useEffect(() => {
    if (!runtime.view.paletteOpen) {
      setQuery("");
      setSelectedId(null);
    }
  }, [runtime.view.paletteOpen]);
  if (!runtime.view.paletteOpen) return null;
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
              {selected.configuration.inputSchema && (
                <PluginNativeField
                  name="root"
                  schema={selected.configuration.inputSchema}
                  value={input}
                  onChange={(value) => {
                    if (value && typeof value === "object" && !Array.isArray(value)) setInput(value);
                  }}
                />
              )}
              <button
                type="button"
                disabled={!runtime.view.managementAvailable || running}
                onClick={async () => {
                  setRunning(true);
                  try {
                    await runtime.actions.invokeCommand(selected.id, input);
                    runtime.actions.closePalette();
                  } catch {
                    // Runtime publishes a bounded notice.
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

function PluginManager({ runtime }: { runtime: PluginPlatformRuntime }) {
  const plugins = useMemo(
    () => runtime.view.catalog?.plugins ?? [],
    [runtime.view.catalog?.plugins],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PluginManagementDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    if (!runtime.view.managerOpen) return;
    if (!selectedId || !plugins.some((item) => item.id === selectedId)) setSelectedId(plugins[0]?.id ?? null);
  }, [plugins, runtime.view.managerOpen, selectedId]);
  const reload = async () => {
    if (!selectedId || !runtime.view.managementAvailable) return;
    setLoading(true);
    try { setDetail(await runtime.actions.loadDetail(selectedId)); } catch { setDetail(null); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    setDetail(null);
    void reload();
    // reload is intentionally keyed by the selected plugin and manager visibility.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.view.managerOpen, runtime.view.managementAvailable, selectedId]);
  if (!runtime.view.managerOpen) return null;
  const selected = plugins.find((item) => item.id === selectedId) ?? null;
  const mutate = async (action: "enable" | "disable" | "rollback" | "uninstall") => {
    if (!selected) return;
    if (action === "uninstall" && !window.confirm(`Uninstall ${selected.name}? Plugin data and immutable artifacts will be retained.`)) return;
    try {
      await runtime.actions.changeState(selected.id, action);
      if (action !== "uninstall") await reload();
    } catch { /* notice published */ }
  };
  return (
    <Modal title="Plugin Manager" onClose={runtime.actions.closeManager} testId="plugin-manager">
      <div className="plugin-install-row">
        <label>
          <span>{installing ? "Installing and verifying…" : "Install signed .cspkg bundle"}</span>
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
        </label>
        <small>SHA-256 is recomputed by both browser and Host. Maximum 16 MiB.</small>
      </div>
      <div className="plugin-manager-layout">
        <nav>
          {plugins.map((plugin) => (
            <button type="button" key={plugin.id} className={selectedId === plugin.id ? "active" : ""} onClick={() => setSelectedId(plugin.id)}>
              <strong>{plugin.name}</strong><small>{plugin.version} · {plugin.state}</small>
            </button>
          ))}
          {!plugins.length && <p>No v2 plugins installed.</p>}
        </nav>
        <section className="plugin-manager-detail">
          {selected && (
            <>
              <h3>{selected.name}</h3>
              <p>{selected.id} · {selected.publisher} · {selected.trustLevel}</p>
              <div className="plugin-action-row">
                {selected.state === "active"
                  ? <button type="button" disabled={!runtime.view.managementAvailable} onClick={() => void mutate("disable")}>Disable</button>
                  : <button type="button" disabled={!runtime.view.managementAvailable || !selected.permissions.activationReady} onClick={() => void mutate("enable")}>Enable</button>}
                <button type="button" disabled={!runtime.view.managementAvailable || !detail?.rollback.available} onClick={() => void mutate("rollback")}>Rollback</button>
                <button type="button" disabled={!runtime.view.managementAvailable} onClick={() => void mutate("uninstall")}>Uninstall</button>
              </div>
              {!runtime.view.managementAvailable && <p>Read-only: trusted desktop management session was not provided.</p>}
              {loading && <p>Loading protected details…</p>}
              {detail && (
                <>
                  <h4>Health</h4>
                  <p>{detail.health.available ? "Available" : `Unavailable: ${detail.health.unavailableReason ?? "unknown"}`}</p>
                  <h4>Updates and rollback</h4>
                  <p>Updates: local artifact only · automatic updates disabled</p>
                  <p>Rollback: {detail.rollback.available ? `available → ${detail.rollback.target?.version ?? detail.rollback.target?.state ?? "previous activation"}` : detail.rollback.reason ?? "unavailable"}</p>
                  <h4>Data retention</h4>
                  <p>Private data is retained on disable and uninstall. Automatic deletion is disabled.</p>
                  <pre>{JSON.stringify(detail.dataRetention.storage, null, 2)}</pre>
                  <h4>Permissions</h4>
                  <PermissionRows runtime={runtime} detail={detail} reload={reload} />
                </>
              )}
            </>
          )}
        </section>
      </div>
    </Modal>
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
      <PluginManager runtime={runtime} />
      {openSettings && <SettingsSurface runtime={runtime} contribution={openSettings} />}
      {openView && <ViewSurface key={openView.id} runtime={runtime} contribution={openView} />}
      {runtime.view.error && <div className="plugin-platform-notice plugin-platform-error" role="alert">Plugin Platform unavailable: {runtime.view.error}</div>}
      {runtime.view.notice && (
        <button type="button" className="plugin-platform-notice" onClick={runtime.actions.clearNotice}>{runtime.view.notice}</button>
      )}
    </PluginUiErrorBoundary>
  );
}
