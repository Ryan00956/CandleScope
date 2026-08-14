import { useCallback, useEffect, useState } from "react";
import {
  deleteCustomIndicator as deleteCustomIndicatorRequest,
  fetchCustomIndicators,
  fetchPreset,
  fetchPresets,
  saveCustomIndicator as saveCustomIndicatorRequest,
} from "../../services/indicatorApi.js";
import type {
  CustomIndicatorRecord,
  CustomIndicatorSaveInput,
  IndicatorDefinition,
  IndicatorPreset,
} from "./indicatorTypes.js";

export type CatalogCustomIndicator = CustomIndicatorRecord
  & Omit<IndicatorDefinition, keyof CustomIndicatorRecord>
  & {
    category: string;
    is_builtin: false;
    isPreset: false;
    paneTarget: string;
    securityMode?: string;
  };

export type CatalogIndicator = IndicatorPreset | CatalogCustomIndicator | IndicatorDefinition;
export interface StaticIndicatorCatalog {
  presets: readonly IndicatorPreset[];
  resolvePresetForChart(
    preset: CatalogIndicator,
  ): IndicatorDefinition | Promise<IndicatorDefinition>;
}
type CatalogFallback = Partial<CustomIndicatorRecord>
  & Partial<Pick<IndicatorDefinition, "category" | "paneTarget">>;

function renderPaneTarget(value: Record<string, unknown> | undefined): string | null {
  return typeof value?.paneTarget === "string" ? value.paneTarget : null;
}

function normalizeCustomIndicator(
  item: CustomIndicatorRecord & Partial<Pick<IndicatorDefinition, "category" | "paneTarget">>,
): CatalogCustomIndicator {
  const { securityMode, ...fields } = item;
  return {
    ...fields,
    category: item.category || "custom",
    is_builtin: false,
    isPreset: false,
    paneTarget: renderPaneTarget(item.renderHints) || item.paneTarget || "sub",
    ...((item.language === undefined || item.language === "pyne")
      ? { securityMode: securityMode || "safe" }
      : securityMode
        ? { securityMode }
        : {}),
  };
}

function buildCustomIndicatorForChart(preset: CatalogCustomIndicator): IndicatorDefinition {
  return {
    id: preset.id,
    name: preset.name,
    engineName: null,
    script: preset.script,
    ...(preset.language ? { language: preset.language } : {}),
    params: preset.params || {},
    description: preset.description || "",
    category: preset.category || "custom",
    paneTarget: preset.paneTarget || renderPaneTarget(preset.renderHints) || "sub",
    ...(preset.securityMode ? { securityMode: preset.securityMode } : {}),
    kind: "script",
    isPreset: false,
  };
}

function buildBuiltinIndicatorForChart(fullPreset: IndicatorPreset): IndicatorDefinition {
  return {
    id: fullPreset.id,
    name: fullPreset.name,
    engineName: fullPreset.engineName || null,
    script: fullPreset.script,
    params: fullPreset.params || {},
    description: fullPreset.description || "",
    category: fullPreset.category || "",
    paneTarget: fullPreset.paneTarget || "sub",
    kind: "builtin",
    isPreset: true,
  };
}

function isCustomPreset(preset: CatalogIndicator): preset is CatalogCustomIndicator {
  return preset.is_builtin === false || preset.isPreset === false || preset.kind === "script";
}

export interface UseIndicatorCatalogRuntimeOptions {
  isOpen: boolean;
  staticCatalog?: StaticIndicatorCatalog;
}

export interface IndicatorCatalogRuntime {
  customIndicators: CatalogCustomIndicator[];
  deleteCustomIndicator(id: string): Promise<void>;
  presets: IndicatorPreset[];
  presetsLoading: boolean;
  removeCustomIndicator(id: string): void;
  resolvePresetForChart(preset: CatalogIndicator): Promise<IndicatorDefinition>;
  saveCustomIndicator(draft: CustomIndicatorSaveInput): Promise<CustomIndicatorRecord>;
  upsertCustomIndicator(saved: CustomIndicatorRecord, fallback?: CatalogFallback): void;
}

