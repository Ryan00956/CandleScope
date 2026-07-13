type SurfaceMethod = (...args: never[]) => unknown;

type SurfaceMethodKeys<TSurface> = {
  [TKey in keyof TSurface]-?: TSurface[TKey] extends SurfaceMethod ? TKey : never;
}[keyof TSurface];

type SurfaceMethodAt<
  TSurface,
  TKey extends SurfaceMethodKeys<TSurface>,
> = Extract<TSurface[TKey], SurfaceMethod>;

export type ChartSurfaceView = Readonly<Record<string, never>>;

export const EMPTY_CHART_SURFACE_VIEW: ChartSurfaceView = Object.freeze({});

export function callChartSurface<
  TSurface extends object,
  TKey extends SurfaceMethodKeys<TSurface>,
  TFallback = undefined,
>(
  chartRef: { current?: TSurface | null } | null | undefined,
  methodName: TKey,
  fallback: TFallback = undefined as TFallback,
  ...args: Parameters<SurfaceMethodAt<TSurface, TKey>>
): ReturnType<SurfaceMethodAt<TSurface, TKey>> | TFallback {
  try {
    const surface = chartRef?.current;
    const method = surface?.[methodName];
    if (typeof method !== "function") return fallback;
    return Reflect.apply(method, surface, args) as ReturnType<SurfaceMethodAt<TSurface, TKey>>;
  } catch {
    return fallback;
  }
}
