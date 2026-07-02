import {
  fetchKlinesBefore,
  fetchKlinesHistory,
  fetchKlinesRange,
  fetchLatestKlines,
  getMultiStreamUrl,
} from "../../../services/api";

export const defaultKlineApi = {
  fetchKlinesHistory,
  fetchKlinesBefore,
  fetchKlinesRange,
  fetchLatestKlines,
  getMultiStreamUrl,
};
