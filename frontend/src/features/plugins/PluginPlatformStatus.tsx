import { formatPluginValue } from "./pluginViewFormatting.js";
import type { PluginPlatformRuntime } from "./pluginPlatformTypes.js";

export default function PluginPlatformStatus({ runtime }: { runtime: PluginPlatformRuntime }) {
  const projections = new Map((runtime.view.snapshot?.views ?? []).map((item) => [item.id, item]));
  return (
    <div className="plugin-status-slot" data-plugin-slot="statusArea">
      {runtime.view.registries.statusArea.map((view) => {
        const candidate = projections.get(view.id);
        const projection = candidate
          && candidate.pluginId === view.pluginId
          && candidate.slot === view.configuration.slot
          && candidate.renderer === view.configuration.renderer
          ? candidate
          : undefined;
        if (candidate && !projection) return <span key={view.id}>Plugin status unavailable</span>;
        if (!projection || projection.state === "empty") return <span key={view.id}>{view.configuration.emptyState}</span>;
        if (projection.state === "error" || !("values" in projection.data)) return <span key={view.id}>Plugin status unavailable</span>;
        const values = projection.data.values;
        return (
          <span key={view.id} data-plugin-view={view.id}>
            {view.configuration.fields.map((field) => `${field.label}: ${formatPluginValue(values[field.field], field.format)}`).join(" · ")}
          </span>
        );
      })}
    </div>
  );
}
