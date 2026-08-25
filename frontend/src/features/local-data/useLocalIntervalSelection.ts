import { useCallback, useEffect, useMemo, useState } from "react";

import type { LocalDatasetManifest } from "./localDataTypes.js";
import { resolveLocalIntervalSupport } from "./localIntervalPolicy.js";


export const LOCAL_INTERVAL_STORAGE_PREFIX = "candlescope:local-interval:v1:";

export function localIntervalStorageKey(datasetId: string, dataEpoch: string): string {
  return `${LOCAL_INTERVAL_STORAGE_PREFIX}${datasetId}:${dataEpoch}`;
}

export function useLocalIntervalSelection(
  selected: LocalDatasetManifest | null,
  onFeedback?: (message: string | null) => void,
): {
  intervalScope: string | null;
  selectedInterval: string | null;
  handleIntervalSelect(value: string): void;
} {
  const [intervalSelection, setIntervalSelection] = useState<{
    scope: string;
    value: string;
  } | null>(null);

  const intervalScope = selected === null
    ? null
    : `${selected.dataset_id}:${selected.data_epoch}`;
  const selectedInterval = useMemo(() => {
    if (selected === null) return null;
    if (intervalSelection?.scope !== intervalScope) return selected.interval;
    const support = resolveLocalIntervalSupport(selected, intervalSelection.value);
    return support.supported ? support.target : selected.interval;
  }, [intervalScope, intervalSelection, selected]);

  useEffect(() => {
    if (selected === null || intervalScope === null) {
      setIntervalSelection(null);
      return;
    }
    const storageKey = localIntervalStorageKey(selected.dataset_id, selected.data_epoch);
    let value = selected.interval;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored !== null) {
        const support = resolveLocalIntervalSupport(selected, stored);
        if (support.supported) value = support.target;
      }
    } catch {
      // Storage availability must not block local chart access.
    }
    setIntervalSelection({ scope: intervalScope, value });
  }, [intervalScope, selected]);

  const handleIntervalSelect = useCallback((value: string) => {
    if (selected === null || intervalScope === null) return;
    const support = resolveLocalIntervalSupport(selected, value);
    if (!support.supported) {
      onFeedback?.(support.message);
      return;
    }
    onFeedback?.(null);
    setIntervalSelection({ scope: intervalScope, value: support.target });
    try {
      window.localStorage.setItem(
        localIntervalStorageKey(selected.dataset_id, selected.data_epoch),
        support.target,
      );
    } catch {
      // The selection still works for this session when persistence is unavailable.
    }
  }, [intervalScope, onFeedback, selected]);

  return { intervalScope, selectedInterval, handleIntervalSelect };
}
