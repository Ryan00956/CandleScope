import { formatPluginValue } from "./pluginViewFormatting.js";
import type { PluginPlatformRuntime } from "./pluginPlatformTypes.js";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";

export default function PluginPlatformStatus({ runtime }: { runtime: PluginPlatformRuntime }) {
  const locale = useLocale();
  const projections = new Map((runtime.view.snapshot?.views ?? []).map((item) => [item.id, item]));
  return (
    <div className="plugin-status-slot" data-plugin-slot="statusArea">
      {runtime.view.registries.statusArea.map((view) => {
        if (view.configuration.renderer === "sandbox") {
          return <span key={view.id}>{t("plugin.host.statusUnavailable", {}, locale)}</span>;
        }
        const candidate = projections.get(view.id);
        const projection = candidate
          && candidate.pluginId === view.pluginId
          && candidate.slot === view.configuration.slot
          && candidate.renderer === view.configuration.renderer
          ? candidate
          : undefined;
        if (candidate && !projection) return <span key={view.id}>{t("plugin.host.statusUnavailable", {}, locale)}</span>;
        if (!projection || projection.state === "empty") return <span key={view.id}>{view.configuration.emptyState}</span>;
        if (projection.state === "error" || !("values" in projection.data)) return <span key={view.id}>{t("plugin.host.statusUnavailable", {}, locale)}</span>;
        const values = projection.data.values;
        return (
          <span key={view.id} data-plugin-view={view.id}>
            {view.configuration.fields.map((field) => `${field.label}: ${formatPluginValue(values[field.field], field.format, locale)}`).join(" · ")}
          </span>
        );
      })}
    </div>
  );
}