export interface IndicatorCatalogSnapshot {
  customIndicators: CatalogCustomIndicator[];
  presets: IndicatorPreset[];
}

export interface IndicatorCatalogStore {
  getSnapshot(): IndicatorCatalogSnapshot | null;
  load(): Promise<IndicatorCatalogSnapshot>;
  updateCustomIndicators(
    updater: (current: CatalogCustomIndicator[]) => CatalogCustomIndicator[],
  ): void;
}

/**
 * Keeps the panel-only catalog warm once a user has opened it.  The store is
 * deliberately lazy: constructing it performs no request, and callers share
 * one in-flight request rather than competing for the same catalog endpoints.
 */
export function createIndicatorCatalogStore(
  loadCatalog: () => Promise<IndicatorCatalogSnapshot>,
): IndicatorCatalogStore {
  let snapshot: IndicatorCatalogSnapshot | null = null;
  let inFlight: Promise<IndicatorCatalogSnapshot> | null = null;
  let pendingCustomIndicatorUpdates: Array<
    (current: CatalogCustomIndicator[]) => CatalogCustomIndicator[]
  > = [];

  return {
    getSnapshot: () => snapshot,
    load: () => {
      if (snapshot) return Promise.resolve(snapshot);
      if (inFlight) return inFlight;

      inFlight = Promise.resolve()
        .then(loadCatalog)
        .then((loaded) => {
          let customIndicators = Array.isArray(loaded.customIndicators)
            ? loaded.customIndicators
            : [];
          for (const update of pendingCustomIndicatorUpdates) {
            customIndicators = update(customIndicators);
          }
          pendingCustomIndicatorUpdates = [];
          snapshot = {
            presets: Array.isArray(loaded.presets) ? loaded.presets : [],
            customIndicators,
          };
          return snapshot;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    updateCustomIndicators: (updater) => {
      if (!snapshot) {
        pendingCustomIndicatorUpdates.push(updater);
        return;
      }
      snapshot = {
        ...snapshot,
        customIndicators: updater(snapshot.customIndicators),
      };
    },
  };
}

const indicatorCatalogStore = createIndicatorCatalogStore(async () => {
  const [presetData, customData] = await Promise.all([
    fetchPresets(),
    fetchCustomIndicators(),
  ]);
  return {
    presets: presetData,
    customIndicators: (customData || []).map(normalizeCustomIndicator),
  };
});

export function shouldLoadIndicatorCatalog(
  isOpen: boolean,
  snapshot: IndicatorCatalogSnapshot | null,
): boolean {
  return isOpen && snapshot === null;
}

export function shouldShowIndicatorCatalogLoading(
  presetsLoading: boolean,
  presets: readonly unknown[],
  customIndicators: readonly unknown[],
): boolean {
  return presetsLoading && presets.length === 0 && customIndicators.length === 0;
}

export function useIndicatorCatalogRuntime({
  isOpen,
  staticCatalog,
}: UseIndicatorCatalogRuntimeOptions): IndicatorCatalogRuntime {
  const [presets, setPresets] = useState<IndicatorPreset[]>(() => (
    staticCatalog ? [...staticCatalog.presets] : indicatorCatalogStore.getSnapshot()?.presets || []
  ));
  const [customIndicators, setCustomIndicators] = useState<CatalogCustomIndicator[]>(() => (
    indicatorCatalogStore.getSnapshot()?.customIndicators || []
  ));
  const [presetsLoading, setPresetsLoading] = useState(false);

  useEffect(() => {
    if (staticCatalog) {
      return undefined;
    }
    const cached = indicatorCatalogStore.getSnapshot();
    if (!shouldLoadIndicatorCatalog(isOpen, cached)) {
      return undefined;
    }

    let active = true;
    queueMicrotask(() => {
      if (active && indicatorCatalogStore.getSnapshot() === null) {
        setPresetsLoading(true);
      }
    });
    void indicatorCatalogStore.load()
      .then((loaded) => {
        if (!active) return;
        setPresets(loaded.presets);
        setCustomIndicators(loaded.customIndicators);
      })
      .catch((error) => {
        // Keep the existing API error reporting, while allowing a later open
        // to retry after this shared request has settled.
        console.error("Failed to load presets:", error);
      })
      .finally(() => {
        if (active) setPresetsLoading(false);
      });
    return () => {
      // Do not abort the shared request: a concurrent/reopened panel can
      // still consume it.  This only prevents a closed panel from updating.
      active = false;
    };
  }, [isOpen, staticCatalog]);

  const resolvePresetForChart = useCallback(async (preset: CatalogIndicator) => {
    if (staticCatalog) {
      return await staticCatalog.resolvePresetForChart(preset);
    }
    if (isCustomPreset(preset)) {
      return buildCustomIndicatorForChart(preset);
    }
    const fullPreset = await fetchPreset(preset.id);
    return buildBuiltinIndicatorForChart(fullPreset);
  }, [staticCatalog]);

  const removeCustomIndicator = useCallback((id: string) => {
    const remove = (current: CatalogCustomIndicator[]) => (
      current.filter((item) => item.id !== id)
    );
    indicatorCatalogStore.updateCustomIndicators(remove);
    setCustomIndicators(remove);
  }, []);

  const upsertCustomIndicator = useCallback((
    saved: CustomIndicatorRecord,
    fallback: CatalogFallback = {},
  ) => {
    const item = normalizeCustomIndicator({
      ...fallback,
      ...saved,
      paneTarget: renderPaneTarget(saved.renderHints) || fallback.paneTarget || "sub",
      ...((saved.securityMode || fallback.securityMode)
        ? { securityMode: saved.securityMode || fallback.securityMode }
        : {}),
    });
    const upsert = (prev: CatalogCustomIndicator[]) => {
      const index = prev.findIndex((candidate) => candidate.id === item.id);
      if (index === -1) return [...prev, item];
      const next = [...prev];
      next[index] = item;
      return next;
    };
    indicatorCatalogStore.updateCustomIndicators(upsert);
    setCustomIndicators(upsert);
  }, []);

  const deleteCustomIndicator = useCallback(async (id: string) => {
    if (staticCatalog) throw new Error("static indicator catalog is read-only");
    await deleteCustomIndicatorRequest(id);
    removeCustomIndicator(id);
  }, [removeCustomIndicator, staticCatalog]);

  const saveCustomIndicator = useCallback(async (draft: CustomIndicatorSaveInput) => {
    if (staticCatalog) throw new Error("static indicator catalog is read-only");
    const saved = await saveCustomIndicatorRequest(draft);
    upsertCustomIndicator(saved, draft);
    return saved;
  }, [staticCatalog, upsertCustomIndicator]);

  // Read a completed shared request synchronously during render.  This avoids
  // a close/reopen frame that briefly shows a spinner for catalog data already
  // in memory, while local state remains the source during the first request.
  const cached = staticCatalog ? null : indicatorCatalogStore.getSnapshot();
  const resolvedPresets = staticCatalog ? [...staticCatalog.presets] : cached?.presets || presets;
  const resolvedCustomIndicators = staticCatalog ? [] : cached?.customIndicators || customIndicators;

  return {
    customIndicators: resolvedCustomIndicators,
    deleteCustomIndicator,
    presets: resolvedPresets,
    presetsLoading: staticCatalog || cached ? false : presetsLoading,
    removeCustomIndicator,
    resolvePresetForChart,
    saveCustomIndicator,
    upsertCustomIndicator,
  };
}
