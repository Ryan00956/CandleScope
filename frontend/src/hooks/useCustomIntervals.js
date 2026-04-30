import { useCallback, useMemo, useState } from "react";
import { normalizeIntervalValue, parseIntervalSeconds } from "../utils/intervals";

const LEGACY_CUSTOM_INTERVALS_KEY = "candlescope-custom-intervals";
const CUSTOM_INTERVAL_RECORDS_KEY = "candlescope-custom-intervals-v2";

function now() {
  return Date.now();
}

function normalizeRecord(item, index = 0, timestamp = now()) {
  const rawValue = typeof item === "string" ? item : item?.value;
  const value = normalizeIntervalValue(rawValue);
  const seconds = parseIntervalSeconds(value);
  if (!value || !seconds) return null;

  return {
    value,
    createdAt: Number.isFinite(item?.createdAt) ? item.createdAt : timestamp,
    lastUsedAt: Number.isFinite(item?.lastUsedAt) ? item.lastUsedAt : 0,
    usageCount: Number.isFinite(item?.usageCount) ? item.usageCount : 0,
    pinned: Boolean(item?.pinned),
    order: Number.isFinite(item?.order) ? item.order : index,
  };
}

function sanitizeRecords(raw) {
  if (!Array.isArray(raw)) return [];
  const timestamp = now();
  const seen = new Set();
  const records = [];

  raw.forEach((item, index) => {
    const record = normalizeRecord(item, index, timestamp);
    if (!record || seen.has(record.value)) return;
    seen.add(record.value);
    records.push(record);
  });

  return records.sort((a, b) => a.order - b.order || a.value.localeCompare(b.value));
}

function persistRecords(records) {
  try {
    const cleanRecords = sanitizeRecords(records);
    localStorage.setItem(CUSTOM_INTERVAL_RECORDS_KEY, JSON.stringify(cleanRecords));
    localStorage.setItem(LEGACY_CUSTOM_INTERVALS_KEY, JSON.stringify(cleanRecords.map((record) => record.value)));
  } catch {
    // Ignore storage failures; UI state should still work for this session.
  }
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadCustomIntervalRecords() {
  const metaRecords = sanitizeRecords(readJson(CUSTOM_INTERVAL_RECORDS_KEY));
  if (metaRecords.length > 0) return metaRecords;

  const legacyRecords = sanitizeRecords(readJson(LEGACY_CUSTOM_INTERVALS_KEY));
  if (legacyRecords.length > 0) persistRecords(legacyRecords);
  return legacyRecords;
}

export function useCustomIntervals() {
  const [records, setRecords] = useState(loadCustomIntervalRecords);

  const saveAndSetRecords = useCallback((nextRecords) => {
    const cleanRecords = sanitizeRecords(nextRecords);
    persistRecords(cleanRecords);
    setRecords(cleanRecords);
    return cleanRecords;
  }, []);

  const values = useMemo(() => records.map((record) => record.value), [records]);

  const addCustomInterval = useCallback((interval, options = {}) => {
    const value = normalizeIntervalValue(interval);
    const seconds = parseIntervalSeconds(value);
    if (!value || !seconds) return { ok: false, reason: "invalid" };

    const existing = records.find((record) => record.value === value);
    const timestamp = now();
    if (existing) {
      const next = records.map((record) => (
        record.value === value
          ? {
              ...record,
              pinned: options.pinned ?? record.pinned,
              lastUsedAt: options.markUsed ? timestamp : record.lastUsedAt,
              usageCount: options.markUsed ? record.usageCount + 1 : record.usageCount,
            }
          : record
      ));
      saveAndSetRecords(next);
      return { ok: true, added: false, value, record: next.find((record) => record.value === value) };
    }

    const maxOrder = records.reduce((max, record) => Math.max(max, record.order), -1);
    const record = {
      value,
      createdAt: timestamp,
      lastUsedAt: options.markUsed ? timestamp : 0,
      usageCount: options.markUsed ? 1 : 0,
      pinned: Boolean(options.pinned),
      order: maxOrder + 1,
    };
    const next = saveAndSetRecords([...records, record]);
    return { ok: true, added: true, value, record: next.find((item) => item.value === value) };
  }, [records, saveAndSetRecords]);

  const markIntervalUsed = useCallback((interval) => {
    const value = normalizeIntervalValue(interval);
    if (!value || !records.some((record) => record.value === value)) return;
    const timestamp = now();
    saveAndSetRecords(records.map((record) => (
      record.value === value
        ? { ...record, lastUsedAt: timestamp, usageCount: record.usageCount + 1 }
        : record
    )));
  }, [records, saveAndSetRecords]);

  const removeCustomInterval = useCallback((interval) => {
    const value = normalizeIntervalValue(interval);
    const removed = records.find((record) => record.value === value) || null;
    if (!removed) return null;
    saveAndSetRecords(records.filter((record) => record.value !== value));
    return removed;
  }, [records, saveAndSetRecords]);

  const restoreCustomInterval = useCallback((record) => {
    const normalized = normalizeRecord(record, records.length);
    if (!normalized) return null;
    const next = records.some((item) => item.value === normalized.value)
      ? records.map((item) => (item.value === normalized.value ? normalized : item))
      : [...records, normalized];
    saveAndSetRecords(next);
    return normalized;
  }, [records, saveAndSetRecords]);

  const togglePinCustomInterval = useCallback((interval) => {
    const value = normalizeIntervalValue(interval);
    const target = records.find((record) => record.value === value);
    if (!target) return null;
    const next = records.map((record) => (
      record.value === value ? { ...record, pinned: !record.pinned } : record
    ));
    saveAndSetRecords(next);
    return next.find((record) => record.value === value);
  }, [records, saveAndSetRecords]);

  const clearCustomIntervals = useCallback(() => {
    const removed = records;
    saveAndSetRecords([]);
    return removed;
  }, [records, saveAndSetRecords]);

  return {
    customIntervalRecords: records,
    savedCustomIntervals: values,
    addCustomInterval,
    markIntervalUsed,
    removeCustomInterval,
    restoreCustomInterval,
    togglePinCustomInterval,
    clearCustomIntervals,
  };
}
