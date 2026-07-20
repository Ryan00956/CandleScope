export type InitialRepairRetryMode = "none" | "exact" | "broad";

export interface InitialRepairRetryPolicyInput {
  repairPending: boolean;
  exactRangeTracked: boolean;
  terminal: boolean;
}

export interface InitialRepairRetryControls {
  startBroadRetry(): void;
  stopBroadRetry(): void;
}

/**
 * Selects one owner for initial-history recovery.
 *
 * Exact range polling is preferred whenever the backend supplied enough
 * coverage metadata to identify the unfinished range. The broad history
 * retry remains only as a compatibility fallback for pending responses that
 * cannot be located precisely.
 */
export function initialRepairRetryMode({
  repairPending,
  exactRangeTracked,
  terminal,
}: InitialRepairRetryPolicyInput): InitialRepairRetryMode {
  if (!repairPending || terminal) return "none";
  return exactRangeTracked ? "exact" : "broad";
}

export function reconcileInitialRepairRetry(
  mode: InitialRepairRetryMode,
  { startBroadRetry, stopBroadRetry }: InitialRepairRetryControls,
): void {
  if (mode === "broad") startBroadRetry();
  else stopBroadRetry();
}
