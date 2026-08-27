import { useCallback, useEffect, useState } from "react";
import { fetchSupportedExchanges, refreshExchangeInfo } from "../../services/api";
import type {
  CcxtCatalogSummaryPayload,
  ExchangeCapabilityPayload,
} from "../../services/apiPayloadParsers.js";
import {
  exchangeMarketCheckKey,
  type ExchangeConnectionCheck,
} from "../exchange-support/exchangeSupportModel.js";
import { t } from "../../i18n/index.js";
export type { ExchangeCapabilityPayload } from "../../services/apiPayloadParsers.js";

export interface ExchangeSettingsRuntime {
  supportedExchanges: ExchangeCapabilityPayload[];
  exchangeCatalogSummary: CcxtCatalogSummaryPayload | null;
  exchangeConnectionChecks: Record<string, ExchangeConnectionCheck>;
  exchangeListLoading: boolean;
  exchangeListError: string | null;
  loadSupportedExchanges(): Promise<void>;
  testExchangeMarket(exchange: string, marketType: string): Promise<void>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function symbolCountFromRefresh(payload: unknown, key: string): number {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return 0;
  const counts = (payload as Record<string, unknown>).counts;
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) return 0;
  const count = Number((counts as Record<string, unknown>)[key]);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

export function useExchangeSettingsRuntime({
  isOpen,
}: {
  isOpen: boolean;
}): ExchangeSettingsRuntime {
  const [supportedExchanges, setSupportedExchanges] = useState<ExchangeCapabilityPayload[]>([]);
  const [exchangeCatalogSummary, setExchangeCatalogSummary] = useState<CcxtCatalogSummaryPayload | null>(null);
  const [exchangeConnectionChecks, setExchangeConnectionChecks] = useState<Record<string, ExchangeConnectionCheck>>({});
  const [exchangeListLoading, setExchangeListLoading] = useState(false);
  const [exchangeListError, setExchangeListError] = useState<string | null>(null);

  const loadSupportedExchanges = useCallback(async () => {
    setExchangeListLoading(true);
    setExchangeListError(null);
    try {
      const data = await fetchSupportedExchanges();
      setSupportedExchanges(Array.isArray(data.exchanges) ? data.exchanges : []);
      setExchangeCatalogSummary(data.ccxt || null);
    } catch (err: unknown) {
      setExchangeListError(errorMessage(err, t("core.error.exchangeList")));
    } finally {
      setExchangeListLoading(false);
    }
  }, []);

  const testExchangeMarket = useCallback(async (exchange: string, marketType: string) => {
    const key = exchangeMarketCheckKey(exchange, marketType);
    setExchangeConnectionChecks((current) => ({
      ...current,
      [key]: { status: "running" },
    }));
    try {
      const payload = await refreshExchangeInfo(exchange, marketType);
      setExchangeConnectionChecks((current) => ({
        ...current,
        [key]: {
          status: "success",
          symbolCount: symbolCountFromRefresh(payload, key),
          checkedAt: Date.now(),
        },
      }));
    } catch (error: unknown) {
      setExchangeConnectionChecks((current) => ({
        ...current,
        [key]: {
          status: "error",
          error: errorMessage(error, t("settings.exchange.testFailed")),
          checkedAt: Date.now(),
        },
      }));
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void loadSupportedExchanges();
  }, [isOpen, loadSupportedExchanges]);

  return {
    supportedExchanges,
    exchangeCatalogSummary,
    exchangeConnectionChecks,
    exchangeListLoading,
    exchangeListError,
    loadSupportedExchanges,
    testExchangeMarket,
  };
}
