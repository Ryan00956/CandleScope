import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type { ChartStrategyAttachmentRecord } from "../../chart-workspace/chartWorkspaceTypes.js";
import type { StrategyDraftLanguage } from "./StrategyDraftStore.js";

export interface ChartStrategyTemplate {
  id: "SMA_CROSS" | "RSI_REVERSAL" | "DONCHIAN_BREAKOUT";
  nameKey:
    | "chartTester.template.sma"
    | "chartTester.template.rsi"
    | "chartTester.template.donchian";
  descriptionKey:
    | "chartTester.template.smaDescription"
    | "chartTester.template.rsiDescription"
    | "chartTester.template.donchianDescription";
  displayName: string;
  language: StrategyDraftLanguage;
  source: string;
}

export const CHART_STRATEGY_TEMPLATES: readonly ChartStrategyTemplate[] = Object.freeze([
  Object.freeze({
    id: "SMA_CROSS",
    nameKey: "chartTester.template.sma",
    descriptionKey: "chartTester.template.smaDescription",
    displayName: "SMA Cross",
    language: "pyne",
    source: [
      'strategy("SMA Cross")',
      "fast = sma(close, 3)",
      "slow = sma(close, 5)",
      "",
      "if crossover(fast, slow)",
      "  target_position(1)",
      "else if crossunder(fast, slow)",
      "  target_position(0)",
    ].join("\n"),
  }),
  Object.freeze({
    id: "RSI_REVERSAL",
    nameKey: "chartTester.template.rsi",
    descriptionKey: "chartTester.template.rsiDescription",
    displayName: "RSI Reversal",
    language: "pyne",
    source: [
      'strategy("RSI Reversal")',
      "value = rsi(close, 14)",
      "",
      "if value < 30",
      "  target_position(1)",
      "else if value > 70",
      "  target_position(0)",
    ].join("\n"),
  }),
  Object.freeze({
    id: "DONCHIAN_BREAKOUT",
    nameKey: "chartTester.template.donchian",
    descriptionKey: "chartTester.template.donchianDescription",
    displayName: "Donchian Breakout",
    language: "pyne",
    source: [
      'strategy("Donchian Breakout")',
      "upper = highest(high, 20)",
      "lower = lowest(low, 20)",
      "",
      "if close > upper[1]",
      "  target_position(1)",
      "else if close < lower[1]",
      "  target_position(0)",
    ].join("\n"),
  }),
]);

export interface ChartStrategyDraftIssue {
  code:
    | "EMPTY_SOURCE"
    | "UNDECLARED_TARGET"
    | "UNBALANCED_DELIMITER"
    | "SERVER_DIAGNOSTIC";
  line: number;
  column: number;
  endColumn: number;
  variable: string | null;
  message?: string;
}

function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset).split("\n");
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}

function maskChartStrategyNonCode(source: string): string {
  const masked = source.split("");
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset]!;
    if (character === "#" || (character === "/" && source[offset + 1] === "/")) {
      while (offset < source.length && source[offset] !== "\n") {
        masked[offset] = " ";
        offset += 1;
      }
      continue;
    }
    if (character !== "\"" && character !== "'") {
      offset += 1;
      continue;
    }
    const delimiterLength = source.slice(offset, offset + 3) === character.repeat(3) ? 3 : 1;
    for (let index = 0; index < delimiterLength; index += 1) masked[offset + index] = " ";
    offset += delimiterLength;
    while (offset < source.length) {
      if (source[offset] === "\n") {
        if (delimiterLength === 1) break;
        offset += 1;
        continue;
      }
      if (delimiterLength === 1 && source[offset] === "\\") {
        masked[offset] = " ";
        if (offset + 1 < source.length && source[offset + 1] !== "\n") {
          masked[offset + 1] = " ";
          offset += 2;
        } else {
          offset += 1;
        }
        continue;
      }
      if (source.slice(offset, offset + delimiterLength) === character.repeat(delimiterLength)) {
        for (let index = 0; index < delimiterLength; index += 1) masked[offset + index] = " ";
        offset += delimiterLength;
        break;
      }
      masked[offset] = " ";
      offset += 1;
    }
  }
  return masked.join("");
}

export function diagnoseChartStrategyDraft(
  source: string,
  options: { requireSource?: boolean } = {},
): ChartStrategyDraftIssue[] {
  if (!source.trim()) {
    return options.requireSource
      ? [{ code: "EMPTY_SOURCE", line: 1, column: 1, endColumn: 1, variable: null }]
      : [];
  }
  const issues: ChartStrategyDraftIssue[] = [];
  const code = maskChartStrategyNonCode(source);
  const declarations = new Set(
    [...code.matchAll(/^\s*([A-Za-z_]\w*)\s*=/gm)].map((match) => match[1]!),
  );
  for (const match of code.matchAll(/target_position\(\s*([A-Za-z_]\w*)\s*\)/g)) {
    const variable = match[1]!;
    if (declarations.has(variable)) continue;
    const variableOffset = (match.index ?? 0) + match[0].indexOf(variable);
    const position = lineAndColumn(source, variableOffset);
    issues.push({
      code: "UNDECLARED_TARGET",
      ...position,
      endColumn: position.column + variable.length,
      variable,
    });
  }
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closing = new Set(Object.values(pairs));
  const stack: Array<{ character: string; offset: number }> = [];
  for (let offset = 0; offset < code.length; offset += 1) {
    const character = code[offset]!;
    if (pairs[character]) stack.push({ character, offset });
    else if (closing.has(character)) {
      const open = stack.pop();
      if (!open || pairs[open.character] !== character) {
        const position = lineAndColumn(source, offset);
        issues.push({
          code: "UNBALANCED_DELIMITER",
          ...position,
          endColumn: position.column + 1,
          variable: character,
        });
        break;
      }
    }
  }
  if (!issues.some((issue) => issue.code === "UNBALANCED_DELIMITER") && stack.length > 0) {
    const open = stack.at(-1)!;
    const position = lineAndColumn(source, open.offset);
    issues.push({
      code: "UNBALANCED_DELIMITER",
      ...position,
      endColumn: position.column + 1,
      variable: open.character,
    });
  }
  return issues.sort((left, right) => left.line - right.line || left.column - right.column);
}

export interface ChartStrategyRunRequest {
  cellScope: string;
  session: ChartSession;
  draftId: string;
  draftContentRevision: number;
  displayName: string;
  language: StrategyDraftLanguage;
  source: string;
  attachment: ChartStrategyAttachmentRecord;
}

export type ChartStrategyTesterEntryState =
  | "unattached"
  | "editing"
  | "saving"
  | "ready"
  | "error";

export function chartStrategyEntryState(
  attachment: ChartStrategyAttachmentRecord | null,
  state: "idle" | "editing" | "saving" | "ready" | "error",
): ChartStrategyTesterEntryState {
  if (!attachment) return "unattached";
  return state === "idle" ? "editing" : state;
}
