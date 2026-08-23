import type { ReplayLaunchContext } from "../replay/replayV2Types.js";
import type { WatchlistGroup } from "../watchlist/watchlistTypes.js";
import { parseSymbolKey } from "../../utils/symbolKey.js";
import { t } from "../../i18n/index.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_MARKET_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_GROUPS = 32;
const MAX_ITEMS = 100;

export interface LiveReplayLaunchContextInput {
  readonly exchange: string;
  readonly marketType: string;
  readonly symbol: string;
  readonly displayInterval: string;
  readonly watchlists: readonly WatchlistGroup[];
}

function identifier(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!SAFE_IDENTIFIER.test(normalized)) {
    throw new TypeError(`${fieldName} is not a safe replay identifier`);
  }
  return normalized;
}

function marketIdentity(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!SAFE_MARKET_IDENTITY.test(normalized)) {
    throw new TypeError(`${fieldName} is not a safe replay market identity`);
  }
  return normalized;
}

function displayString(
  value: string,
  fallback: string,
  maxLength: number,
): string {
  const normalized = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("")
    .trim()
    .slice(0, maxLength);
  return normalized || fallback;
}

export function buildLiveReplayLaunchContext({
  exchange,
  marketType,
  symbol,
  displayInterval,
  watchlists,
}: LiveReplayLaunchContextInput): ReplayLaunchContext {
  let itemCount = 0;
  const groupIds = new Set<string>();
  const groups = watchlists.slice(0, MAX_GROUPS).map((group, groupIndex) => {
    const candidateId = group.id.trim();
    let id = SAFE_IDENTIFIER.test(candidateId) && !groupIds.has(candidateId)
      ? candidateId
      : `live_group_${groupIndex + 1}`;
    let collision = 1;
    while (groupIds.has(id)) {
      id = `live_group_${groupIndex + 1}_${collision}`;
      collision += 1;
    }
    groupIds.add(id);
    const identities = new Set<string>();
    const items = [];
    for (const rawSymbol of group.symbols) {
      if (itemCount >= MAX_ITEMS) break;
      const parsed = parseSymbolKey(rawSymbol);
      if (
        !SAFE_MARKET_IDENTITY.test(parsed.exchange)
        || !SAFE_MARKET_IDENTITY.test(parsed.marketType)
        || !SAFE_MARKET_IDENTITY.test(parsed.symbol)
      ) {
        continue;
      }
      const key = `${parsed.exchange}\u0000${parsed.marketType}\u0000${parsed.symbol}`;
      if (identities.has(key)) continue;
      identities.add(key);
      items.push({
        exchange: parsed.exchange,
        market_type: parsed.marketType,
        symbol: parsed.symbol,
      });
      itemCount += 1;
    }
    return {
      id,
      name: displayString(group.name, t("watchlist.unnamedGroup", { count: groupIndex + 1 }), 80),
      color: displayString(group.color, "#3b82f6", 32),
      items,
    };
  });
  return {
    schema_version: "replay.launch-context.v1",
    source: "LIVE_PAGE",
    exchange: marketIdentity(exchange, "exchange"),
    market_type: marketIdentity(marketType, "marketType"),
    symbol: marketIdentity(symbol, "symbol"),
    display_interval: identifier(displayInterval, "displayInterval"),
    watchlist_snapshot: {
      schema_version: "replay.watchlist-snapshot.v1",
      groups,
    },
  };
}
