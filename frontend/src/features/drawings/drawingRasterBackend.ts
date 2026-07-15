export const DRAWING_RASTER_BACKENDS = ["worker", "main-thread"] as const;

export type DrawingRasterBackend = typeof DRAWING_RASTER_BACKENDS[number];

export interface DrawingRasterBackendResolution {
  readonly requested: DrawingRasterBackend;
  readonly effective: DrawingRasterBackend;
  readonly source: "default" | "environment" | "benchmark-fallback";
  readonly failedClosed: boolean;
  readonly workerResultDeliveryDelayMs: number;
}

export interface DrawingRasterBackendResolverOptions {
  readonly configured?: unknown;
  readonly forceMainThreadFallback?: boolean;
  readonly workerResultDeliveryDelayMs?: unknown;
}

function configuredRasterBackend(): unknown {
  return import.meta.env?.VITE_DRAWING_RASTER_BACKEND;
}

function benchmarkForcesMainThread(): boolean {
  if (typeof window === "undefined") return false;
  const candidate = window as Window & {
    __CANDLESCOPE_DRAWING_PERF_CONFIG__?: Readonly<{
      phase6ForceMainThreadFallback?: unknown;
    }>;
  };
  return candidate.__CANDLESCOPE_DRAWING_PERF_CONFIG__?.phase6ForceMainThreadFallback === true;
}

function benchmarkWorkerResultDeliveryDelayMs(): unknown {
  if (typeof window === "undefined") return 0;
  const candidate = window as Window & {
    __CANDLESCOPE_DRAWING_PERF_CONFIG__?: Readonly<{
      phase6WorkerDelayMs?: unknown;
    }>;
  };
  return candidate.__CANDLESCOPE_DRAWING_PERF_CONFIG__?.phase6WorkerDelayMs ?? 0;
}

function normalizedWorkerResultDeliveryDelayMs(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.min(1_000, Math.floor(numeric))
    : 0;
}

export function isDrawingRasterBackend(value: unknown): value is DrawingRasterBackend {
  return typeof value === "string"
    && (DRAWING_RASTER_BACKENDS as readonly string[]).includes(value);
}

/** Mount-locked backend choice; fallback never changes scene/document ownership. */
export function resolveDrawingRasterBackend({
  configured = configuredRasterBackend(),
  forceMainThreadFallback = benchmarkForcesMainThread(),
  workerResultDeliveryDelayMs = benchmarkWorkerResultDeliveryDelayMs(),
}: DrawingRasterBackendResolverOptions = {}): DrawingRasterBackendResolution {
  const valid = isDrawingRasterBackend(configured);
  const requested = valid ? configured : "worker";
  const resultDeliveryDelayMs = normalizedWorkerResultDeliveryDelayMs(
    workerResultDeliveryDelayMs,
  );
  if (forceMainThreadFallback) {
    return Object.freeze({
      requested,
      effective: "main-thread",
      source: "benchmark-fallback",
      failedClosed: false,
      workerResultDeliveryDelayMs: resultDeliveryDelayMs,
    });
  }
  return Object.freeze({
    requested,
    effective: requested,
    source: valid ? "environment" : "default",
    failedClosed:
      !valid && configured !== undefined && configured !== null && configured !== "",
    workerResultDeliveryDelayMs: resultDeliveryDelayMs,
  });
}
