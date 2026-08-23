import { t } from "../../i18n/index.js";
import type {
  IndicatorDefinition,
  IndicatorPreset,
} from "../indicators/indicatorTypes.js";
import type {
  CatalogIndicator,
  StaticIndicatorCatalog,
} from "../indicators/useIndicatorCatalogRuntime.js";
import type { LocalDatasetManifest } from "./localDataTypes.js";


let localIndicatorOrdinal = 0;

function newIndicatorId(presetId: string): string {
  localIndicatorOrdinal += 1;
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    ?? `${Date.now().toString(36)}${localIndicatorOrdinal.toString(36)}`;
  return `local-${presetId}-${random}`;
}

function localDefinitionFromPreset(preset: IndicatorPreset): IndicatorDefinition {
  return {
    id: newIndicatorId(preset.id),
    executionTarget: "local",
    name: preset.name,
    engineName: preset.engineName,
    script: preset.script,
    ...(preset.language === undefined ? {} : { language: preset.language }),
    params: { ...preset.params },
    visible: true,
    lines: [],
    description: preset.description,
    category: preset.category,
    paneTarget: preset.paneTarget,
    paramSchema: preset.paramSchema.map((schema) => ({ ...schema })),
    isPreset: true,
    is_builtin: true,
    kind: "builtin",
  };
}

function asBuiltinPreset(preset: CatalogIndicator): IndicatorPreset {
  if (
    preset.is_builtin !== true
    || typeof preset.engineName !== "string"
    || typeof preset.script !== "string"
  ) {
    throw new Error(t("local.err.builtinOnly"));
  }
  return preset as IndicatorPreset;
}

export function createLocalIndicatorCatalog(
  presets: readonly IndicatorPreset[],
): StaticIndicatorCatalog {
  return {
    presets,
    resolvePresetForChart(preset) {
      return localDefinitionFromPreset(asBuiltinPreset(preset));
    },
  };
}

export function resolveLocalIndicatorSupport(
  indicator: IndicatorDefinition,
  manifest: LocalDatasetManifest,
): { supported: boolean; reason: string | null } {
  if (indicator.is_builtin !== true || typeof indicator.engineName !== "string") {
    return {
      supported: false,
      reason: t("local.err.offlineNoScript"),
    };
  }
  if (indicator.engineName.toUpperCase() === "VOL" && !manifest.volume_available) {
    return {
      supported: false,
      reason: t("local.err.noVolume"),
    };
  }
  return { supported: true, reason: null };
}
