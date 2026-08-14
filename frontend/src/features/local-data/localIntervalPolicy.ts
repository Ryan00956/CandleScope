import {
  getIntervalSemanticSpec,
  intervalsSemanticallyEquivalent,
} from "../../utils/intervals.js";

import type { LocalDatasetManifest } from "./localDataTypes.js";


export const MAX_LOCAL_RESAMPLE_FACTOR = 10_000;

export interface LocalIntervalSupport {
  supported: boolean;
  source: string;
  target: string;
  factor: number | null;
  derived: boolean;
  code: string | null;
  message: string;
}

const COMMON_LOCAL_INTERVALS = [
  "1s", "1m", "3m", "5m", "15m", "30m", "1h", "90m", "2h", "4h", "6h", "12h", "1d",
] as const;

function unsupported(
  source: string,
  target: string,
  code: string,
  message: string,
): LocalIntervalSupport {
  return { supported: false, source, target, factor: null, derived: false, code, message };
}

export function resolveLocalIntervalSupport(
  manifest: Pick<LocalDatasetManifest, "interval" | "alignment_offset_ms"> &
    Partial<Pick<LocalDatasetManifest, "first_open_ms">>,
  requestedInterval: string,
): LocalIntervalSupport {
  const sourceSpec = getIntervalSemanticSpec(manifest.interval);
  const targetSpec = getIntervalSemanticSpec(requestedInterval);
  const source = sourceSpec?.canonicalValue ?? manifest.interval;
  const target = targetSpec?.canonicalValue ?? requestedInterval.trim();
  if (!sourceSpec) {
    return unsupported(source, target, "dataset_corrupt", `源周期 ${manifest.interval} 无法识别`);
  }
  if (!targetSpec) {
    return unsupported(source, target, "interval_not_available", "周期格式无效，例如 30m、1h 或 90m");
  }
  if (intervalsSemanticallyEquivalent(source, target)) {
    return {
      supported: true,
      source,
      target: source,
      factor: 1,
      derived: false,
      code: null,
      message: `${source} 是导入的源周期`,
    };
  }
  const sourceWidth = sourceSpec.widthSeconds;
  const targetWidth = targetSpec.widthSeconds;
  if (sourceWidth === null || targetWidth === null) {
    return unsupported(
      source,
      target,
      "interval_not_composable",
      "派生周期目前只支持固定长度的秒、分钟、小时和日线",
    );
  }
  if (targetWidth <= sourceWidth) {
    return unsupported(
      source,
      target,
      "interval_not_composable",
      `${target} 不大于源周期 ${source}，本地模式不会向下拆分 K 线`,
    );
  }
  const alignmentOffsetMs = manifest.alignment_offset_ms
    ?? (manifest.first_open_ms === undefined
      ? -1
      : manifest.first_open_ms % (sourceWidth * 1_000));
  if (alignmentOffsetMs !== 0) {
    return unsupported(
      source,
      target,
      "interval_alignment_incompatible",
      `源数据没有对齐 UTC 的 ${source} 网格，无法可靠生成更大周期`,
    );
  }
  if (targetWidth % sourceWidth !== 0) {
    return unsupported(
      source,
      target,
      "interval_not_composable",
      `${target} 不是 ${source} 的整数倍，无法精确合成`,
    );
  }
  const factor = targetWidth / sourceWidth;
  if (factor > MAX_LOCAL_RESAMPLE_FACTOR) {
    return unsupported(
      source,
      target,
      "interval_resample_factor_too_large",
      `需要 ${factor} 根 ${source}，超过单根 ${MAX_LOCAL_RESAMPLE_FACTOR} 个基础周期的安全上限`,
    );
  }
  return {
    supported: true,
    source,
    target,
    factor,
    derived: true,
    code: null,
    message: `每 ${factor} 根 ${source} 精确合成 1 根 ${target}`,
  };
}

export function getCommonLocalIntervals(
  manifest: Pick<LocalDatasetManifest, "interval" | "alignment_offset_ms"> &
    Partial<Pick<LocalDatasetManifest, "first_open_ms">>,
): string[] {
  const candidates = [manifest.interval, ...COMMON_LOCAL_INTERVALS];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const support = resolveLocalIntervalSupport(manifest, candidate);
    if (!support.supported || seen.has(support.target)) return false;
    seen.add(support.target);
    return true;
  });
}
