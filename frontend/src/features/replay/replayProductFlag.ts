const replayV2EnvironmentFlag: unknown = (import.meta as {
  readonly env?: { readonly VITE_REPLAY_PRODUCT_V2_ENABLED?: unknown };
}).env?.VITE_REPLAY_PRODUCT_V2_ENABLED;

export function replayV2ProductFlagEnabled(
  value: string | boolean | undefined,
): boolean {
  return value === undefined || value === true || value === "1" || value === "true";
}

export const REPLAY_PRODUCT_V2_ENABLED = replayV2ProductFlagEnabled(
  typeof replayV2EnvironmentFlag === "string"
    ? replayV2EnvironmentFlag
    : undefined,
);
