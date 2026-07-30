import type {
  PluginCatalog,
  PluginCatalogPlugin,
  PluginLiveControlStatus,
  PluginUiSnapshot,
} from "./pluginPlatformTypes.js";

export const PLUGIN_CATALOG_REVALIDATE_MS = 60_000;
export const PLUGIN_UI_ACTIVE_POLL_MS = 2_000;
export const PLUGIN_LIVE_ACTIVE_POLL_MS = 2_000;
export const PLUGIN_LIVE_IDLE_REVALIDATE_MS = 60_000;
export const PLUGIN_CHART_CONTEXT_HEARTBEAT_MS = 5_000;

const CHART_CONTEXT_PERMISSION_IDS = new Set([
  "chart.context.read",
  "chart.layer.publish",
]);
const CHART_LAYER_PERMISSION_IDS = new Set(["chart.layer.publish"]);

function isActivePlugin(plugin: PluginCatalogPlugin): boolean {
  return plugin.enabled && plugin.available && plugin.state === "active";
}

function hasGrantedPermission(
  plugin: PluginCatalogPlugin,
  permissionIds: ReadonlySet<string>,
): boolean {
  return plugin.permissions.permissions.some((permission) => (
    permission.decision === "granted" && permissionIds.has(permission.permissionId)
  ));
}

export function pluginCatalogNeedsUiPolling(
  catalog: PluginCatalog | null,
  snapshot: PluginUiSnapshot | null,
): boolean {
  if ((snapshot?.views.length ?? 0) > 0 || (snapshot?.chartLayers.length ?? 0) > 0) {
    return true;
  }
  if (!catalog?.platform.enabled || !catalog.platform.started) return false;
  return catalog.plugins.some((plugin) => (
    isActivePlugin(plugin)
    && (
      plugin.contributions.some((contribution) => (
        contribution.available
        && contribution.kind === "view/1"
        && contribution.configuration.renderer !== "sandbox"
      ))
      || hasGrantedPermission(plugin, CHART_LAYER_PERMISSION_IDS)
    )
  ));
}

export function pluginCatalogNeedsChartContextSync(
  catalog: PluginCatalog | null,
): boolean {
  if (!catalog?.platform.enabled || !catalog.platform.started) return false;
  return catalog.plugins.some((plugin) => (
    isActivePlugin(plugin)
    && hasGrantedPermission(plugin, CHART_CONTEXT_PERMISSION_IDS)
  ));
}

export function pluginLivePollIntervalMs(
  status: PluginLiveControlStatus,
): number {
  if (
    status.available
    || status.generation > 0
    || status.updatedAt !== null
  ) {
    return PLUGIN_LIVE_ACTIVE_POLL_MS;
  }
  return PLUGIN_LIVE_IDLE_REVALIDATE_MS;
}

export interface DeferredAbortableTask {
  start(): void;
  stop(): void;
}

interface DeferredTaskTimers {
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

interface DeferredAbortableTaskOptions {
  delayMs?: number;
  timers?: DeferredTaskTimers;
  onError?: (error: unknown) => void;
}

const DEFAULT_TIMERS: DeferredTaskTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * Defers bootstrap by one task so React StrictMode can tear down its rehearsal
 * effect before any HTTP request starts. Once running, cleanup aborts the
 * complete bootstrap request group.
 */
export function createDeferredAbortableTask(
  task: (signal: AbortSignal) => Promise<void>,
  options: DeferredAbortableTaskOptions = {},
): DeferredAbortableTask {
  const delayMs = options.delayMs ?? 0;
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error("deferred task delay must be a non-negative integer");
  }
  const timers = options.timers ?? DEFAULT_TIMERS;
  const onError = options.onError ?? (() => undefined);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let started = false;
  let stopped = false;

  return {
    start() {
      if (started || stopped) return;
      started = true;
      timer = timers.setTimeout(() => {
        timer = null;
        if (stopped) return;
        const current = new AbortController();
        controller = current;
        void task(current.signal)
          .catch(onError)
          .finally(() => {
            if (controller === current) controller = null;
          });
      }, delayMs);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      controller?.abort();
      controller = null;
    },
  };
}
