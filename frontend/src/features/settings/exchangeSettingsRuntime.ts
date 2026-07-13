import { useCallback, useEffect, useState } from "react";
import { fetchSupportedExchanges } from "../../services/api";
import type { ExchangeCapabilityPayload } from "../../services/apiPayloadParsers.js";
export type { ExchangeCapabilityPayload } from "../../services/apiPayloadParsers.js";

export interface ExchangeSettingsRuntime {
  supportedExchanges: ExchangeCapabilityPayload[];
  exchangeListLoading: boolean;
  exchangeListError: string | null;
  loadSupportedExchanges(): Promise<void>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useExchangeSettingsRuntime({
  isOpen,
}: {
  isOpen: boolean;
}): ExchangeSettingsRuntime {
  const [supportedExchanges, setSupportedExchanges] = useState<ExchangeCapabilityPayload[]>([]);
  const [exchangeListLoading, setExchangeListLoading] = useState(false);
  const [exchangeListError, setExchangeListError] = useState<string | null>(null);

  const loadSupportedExchanges = useCallback(async () => {
    setExchangeListLoading(true);
    setExchangeListError(null);
    try {
      const data = await fetchSupportedExchanges();
      setSupportedExchanges(Array.isArray(data.exchanges) ? data.exchanges : []);
    } catch (err: unknown) {
      setExchangeListError(errorMessage(err, "交易所列表加载失败"));
    } finally {
      setExchangeListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    loadSupportedExchanges();
  }, [isOpen, loadSupportedExchanges]);

  return {
    supportedExchanges,
    exchangeListLoading,
    exchangeListError,
    loadSupportedExchanges,
  };
}
