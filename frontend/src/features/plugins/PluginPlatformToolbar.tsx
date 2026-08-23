import type { PluginPlatformRuntime } from "./pluginPlatformTypes.js";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";

export default function PluginPlatformToolbar({ runtime }: { runtime: PluginPlatformRuntime }) {
  useLocale();
  const { catalog, registries, managementAvailable } = runtime.view;
  if (!catalog) return null;
  if (!catalog.platform.enabled && catalog.compatibility.contributions.length === 0) return null;
  const hasToolbarControls = catalog.platform.enabled && (
    registries.topToolbar.length > 0
    || registries.commandPalette.length > 0
    || registries.sidePanel.length > 0
    || registries.bottomPanel.length > 0
    || registries.settings.length > 0
    || runtime.view.liveControl.mode !== "disabled"
  );
  if (!hasToolbarControls) return null;
  return (
    <div className="plugin-toolbar" data-plugin-slot="topToolbar">
      {catalog.platform.enabled && registries.topToolbar.map((command) => {
        const properties = command.configuration.inputSchema?.properties ?? {};
        const direct = Object.keys(properties).length === 0;
        return (
          <button
            type="button"
            key={command.id}
            data-plugin-command={command.id}
            disabled={!managementAvailable}
            title={managementAvailable ? command.title : t("plugin.host.managementRequired")}
            onClick={() => {
              if (direct) void runtime.actions.invokeCommand(command.id, {}).catch(() => undefined);
              else runtime.actions.openPalette();
            }}
          >
            {command.title}
          </button>
        );
      })}
      {catalog.platform.enabled && registries.commandPalette.length > 0 && (
        <button type="button" data-plugin-command-palette onClick={runtime.actions.openPalette}>
          {t("plugin.host.commands")}
        </button>
      )}
      {catalog.platform.enabled && [...registries.sidePanel, ...registries.bottomPanel].map((view) => (
        <button type="button" key={view.id} data-plugin-view-button={view.id} onClick={() => runtime.actions.openView(view.id)}>
          {view.title}
        </button>
      ))}
      {catalog.platform.enabled && registries.settings.map((settings) => (
        <button type="button" key={settings.id} data-plugin-settings-button={settings.id} onClick={() => runtime.actions.openSettings(settings.id)}>
          {settings.title}
        </button>
      ))}
      {catalog.platform.enabled && runtime.view.liveControl.mode !== "disabled" && (
        <button
          type="button"
          data-live-control-button
          className={`live-control-toolbar live-control-${runtime.view.liveControl.mode}`}
          onClick={runtime.actions.openLiveControl}
        >
          LIVE {runtime.view.liveControl.mode.toUpperCase()}
        </button>
      )}
    </div>
  );
}
