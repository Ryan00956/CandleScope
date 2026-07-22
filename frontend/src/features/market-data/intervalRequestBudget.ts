import {
  getIntervalSemanticSpec,
  INTERVAL_UNIT_SECONDS,
  intervalTiles,
  intervalsSemanticallyEquivalent,
  parseIntervalSeconds,
  type IntervalString,
} from "../../utils/intervals.js";

export const DERIVED_INTERVAL_SOURCE_PADDING_BARS = 3;

export interface TargetBarRequestPlan {
  baseInterval: IntervalString | null;
  blockedReason: "invalid-request" | "unresolved-source" | null;
  budgetLimited: boolean;
  derived: boolean;
  estimatedSourceRows: number;
  sourceFactor: number;
  targetBars: number;
}

function sourceRowsPerTargetBar(source: IntervalString, target: IntervalString): number | null {
  const sourceSpec = getIntervalSemanticSpec(source);
  const targetSpec = getIntervalSemanticSpec(target);
  if (!sourceSpec || !targetSpec) return null;

  if (targetSpec.alignment === "calendar-month") {
    if (sourceSpec.alignment === "calendar-month") {
      return Math.ceil((targetSpec.monthCount || 0) / (sourceSpec.monthCount || 1));
    }
    if (sourceSpec.widthSeconds == null) return null;
    return Math.ceil(
      ((targetSpec.monthCount || 0) * 31 * INTERVAL_UNIT_SECONDS.d)
      / sourceSpec.widthSeconds,
    );
  }
  if (targetSpec.alignment === "weekly-monday") {
    if (sourceSpec.alignment === "weekly-monday") {
      return Math.ceil((targetSpec.weekCount || 0) / (sourceSpec.weekCount || 1));
    }
    if (sourceSpec.widthSeconds == null) return null;
    return Math.ceil(
      ((targetSpec.weekCount || 0) * INTERVAL_UNIT_SECONDS.w)
      / sourceSpec.widthSeconds,
    );
  }
  if (sourceSpec.widthSeconds == null || targetSpec.widthSeconds == null) return null;
  return Math.ceil(targetSpec.widthSeconds / sourceSpec.widthSeconds);
}

export interface TargetBarRequestPlanInput {
  desiredTargetBars: number;
  interval: IntervalString;
  nativeIntervals: readonly IntervalString[];
  sourcePaddingBars?: number;
  sourceRowBudget: number;
}

/**
 * Bound a derived-interval request by the number of native source rows it expands to.
 * Native intervals keep the requested target size because they do not fan out.
 */
export function planTargetBarRequest({
  desiredTargetBars,
  interval,
  nativeIntervals,
  sourcePaddingBars = DERIVED_INTERVAL_SOURCE_PADDING_BARS,
  sourceRowBudget,
}: TargetBarRequestPlanInput): TargetBarRequestPlan {
  const desired = Math.floor(desiredTargetBars);
  const budget = Math.floor(sourceRowBudget);
  const padding = Math.max(0, Math.floor(sourcePaddingBars));
  if (desired <= 0 || budget <= 0) {
    return {
      baseInterval: null,
      blockedReason: "invalid-request",
      budgetLimited: true,
      derived: true,
      estimatedSourceRows: 0,
      sourceFactor: 0,
      targetBars: 0,
    };
  }

  const nativeMatch = nativeIntervals.find((candidate) => (
    intervalsSemanticallyEquivalent(candidate, interval)
  ));
  if (nativeMatch) {
    return {
      baseInterval: nativeMatch,
      blockedReason: null,
      budgetLimited: false,
      derived: false,
      estimatedSourceRows: desired,
      sourceFactor: 1,
      targetBars: desired,
    };
  }

  const targetSeconds = parseIntervalSeconds(interval);
  if (!targetSeconds) {
    return {
      baseInterval: null,
      blockedReason: "unresolved-source",
      budgetLimited: true,
      derived: true,
      estimatedSourceRows: 0,
      sourceFactor: 0,
      targetBars: 0,
    };
  }

  let baseInterval: IntervalString | null = null;
  let baseSeconds = 0;
  for (const candidate of nativeIntervals) {
    const candidateSeconds = parseIntervalSeconds(candidate);
    if (
      !candidateSeconds
      || candidateSeconds >= targetSeconds
      || candidateSeconds <= baseSeconds
      || !intervalTiles(candidate, interval)
    ) continue;
    baseInterval = candidate;
    baseSeconds = candidateSeconds;
  }
  if (!baseInterval || baseSeconds <= 0) {
    return {
      baseInterval: null,
      blockedReason: "unresolved-source",
      budgetLimited: true,
      derived: true,
      estimatedSourceRows: 0,
      sourceFactor: 0,
      targetBars: 0,
    };
  }

  const sourceFactor = sourceRowsPerTargetBar(baseInterval, interval);
  if (!sourceFactor || sourceFactor <= 0) {
    return {
      baseInterval,
      blockedReason: "unresolved-source",
      budgetLimited: true,
      derived: true,
      estimatedSourceRows: 0,
      sourceFactor: 0,
      targetBars: 0,
    };
  }
  const maxTargetBars = Math.floor(budget / sourceFactor) - padding;
  if (maxTargetBars <= 0) {
    return {
      baseInterval,
      blockedReason: null,
      budgetLimited: true,
      derived: true,
      estimatedSourceRows: 0,
      sourceFactor,
      targetBars: 0,
    };
  }
  const targetBars = Math.min(desired, maxTargetBars);
  return {
    baseInterval,
    blockedReason: null,
    budgetLimited: targetBars < desired,
    derived: true,
    estimatedSourceRows: (targetBars + padding) * sourceFactor,
    sourceFactor,
    targetBars,
  };
}
