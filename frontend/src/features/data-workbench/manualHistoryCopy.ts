import { t, type LocaleId, type MessageKey } from "../../i18n/index.js";

const MANUAL_HISTORY_KEYS = {
  disabled: "workbench.manualHistory.disabled",
  title: "workbench.manualHistory.title",
  hint: "workbench.manualHistory.hint",
  protected: "workbench.manualHistory.protected",
  startTime: "workbench.manualHistory.startTime",
  startRequired: "workbench.manualHistory.startRequired",
  endNotAllowed: "workbench.manualHistory.endNotAllowed",
  previewPlan: "workbench.manualHistory.previewPlan",
  startDownload: "workbench.manualHistory.startDownload",
  cancel: "workbench.manualHistory.cancel",
  exchange: "workbench.manualHistory.exchange",
  binance: "workbench.manualHistory.binance",
  okx: "workbench.manualHistory.okx",
  marketType: "workbench.manualHistory.marketType",
  spot: "workbench.manualHistory.spot",
  futures: "workbench.manualHistory.futures",
  symbols: "workbench.manualHistory.symbols",
  intervals: "workbench.manualHistory.intervals",
  customInterval: "workbench.manualHistory.customInterval",
  addCustomInterval: "workbench.manualHistory.addCustomInterval",
  customIntervalInvalid: "workbench.manualHistory.customIntervalInvalid",
  planSummary: "workbench.manualHistory.planSummary",
  effectiveStart: "workbench.manualHistory.effectiveStart",
  sealedEnd: "workbench.manualHistory.sealedEnd",
  planCanStart: "workbench.manualHistory.planCanStart",
  estimatedStorage: "workbench.manualHistory.estimatedStorage",
  yes: "workbench.manualHistory.yes",
  no: "workbench.manualHistory.no",
  unknown: "workbench.manualHistory.unknown",
  recentJobs: "workbench.manualHistory.recentJobs",
  protectedCollections: "workbench.manualHistory.protectedCollections",
  releaseProtection: "workbench.manualHistory.releaseProtection",
  released: "workbench.manualHistory.released",
  none: "workbench.manualHistory.none",
  polling: "workbench.manualHistory.polling",
  partialNotComplete: "workbench.manualHistory.partialNotComplete",
  blocked: "workbench.manualHistory.blocked",
  failed: "workbench.manualHistory.failed",
  succeeded: "workbench.manualHistory.succeeded",
  jobState: "workbench.manualHistory.jobState",
} as const satisfies Record<string, MessageKey>;

export type ManualHistoryCopyKey = keyof typeof MANUAL_HISTORY_KEYS;

export function manualHistoryText(
  locale: LocaleId,
  key: ManualHistoryCopyKey,
  vars?: Readonly<Record<string, string>>,
): string {
  return t(MANUAL_HISTORY_KEYS[key], vars, locale);
}
