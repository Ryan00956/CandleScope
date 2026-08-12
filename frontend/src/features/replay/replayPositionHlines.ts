import type { IndicatorHLine } from "../indicators/indicatorTypes.js";
import type {
  ReplayTrainingPortfolioPosition,
  ReplayV2Json,
  ReplayV2PositionMode,
} from "./replayV2Types.js";


type InstrumentRuleRecord = Readonly<Record<string, ReplayV2Json>>;

export interface ReplayPositionHLineInput {
  readonly selectedTrackId: string | null | undefined;
  readonly positionMode: ReplayV2PositionMode | null | undefined;
  readonly positions: readonly ReplayTrainingPortfolioPosition[];
  readonly instrumentRules?: readonly InstrumentRuleRecord[];
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function replayPositiveModelPrice(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export function replayMarkFidelityLabel(value: unknown): string {
  if (typeof value !== "string") return "模型代理";
  const fidelity = value.toUpperCase();
  if (fidelity.includes("HISTORICAL") && !fidelity.includes("PROXY")) {
    return "历史 Mark";
  }
  if (fidelity.includes("BAR") && (
    fidelity.includes("TAPE") || fidelity.includes("TRADE")
  )) return "K线/成交代理";
  if (fidelity.includes("BAR")) return "K线代理";
  if (fidelity.includes("TAPE") || fidelity.includes("TRADE")) return "成交代理";
  return "模型代理";
}

function displayPrice(raw: unknown, parsed: number): string {
  return typeof raw === "string" && raw.length > 0 ? raw : String(parsed);
}

function contractSizeFor(
  instrumentRules: readonly InstrumentRuleRecord[],
  trackId: string,
): number {
  const entry = instrumentRules.find((item) => item.track_id === trackId);
  const rawRule = entry?.rule;
  if (typeof rawRule !== "object" || rawRule === null || Array.isArray(rawRule)) return 1;
  const rule = rawRule as Readonly<Record<string, ReplayV2Json>>;
  const parsed = Number(rule.contract_size ?? 1);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Build account-risk chart lines from the server-owned portfolio projection.
 * HEDGE legs never derive liquidation locally: each leg is isolated by its
 * explicit position_side and uses only its server model prices. ONE_WAY keeps
 * the legacy K-line mark proxy solely as a fallback when no server liquidation
 * price is available.
 */
export function buildReplayPositionHlines({
  selectedTrackId,
  positionMode,
  positions,
  instrumentRules = [],
}: ReplayPositionHLineInput): IndicatorHLine[] {
  if (selectedTrackId === null || selectedTrackId === undefined) return [];
  const selectedPositions = positions.filter((item) => item.track_id === selectedTrackId);
  const lines: IndicatorHLine[] = [];

  for (const selectedPosition of selectedPositions) {
    const position = selectedPosition.position;
    const entryPrice = replayPositiveModelPrice(position.entry_price);
    const quantity = finiteNumber(position.quantity) ?? 0;
    const positionSide = selectedPosition.position_side;
    const sideLabel = positionSide === "LONG"
      ? "多仓"
      : positionSide === "SHORT"
        ? "空仓"
        : "持仓";
    const lineSuffix = positionSide?.toLowerCase() ?? "net";
    const idSuffix = positionSide === undefined ? "" : `-${lineSuffix}`;

    if (quantity !== 0 && entryPrice !== null) {
      lines.push({
        id: `replay-position-average${idSuffix}`,
        pane: "main",
        price: entryPrice,
        title: `${sideLabel}均价 ${displayPrice(position.entry_price, entryPrice)}`,
        color: positionSide === "SHORT" ? "#7c3aed" : "#2563eb",
        linestyle: "solid",
        linewidth: 1,
      });
    }
    if (quantity === 0) continue;

    const liquidationPrice = replayPositiveModelPrice(selectedPosition.liquidation_price);
    if (liquidationPrice !== null) {
      lines.push({
        id: `replay-position-liquidation${idSuffix}`,
        pane: "main",
        price: liquidationPrice,
        title: `${sideLabel}强平价≈ ${displayPrice(selectedPosition.liquidation_price, liquidationPrice)}（服务端模型）`,
        color: "#f59e0b",
        linestyle: "dotted",
        linewidth: 1,
      });
    }

    const bankruptcyPrice = replayPositiveModelPrice(selectedPosition.bankruptcy_price);
    if (bankruptcyPrice !== null) {
      lines.push({
        id: `replay-position-bankruptcy${idSuffix}`,
        pane: "main",
        price: bankruptcyPrice,
        title: `${sideLabel}破产价≈ ${displayPrice(selectedPosition.bankruptcy_price, bankruptcyPrice)}（服务端模型）`,
        color: "#e11d48",
        linestyle: "dashed",
        linewidth: 1,
      });
    }

    if (liquidationPrice !== null || positionMode === "HEDGE") continue;
    const mark = replayPositiveModelPrice(position.mark_price);
    const marginEquity = finiteNumber(selectedPosition.margin_equity);
    const maintenance = finiteNumber(selectedPosition.maintenance_margin);
    const sensitivity = Math.abs(quantity) * contractSizeFor(
      instrumentRules,
      selectedTrackId,
    );
    if (mark === null || marginEquity === null || maintenance === null) continue;
    const buffer = marginEquity - maintenance;
    const riskPrice = quantity > 0
      ? mark - buffer / sensitivity
      : mark + buffer / sensitivity;
    if (sensitivity <= 0 || buffer < 0 || !Number.isFinite(riskPrice) || riskPrice <= 0) {
      continue;
    }
    lines.push({
      id: `replay-position-risk-reference${idSuffix}`,
      pane: "main",
      price: riskPrice,
      title: `风险参考≈ ${riskPrice.toFixed(6)}（K线标记代理）`,
      color: "#f59e0b",
      linestyle: "dotted",
      linewidth: 1,
    });
  }

  return lines;
}
