/** Feature-local copy so the panel can localize without editing dirty catalogs. */

import type { LocaleId } from "../../i18n/locale.js";

export const MANUAL_HISTORY_COPY = {
  "zh-CN": {
    disabled: "手动连续历史下载已关闭。",
    title: "手动连续历史",
    hint: "选择商品、周期和开始时间。系统会补到封口时最后一根已收盘 K 线。",
    protected: "成功数据并入用户数据集，并受 GC 保护。",
    startTime: "开始时间",
    startRequired: "必须填写开始时间。",
    endNotAllowed: "表单无效：不允许结束时间。",
    previewPlan: "预览计划",
    startDownload: "开始下载",
    succeeded: "下载已成功",
    jobState: "任务 {state}",
  },
  en: {
    disabled: "Manual history download is disabled.",
    title: "Manual continuous history",
    hint: "Select symbols, intervals, and a start time. The system fills to the last closed bar at seal time.",
    protected: "Successful data joins the user dataset and is GC-protected.",
    startTime: "Start time",
    startRequired: "Start time is required.",
    endNotAllowed: "Invalid form: end time is not allowed.",
    previewPlan: "Preview plan",
    startDownload: "Start download",
    succeeded: "Download succeeded",
    jobState: "Job {state}",
  },
} as const;

export type ManualHistoryCopyKey = keyof typeof MANUAL_HISTORY_COPY.en;

export function manualHistoryText(
  locale: LocaleId,
  key: ManualHistoryCopyKey,
  vars?: Readonly<Record<string, string>>,
): string {
  const template = MANUAL_HISTORY_COPY[locale][key];
  if (!vars) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const value = vars[name];
    return value == null ? match : value;
  });
}
