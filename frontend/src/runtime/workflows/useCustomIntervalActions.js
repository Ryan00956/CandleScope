import { useCallback, useRef } from "react";
import { parseIntervalSeconds } from "../../utils/intervals";

export function useCustomIntervalActions({
  exchange,
  interval,
  nativeIntervals,
  customIntervalRecords,
  addCustomInterval,
  removeCustomInterval,
  restoreCustomInterval,
  clearCustomIntervals,
  handleIntervalChange,
  showIntervalNotice,
  isNativeIntervalSupported,
}) {
  const lastRemovedIntervalRef = useRef(null);

  const getFallbackIntervalAfterRemove = useCallback((removedInterval) => {
    const recentCustom = customIntervalRecords
      .filter((record) => record.value !== removedInterval)
      .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))[0];
    if (recentCustom) return recentCustom.value;

    const removedSeconds = parseIntervalSeconds(removedInterval);
    if (!removedSeconds) {
      return isNativeIntervalSupported(exchange, "1h") ? "1h" : nativeIntervals[0]?.value || "1m";
    }

    return [...nativeIntervals]
      .filter((item) => item.value !== removedInterval)
      .sort((a, b) => Math.abs(a.seconds - removedSeconds) - Math.abs(b.seconds - removedSeconds))[0]?.value || "1h";
  }, [customIntervalRecords, exchange, isNativeIntervalSupported, nativeIntervals]);

  const handleCreateCustomInterval = useCallback((newInterval) => {
    if (isNativeIntervalSupported(exchange, newInterval)) {
      handleIntervalChange(newInterval);
      return { ok: true, added: false };
    }
    const result = addCustomInterval(newInterval, { markUsed: true });
    if (!result.ok) return { ok: false, message: "周期格式无效" };
    handleIntervalChange(result.value);
    showIntervalNotice({ type: "success", text: `${result.value} 已添加并切换` });
    return { ok: true, added: result.added };
  }, [addCustomInterval, exchange, handleIntervalChange, isNativeIntervalSupported, showIntervalNotice]);

  const handleRemoveCustomInterval = useCallback((removedInterval) => {
    const removed = removeCustomInterval(removedInterval);
    if (!removed) return;
    lastRemovedIntervalRef.current = removed;
    if (interval === removedInterval) {
      handleIntervalChange(getFallbackIntervalAfterRemove(removedInterval));
    }
    showIntervalNotice({
      type: "warning",
      text: `${removedInterval} 已删除`,
      actionLabel: "撤销",
      duration: 6500,
    });
  }, [getFallbackIntervalAfterRemove, handleIntervalChange, interval, removeCustomInterval, showIntervalNotice]);

  const handleRestoreCustomInterval = useCallback(() => {
    const restored = restoreCustomInterval(lastRemovedIntervalRef.current);
    if (!restored) return;
    lastRemovedIntervalRef.current = null;
    showIntervalNotice({ type: "success", text: `${restored.value} 已恢复` });
  }, [restoreCustomInterval, showIntervalNotice]);

  const handleClearCustomIntervals = useCallback(() => {
    const removed = clearCustomIntervals();
    if (removed.length === 0) return;
    const currentWasRemoved = removed.some((record) => record.value === interval);
    lastRemovedIntervalRef.current = removed[removed.length - 1] || null;
    if (currentWasRemoved) {
      const currentSeconds = parseIntervalSeconds(interval);
      const fallback = currentSeconds
        ? [...nativeIntervals].sort((a, b) => Math.abs(a.seconds - currentSeconds) - Math.abs(b.seconds - currentSeconds))[0]?.value
        : null;
      handleIntervalChange(fallback || "1h");
    }
    showIntervalNotice({
      type: "warning",
      text: `已清空 ${removed.length} 个自定义周期，最近一项可撤销`,
      actionLabel: "撤销最近一项",
      duration: 6500,
    });
  }, [clearCustomIntervals, handleIntervalChange, interval, nativeIntervals, showIntervalNotice]);

  return {
    handleCreateCustomInterval,
    handleRemoveCustomInterval,
    handleRestoreCustomInterval,
    handleClearCustomIntervals,
  };
}
