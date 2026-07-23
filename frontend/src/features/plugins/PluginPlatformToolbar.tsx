import type { PluginPlatformRuntime } from "./pluginPlatformTypes.js";

export default function PluginPlatformToolbar({ runtime }: { runtime: PluginPlatformRuntime }) {
  const { catalog, registries, managementAvailable } = runtime.view;
  if (!catalog?.platform.enabled) return null;
  return (
    <div className="plugin-toolbar" data-plugin-slot="topToolbar">
      {registries.topToolbar.map((command) => {
        const properties = command.configuration.inputSchema?.properties ?? {};
        const direct = Object.keys(properties).length === 0;
        return (
          <button
            type="button"
            key={command.id}
            data-plugin-command={command.id}
            disabled={!managementAvailable}
            title={managementAvailable ? command.title : "Trusted desktop management session required"}
            onClick={() => {
              if (direct) void runtime.actions.invokeCommand(command.id, {}).catch(() => undefined);
              else runtime.actions.openPalette();
            }}
          >
            {command.title}
          </button>
        );
      })}
      {registries.commandPalette.length > 0 && (
        <button type="button" data-plugin-command-palette onClick={runtime.actions.openPalette}>
          Commands
        </button>
      )}
      {[...registries.sidePanel, ...registries.bottomPanel].map((view) => (
        <button type="button" key={view.id} data-plugin-view-button={view.id} onClick={() => runtime.actions.openView(view.id)}>
          {view.title}
        </button>
      ))}
      {registries.settings.map((settings) => (
        <button type="button" key={settings.id} data-plugin-settings-button={settings.id} onClick={() => runtime.actions.openSettings(settings.id)}>
          {settings.title}
        </button>
      ))}
      {runtime.view.liveControl.mode !== "disabled" && (
        <button
          type="button"
          data-live-control-button
          className={`live-control-toolbar live-control-${runtime.view.liveControl.mode}`}
          onClick={runtime.actions.openLiveControl}
        >
          LIVE {runtime.view.liveControl.mode.toUpperCase()}
        </button>
      )}
      <button type="button" data-plugin-manager onClick={runtime.actions.openManager}>
        Plugins
      </button>
    </div>
  );
}
