import {
  fetchKlinesBefore as fetchTransportKlinesBefore,
  fetchKlinesHistory as fetchTransportKlinesHistory,
  fetchKlinesRange as fetchTransportKlinesRange,
  fetchLatestKlines as fetchTransportLatestKlines,
  getMultiStreamUrl,
} from "../../../services/api.js";
import type { TransportKlineResponse } from "../../../services/apiPayloadParsers.js";
import type {
  KlineApi,
  KlineFetchResult,
  KlineHistoryRequestOptions,
  KlineRangeRequestOptions,
  KlineRequestOptions,
} from "../klineContracts.js";
import {
  toEpochSeconds,
  type EpochSeconds,
  type KlineBar,
} from "../marketDataTypes.js";
import type { IntervalString } from "../../../utils/intervals.js";

function toMarketDataResult(result: TransportKlineResponse): KlineFetchResult {
  const data: KlineBar[] = result.data.map((row) => {
    const time = toEpochSeconds(row.time);
    if (time === null) throw new TypeError("Validated kline time could not be converted to EpochSeconds");
    return { ...row, time };
  });
  return { ...result, data };
}

async function fetchKlinesHistory(
  symbol: string,
  interval: IntervalString,
  days: number | null | undefined,
  marketType: string,
  exchange: string,
  options: KlineHistoryRequestOptions,
): Promise<KlineFetchResult> {
  return toMarketDataResult(await fetchTransportKlinesHistory(
    symbol,
    interval,
    days,
    marketType,
    exchange,
    options,
  ));
}

async function fetchKlinesBefore(
  symbol: string,
  interval: IntervalString,
  before: EpochSeconds | undefined,
  bars: number,
  marketType: string,
  exchange: string,
  options: KlineRequestOptions,
): Promise<KlineFetchResult> {
  return toMarketDataResult(await fetchTransportKlinesBefore(
    symbol,
    interval,
    before ?? 0,
    bars,
    marketType,
    exchange,
    options,
  ));
}

async function fetchKlinesRange(
  symbol: string,
  interval: IntervalString,
  start: EpochSeconds,
  end: EpochSeconds,
  marketType: string,
  exchange: string,
  options: KlineRangeRequestOptions,
): Promise<KlineFetchResult> {
  return toMarketDataResult(await fetchTransportKlinesRange(
    symbol,
    interval,
    start,
    end,
    marketType,
    exchange,
    options,
  ));
}

async function fetchLatestKlines(
  symbol: string,
  interval: IntervalString,
  limit: number,
  marketType: string,
  exchange: string,
  source: string,
  options: KlineRequestOptions,
): Promise<KlineFetchResult> {
  return toMarketDataResult(await fetchTransportLatestKlines(
    symbol,
    interval,
    limit,
    marketType,
    exchange,
    source,
    options,
  ));
}

export const defaultKlineApi = {
  fetchKlinesHistory,
  fetchKlinesBefore,
  fetchKlinesRange,
  fetchLatestKlines,
  getMultiStreamUrl,
} satisfies KlineApi;
