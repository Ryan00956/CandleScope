import {
  buildHostedSubscriptionSignature,
  getVisibleHostedIndicators,
} from "./indicatorWsRuntime.js";
import type {
  IndicatorDefinition,
  IndicatorSubscriptionContext,
  IndicatorWsMessage,
} from "./indicatorTypes.js";

export type HostedIndicatorIdentityContext = Pick<
  IndicatorSubscriptionContext,
  | "candleDownColor"
  | "candleUpColor"
  | "exchange"
  | "interval"
  | "marketType"
  | "symbol"
>;

/**
 * Build the configuration identities that are authoritative for the current
 * committed React tree. The map intentionally excludes resume/checkpoint
 * metadata: those fields change transport recovery, not indicator semantics.
 */
export function buildCurrentHostedIndicatorSignatures(
  indicators: readonly IndicatorDefinition[],
  context: HostedIndicatorIdentityContext,
): ReadonlyMap<string, string> {
  return new Map(getVisibleHostedIndicators([...indicators]).map((indicator) => [
    indicator.id,
    buildHostedSubscriptionSignature(indicator, context),
  ]));
}

/**
 * Every client-scoped frame must prove which wire subscription produced it.
 * Missing provenance is rejected instead of being relabelled with the current
 * identity; otherwise an A -> B commit can expose a late A snapshot/error to B
 * before the passive subscription reconciliation runs.
 */
export function isCurrentHostedIndicatorMessage(
  message: IndicatorWsMessage,
  sourceSubscriptionSignature: string | undefined,
  currentSignatures: ReadonlyMap<string, string>,
): boolean {
  const clientId = message.clientId;
  if (!clientId || !sourceSubscriptionSignature) return false;
  return currentSignatures.get(clientId) === sourceSubscriptionSignature;
}
