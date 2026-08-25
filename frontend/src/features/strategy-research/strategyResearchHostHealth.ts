import type { ResearchRuntimeMode } from "../research-data/researchDataTypes.js";

export type StrategyResearchNetworkDiagnostics = {
  installed: boolean;
  policy: string;
  blockedAttempts: number;
};

export type StrategyResearchHostHealth = {
  runtimeMode: ResearchRuntimeMode;
  network: StrategyResearchNetworkDiagnostics | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseStrategyResearchHostHealth(payload: unknown): StrategyResearchHostHealth {
  const record = asRecord(payload);
  const runtimeMode = record?.runtime_mode === "LOCAL_OFFLINE" ? "LOCAL_OFFLINE" : "LIVE";
  const localOffline = asRecord(record?.local_offline);
  const network = asRecord(localOffline?.network);
  if (network === null) {
    return { runtimeMode, network: null };
  }
  return {
    runtimeMode,
    network: {
      installed: network.installed === true,
      policy: typeof network.policy === "string" ? network.policy : "loopback_only",
      blockedAttempts: Number.isFinite(Number(network.blocked_attempts))
        ? Number(network.blocked_attempts)
        : 0,
    },
  };
}

export async function loadStrategyResearchHostHealth(
  signal?: AbortSignal,
): Promise<StrategyResearchHostHealth> {
  try {
    const response = await fetch("/health", signal === undefined ? {} : { signal });
    if (!response.ok) return { runtimeMode: "LIVE", network: null };
    return parseStrategyResearchHostHealth(await response.json());
  } catch (reason) {
    if (signal?.aborted) throw reason;
    return { runtimeMode: "LIVE", network: null };
  }
}
