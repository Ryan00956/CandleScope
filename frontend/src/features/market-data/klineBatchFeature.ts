export interface KlineBatchEnvironment {
  KLINE_BATCH_STREAM_ENABLED?: unknown;
}

function enabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

export function resolveKlineBatchStreamEnabled(
  environment: KlineBatchEnvironment = {},
): boolean {
  return enabled(environment.KLINE_BATCH_STREAM_ENABLED);
}

function viteEnvironment(): KlineBatchEnvironment {
  try {
    return {
      KLINE_BATCH_STREAM_ENABLED: import.meta.env?.VITE_KLINE_BATCH_STREAM_ENABLED,
    };
  } catch {
    return {};
  }
}

/** Default-off rollback boundary; false keeps /stream/klines_multi unchanged. */
export const KLINE_BATCH_STREAM_ENABLED = resolveKlineBatchStreamEnabled(viteEnvironment());
