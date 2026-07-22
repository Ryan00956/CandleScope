import type {
  PluginCatalog,
  PluginRegistries,
  PluginUiContribution,
} from "./pluginPlatformTypes.js";

export const EMPTY_PLUGIN_REGISTRIES: PluginRegistries = {
  commandPalette: [],
  topToolbar: [],
  chartContextMenu: [],
  settings: [],
  sidePanel: [],
  bottomPanel: [],
  statusArea: [],
};

export function buildPluginRegistries(catalog: PluginCatalog | null): PluginRegistries {
  if (!catalog?.platform.enabled) return EMPTY_PLUGIN_REGISTRIES;
  const values: PluginRegistries = {
    commandPalette: [],
    topToolbar: [],
    chartContextMenu: [],
    settings: [],
    sidePanel: [],
    bottomPanel: [],
    statusArea: [],
  };
  const contributions: PluginUiContribution[] = catalog.plugins
    .filter((plugin) => plugin.available && plugin.enabled)
    .flatMap((plugin) => plugin.contributions)
    .filter((item) => item.available);
  for (const item of contributions) {
    if (item.kind === "command/1") {
      for (const placement of item.configuration.placements) values[placement].push(item);
    } else if (item.kind === "settings/1") {
      values.settings.push(item);
    } else if (item.kind === "view/1") {
      values[item.configuration.slot].push(item);
    }
  }
  const compare = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
  values.commandPalette.sort(compare);
  values.topToolbar.sort(compare);
  values.chartContextMenu.sort(compare);
  values.settings.sort(compare);
  values.sidePanel.sort(compare);
  values.bottomPanel.sort(compare);
  values.statusArea.sort(compare);
  return values;
}
