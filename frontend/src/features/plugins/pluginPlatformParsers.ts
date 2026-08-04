import type {
  JsonScalar,
  JsonValue,
  PluginCatalog,
  PluginCatalogContribution,
  PluginCatalogPlugin,
  PluginCanonicalTrustMode,
  PluginChartLayer,
  PluginCommandFileInput,
  PluginCommandContribution,
  PluginDeclarativeViewRenderer,
  PluginFieldFormat,
  PluginJsonSchema,
  PluginManagementDetail,
  PluginLiveConfirmationPreview,
  PluginLiveConfirmationReceipt,
  PluginLiveControlStatus,
  PluginLiveExecutionRecord,
  PluginLocalInstallCandidate,
  PluginLocalInstallPreview,
  PluginMarketProviderChannel,
  PluginMarketplaceCandidate,
  PluginMarketplaceCatalog,
  PluginMarketplacePermissionDiff,
  PluginMarketplaceRelease,
  PluginMarketplaceStatus,
  PluginMarketplaceUpdate,
  PluginPaperAccountContribution,
  PluginPaperExecutorContribution,
  PluginPaperStatus,
  PluginPlacement,
  PluginRuntimeRegistryStatus,
  PluginRuntimeDiff,
  PluginRuntimeSupply,
  PluginSettingsContribution,
  PluginUiSnapshot,
  PluginViewContribution,
  PluginViewProjection,
  PluginViewSlot,
  PluginV1CompatibilityCatalog,
  PluginV1CompatibilityContribution,
  PluginV1CompatibilityPreview,
  PluginRestrictedRuntimeProfile,
  PluginTrustAuthorization,
  PluginTrustChangeReview,
  PluginTrustRequests,
  PluginTrustReview,
  PluginTrustRuntimeEntrypoint,
  PluginTrustSource,
  PluginTrustSummary,
  PluginTrustUxStatus,
} from "./pluginPlatformTypes.js";

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const LOCAL_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const V1_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const V1_COMPATIBILITY_ID = /^compat\.v1\.[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const MARKETPLACE_LOCAL_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MARKETPLACE_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MARKETPLACE_LICENSE = /^[A-Za-z0-9][A-Za-z0-9.+(): /-]{0,255}$/;
const MARKETPLACE_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MARKETPLACE_MAX_REMOTE_ARTIFACT_BYTES = 128 * 1024 * 1024;
const FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const BUNDLE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const ED25519_KEY_ID = /^ed25519:[0-9a-f]{64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const SANDBOX_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}\.html$/;
const COLOR = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const EXCHANGE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MARKET_TYPE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const INTERVAL_ID = /^[1-9][0-9]{0,5}[smhdwM]$/;
const PAPER_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PAPER_SYMBOL = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/;
const PAPER_ASSET = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const PAPER_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const PROVIDER_QUALITY_LEVELS = new Set([
  "authoritative", "verified", "best-effort", "synthetic",
] as const);
const PROVIDER_TIMESTAMP_OWNERS = new Set(["exchange", "provider", "host"] as const);
const PLACEMENTS = new Set<PluginPlacement>(["commandPalette", "topToolbar", "chartContextMenu"]);
const VIEW_SLOTS = new Set<PluginViewSlot>(["sidePanel", "bottomPanel", "statusArea"]);
const VIEW_RENDERERS = new Set<PluginDeclarativeViewRenderer>(["table", "list", "detail", "status"]);
const SANDBOX_VIEW_SLOTS = new Set(["sidePanel", "bottomPanel"] as const);
const FIELD_FORMATS = new Set<PluginFieldFormat>(["text", "number", "percent", "price", "boolean", "timestamp"]);

type RecordValue = Record<string, unknown>;

function fail(path: string): never {
  throw new Error(`Plugin Platform response is invalid at ${path}`);
}

function record(value: unknown, path: string): RecordValue {
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail(path);
  return value as RecordValue;
}

function exact(value: RecordValue, required: string[], optional: string[], path: string): void {
  const keys = Object.keys(value);
  if (required.some((key) => !(key in value)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    fail(path);
  }
}

function string(value: unknown, path: string, maximum = 512): string {
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.trim()) fail(path);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path);
  return value;
}

function integer(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail(path);
  return Number(value);
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path);
  return value;
}

function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path);
  return value;
}

function oneOf<T extends string>(value: unknown, choices: ReadonlySet<T>, path: string): T {
  if (typeof value !== "string" || !choices.has(value as T)) fail(path);
  return value as T;
}

function rawString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) fail(path);
  return value;
}

function utcTimestamp(value: unknown, path: string): string {
  const result = string(value, path, 64);
  if (!UTC_TIMESTAMP.test(result) || !Number.isFinite(Date.parse(result))) fail(path);
  return result;
}

function digest(value: unknown, path: string): string {
  const result = string(value, path, 71);
  if (!BUNDLE_DIGEST.test(result)) fail(path);
  return result;
}

function keyId(value: unknown, path: string): string {
  const result = string(value, path, 72);
  if (!ED25519_KEY_ID.test(result)) fail(path);
  return result;
}

function jsonValue(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 8) fail(path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 256) fail(path);
    return value.map((item, index) => jsonValue(item, `${path}[${index}]`, depth + 1));
  }
  const data = record(value, path);
  if (Object.keys(data).length > 64) fail(path);
  return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, jsonValue(item, `${path}.${key}`, depth + 1)]));
}

function jsonScalar(value: unknown, path: string): JsonScalar {
  const parsed = jsonValue(value, path);
  if (parsed !== null && typeof parsed === "object") fail(path);
  if (typeof parsed === "string" && parsed.length > 512) fail(path);
  return parsed as JsonScalar;
}

function schema(value: unknown, path: string, depth = 0): PluginJsonSchema {
  if (depth > 8) fail(path);
  const data = record(value, path);
  const schemaType = oneOf(data.type, new Set(["object", "array", "string", "number", "integer", "boolean", "null"] as const), `${path}.type`);
  const allowed = ["type", "title", "description", "default", "enum"];
  if (schemaType === "object") allowed.push("properties", "required", "additionalProperties");
  if (schemaType === "array") allowed.push("items", "minItems", "maxItems");
  if (schemaType === "string") allowed.push("minLength", "maxLength");
  if (schemaType === "number" || schemaType === "integer") allowed.push("minimum", "maximum");
  exact(data, ["type"], allowed.filter((key) => key !== "type"), path);
  const result: PluginJsonSchema = { type: schemaType };
  if (data.title !== undefined) result.title = string(data.title, `${path}.title`, 128);
  if (data.description !== undefined) result.description = string(data.description, `${path}.description`, 512);
  if (data.default !== undefined) result.default = jsonValue(data.default, `${path}.default`);
  if (data.enum !== undefined) result.enum = array(data.enum, `${path}.enum`, 64).map((item, index) => jsonValue(item, `${path}.enum[${index}]`));
  if (schemaType === "object") {
    const properties = record(data.properties ?? {}, `${path}.properties`);
    if (Object.keys(properties).length > 64) fail(`${path}.properties`);
    result.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) => {
      if (!FIELD.test(key)) fail(`${path}.properties`);
      return [key, schema(child, `${path}.properties.${key}`, depth + 1)];
    }));
    result.required = array(data.required ?? [], `${path}.required`, 64).map((item, index) => string(item, `${path}.required[${index}]`, 64));
    if (new Set(result.required).size !== result.required.length || result.required.some((key) => !(key in result.properties!))) fail(`${path}.required`);
    if (data.additionalProperties !== false) fail(`${path}.additionalProperties`);
    result.additionalProperties = false;
  }
  if (schemaType === "array") {
    result.items = schema(data.items, `${path}.items`, depth + 1);
    if (data.minItems !== undefined) result.minItems = integer(data.minItems, `${path}.minItems`, 0, 256);
    if (data.maxItems !== undefined) result.maxItems = integer(data.maxItems, `${path}.maxItems`, 0, 256);
  }
  if (schemaType === "string") {
    if (data.minLength !== undefined) result.minLength = integer(data.minLength, `${path}.minLength`, 0, 16_384);
    if (data.maxLength !== undefined) result.maxLength = integer(data.maxLength, `${path}.maxLength`, 0, 16_384);
  }
  if (schemaType === "number" || schemaType === "integer") {
    if (data.minimum !== undefined) result.minimum = finite(data.minimum, `${path}.minimum`);
    if (data.maximum !== undefined) result.maximum = finite(data.maximum, `${path}.maximum`);
  }
  return result;
}

function contributionBase(value: RecordValue, path: string, pluginId: string) {
  const id = string(value.id, `${path}.id`, 256);
  const localId = string(value.localId, `${path}.localId`, 128);
  if (!LOCAL_ID.test(localId) || id !== `${pluginId}.${localId}`) fail(`${path}.id`);
  return {
    pluginId,
    id,
    localId,
    title: string(value.title, `${path}.title`, 128),
    entrypointId: string(value.entrypointId, `${path}.entrypointId`, 128),
    available: boolean(value.available, `${path}.available`),
    ...(value.unavailableReason === undefined ? {} : { unavailableReason: string(value.unavailableReason, `${path}.unavailableReason`, 128) }),
  };
}

function providerStringList(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  pattern = MARKET_TYPE_ID,
): string[] {
  const values = array(value, path, maximum).map((item, index) => {
    const parsed = string(item, `${path}[${index}]`, 64);
    if (!pattern.test(parsed)) fail(`${path}[${index}]`);
    return parsed;
  });
  if (values.length < minimum || new Set(values).size !== values.length) fail(path);
  return values;
}

function providerChannel(value: unknown, path: string): PluginMarketProviderChannel {
  const data = record(value, path);
  const kind = oneOf(data.kind, new Set(["kline", "full_depth"] as const), `${path}.kind`);
  const common = [
    "kind", "marketTypes", "history", "realtime", "intervals", "delivery",
    "finality", "corrections", "maxPageSize", "maxBatch", "pollIntervalMs",
    "ratePerMinute", "maxConcurrent",
  ];
  const depth = ["snapshot", "delta", "sequence", "resync", "maxDepthLevels"];
  exact(data, kind === "full_depth" ? [...common, ...depth] : common, [], path);
  const marketTypes = providerStringList(data.marketTypes, `${path}.marketTypes`, 1, 16);
  const intervals = providerStringList(
    data.intervals,
    `${path}.intervals`,
    kind === "kline" ? 1 : 0,
    kind === "kline" ? 64 : 0,
    INTERVAL_ID,
  );
  const history = boolean(data.history, `${path}.history`);
  const realtime = boolean(data.realtime, `${path}.realtime`);
  const corrections = boolean(data.corrections, `${path}.corrections`);
  if (!history && !realtime) fail(path);
  const delivery = oneOf(data.delivery, new Set(["append", "ordered_delta"] as const), `${path}.delivery`);
  const finality = oneOf(data.finality, new Set(["explicit", "inferred"] as const), `${path}.finality`);
  if (kind === "kline" && delivery !== "append") fail(`${path}.delivery`);
  if (kind === "full_depth" && (
    history || corrections || !realtime || delivery !== "ordered_delta" || finality !== "explicit"
    || data.snapshot !== true || data.delta !== true || data.sequence !== "range"
    || data.resync !== "snapshot_replay"
  )) fail(path);
  return {
    kind,
    marketTypes,
    history,
    realtime,
    intervals,
    delivery,
    finality,
    corrections,
    maxPageSize: integer(data.maxPageSize, `${path}.maxPageSize`, 1, 5_000),
    maxBatch: integer(data.maxBatch, `${path}.maxBatch`, 1, 256),
    pollIntervalMs: integer(data.pollIntervalMs, `${path}.pollIntervalMs`, 10, 60_000),
    ratePerMinute: integer(data.ratePerMinute, `${path}.ratePerMinute`, 1, 60_000),
    maxConcurrent: integer(data.maxConcurrent, `${path}.maxConcurrent`, 1, 32),
    ...(kind === "full_depth" ? {
      snapshot: true,
      delta: true,
      sequence: "range" as const,
      resync: "snapshot_replay" as const,
      maxDepthLevels: integer(data.maxDepthLevels, `${path}.maxDepthLevels`, 1, 5_000),
    } : {}),
  };
}

function paperDecimal(value: unknown, path: string): string {
  const parsed = string(value, path, 128);
  if (!PAPER_DECIMAL.test(parsed)) fail(path);
  return parsed;
}

function paperAccountContribution(
  config: RecordValue,
  path: string,
  base: ReturnType<typeof contributionBase>,
): PluginPaperAccountContribution {
  exact(config, ["brokerId", "displayName", "environment", "accounts"], [], path);
  const brokerId = string(config.brokerId, `${path}.brokerId`, 64);
  if (!EXCHANGE_ID.test(brokerId) || config.environment !== "paper") fail(path);
  const accounts = array(config.accounts, `${path}.accounts`, 16).map((raw, index) => {
    const account = record(raw, `${path}.accounts[${index}]`);
    exact(account, ["id", "label", "baseCurrency", "initialBalances"], [], `${path}.accounts[${index}]`);
    const id = string(account.id, `${path}.accounts[${index}].id`, 128);
    const baseCurrency = string(account.baseCurrency, `${path}.accounts[${index}].baseCurrency`, 32);
    if (!PAPER_ACCOUNT_ID.test(id) || !PAPER_ASSET.test(baseCurrency)) fail(`${path}.accounts[${index}]`);
    const initialBalances = array(account.initialBalances, `${path}.accounts[${index}].initialBalances`, 32).map((balanceValue, balanceIndex) => {
      const balance = record(balanceValue, `${path}.accounts[${index}].initialBalances[${balanceIndex}]`);
      exact(balance, ["asset", "available"], [], `${path}.accounts[${index}].initialBalances[${balanceIndex}]`);
      const asset = string(balance.asset, `${path}.accounts[${index}].initialBalances[${balanceIndex}].asset`, 32);
      if (!PAPER_ASSET.test(asset)) fail(`${path}.accounts[${index}].initialBalances[${balanceIndex}].asset`);
      return { asset, available: paperDecimal(balance.available, `${path}.accounts[${index}].initialBalances[${balanceIndex}].available`) };
    });
    if (
      !initialBalances.length
      || new Set(initialBalances.map((item) => item.asset)).size !== initialBalances.length
      || !initialBalances.some((item) => item.asset === baseCurrency)
    ) fail(`${path}.accounts[${index}].initialBalances`);
    return {
      id,
      label: string(account.label, `${path}.accounts[${index}].label`, 128),
      baseCurrency,
      initialBalances,
    };
  });
  if (!accounts.length || new Set(accounts.map((item) => item.id)).size !== accounts.length) fail(`${path}.accounts`);
  return {
    ...base,
    kind: "account-provider/1",
    configuration: {
      brokerId,
      displayName: string(config.displayName, `${path}.displayName`, 128),
      environment: "paper",
      accounts,
    },
  };
}

function paperExecutorContribution(
  config: RecordValue,
  path: string,
  base: ReturnType<typeof contributionBase>,
): PluginPaperExecutorContribution {
  exact(config, ["brokerId", "environment", "protocol", "orderTypes", "symbols", "limits", "maxQuoteAgeMs"], [], path);
  const brokerId = string(config.brokerId, `${path}.brokerId`, 64);
  if (!EXCHANGE_ID.test(brokerId) || config.environment !== "paper" || config.protocol !== "candlescope.paper/1") fail(path);
  const orderTypes = array(config.orderTypes, `${path}.orderTypes`, 2).map((item, index) => (
    oneOf(item, new Set(["market", "limit"] as const), `${path}.orderTypes[${index}]`)
  ));
  if (!orderTypes.length || new Set(orderTypes).size !== orderTypes.length) fail(`${path}.orderTypes`);
  const symbols = array(config.symbols, `${path}.symbols`, 128).map((raw, index) => {
    const symbol = record(raw, `${path}.symbols[${index}]`);
    const keys = ["symbol", "marketType", "baseAsset", "quoteAsset", "priceTick", "quantityStep", "minQuantity", "maxQuantity", "minNotional", "maxNotional"];
    exact(symbol, keys, [], `${path}.symbols[${index}]`);
    const symbolId = string(symbol.symbol, `${path}.symbols[${index}].symbol`, 64);
    const marketType = string(symbol.marketType, `${path}.symbols[${index}].marketType`, 32);
    const baseAsset = string(symbol.baseAsset, `${path}.symbols[${index}].baseAsset`, 32);
    const quoteAsset = string(symbol.quoteAsset, `${path}.symbols[${index}].quoteAsset`, 32);
    if (
      !PAPER_SYMBOL.test(symbolId)
      || !MARKET_TYPE_ID.test(marketType)
      || !PAPER_ASSET.test(baseAsset)
      || !PAPER_ASSET.test(quoteAsset)
      || baseAsset === quoteAsset
    ) fail(`${path}.symbols[${index}]`);
    return {
      symbol: symbolId,
      marketType,
      baseAsset,
      quoteAsset,
      priceTick: paperDecimal(symbol.priceTick, `${path}.symbols[${index}].priceTick`),
      quantityStep: paperDecimal(symbol.quantityStep, `${path}.symbols[${index}].quantityStep`),
      minQuantity: paperDecimal(symbol.minQuantity, `${path}.symbols[${index}].minQuantity`),
      maxQuantity: paperDecimal(symbol.maxQuantity, `${path}.symbols[${index}].maxQuantity`),
      minNotional: paperDecimal(symbol.minNotional, `${path}.symbols[${index}].minNotional`),
      maxNotional: paperDecimal(symbol.maxNotional, `${path}.symbols[${index}].maxNotional`),
    };
  });
  if (!symbols.length || new Set(symbols.map((item) => `${item.marketType}:${item.symbol}`)).size !== symbols.length) fail(`${path}.symbols`);
  const limits = record(config.limits, `${path}.limits`);
  exact(limits, ["maxOrderQuantity", "maxOrderNotional", "maxPositionNotional", "maxOpenOrders", "maxOrdersPerMinute", "allowShort"], [], `${path}.limits`);
  if (limits.allowShort !== false) fail(`${path}.limits.allowShort`);
  return {
    ...base,
    kind: "order-executor/1",
    configuration: {
      brokerId,
      environment: "paper",
      protocol: "candlescope.paper/1",
      orderTypes,
      symbols,
      limits: {
        maxOrderQuantity: paperDecimal(limits.maxOrderQuantity, `${path}.limits.maxOrderQuantity`),
        maxOrderNotional: paperDecimal(limits.maxOrderNotional, `${path}.limits.maxOrderNotional`),
        maxPositionNotional: paperDecimal(limits.maxPositionNotional, `${path}.limits.maxPositionNotional`),
        maxOpenOrders: integer(limits.maxOpenOrders, `${path}.limits.maxOpenOrders`, 1, 1024),
        maxOrdersPerMinute: integer(limits.maxOrdersPerMinute, `${path}.limits.maxOrdersPerMinute`, 1, 10_000),
        allowShort: false,
      },
      maxQuoteAgeMs: integer(config.maxQuoteAgeMs, `${path}.maxQuoteAgeMs`, 100, 60_000),
    },
  };
}

function contribution(value: unknown, path: string, pluginId: string): PluginCatalogContribution | null {
  const data = record(value, path);
  const kind = string(data.kind, `${path}.kind`, 64);
  if (!["command/1", "settings/1", "view/1", "symbol-provider/1", "market-data-provider/1", "account-provider/1", "order-executor/1"].includes(kind)) return null;
  exact(data, ["id", "localId", "kind", "title", "entrypointId", "configuration", "available"], ["unavailableReason"], path);
  const base = contributionBase(data, path, pluginId);
  const config = record(data.configuration, `${path}.configuration`);
  if (kind === "account-provider/1") {
    return paperAccountContribution(config, `${path}.configuration`, base);
  }
  if (kind === "order-executor/1") {
    return paperExecutorContribution(config, `${path}.configuration`, base);
  }
  if (kind === "symbol-provider/1") {
    exact(config, ["exchange", "displayName", "marketTypes", "maxPageSize", "cacheTtlSeconds"], [], `${path}.configuration`);
    const exchange = string(config.exchange, `${path}.configuration.exchange`, 64);
    if (!EXCHANGE_ID.test(exchange)) fail(`${path}.configuration.exchange`);
    const marketTypes = array(config.marketTypes, `${path}.configuration.marketTypes`, 16).map((raw, index) => {
      const market = record(raw, `${path}.configuration.marketTypes[${index}]`);
      exact(market, ["id", "productType", "label", "calendarId", "timezone"], [], `${path}.configuration.marketTypes[${index}]`);
      const id = string(market.id, `${path}.configuration.marketTypes[${index}].id`, 64);
      if (!MARKET_TYPE_ID.test(id)) fail(`${path}.configuration.marketTypes[${index}].id`);
      return {
        id,
        productType: string(market.productType, `${path}.configuration.marketTypes[${index}].productType`, 64),
        label: string(market.label, `${path}.configuration.marketTypes[${index}].label`, 64),
        calendarId: string(market.calendarId, `${path}.configuration.marketTypes[${index}].calendarId`, 64),
        timezone: string(market.timezone, `${path}.configuration.marketTypes[${index}].timezone`, 64),
      };
    });
    if (!marketTypes.length || new Set(marketTypes.map((item) => item.id)).size !== marketTypes.length) fail(`${path}.configuration.marketTypes`);
    return {
      ...base,
      kind: "symbol-provider/1",
      configuration: {
        exchange,
        displayName: string(config.displayName, `${path}.configuration.displayName`, 128),
        marketTypes,
        maxPageSize: integer(config.maxPageSize, `${path}.configuration.maxPageSize`, 1, 500),
        cacheTtlSeconds: integer(config.cacheTtlSeconds, `${path}.configuration.cacheTtlSeconds`, 1, 86_400),
      },
    };
  }
  if (kind === "market-data-provider/1") {
    exact(config, ["exchange", "dataPlane", "channels", "sourceQuality"], [], `${path}.configuration`);
    const exchange = string(config.exchange, `${path}.configuration.exchange`, 64);
    if (!EXCHANGE_ID.test(exchange) || config.dataPlane !== "candlescope.stream/1") fail(`${path}.configuration`);
    const channels = array(config.channels, `${path}.configuration.channels`, 16).map((item, index) => providerChannel(item, `${path}.configuration.channels[${index}]`));
    const channelKeys = channels.flatMap((item) => item.marketTypes.map((marketType) => `${item.kind}:${marketType}`));
    if (!channels.length || new Set(channelKeys).size !== channelKeys.length) fail(`${path}.configuration.channels`);
    const quality = record(config.sourceQuality, `${path}.configuration.sourceQuality`);
    exact(quality, ["quality", "finality", "timestamp"], [], `${path}.configuration.sourceQuality`);
    return {
      ...base,
      kind: "market-data-provider/1",
      configuration: {
        exchange,
        dataPlane: "candlescope.stream/1",
        channels,
        sourceQuality: {
          quality: oneOf(quality.quality, PROVIDER_QUALITY_LEVELS, `${path}.configuration.sourceQuality.quality`),
          finality: oneOf(quality.finality, new Set(["explicit", "inferred"] as const), `${path}.configuration.sourceQuality.finality`),
          timestamp: oneOf(quality.timestamp, PROVIDER_TIMESTAMP_OWNERS, `${path}.configuration.sourceQuality.timestamp`),
        },
      },
    };
  }
  if (kind === "command/1") {
    exact(config, ["placements"], ["requiresUserAction", "inputSchema", "fileInputs"], `${path}.configuration`);
    const placements = array(config.placements, `${path}.configuration.placements`, 3).map((item, index) => oneOf(item, PLACEMENTS, `${path}.configuration.placements[${index}]`));
    if (!placements.length || new Set(placements).size !== placements.length) fail(`${path}.configuration.placements`);
    const inputSchema = config.inputSchema === undefined
      ? undefined
      : schema(config.inputSchema, `${path}.configuration.inputSchema`);
    const fileInputs = config.fileInputs === undefined
      ? undefined
      : array(config.fileInputs, `${path}.configuration.fileInputs`, 8).map((item, index) => {
        const file = record(item, `${path}.configuration.fileInputs[${index}]`);
        exact(file, ["field", "mode", "accept", "maxBytes"], ["suggestedName"], `${path}.configuration.fileInputs[${index}]`);
        const field = string(file.field, `${path}.configuration.fileInputs[${index}].field`, 64);
        const mode = oneOf(file.mode, new Set(["open", "save"] as const), `${path}.configuration.fileInputs[${index}].mode`);
        const accept = array(file.accept, `${path}.configuration.fileInputs[${index}].accept`, 16).map((mediaType, mediaIndex) => {
          const value = string(mediaType, `${path}.configuration.fileInputs[${index}].accept[${mediaIndex}]`, 128);
          if (!MEDIA_TYPE.test(value) || value !== value.toLowerCase()) fail(`${path}.configuration.fileInputs[${index}].accept`);
          return value;
        });
        const maxBytes = integer(file.maxBytes, `${path}.configuration.fileInputs[${index}].maxBytes`, 1, 128 * 1024);
        const suggestedName = file.suggestedName === undefined
          ? undefined
          : string(file.suggestedName, `${path}.configuration.fileInputs[${index}].suggestedName`, 128);
        const property = inputSchema?.type === "object" ? inputSchema.properties?.[field] : undefined;
        if (
          !FIELD.test(field)
          || !accept.length
          || new Set(accept).size !== accept.length
          || property?.type !== "string"
          || !inputSchema?.required?.includes(field)
          || (mode === "open" && suggestedName !== undefined)
          || (mode === "save" && (suggestedName === undefined || !FILE_NAME.test(suggestedName) || [".", ".."].includes(suggestedName)))
        ) fail(`${path}.configuration.fileInputs[${index}]`);
        return {
          field,
          mode,
          accept,
          maxBytes,
          ...(suggestedName === undefined ? {} : { suggestedName }),
        } satisfies PluginCommandFileInput;
      });
    if (fileInputs && (
      !fileInputs.length
      || new Set(fileInputs.map((item) => item.field)).size !== fileInputs.length
      || fileInputs.filter((item) => item.mode === "save").length > 1
      || config.requiresUserAction === false
    )) {
      fail(`${path}.configuration.fileInputs`);
    }
    return {
      ...base,
      kind: "command/1",
      configuration: {
        placements,
        ...(config.requiresUserAction === undefined ? {} : { requiresUserAction: boolean(config.requiresUserAction, `${path}.configuration.requiresUserAction`) }),
        ...(inputSchema === undefined ? {} : { inputSchema }),
        ...(fileInputs === undefined ? {} : { fileInputs }),
      },
    } satisfies PluginCommandContribution;
  }
  if (kind === "settings/1") {
    exact(config, ["schema", "defaults"], [], `${path}.configuration`);
    const parsedSchema = schema(config.schema, `${path}.configuration.schema`);
    const defaults = jsonValue(config.defaults, `${path}.configuration.defaults`);
    if (parsedSchema.type !== "object" || defaults == null || typeof defaults !== "object" || Array.isArray(defaults)) fail(`${path}.configuration`);
    return { ...base, kind: "settings/1", configuration: { schema: parsedSchema, defaults } } satisfies PluginSettingsContribution;
  }
  if (config.renderer === "sandbox") {
    exact(config, ["slot", "renderer", "surface", "asset"], [], `${path}.configuration`);
    const surface = string(config.surface, `${path}.configuration.surface`, 128);
    if (!LOCAL_ID.test(surface) || surface !== base.localId) fail(`${path}.configuration.surface`);
    const asset = record(config.asset, `${path}.configuration.asset`);
    exact(asset, ["bundleDigest", "entry", "protocol", "sandbox", "cspProfile"], [], `${path}.configuration.asset`);
    const bundleDigest = string(asset.bundleDigest, `${path}.configuration.asset.bundleDigest`, 71);
    const entry = string(asset.entry, `${path}.configuration.asset.entry`, 256);
    if (
      !BUNDLE_DIGEST.test(bundleDigest)
      || !SANDBOX_ENTRY.test(entry)
      || entry.includes("..")
      || entry.includes("//")
      || entry.includes("\\")
      || entry.includes(":")
      || entry.includes("%")
      || asset.protocol !== "candlescope.ui-bridge/1"
      || asset.sandbox !== "allow-scripts"
      || asset.cspProfile !== "opaque-origin-v1"
    ) fail(`${path}.configuration.asset`);
    return {
      ...base,
      kind: "view/1",
      configuration: {
        slot: oneOf(config.slot, SANDBOX_VIEW_SLOTS, `${path}.configuration.slot`),
        renderer: "sandbox",
        surface,
        asset: {
          bundleDigest,
          entry,
          protocol: "candlescope.ui-bridge/1",
          sandbox: "allow-scripts",
          cspProfile: "opaque-origin-v1",
        },
      },
    } satisfies PluginViewContribution;
  }
  exact(config, ["slot", "renderer", "source", "fields", "maxItems", "emptyState"], ["primaryCommand"], `${path}.configuration`);
  const source = record(config.source, `${path}.configuration.source`);
  exact(source, ["kind", "name", "path"], [], `${path}.configuration.source`);
  if (source.kind !== "storage.document") fail(`${path}.configuration.source.kind`);
  const fields = array(config.fields, `${path}.configuration.fields`, 16).map((raw, index) => {
    const field = record(raw, `${path}.configuration.fields[${index}]`);
    exact(field, ["field", "label", "format"], [], `${path}.configuration.fields[${index}]`);
    const fieldName = string(field.field, `${path}.configuration.fields[${index}].field`, 64);
    if (!FIELD.test(fieldName)) fail(`${path}.configuration.fields[${index}].field`);
    return {
      field: fieldName,
      label: string(field.label, `${path}.configuration.fields[${index}].label`, 128),
      format: oneOf(field.format, FIELD_FORMATS, `${path}.configuration.fields[${index}].format`),
    };
  });
  if (!fields.length || new Set(fields.map((item) => item.field)).size !== fields.length) fail(`${path}.configuration.fields`);
  const slot = oneOf(config.slot, VIEW_SLOTS, `${path}.configuration.slot`);
  const renderer = oneOf(config.renderer, VIEW_RENDERERS, `${path}.configuration.renderer`);
  if ((slot === "statusArea") !== (renderer === "status")) fail(`${path}.configuration.renderer`);
  const sourceName = string(source.name, `${path}.configuration.source.name`, 64);
  if (!FIELD.test(sourceName)) fail(`${path}.configuration.source.name`);
  const sourcePath = array(source.path, `${path}.configuration.source.path`, 8).map((item, index) => {
    const segment = string(item, `${path}.configuration.source.path[${index}]`, 64);
    if (!FIELD.test(segment)) fail(`${path}.configuration.source.path[${index}]`);
    return segment;
  });
  const primaryCommand = config.primaryCommand === undefined
    ? undefined
    : string(config.primaryCommand, `${path}.configuration.primaryCommand`, 128);
  if (primaryCommand !== undefined && !LOCAL_ID.test(primaryCommand)) fail(`${path}.configuration.primaryCommand`);
  return {
    ...base,
    kind: "view/1",
    configuration: {
      slot,
      renderer,
      source: {
        kind: "storage.document",
        name: sourceName,
        path: sourcePath,
      },
      fields,
      maxItems: integer(config.maxItems, `${path}.configuration.maxItems`, 1, 200),
      emptyState: string(config.emptyState, `${path}.configuration.emptyState`, 256),
      ...(primaryCommand === undefined ? {} : { primaryCommand }),
    },
  } satisfies PluginViewContribution;
}

function runtimeSupply(value: unknown, path: string): PluginRuntimeSupply {
  const data = record(value, path);
  const common = [
    "source", "runtimeId", "runtimeKind", "version", "executable",
    "artifactSha256", "artifactSize", "probeSha256", "verificationStatus",
    "reproducible", "licenseSpdx",
  ];
  const source = oneOf(data.source, new Set(["host-managed", "system"] as const), `${path}.source`);
  exact(
    data,
    source === "host-managed"
      ? [...common, "registryId", "registryRevision", "registrySha256", "sourceUrl"]
      : common,
    [],
    path,
  );
  const base = {
    runtimeId: string(data.runtimeId, `${path}.runtimeId`, 128),
    runtimeKind: oneOf(data.runtimeKind, new Set(["java", "node", "wasm"] as const), `${path}.runtimeKind`),
    version: string(data.version, `${path}.version`, 128),
    executable: string(data.executable, `${path}.executable`, 2048),
    artifactSha256: digest(data.artifactSha256, `${path}.artifactSha256`),
    artifactSize: integer(data.artifactSize, `${path}.artifactSize`, 1, 1024 * 1024 * 1024),
    probeSha256: digest(data.probeSha256, `${path}.probeSha256`),
    licenseSpdx: string(data.licenseSpdx, `${path}.licenseSpdx`, 255),
  };
  if (source === "host-managed") {
    if (data.verificationStatus !== "verified" || data.reproducible !== true) fail(path);
    return {
      source,
      ...base,
      verificationStatus: "verified",
      reproducible: true,
      registryId: string(data.registryId, `${path}.registryId`, 128),
      registryRevision: integer(data.registryRevision, `${path}.registryRevision`, 1),
      registrySha256: digest(data.registrySha256, `${path}.registrySha256`),
      sourceUrl: httpsUrl(data.sourceUrl, `${path}.sourceUrl`),
    };
  }
  if (data.verificationStatus !== "probed" || data.reproducible !== false || base.licenseSpdx !== "NOASSERTION") fail(path);
  return {
    source,
    ...base,
    licenseSpdx: "NOASSERTION",
    verificationStatus: "probed",
    reproducible: false,
  };
}

function runtimeRegistryStatus(value: unknown, path: string): PluginRuntimeRegistryStatus {
  const data = record(value, path);
  exact(data, ["schemaVersion", "enabled", "networkUpdatesEnabled", "automaticUpdates", "active", "runtimes", "systemRuntimes"], [], path);
  if (data.schemaVersion !== "candlescope.runtime-registry-status/1" || data.enabled !== true || data.automaticUpdates !== false) fail(path);
  const active = record(data.active, `${path}.active`);
  exact(active, ["registryId", "revision", "registrySha256", "issuedAt", "rollbackAvailable", "revokedArtifactCount"], [], `${path}.active`);
  const runtimes = array(data.runtimes, `${path}.runtimes`, 4096).map((raw, index) => {
    const itemPath = `${path}.runtimes[${index}]`;
    const item = record(raw, itemPath);
    exact(item, [
      "runtimeId", "kind", "version", "os", "arch", "sourceUrl", "sha256", "size",
      "license", "upstreamReleaseUrl", "source", "registryId", "registryRevision",
      "registrySha256", "verificationStatus", "cached", "probeSha256", "referenceCount",
      "reproducible",
    ], [], itemPath);
    if (item.source !== "host-managed" || item.reproducible !== true) fail(itemPath);
    return {
      runtimeId: string(item.runtimeId, `${itemPath}.runtimeId`, 128),
      kind: oneOf(item.kind, new Set(["java", "node", "wasm"] as const), `${itemPath}.kind`),
      version: string(item.version, `${itemPath}.version`, 128),
      os: string(item.os, `${itemPath}.os`, 32),
      arch: string(item.arch, `${itemPath}.arch`, 32),
      sourceUrl: httpsUrl(item.sourceUrl, `${itemPath}.sourceUrl`),
      sha256: digest(item.sha256, `${itemPath}.sha256`),
      size: integer(item.size, `${itemPath}.size`, 1, 1024 * 1024 * 1024),
      license: string(item.license, `${itemPath}.license`, 255),
      upstreamReleaseUrl: httpsUrl(item.upstreamReleaseUrl, `${itemPath}.upstreamReleaseUrl`),
      source: "host-managed" as const,
      registryId: string(item.registryId, `${itemPath}.registryId`, 128),
      registryRevision: integer(item.registryRevision, `${itemPath}.registryRevision`, 1),
      registrySha256: digest(item.registrySha256, `${itemPath}.registrySha256`),
      verificationStatus: oneOf(item.verificationStatus, new Set(["verified", "missing", "corrupt", "revoked"] as const), `${itemPath}.verificationStatus`),
      cached: boolean(item.cached, `${itemPath}.cached`),
      probeSha256: item.probeSha256 === null ? null : digest(item.probeSha256, `${itemPath}.probeSha256`),
      referenceCount: integer(item.referenceCount, `${itemPath}.referenceCount`, 0),
      reproducible: true as const,
    };
  });
  const systemRuntimes = array(data.systemRuntimes, `${path}.systemRuntimes`, 256).map((raw, index) => {
    const itemPath = `${path}.systemRuntimes[${index}]`;
    const item = record(raw, itemPath);
    exact(item, ["runtimeId", "kind", "version", "source", "executable", "artifactSha256", "artifactSize", "probeSha256", "verificationStatus", "reproducible", "license"], [], itemPath);
    if (item.source !== "system" || item.verificationStatus !== "probed" || item.reproducible !== false || item.license !== "NOASSERTION") fail(itemPath);
    return {
      runtimeId: string(item.runtimeId, `${itemPath}.runtimeId`, 128),
      kind: oneOf(item.kind, new Set(["java", "node", "wasm"] as const), `${itemPath}.kind`),
      version: string(item.version, `${itemPath}.version`, 128),
      source: "system" as const,
      executable: string(item.executable, `${itemPath}.executable`, 2048),
      artifactSha256: digest(item.artifactSha256, `${itemPath}.artifactSha256`),
      artifactSize: integer(item.artifactSize, `${itemPath}.artifactSize`, 1, 1024 * 1024 * 1024),
      probeSha256: digest(item.probeSha256, `${itemPath}.probeSha256`),
      verificationStatus: "probed" as const,
      reproducible: false as const,
      license: "NOASSERTION" as const,
    };
  });
  return {
    schemaVersion: "candlescope.runtime-registry-status/1",
    enabled: true,
    networkUpdatesEnabled: boolean(data.networkUpdatesEnabled, `${path}.networkUpdatesEnabled`),
    automaticUpdates: false,
    active: {
      registryId: string(active.registryId, `${path}.active.registryId`, 128),
      revision: integer(active.revision, `${path}.active.revision`, 1),
      registrySha256: digest(active.registrySha256, `${path}.active.registrySha256`),
      issuedAt: utcTimestamp(active.issuedAt, `${path}.active.issuedAt`),
      rollbackAvailable: boolean(active.rollbackAvailable, `${path}.active.rollbackAvailable`),
      revokedArtifactCount: integer(active.revokedArtifactCount, `${path}.active.revokedArtifactCount`, 0),
    },
    runtimes,
    systemRuntimes,
  };
}

const TRUST_MODES = new Set([
  "first-party-pinned",
  "marketplace-sandboxed",
  "trusted-local",
  "developer-local",
  "ui-only-untrusted",
] as const);

const TRUST_ALIASES = new Map<string, PluginCanonicalTrustMode>([
  ["first-party-pinned", "first-party-pinned"],
  ["verified-publisher", "marketplace-sandboxed"],
  ["marketplace-sandboxed", "marketplace-sandboxed"],
  ["local-trusted", "trusted-local"],
  ["trusted-local", "trusted-local"],
  ["local-developer", "developer-local"],
  ["developer-local", "developer-local"],
  ["untrusted", "marketplace-sandboxed"],
  ["ui-only-untrusted", "ui-only-untrusted"],
]);

function nullableString(value: unknown, path: string, maximum = 2048): string | null {
  return value === null ? null : string(value, path, maximum);
}

function trustProfile(value: unknown, path: string): PluginRestrictedRuntimeProfile {
  const data = record(value, path);
  exact(data, [
    "profileId", "runtimeKind", "sandboxMode", "sandboxSupported", "trustedLocalOnly",
    "networkDefault", "subprocessDeclared", "limits",
  ], [], path);
  const limits = record(data.limits, `${path}.limits`);
  exact(limits, ["maxProcesses"], [
    "memoryBytes", "cpuRatePercent", "probeCpuTimeSeconds", "runtimeCpuTimeSeconds",
    "diskBytes", "probeWallSeconds", "runtimeWallSeconds",
  ], `${path}.limits`);
  const sandboxSupported = boolean(data.sandboxSupported, `${path}.sandboxSupported`);
  const trustedLocalOnly = boolean(data.trustedLocalOnly, `${path}.trustedLocalOnly`);
  if (
    sandboxSupported === trustedLocalOnly
    || data.networkDefault !== "denied"
    || data.subprocessDeclared !== false
    || (sandboxSupported ? data.sandboxMode !== "windows-appcontainer" : data.sandboxMode !== "unavailable")
  ) fail(path);
  const optionalInteger = (key: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined => (
    limits[key] === undefined ? undefined : integer(limits[key], `${path}.limits.${key}`, 1, maximum)
  );
  const memoryBytes = optionalInteger("memoryBytes");
  const cpuRatePercent = optionalInteger("cpuRatePercent", 100);
  const probeCpuTimeSeconds = optionalInteger("probeCpuTimeSeconds", 3600);
  const runtimeCpuTimeSeconds = optionalInteger("runtimeCpuTimeSeconds", 3600);
  const diskBytes = optionalInteger("diskBytes");
  const probeWallSeconds = optionalInteger("probeWallSeconds", 86400);
  const runtimeWallSeconds = optionalInteger("runtimeWallSeconds", 86400);
  return {
    profileId: string(data.profileId, `${path}.profileId`, 64),
    runtimeKind: string(data.runtimeKind, `${path}.runtimeKind`, 64),
    sandboxMode: oneOf(data.sandboxMode, new Set(["windows-appcontainer", "unavailable"] as const), `${path}.sandboxMode`),
    sandboxSupported,
    trustedLocalOnly,
    networkDefault: "denied",
    subprocessDeclared: false,
    limits: {
      ...(memoryBytes === undefined ? {} : { memoryBytes }),
      ...(cpuRatePercent === undefined ? {} : { cpuRatePercent }),
      ...(probeCpuTimeSeconds === undefined ? {} : { probeCpuTimeSeconds }),
      ...(runtimeCpuTimeSeconds === undefined ? {} : { runtimeCpuTimeSeconds }),
      ...(diskBytes === undefined ? {} : { diskBytes }),
      maxProcesses: integer(limits.maxProcesses, `${path}.limits.maxProcesses`, 1, 32),
      ...(probeWallSeconds === undefined ? {} : { probeWallSeconds }),
      ...(runtimeWallSeconds === undefined ? {} : { runtimeWallSeconds }),
    },
  };
}

function trustRuntimeEntrypoint(value: unknown, path: string): PluginTrustRuntimeEntrypoint {
  const data = record(value, path);
  exact(data, [
    "entrypointId", "runtimeKind", "runtimeId", "descriptor", "pluginArtifactSha256",
    "runtimeArtifactSha256", "runtimeArtifactSize", "supplySource", "hostManaged",
    "registrySha256", "systemRuntimePath", "signatureRoot", "profile",
  ], [], path);
  const descriptor = jsonValue(data.descriptor, `${path}.descriptor`);
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) fail(`${path}.descriptor`);
  const runtimeKind = string(data.runtimeKind, `${path}.runtimeKind`, 64);
  const supplySource = oneOf(data.supplySource, new Set(["host-python", "host-managed", "plugin-bundled", "system"] as const), `${path}.supplySource`);
  const hostManaged = boolean(data.hostManaged, `${path}.hostManaged`);
  const profile = trustProfile(data.profile, `${path}.profile`);
  if (
    profile.runtimeKind !== runtimeKind
    || hostManaged !== (supplySource === "host-python" || supplySource === "host-managed")
  ) fail(path);
  return {
    entrypointId: string(data.entrypointId, `${path}.entrypointId`, 128),
    runtimeKind,
    runtimeId: string(data.runtimeId, `${path}.runtimeId`, 128),
    descriptor,
    pluginArtifactSha256: data.pluginArtifactSha256 === null ? null : digest(data.pluginArtifactSha256, `${path}.pluginArtifactSha256`),
    runtimeArtifactSha256: data.runtimeArtifactSha256 === null ? null : digest(data.runtimeArtifactSha256, `${path}.runtimeArtifactSha256`),
    runtimeArtifactSize: data.runtimeArtifactSize === null ? null : integer(data.runtimeArtifactSize, `${path}.runtimeArtifactSize`, 1, 1024 * 1024 * 1024),
    supplySource,
    hostManaged,
    registrySha256: data.registrySha256 === null ? null : digest(data.registrySha256, `${path}.registrySha256`),
    systemRuntimePath: nullableString(data.systemRuntimePath, `${path}.systemRuntimePath`),
    signatureRoot: nullableString(data.signatureRoot, `${path}.signatureRoot`, 512),
    profile,
  };
}

function trustAuthorization(value: unknown, path: string): PluginTrustAuthorization {
  const data = record(value, path);
  exact(data, ["runtimeIdentity", "authorizationIdentity", "mode", "entrypoints", "signatureRoots", "sandbox"], [], path);
  const entrypoints = array(data.entrypoints, `${path}.entrypoints`, 64).map((item, index) => trustRuntimeEntrypoint(item, `${path}.entrypoints[${index}]`));
  const sandbox = record(data.sandbox, `${path}.sandbox`);
  exact(sandbox, ["requested", "active", "status", "supported", "trustedLocalOnly", "profiles"], [], `${path}.sandbox`);
  const requested = boolean(sandbox.requested, `${path}.sandbox.requested`);
  const active = boolean(sandbox.active, `${path}.sandbox.active`);
  const supported = boolean(sandbox.supported, `${path}.sandbox.supported`);
  const mode = oneOf(data.mode, TRUST_MODES, `${path}.mode`);
  const profiles = array(sandbox.profiles, `${path}.sandbox.profiles`, 64).map((item, index) => trustProfile(item, `${path}.sandbox.profiles[${index}]`));
  const expectedSupported = profiles.length > 0 && profiles.every((item) => item.sandboxSupported);
  const expectedRequested = mode === "marketplace-sandboxed";
  const expectedActive = expectedRequested && expectedSupported;
  const expectedTrustedLocalOnly = expectedRequested && !expectedSupported;
  const expectedStatus = expectedActive
    ? "windows-appcontainer"
    : mode === "trusted-local"
      ? "trusted-local-user-approved"
      : "unavailable-trusted-local-only";
  const entrypointIds = entrypoints.map((item) => item.entrypointId);
  const signatureRoots = array(data.signatureRoots, `${path}.signatureRoots`, 64).map((item, index) => string(item, `${path}.signatureRoots[${index}]`, 512));
  if (
    entrypointIds.join("\0") !== [...new Set(entrypointIds)].sort().join("\0")
    || signatureRoots.join("\0") !== [...new Set(signatureRoots)].sort().join("\0")
    || JSON.stringify(profiles) !== JSON.stringify(entrypoints.map((item) => item.profile))
    || requested !== expectedRequested
    || supported !== expectedSupported
    || active !== expectedActive
    || boolean(sandbox.trustedLocalOnly, `${path}.sandbox.trustedLocalOnly`) !== expectedTrustedLocalOnly
    || sandbox.status !== expectedStatus
  ) fail(path);
  return {
    runtimeIdentity: digest(data.runtimeIdentity, `${path}.runtimeIdentity`),
    authorizationIdentity: digest(data.authorizationIdentity, `${path}.authorizationIdentity`),
    mode,
    entrypoints,
    signatureRoots,
    sandbox: {
      requested,
      active,
      status: expectedStatus,
      supported,
      trustedLocalOnly: expectedTrustedLocalOnly,
      profiles,
    },
  };
}

function trustSource(value: unknown, path: string): PluginTrustSource {
  const data = record(value, path);
  exact(data, ["rawTrustLevel", "canonicalDefault", "publisherIdentity", "source", "marketplaceId", "signatureRoot"], [], path);
  const rawTrustLevel = string(data.rawTrustLevel, `${path}.rawTrustLevel`, 64);
  const canonicalDefault = oneOf(data.canonicalDefault, TRUST_MODES, `${path}.canonicalDefault`);
  const publisherIdentity = string(data.publisherIdentity, `${path}.publisherIdentity`, 256);
  const source = string(data.source, `${path}.source`, 128);
  const marketplaceId = nullableString(data.marketplaceId, `${path}.marketplaceId`, 128);
  const signatureRoot = nullableString(data.signatureRoot, `${path}.signatureRoot`, 512);
  const expectedCanonical = TRUST_ALIASES.get(rawTrustLevel);
  const signedMarketplace = source === "signed-marketplace";
  if (
    expectedCanonical === undefined
    || expectedCanonical !== canonicalDefault
    || (publisherIdentity.startsWith("publisher-key:") ? signatureRoot !== publisherIdentity : signatureRoot !== null)
    || signedMarketplace !== (rawTrustLevel === "verified-publisher")
    || signedMarketplace !== (marketplaceId !== null)
  ) fail(path);
  return { rawTrustLevel, canonicalDefault, publisherIdentity, source, marketplaceId, signatureRoot };
}

function trustRequests(value: unknown, path: string): PluginTrustRequests {
  const data = record(value, path);
  exact(data, ["permissions", "network", "files", "secrets", "accounts", "trading", "subprocess", "liveAuthority"], [], path);
  const category = (key: "network" | "files" | "secrets" | "accounts" | "trading") => {
    const item = record(data[key], `${path}.${key}`);
    exact(item, ["requested", "permissionIds"], [], `${path}.${key}`);
    const permissionIds = array(item.permissionIds, `${path}.${key}.permissionIds`, 128).map((raw, index) => string(raw, `${path}.${key}.permissionIds[${index}]`, 128));
    const requested = boolean(item.requested, `${path}.${key}.requested`);
    if (requested !== (permissionIds.length > 0)) fail(`${path}.${key}.requested`);
    return { requested, permissionIds };
  };
  const subprocess = record(data.subprocess, `${path}.subprocess`);
  exact(subprocess, ["requested", "declared", "maxProcesses", "reason"], [], `${path}.subprocess`);
  const live = record(data.liveAuthority, `${path}.liveAuthority`);
  exact(live, ["grantedByTrust", "independentlyProtected"], [], `${path}.liveAuthority`);
  if (subprocess.requested !== false || subprocess.declared !== false || subprocess.maxProcesses !== 1 || live.grantedByTrust !== false || live.independentlyProtected !== true) fail(path);
  const permissions = array(data.permissions, `${path}.permissions`, 128).map((raw, index) => {
      const item = record(raw, `${path}.permissions[${index}]`);
      exact(item, ["permissionId", "kind", "scope"], [], `${path}.permissions[${index}]`);
      const scope = jsonValue(item.scope, `${path}.permissions[${index}].scope`);
      if (scope === null || typeof scope !== "object" || Array.isArray(scope)) fail(`${path}.permissions[${index}].scope`);
      return {
        permissionId: string(item.permissionId, `${path}.permissions[${index}].permissionId`, 128),
        kind: oneOf(item.kind, new Set(["required", "optional"] as const), `${path}.permissions[${index}].kind`),
        scope,
      };
    });
  const permissionIds = permissions.map((item) => item.permissionId);
  if (permissionIds.join("\0") !== [...new Set(permissionIds)].sort().join("\0")) fail(`${path}.permissions`);
  const categories = {
    network: category("network"),
    files: category("files"),
    secrets: category("secrets"),
    accounts: category("accounts"),
    trading: category("trading"),
  };
  const expectedCategories = {
    network: permissionIds.filter((item) => item === "network.connect"),
    files: permissionIds.filter((item) => item.startsWith("filesystem.")),
    secrets: permissionIds.filter((item) => item === "secrets.use"),
    accounts: permissionIds.filter((item) => item === "accounts.read"),
    trading: permissionIds.filter((item) => item.startsWith("trade.")),
  };
  for (const key of ["network", "files", "secrets", "accounts", "trading"] as const) {
    if (categories[key].permissionIds.join("\0") !== expectedCategories[key].join("\0")) fail(`${path}.${key}`);
  }
  return {
    permissions,
    ...categories,
    subprocess: { requested: false, declared: false, maxProcesses: 1, reason: string(subprocess.reason, `${path}.subprocess.reason`, 512) },
    liveAuthority: { grantedByTrust: false, independentlyProtected: true },
  };
}

function runtimeDiff(value: unknown, path: string): PluginRuntimeDiff {
  const data = record(value, path);
  exact(data, ["changed", "requiresConfirmation", "kindOrIdChanged", "signatureRootChanged", "systemRuntimePathChanged", "supplyChanged", "previous", "current"], [], path);
  const changed = boolean(data.changed, `${path}.changed`);
  const requiresConfirmation = boolean(data.requiresConfirmation, `${path}.requiresConfirmation`);
  if (changed !== requiresConfirmation) fail(`${path}.requiresConfirmation`);
  return {
    changed,
    requiresConfirmation,
    kindOrIdChanged: boolean(data.kindOrIdChanged, `${path}.kindOrIdChanged`),
    signatureRootChanged: boolean(data.signatureRootChanged, `${path}.signatureRootChanged`),
    systemRuntimePathChanged: boolean(data.systemRuntimePathChanged, `${path}.systemRuntimePathChanged`),
    supplyChanged: boolean(data.supplyChanged, `${path}.supplyChanged`),
    previous: array(data.previous, `${path}.previous`, 64).map((item, index) => trustRuntimeEntrypoint(item, `${path}.previous[${index}]`)),
    current: array(data.current, `${path}.current`, 64).map((item, index) => trustRuntimeEntrypoint(item, `${path}.current[${index}]`)),
  };
}

function trustSummary(value: unknown, path: string): PluginTrustSummary {
  const data = record(value, path);
  exact(data, ["schemaVersion", "uxEnabled", "mode", "defaultMode", "decisionRecorded", "source", "authorization", "requests", "profiles", "changeAllowed", "highRiskAuthorityIndependent"], [], path);
  if (data.schemaVersion !== "candlescope.plugin-trust-summary/1" || data.highRiskAuthorityIndependent !== true) fail(path);
  const authorization = trustAuthorization(data.authorization, `${path}.authorization`);
  const mode = oneOf(data.mode, TRUST_MODES, `${path}.mode`);
  if (authorization.mode !== mode) fail(`${path}.authorization.mode`);
  return {
    schemaVersion: "candlescope.plugin-trust-summary/1",
    uxEnabled: boolean(data.uxEnabled, `${path}.uxEnabled`),
    mode,
    defaultMode: oneOf(data.defaultMode, TRUST_MODES, `${path}.defaultMode`),
    decisionRecorded: boolean(data.decisionRecorded, `${path}.decisionRecorded`),
    source: trustSource(data.source, `${path}.source`),
    authorization,
    requests: trustRequests(data.requests, `${path}.requests`),
    profiles: array(data.profiles, `${path}.profiles`, 16).map((item, index) => trustProfile(item, `${path}.profiles[${index}]`)),
    changeAllowed: boolean(data.changeAllowed, `${path}.changeAllowed`),
    highRiskAuthorityIndependent: true,
  };
}

function trustUxStatus(value: unknown, path: string): PluginTrustUxStatus {
  const data = record(value, path);
  exact(data, ["schemaVersion", "enabled", "localInstallFlow", "actor", "profiles", "highRiskAuthorityIndependent"], [], path);
  if (data.schemaVersion !== "candlescope.plugin-trust-ux/1" || data.enabled !== true || data.localInstallFlow !== "itemized-double-confirmation" || data.actor !== "local-desktop-user" || data.highRiskAuthorityIndependent !== true) fail(path);
  return {
    schemaVersion: "candlescope.plugin-trust-ux/1",
    enabled: true,
    localInstallFlow: "itemized-double-confirmation",
    actor: "local-desktop-user",
    profiles: array(data.profiles, `${path}.profiles`, 16).map((item, index) => trustProfile(item, `${path}.profiles[${index}]`)),
    highRiskAuthorityIndependent: true,
  };
}

function catalogPlugin(value: unknown, path: string, contributionIds: Set<string>): PluginCatalogPlugin {
  const data = record(value, path);
  exact(data, ["id", "name", "version", "publisher", "state", "enabled", "trustLevel", "available", "permissions", "contributions", "runtime"], ["unavailableReason", "trust"], path);
  const pluginId = string(data.id, `${path}.id`, 128);
  if (!PLUGIN_ID.test(pluginId)) fail(`${path}.id`);
  const permissions = record(data.permissions, `${path}.permissions`);
  exact(permissions, ["activationReady", "requiredSatisfied", "permissions", "requiredPermissionIds"], [], `${path}.permissions`);
  const runtime = record(data.runtime, `${path}.runtime`);
  exact(runtime, ["entrypoints"], [], `${path}.runtime`);
  const parsedContributions: PluginCatalogContribution[] = [];
  for (const [index, raw] of array(data.contributions, `${path}.contributions`, 256).entries()) {
    const rawData = record(raw, `${path}.contributions[${index}]`);
    const contributionId = string(rawData.id, `${path}.contributions[${index}].id`, 256);
    if (contributionIds.has(contributionId)) fail(`${path}.contributions[${index}].id`);
    contributionIds.add(contributionId);
    const parsed = contribution(raw, `${path}.contributions[${index}]`, pluginId);
    if (parsed) parsedContributions.push(parsed);
  }
  const commandIds = new Set(parsedContributions.filter((item) => item.kind === "command/1").map((item) => item.localId));
  if (parsedContributions.some((item) => item.kind === "view/1" && item.configuration.renderer !== "sandbox" && item.configuration.primaryCommand !== undefined && !commandIds.has(item.configuration.primaryCommand))) {
    fail(`${path}.contributions`);
  }
  return {
    id: pluginId,
    name: string(data.name, `${path}.name`, 128),
    version: string(data.version, `${path}.version`, 64),
    publisher: string(data.publisher, `${path}.publisher`, 128),
    state: oneOf(data.state, new Set(["active", "disabled", "staged"] as const), `${path}.state`),
    enabled: boolean(data.enabled, `${path}.enabled`),
    trustLevel: oneOf(data.trustLevel, new Set(["first-party-pinned", "verified-publisher", "local-developer", "local-trusted", "untrusted"] as const), `${path}.trustLevel`),
    ...(data.trust === undefined ? {} : { trust: trustSummary(data.trust, `${path}.trust`) }),
    available: boolean(data.available, `${path}.available`),
    ...(data.unavailableReason === undefined ? {} : { unavailableReason: string(data.unavailableReason, `${path}.unavailableReason`, 128) }),
    permissions: {
      activationReady: boolean(permissions.activationReady, `${path}.permissions.activationReady`),
      requiredSatisfied: boolean(permissions.requiredSatisfied, `${path}.permissions.requiredSatisfied`),
      requiredPermissionIds: array(permissions.requiredPermissionIds, `${path}.permissions.requiredPermissionIds`, 128).map((item, index) => string(item, `${path}.permissions.requiredPermissionIds[${index}]`, 128)),
      permissions: array(permissions.permissions, `${path}.permissions.permissions`, 128).map((raw, index) => {
        const item = record(raw, `${path}.permissions.permissions[${index}]`);
        exact(item, ["permissionId", "kind", "decision", "hasGrantedScope"], [], `${path}.permissions.permissions[${index}]`);
        return {
          permissionId: string(item.permissionId, `${path}.permissions.permissions[${index}].permissionId`, 128),
          kind: oneOf(item.kind, new Set(["required", "optional"] as const), `${path}.permissions.permissions[${index}].kind`),
          decision: oneOf(item.decision, new Set(["pending", "granted", "denied", "revoked"] as const), `${path}.permissions.permissions[${index}].decision`),
          hasGrantedScope: boolean(item.hasGrantedScope, `${path}.permissions.permissions[${index}].hasGrantedScope`),
        };
      }),
    },
    contributions: parsedContributions,
    runtime: {
      entrypoints: array(runtime.entrypoints, `${path}.runtime.entrypoints`, 64).map((raw, index) => {
        const item = record(raw, `${path}.runtime.entrypoints[${index}]`);
        exact(item, ["entrypointId", "state", "generation"], ["runtimeKind", "runtimeId", "artifactSha256", "runtimeSupply"], `${path}.runtime.entrypoints[${index}]`);
        return {
          entrypointId: string(item.entrypointId, `${path}.runtime.entrypoints[${index}].entrypointId`, 128),
          state: string(item.state, `${path}.runtime.entrypoints[${index}].state`, 64),
          generation: integer(item.generation, `${path}.runtime.entrypoints[${index}].generation`),
          ...(item.runtimeKind === undefined ? {} : { runtimeKind: string(item.runtimeKind, `${path}.runtime.entrypoints[${index}].runtimeKind`, 64) }),
          ...(item.runtimeId === undefined ? {} : { runtimeId: string(item.runtimeId, `${path}.runtime.entrypoints[${index}].runtimeId`, 128) }),
          ...(item.artifactSha256 === undefined ? {} : { artifactSha256: item.artifactSha256 === null ? null : digest(item.artifactSha256, `${path}.runtime.entrypoints[${index}].artifactSha256`) }),
          ...(item.runtimeSupply === undefined ? {} : { runtimeSupply: runtimeSupply(item.runtimeSupply, `${path}.runtime.entrypoints[${index}].runtimeSupply`) }),
        };
      }),
    },
  };
}

function nullableDigest(value: unknown, path: string): string | null {
  if (value === null) return null;
  return digest(value, path);
}

function v1CompatibilityContribution(
  value: unknown,
  path: string,
): PluginV1CompatibilityContribution {
  const data = record(value, path);
  exact(
    data,
    [
      "id",
      "kind",
      "runtimeId",
      "title",
      "version",
      "package",
      "available",
      "protocol",
      "renderProtocol",
      "languages",
      "features",
      "routeModes",
      "release",
      "imported",
    ],
    [],
    path,
  );
  const id = string(data.id, `${path}.id`, 160);
  const runtimeId = string(data.runtimeId, `${path}.runtimeId`, 64);
  if (
    !V1_COMPATIBILITY_ID.test(id)
    || !V1_ID.test(runtimeId)
    || id !== `compat.v1.${runtimeId}`
    || data.kind !== "script-runtime/1"
    || data.protocol !== "candlescope.script-runtime/1"
    || data.renderProtocol !== "candlescope.render/1"
  ) fail(path);
  const languages = array(data.languages, `${path}.languages`, 64).map((raw, index) => {
    const languagePath = `${path}.languages[${index}]`;
    const language = record(raw, languagePath);
    exact(language, ["id", "name", "extensions", "aliases", "routeMode", "available"], [], languagePath);
    const languageId = string(language.id, `${languagePath}.id`, 64);
    if (!V1_ID.test(languageId)) fail(`${languagePath}.id`);
    const extensions = array(language.extensions, `${languagePath}.extensions`, 32)
      .map((item, itemIndex) => string(item, `${languagePath}.extensions[${itemIndex}]`, 32));
    const aliases = array(language.aliases, `${languagePath}.aliases`, 32)
      .map((item, itemIndex) => string(item, `${languagePath}.aliases[${itemIndex}]`, 64));
    if (
      new Set(extensions).size !== extensions.length
      || new Set(aliases).size !== aliases.length
    ) fail(languagePath);
    return {
      id: languageId,
      name: string(language.name, `${languagePath}.name`, 128),
      extensions,
      aliases,
      routeMode: oneOf(
        language.routeMode,
        new Set(["legacy", "shadow", "sidecar"] as const),
        `${languagePath}.routeMode`,
      ),
      available: boolean(language.available, `${languagePath}.available`),
    };
  });
  if (!languages.length || new Set(languages.map((item) => item.id)).size !== languages.length) {
    fail(`${path}.languages`);
  }
  const features = array(data.features, `${path}.features`, 64)
    .map((item, index) => string(item, `${path}.features[${index}]`, 128));
  const routeModes = array(data.routeModes, `${path}.routeModes`, 3)
    .map((item, index) => oneOf(
      item,
      new Set(["legacy", "shadow", "sidecar"] as const),
      `${path}.routeModes[${index}]`,
    ));
  if (
    new Set(features).size !== features.length
    || !routeModes.length
    || new Set(routeModes).size !== routeModes.length
    || languages.some((item) => !routeModes.includes(item.routeMode))
  ) fail(path);
  const release = record(data.release, `${path}.release`);
  exact(release, ["managed"], ["bundleSha256"], `${path}.release`);
  const managed = boolean(release.managed, `${path}.release.managed`);
  const bundleSha256 = release.bundleSha256 === undefined
    ? undefined
    : digest(release.bundleSha256, `${path}.release.bundleSha256`);
  if ((bundleSha256 !== undefined) !== managed) fail(`${path}.release`);
  return {
    id,
    kind: "script-runtime/1",
    runtimeId,
    title: string(data.title, `${path}.title`, 128),
    version: string(data.version, `${path}.version`, 128),
    package: string(data.package, `${path}.package`, 128),
    available: boolean(data.available, `${path}.available`),
    protocol: "candlescope.script-runtime/1",
    renderProtocol: "candlescope.render/1",
    languages,
    features,
    routeModes,
    release: {
      managed,
      ...(bundleSha256 === undefined ? {} : { bundleSha256 }),
    },
    imported: boolean(data.imported, `${path}.imported`),
  };
}

function v1CompatibilityCatalog(
  value: unknown,
  path: string,
): PluginV1CompatibilityCatalog {
  const data = record(value, path);
  exact(
    data,
    [
      "schemaVersion",
      "status",
      "kind",
      "protocol",
      "renderProtocol",
      "import",
      "contributions",
    ],
    [],
    path,
  );
  if (
    data.schemaVersion !== "candlescope.v1-script-runtime-compatibility/1"
    || data.kind !== "script-runtime/1"
    || data.protocol !== "candlescope.script-runtime/1"
    || data.renderProtocol !== "candlescope.render/1"
  ) fail(path);
  const status = oneOf(
    data.status,
    new Set(["ready", "unavailable", "invalid"] as const),
    `${path}.status`,
  );
  const importState = record(data.import, `${path}.import`);
  exact(
    importState,
    [
      "status",
      "stateRevision",
      "activeSnapshotRevision",
      "sourceSha256",
      "importedSourceSha256",
      "historyDepth",
      "rollbackAvailable",
    ],
    [],
    `${path}.import`,
  );
  const importStatus = oneOf(
    importState.status,
    new Set(["not-imported", "current", "stale", "invalid"] as const),
    `${path}.import.status`,
  );
  const activeSnapshotRevision = importState.activeSnapshotRevision === null
    ? null
    : integer(importState.activeSnapshotRevision, `${path}.import.activeSnapshotRevision`, 1);
  const sourceSha256 = nullableDigest(importState.sourceSha256, `${path}.import.sourceSha256`);
  const importedSourceSha256 = nullableDigest(
    importState.importedSourceSha256,
    `${path}.import.importedSourceSha256`,
  );
  const stateRevision = integer(importState.stateRevision, `${path}.import.stateRevision`);
  const historyDepth = integer(importState.historyDepth, `${path}.import.historyDepth`, 0, 8);
  const rollbackAvailable = boolean(
    importState.rollbackAvailable,
    `${path}.import.rollbackAvailable`,
  );
  const contributions = array(data.contributions, `${path}.contributions`, 128)
    .map((item, index) => v1CompatibilityContribution(item, `${path}.contributions[${index}]`));
  if (
    new Set(contributions.map((item) => item.id)).size !== contributions.length
    || new Set(contributions.map((item) => item.runtimeId)).size !== contributions.length
    || rollbackAvailable !== (historyDepth > 0)
    || (status === "unavailable" && (
      importStatus !== "not-imported"
      || sourceSha256 !== null
      || contributions.length > 0
    ))
    || (status === "ready" && (
      importStatus === "invalid"
      || sourceSha256 === null
    ))
    || (status === "invalid" && (
      importStatus !== "invalid"
      || (sourceSha256 === null && contributions.length > 0)
    ))
    || (importStatus === "current" && (
      activeSnapshotRevision === null
      || sourceSha256 !== importedSourceSha256
      || contributions.some((item) => !item.imported)
    ))
    || (importStatus === "stale" && (
      activeSnapshotRevision === null
      || importedSourceSha256 === null
      || sourceSha256 === importedSourceSha256
    ))
    || (importStatus !== "current" && contributions.some((item) => item.imported))
    || (importStatus === "not-imported" && (
      activeSnapshotRevision !== null
      || importedSourceSha256 !== null
    ))
    || (importStatus === "invalid" && (
      stateRevision !== 0
      || activeSnapshotRevision !== null
      || importedSourceSha256 !== null
      || historyDepth !== 0
      || rollbackAvailable
    ))
  ) fail(path);
  return {
    schemaVersion: "candlescope.v1-script-runtime-compatibility/1",
    status,
    kind: "script-runtime/1",
    protocol: "candlescope.script-runtime/1",
    renderProtocol: "candlescope.render/1",
    import: {
      status: importStatus,
      stateRevision,
      activeSnapshotRevision,
      sourceSha256,
      importedSourceSha256,
      historyDepth,
      rollbackAvailable,
    },
    contributions,
  };
}

export function parsePluginCatalog(value: unknown): PluginCatalog {
  if (JSON.stringify(value).length > 2 * 1024 * 1024) fail("catalog");
  const data = record(value, "catalog");
  exact(data, ["schemaVersion", "platform", "plugins", "compatibility"], ["runtimeRegistry", "trustUx"], "catalog");
  if (data.schemaVersion !== "candlescope.plugin-catalog/2") fail("catalog.schemaVersion");
  const platform = record(data.platform, "catalog.platform");
  exact(platform, ["enabled", "started", "status", "registryRevision"], [], "catalog.platform");
  const contributionIds = new Set<string>();
  const plugins = array(data.plugins, "catalog.plugins", 256).map((item, index) => catalogPlugin(item, `catalog.plugins[${index}]`, contributionIds));
  if (new Set(plugins.map((item) => item.id)).size !== plugins.length) fail("catalog.plugins");
  return {
    schemaVersion: "candlescope.plugin-catalog/2",
    platform: {
      enabled: boolean(platform.enabled, "catalog.platform.enabled"),
      started: boolean(platform.started, "catalog.platform.started"),
      status: oneOf(platform.status, new Set(["disabled", "ok", "degraded"] as const), "catalog.platform.status"),
      registryRevision: integer(platform.registryRevision, "catalog.platform.registryRevision"),
    },
    plugins,
    compatibility: v1CompatibilityCatalog(data.compatibility, "catalog.compatibility"),
    ...(data.runtimeRegistry === undefined ? {} : { runtimeRegistry: runtimeRegistryStatus(data.runtimeRegistry, "catalog.runtimeRegistry") }),
    ...(data.trustUx === undefined ? {} : { trustUx: trustUxStatus(data.trustUx, "catalog.trustUx") }),
  };
}

export function parsePluginV1CompatibilityPreview(
  value: unknown,
): PluginV1CompatibilityPreview {
  const data = record(value, "v1 compatibility preview");
  exact(
    data,
    [
      "schemaVersion",
      "action",
      "available",
      "stateRevision",
      "sourceSha256",
      "targetSnapshotRevision",
      "changes",
      "previewSha256",
    ],
    [],
    "v1 compatibility preview",
  );
  if (data.schemaVersion !== "candlescope.v1-compatibility-preview/1") {
    fail("v1 compatibility preview.schemaVersion");
  }
  const available = boolean(data.available, "v1 compatibility preview.available");
  const previewSha256 = nullableDigest(
    data.previewSha256,
    "v1 compatibility preview.previewSha256",
  );
  if (available !== (previewSha256 !== null)) fail("v1 compatibility preview");
  const changes = array(data.changes, "v1 compatibility preview.changes", 256)
    .map((raw, index) => {
      const path = `v1 compatibility preview.changes[${index}]`;
      const item = record(raw, path);
      exact(item, ["id", "action"], [], path);
      const id = string(item.id, `${path}.id`, 160);
      if (!V1_COMPATIBILITY_ID.test(id)) fail(`${path}.id`);
      return {
        id,
        action: oneOf(
          item.action,
          new Set(["add", "update", "remove"] as const),
          `${path}.action`,
        ),
      };
    });
  if (new Set(changes.map((item) => item.id)).size !== changes.length) {
    fail("v1 compatibility preview.changes");
  }
  return {
    schemaVersion: "candlescope.v1-compatibility-preview/1",
    action: oneOf(
      data.action,
      new Set(["import", "rollback"] as const),
      "v1 compatibility preview.action",
    ),
    available,
    stateRevision: integer(data.stateRevision, "v1 compatibility preview.stateRevision"),
    sourceSha256: digest(data.sourceSha256, "v1 compatibility preview.sourceSha256"),
    targetSnapshotRevision: data.targetSnapshotRevision === null
      ? null
      : integer(
        data.targetSnapshotRevision,
        "v1 compatibility preview.targetSnapshotRevision",
        1,
      ),
    changes,
    previewSha256,
  };
}

function viewProjection(value: unknown, path: string): PluginViewProjection {
  const data = record(value, path);
  exact(data, ["id", "pluginId", "title", "slot", "renderer", "state", "data"], ["sourceRevision", "errorCode"], path);
  const state = oneOf(data.state, new Set(["empty", "ready", "error"] as const), `${path}.state`);
  const renderer = oneOf(data.renderer, VIEW_RENDERERS, `${path}.renderer`);
  const payload = record(data.data, `${path}.data`);
  let parsedData: PluginViewProjection["data"];
  if (renderer === "table" || renderer === "list") {
    exact(payload, ["rows"], [], `${path}.data`);
    parsedData = { rows: array(payload.rows, `${path}.data.rows`, 200).map((raw, index) => {
      const row = record(raw, `${path}.data.rows[${index}]`);
      if (Object.keys(row).length > 16) fail(`${path}.data.rows[${index}]`);
      return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, jsonScalar(item, `${path}.data.rows[${index}].${key}`)]));
    }) };
  } else {
    exact(payload, ["values"], [], `${path}.data`);
    const values = record(payload.values, `${path}.data.values`);
    if (Object.keys(values).length > 16) fail(`${path}.data.values`);
    parsedData = { values: Object.fromEntries(Object.entries(values).map(([key, item]) => [key, jsonScalar(item, `${path}.data.values.${key}`)])) };
  }
  if (state === "error" && data.errorCode !== "PLUGIN_VIEW_DATA_INVALID") fail(`${path}.errorCode`);
  return {
    id: string(data.id, `${path}.id`, 256),
    pluginId: string(data.pluginId, `${path}.pluginId`, 128),
    title: string(data.title, `${path}.title`, 128),
    slot: oneOf(data.slot, VIEW_SLOTS, `${path}.slot`),
    renderer,
    state,
    ...(data.sourceRevision === undefined ? {} : { sourceRevision: integer(data.sourceRevision, `${path}.sourceRevision`, 1) }),
    ...(data.errorCode === undefined ? {} : { errorCode: "PLUGIN_VIEW_DATA_INVALID" as const }),
    data: parsedData,
  };
}

function chartLayer(value: unknown, path: string): PluginChartLayer {
  const data = record(value, path);
  const context = record(data.context, `${path}.context`);
  const series = record(data.series, `${path}.series`);
  const render = record(data.render, `${path}.render`);
  exact(context, ["mode", "exchange", "marketType"], [], `${path}.context`);
  exact(series, ["symbol", "interval"], [], `${path}.series`);
  exact(render, ["schemaVersion", "items"], [], `${path}.render`);
  if (context.mode !== "live" || render.schemaVersion !== data.schemaVersion) fail(path);
  const base = {
    id: string(data.id, `${path}.id`, 256),
    pluginId: string(data.pluginId, `${path}.pluginId`, 128),
    generation: integer(data.generation, `${path}.generation`, 1),
    revision: integer(data.revision, `${path}.revision`, 1),
    context: {
      mode: "live" as const,
      exchange: string(context.exchange, `${path}.context.exchange`, 64),
      marketType: string(context.marketType, `${path}.context.marketType`, 64),
    },
    series: {
      symbol: string(series.symbol, `${path}.series.symbol`, 64),
      interval: string(series.interval, `${path}.series.interval`, 64),
    },
  };
  if (render.schemaVersion === "candlescope.render/1") {
    exact(data, ["id", "pluginId", "generation", "revision", "context", "series", "itemCount", "schemaVersion", "render"], [], path);
    const items = array(render.items, `${path}.render.items`, 5_000).map((raw, index) => {
      const item = record(raw, `${path}.render.items[${index}]`);
      exact(item, ["id", "type", "time", "position", "shape", "color", "text"], ["price"], `${path}.render.items[${index}]`);
      const color = string(item.color, `${path}.render.items[${index}].color`, 9);
      if (!COLOR.test(color) || item.type !== "marker") fail(`${path}.render.items[${index}]`);
      return {
        id: string(item.id, `${path}.render.items[${index}].id`, 128),
        type: "marker" as const,
        time: integer(item.time, `${path}.render.items[${index}].time`),
        position: oneOf(item.position, new Set(["aboveBar", "belowBar", "inBar"] as const), `${path}.render.items[${index}].position`),
        shape: oneOf(item.shape, new Set(["circle", "square", "arrowUp", "arrowDown"] as const), `${path}.render.items[${index}].shape`),
        color,
        text: typeof item.text === "string" && item.text.length <= 1_024 ? item.text : fail(`${path}.render.items[${index}].text`),
        ...(item.price === undefined ? {} : { price: finite(item.price, `${path}.render.items[${index}].price`) }),
      };
    });
    if (integer(data.itemCount, `${path}.itemCount`) !== items.length) fail(`${path}.itemCount`);
    return {
      ...base,
      render: { schemaVersion: "candlescope.render/1", items },
    };
  }
  if (render.schemaVersion !== "candlescope.render/2") fail(`${path}.render.schemaVersion`);
  exact(data, [
    "id", "pluginId", "generation", "revision", "chartId", "chartRevision",
    "zOrder", "context", "series", "itemCount", "schemaVersion", "render",
  ], [], path);
  if (data.chartId !== "main-chart") fail(`${path}.chartId`);
  const lineStyles = new Set(["solid", "dashed", "dotted"] as const);
  const items = array(render.items, `${path}.render.items`, 5_000).map((raw, index) => {
    const itemPath = `${path}.render.items[${index}]`;
    const item = record(raw, itemPath);
    const id = string(item.id, `${itemPath}.id`, 128);
    if (item.type === "marker") {
      exact(item, ["id", "type", "time", "position", "shape", "color", "text"], ["price"], itemPath);
      const color = string(item.color, `${itemPath}.color`, 9);
      if (!COLOR.test(color)) fail(`${itemPath}.color`);
      return {
        id,
        type: "marker" as const,
        time: integer(item.time, `${itemPath}.time`),
        position: oneOf(item.position, new Set(["aboveBar", "belowBar", "inBar"] as const), `${itemPath}.position`),
        shape: oneOf(item.shape, new Set(["circle", "square", "arrowUp", "arrowDown"] as const), `${itemPath}.shape`),
        color,
        text: typeof item.text === "string" && item.text.length <= 1_024 ? item.text : fail(`${itemPath}.text`),
        ...(item.price === undefined ? {} : { price: finite(item.price, `${itemPath}.price`) }),
      };
    }
    if (item.type === "polyline") {
      exact(item, ["id", "type", "points", "color", "width", "style"], [], itemPath);
      const points = array(item.points, `${itemPath}.points`, 10_000).map((rawPoint, pointIndex) => {
        const point = record(rawPoint, `${itemPath}.points[${pointIndex}]`);
        exact(point, ["time", "price"], [], `${itemPath}.points[${pointIndex}]`);
        return {
          time: integer(point.time, `${itemPath}.points[${pointIndex}].time`),
          price: finite(point.price, `${itemPath}.points[${pointIndex}].price`),
        };
      });
      if (points.length < 2 || points.some((point, pointIndex) => pointIndex > 0 && point.time <= points[pointIndex - 1]!.time)) fail(`${itemPath}.points`);
      const color = string(item.color, `${itemPath}.color`, 9);
      if (!COLOR.test(color)) fail(`${itemPath}.color`);
      return {
        id,
        type: "polyline" as const,
        points,
        color,
        width: integer(item.width, `${itemPath}.width`, 1, 8),
        style: oneOf(item.style, lineStyles, `${itemPath}.style`),
      };
    }
    if (item.type === "price-line") {
      exact(item, ["id", "type", "price", "color", "width", "style"], ["text"], itemPath);
      const color = string(item.color, `${itemPath}.color`, 9);
      if (!COLOR.test(color)) fail(`${itemPath}.color`);
      return {
        id,
        type: "price-line" as const,
        price: finite(item.price, `${itemPath}.price`),
        color,
        width: integer(item.width, `${itemPath}.width`, 1, 8),
        style: oneOf(item.style, lineStyles, `${itemPath}.style`),
        ...(item.text === undefined ? {} : { text: typeof item.text === "string" && item.text.length <= 1_024 ? item.text : fail(`${itemPath}.text`) }),
      };
    }
    if (item.type === "band") {
      exact(item, ["id", "type", "startTime", "endTime", "lowerPrice", "upperPrice", "fillColor"], ["borderColor"], itemPath);
      const startTime = integer(item.startTime, `${itemPath}.startTime`);
      const endTime = integer(item.endTime, `${itemPath}.endTime`);
      const lowerPrice = finite(item.lowerPrice, `${itemPath}.lowerPrice`);
      const upperPrice = finite(item.upperPrice, `${itemPath}.upperPrice`);
      const fillColor = string(item.fillColor, `${itemPath}.fillColor`, 9);
      const borderColor = item.borderColor === undefined ? undefined : string(item.borderColor, `${itemPath}.borderColor`, 9);
      if (endTime <= startTime || upperPrice < lowerPrice || !COLOR.test(fillColor) || (borderColor !== undefined && !COLOR.test(borderColor))) fail(itemPath);
      return {
        id,
        type: "band" as const,
        startTime,
        endTime,
        lowerPrice,
        upperPrice,
        fillColor,
        ...(borderColor === undefined ? {} : { borderColor }),
      };
    }
    if (item.type === "label") {
      exact(item, ["id", "type", "time", "price", "text", "color", "position"], ["backgroundColor"], itemPath);
      const color = string(item.color, `${itemPath}.color`, 9);
      const backgroundColor = item.backgroundColor === undefined ? undefined : string(item.backgroundColor, `${itemPath}.backgroundColor`, 9);
      if (!COLOR.test(color) || (backgroundColor !== undefined && !COLOR.test(backgroundColor))) fail(itemPath);
      return {
        id,
        type: "label" as const,
        time: integer(item.time, `${itemPath}.time`),
        price: finite(item.price, `${itemPath}.price`),
        text: typeof item.text === "string" && item.text.length <= 1_024 ? item.text : fail(`${itemPath}.text`),
        color,
        position: oneOf(item.position, new Set(["above", "below", "center"] as const), `${itemPath}.position`),
        ...(backgroundColor === undefined ? {} : { backgroundColor }),
      };
    }
    return fail(`${itemPath}.type`);
  });
  if (integer(data.itemCount, `${path}.itemCount`) !== items.length) fail(`${path}.itemCount`);
  return {
    ...base,
    chartId: "main-chart",
    chartRevision: integer(data.chartRevision, `${path}.chartRevision`, 1),
    zOrder: oneOf(data.zOrder, new Set(["above-series", "below-series"] as const), `${path}.zOrder`),
    render: { schemaVersion: "candlescope.render/2", items },
  };
}

export function parsePluginUiSnapshot(value: unknown): PluginUiSnapshot {
  if (JSON.stringify(value).length > 2 * 1024 * 1024) fail("ui");
  const data = record(value, "ui");
  exact(data, ["schemaVersion", "registryRevision", "views", "chartLayers"], [], "ui");
  if (data.schemaVersion !== "candlescope.plugin-ui/1") fail("ui.schemaVersion");
  const views = array(data.views, "ui.views", 256).map((item, index) => viewProjection(item, `ui.views[${index}]`));
  if (new Set(views.map((item) => item.id)).size !== views.length) fail("ui.views");
  const chartLayers = array(data.chartLayers, "ui.chartLayers", 256).map((item, index) => chartLayer(item, `ui.chartLayers[${index}]`));
  if (new Set(chartLayers.map((item) => item.id)).size !== chartLayers.length) fail("ui.chartLayers");
  return { schemaVersion: "candlescope.plugin-ui/1", registryRevision: integer(data.registryRevision, "ui.registryRevision"), views, chartLayers };
}

export function parsePluginLiveControlStatus(value: unknown): PluginLiveControlStatus {
  const path = "liveControl";
  const data = record(value, path);
  exact(data, [
    "schemaVersion", "available", "mode", "generation", "policyEpoch",
    "updatedAt", "outstandingConfirmationCount", "confirmationCounts",
    "eventSequence", "eventSha256", "liveSubmitAvailable",
    "liveCancelAvailable", "liveTransferAvailable",
  ], [], path);
  const available = boolean(data.available, `${path}.available`);
  const mode = oneOf(
    data.mode,
    new Set(["disabled", "unavailable", "disarmed", "armed", "killed"] as const),
    `${path}.mode`,
  );
  const liveSubmitAvailable = boolean(
    data.liveSubmitAvailable,
    `${path}.liveSubmitAvailable`,
  );
  const liveCancelAvailable = boolean(
    data.liveCancelAvailable,
    `${path}.liveCancelAvailable`,
  );
  if (
    data.schemaVersion !== "candlescope.live-control-status/1"
    || available !== new Set(["disarmed", "armed", "killed"]).has(mode)
    || liveSubmitAvailable !== liveCancelAvailable
    || data.liveTransferAvailable !== false
  ) fail(path);
  const counts = record(data.confirmationCounts, `${path}.confirmationCounts`);
  exact(counts, ["consumed", "expired", "issued", "revoked"], [], `${path}.confirmationCounts`);
  const confirmationCounts = {
    consumed: integer(counts.consumed, `${path}.confirmationCounts.consumed`),
    expired: integer(counts.expired, `${path}.confirmationCounts.expired`),
    issued: integer(counts.issued, `${path}.confirmationCounts.issued`),
    revoked: integer(counts.revoked, `${path}.confirmationCounts.revoked`),
  };
  const outstandingConfirmationCount = integer(
    data.outstandingConfirmationCount,
    `${path}.outstandingConfirmationCount`,
  );
  if (outstandingConfirmationCount !== confirmationCounts.issued) fail(path);
  const eventSha256 = data.eventSha256 === null
    ? null
    : string(data.eventSha256, `${path}.eventSha256`, 71);
  if (eventSha256 !== null && !BUNDLE_DIGEST.test(eventSha256)) fail(`${path}.eventSha256`);
  return {
    schemaVersion: "candlescope.live-control-status/1",
    available,
    mode,
    generation: integer(data.generation, `${path}.generation`),
    policyEpoch: integer(data.policyEpoch, `${path}.policyEpoch`),
    updatedAt: data.updatedAt === null ? null : string(data.updatedAt, `${path}.updatedAt`, 64),
    outstandingConfirmationCount,
    confirmationCounts,
    eventSequence: integer(data.eventSequence, `${path}.eventSequence`),
    eventSha256,
    liveSubmitAvailable,
    liveCancelAvailable,
    liveTransferAvailable: false,
  };
}

export function parsePluginLiveConfirmationPreview(
  value: unknown,
): PluginLiveConfirmationPreview {
  const path = "liveConfirmationPreview";
  const data = record(value, path);
  const commonFields = [
    "schemaVersion", "intentSha256", "pluginId", "connectorId",
    "publisherIdentity", "version", "clientOrderId", "instrumentId",
    "side", "orderType", "quantity", "limitPrice", "policyEpoch",
    "controlGeneration", "liveSubmitAvailable", "liveCancelAvailable",
  ];
  const executionFields = [
    "orderIntentSha256", "action", "executionState", "notional",
    "riskDecisionSha256", "hardLimits",
  ];
  const execution = data.schemaVersion === "candlescope.live-confirmation-preview/2";
  exact(data, execution ? [...commonFields, ...executionFields] : commonFields, [], path);
  const intentSha256 = string(data.intentSha256, `${path}.intentSha256`, 71);
  const clientOrderId = string(data.clientOrderId, `${path}.clientOrderId`, 32);
  const liveSubmitAvailable = boolean(
    data.liveSubmitAvailable,
    `${path}.liveSubmitAvailable`,
  );
  const liveCancelAvailable = boolean(
    data.liveCancelAvailable,
    `${path}.liveCancelAvailable`,
  );
  if (
    !new Set([
      "candlescope.live-confirmation-preview/1",
      "candlescope.live-confirmation-preview/2",
    ]).has(String(data.schemaVersion))
    || !BUNDLE_DIGEST.test(intentSha256)
    || !/^[A-Za-z0-9]{32}$/.test(clientOrderId)
    || data.orderType !== "limit"
  ) fail(path);
  const pluginId = string(data.pluginId, `${path}.pluginId`, 128);
  const connectorId = string(data.connectorId, `${path}.connectorId`, 128);
  if (!PLUGIN_ID.test(pluginId) || !PLUGIN_ID.test(connectorId)) fail(path);
  const common = {
    intentSha256,
    pluginId,
    connectorId,
    publisherIdentity: string(data.publisherIdentity, `${path}.publisherIdentity`, 256),
    version: string(data.version, `${path}.version`, 64),
    clientOrderId,
    instrumentId: string(data.instrumentId, `${path}.instrumentId`, 64),
    side: oneOf(data.side, new Set(["buy", "sell"] as const), `${path}.side`),
    orderType: "limit" as const,
    quantity: string(data.quantity, `${path}.quantity`, 64),
    limitPrice: string(data.limitPrice, `${path}.limitPrice`, 64),
    policyEpoch: integer(data.policyEpoch, `${path}.policyEpoch`),
    controlGeneration: integer(data.controlGeneration, `${path}.controlGeneration`),
    liveSubmitAvailable,
    liveCancelAvailable,
  };
  if (!execution) {
    if (liveSubmitAvailable || liveCancelAvailable) fail(path);
    return {
      schemaVersion: "candlescope.live-confirmation-preview/1",
      ...common,
    };
  }
  const orderIntentSha256 = string(
    data.orderIntentSha256,
    `${path}.orderIntentSha256`,
    71,
  );
  const riskDecisionSha256 = string(
    data.riskDecisionSha256,
    `${path}.riskDecisionSha256`,
    71,
  );
  const action = oneOf(
    data.action,
    new Set(["submit", "cancel"] as const),
    `${path}.action`,
  );
  const executionState = oneOf(
    data.executionState,
    new Set(["not-started", "live", "partially_filled"] as const),
    `${path}.executionState`,
  );
  const notional = string(data.notional, `${path}.notional`, 64);
  const limits = record(data.hardLimits, `${path}.hardLimits`);
  exact(limits, [
    "instrumentId", "maxOrderNotional", "maxUnresolvedOrders",
    "maxUnresolvedNotional",
  ], [], `${path}.hardLimits`);
  if (
    !BUNDLE_DIGEST.test(orderIntentSha256)
    || !BUNDLE_DIGEST.test(riskDecisionSha256)
    || !PAPER_DECIMAL.test(notional)
    || notional === "0"
    || common.instrumentId !== "BTC-USDT"
    || connectorId !== "candlescope.okx-demo-spot-execution"
    || (action === "submit" && executionState !== "not-started")
    || (action === "cancel" && !new Set(["live", "partially_filled"]).has(executionState))
    || liveSubmitAvailable !== (action === "submit")
    || liveCancelAvailable !== (action === "cancel")
    || limits.instrumentId !== "BTC-USDT"
    || limits.maxOrderNotional !== "100"
    || limits.maxUnresolvedOrders !== 2
    || limits.maxUnresolvedNotional !== "200"
  ) fail(path);
  return {
    schemaVersion: "candlescope.live-confirmation-preview/2",
    ...common,
    orderIntentSha256,
    action,
    executionState,
    notional,
    riskDecisionSha256,
    hardLimits: {
      instrumentId: "BTC-USDT",
      maxOrderNotional: "100",
      maxUnresolvedOrders: 2,
      maxUnresolvedNotional: "200",
    },
  };
}

export function parsePluginLiveConfirmationReceipt(
  value: unknown,
): PluginLiveConfirmationReceipt {
  const path = "liveConfirmationReceipt";
  const data = record(value, path);
  const commonFields = [
    "schemaVersion", "receiptRef", "receiptId", "intentSha256", "pluginId",
    "connectorId", "publisherIdentity", "version", "clientOrderId",
    "instrumentId", "side", "orderType", "quantity", "limitPrice",
    "policyEpoch", "controlGeneration", "state", "issuedAt", "expiresAt",
    "resolvedAt", "liveSubmitAvailable", "liveCancelAvailable",
  ];
  const executionFields = [
    "orderIntentSha256", "action", "executionState", "notional",
    "riskDecisionSha256",
  ];
  const execution = data.schemaVersion === "candlescope.live-confirmation/2";
  exact(data, execution ? [...commonFields, ...executionFields] : commonFields, [], path);
  const preview = parsePluginLiveConfirmationPreview({
    schemaVersion: execution
      ? "candlescope.live-confirmation-preview/2"
      : "candlescope.live-confirmation-preview/1",
    intentSha256: data.intentSha256,
    pluginId: data.pluginId,
    connectorId: data.connectorId,
    publisherIdentity: data.publisherIdentity,
    version: data.version,
    clientOrderId: data.clientOrderId,
    instrumentId: data.instrumentId,
    side: data.side,
    orderType: data.orderType,
    quantity: data.quantity,
    limitPrice: data.limitPrice,
    policyEpoch: data.policyEpoch,
    controlGeneration: data.controlGeneration,
    liveSubmitAvailable: data.liveSubmitAvailable,
    liveCancelAvailable: data.liveCancelAvailable,
    ...(execution ? {
      orderIntentSha256: data.orderIntentSha256,
      action: data.action,
      executionState: data.executionState,
      notional: data.notional,
      riskDecisionSha256: data.riskDecisionSha256,
      hardLimits: {
        instrumentId: "BTC-USDT",
        maxOrderNotional: "100",
        maxUnresolvedOrders: 2,
        maxUnresolvedNotional: "200",
      },
    } : {}),
  });
  const receiptRef = string(data.receiptRef, `${path}.receiptRef`, 64);
  const receiptId = string(data.receiptId, `${path}.receiptId`, 32);
  if (
    !new Set([
      "candlescope.live-confirmation/1",
      "candlescope.live-confirmation/2",
    ]).has(String(data.schemaVersion))
    || !/^livecfm_[A-Za-z0-9_-]{43}$/.test(receiptRef)
    || !/^[0-9a-f]{32}$/.test(receiptId)
    || data.state !== "issued"
    || data.resolvedAt !== null
  ) fail(path);
  return {
    schemaVersion: execution
      ? "candlescope.live-confirmation/2"
      : "candlescope.live-confirmation/1",
    receiptRef,
    receiptId,
    intentSha256: preview.intentSha256,
    pluginId: preview.pluginId,
    connectorId: preview.connectorId,
    publisherIdentity: preview.publisherIdentity,
    version: preview.version,
    clientOrderId: preview.clientOrderId,
    instrumentId: preview.instrumentId,
    side: preview.side,
    orderType: "limit",
    quantity: preview.quantity,
    limitPrice: preview.limitPrice,
    policyEpoch: preview.policyEpoch,
    controlGeneration: preview.controlGeneration,
    state: "issued",
    issuedAt: string(data.issuedAt, `${path}.issuedAt`, 64),
    expiresAt: string(data.expiresAt, `${path}.expiresAt`, 64),
    resolvedAt: null,
    liveSubmitAvailable: preview.liveSubmitAvailable,
    liveCancelAvailable: preview.liveCancelAvailable,
    ...(execution ? {
      orderIntentSha256: preview.orderIntentSha256,
      action: preview.action,
      executionState: preview.executionState,
      notional: preview.notional,
      riskDecisionSha256: preview.riskDecisionSha256,
    } : {}),
  };
}

export function parsePluginLiveExecutionRecord(
  value: unknown,
): PluginLiveExecutionRecord {
  const path = "liveExecution";
  const data = record(value, path);
  const optionalAction = "action" in data || "accepted" in data;
  const fields = [
    "schemaVersion", "pluginId", "connectorId", "publisherIdentity",
    "version", "clientOrderId", "orderIntentSha256", "instrumentId",
    "side", "orderType", "quantity", "limitPrice", "notional", "state",
    "priorState", "submitAttemptCount", "cancelAttemptCount",
    "venueOrderIdSha256", "lastReceiptId", "lastConfirmationSha256",
    "lastRiskDecisionSha256", "lastErrorCode", "createdAt", "updatedAt",
    "policyEpoch", "controlGeneration", "terminal", "reconciliationRequired",
  ];
  exact(data, optionalAction ? [...fields, "accepted", "action"] : fields, [], path);
  const state = oneOf(
    data.state,
    new Set([
      "submitting", "unknown", "rejected", "live", "partially_filled",
      "filled", "canceled", "mmp_canceled", "canceling", "cancel_unknown",
    ] as const),
    `${path}.state`,
  );
  const terminalStates = new Set(["rejected", "filled", "canceled", "mmp_canceled"]);
  const venueOrderIdSha256 = data.venueOrderIdSha256 === null
    ? null
    : string(data.venueOrderIdSha256, `${path}.venueOrderIdSha256`, 71);
  const lastErrorCode = data.lastErrorCode === null
    ? null
    : string(data.lastErrorCode, `${path}.lastErrorCode`, 128);
  const priorState = data.priorState === null
    ? null
    : oneOf(
        data.priorState,
        new Set(["live", "partially_filled"] as const),
        `${path}.priorState`,
      );
  const orderIntentSha256 = string(
    data.orderIntentSha256,
    `${path}.orderIntentSha256`,
    71,
  );
  const lastConfirmationSha256 = string(
    data.lastConfirmationSha256,
    `${path}.lastConfirmationSha256`,
    71,
  );
  const lastRiskDecisionSha256 = string(
    data.lastRiskDecisionSha256,
    `${path}.lastRiskDecisionSha256`,
    71,
  );
  const digestFields = [
    orderIntentSha256,
    lastConfirmationSha256,
    lastRiskDecisionSha256,
  ];
  const quantity = string(data.quantity, `${path}.quantity`, 64);
  const limitPrice = string(data.limitPrice, `${path}.limitPrice`, 64);
  const notional = string(data.notional, `${path}.notional`, 64);
  const terminal = boolean(data.terminal, `${path}.terminal`);
  const reconciliationRequired = boolean(
    data.reconciliationRequired,
    `${path}.reconciliationRequired`,
  );
  if (
    data.schemaVersion !== "candlescope.live-execution-record/1"
    || data.connectorId !== "candlescope.okx-demo-spot-execution"
    || data.instrumentId !== "BTC-USDT"
    || data.orderType !== "limit"
    || !digestFields.every((item) => BUNDLE_DIGEST.test(item))
    || (venueOrderIdSha256 !== null && !BUNDLE_DIGEST.test(venueOrderIdSha256))
    || !/^[A-Za-z0-9]{32}$/.test(string(data.clientOrderId, `${path}.clientOrderId`, 32))
    || !/^[0-9a-f]{32}$/.test(string(data.lastReceiptId, `${path}.lastReceiptId`, 32))
    || ![quantity, limitPrice, notional].every((item) => PAPER_DECIMAL.test(item) && item !== "0")
    || terminal !== terminalStates.has(state)
    || reconciliationRequired !== new Set(["unknown", "cancel_unknown"]).has(state)
    || (new Set(["canceling", "cancel_unknown"]).has(state) !== (priorState !== null))
    || (new Set([
      "live", "partially_filled", "filled", "canceled", "mmp_canceled",
      "canceling", "cancel_unknown",
    ]).has(state) && venueOrderIdSha256 === null)
    || (lastErrorCode !== null && !/^[A-Z][A-Z0-9_]{0,127}$/.test(lastErrorCode))
  ) fail(path);
  const action = optionalAction
    ? oneOf(data.action, new Set(["submit", "cancel"] as const), `${path}.action`)
    : undefined;
  const accepted = optionalAction
    ? boolean(data.accepted, `${path}.accepted`)
    : undefined;
  const parsed: PluginLiveExecutionRecord = {
    schemaVersion: "candlescope.live-execution-record/1",
    pluginId: string(data.pluginId, `${path}.pluginId`, 128),
    connectorId: "candlescope.okx-demo-spot-execution",
    publisherIdentity: string(data.publisherIdentity, `${path}.publisherIdentity`, 256),
    version: string(data.version, `${path}.version`, 64),
    clientOrderId: string(data.clientOrderId, `${path}.clientOrderId`, 32),
    orderIntentSha256,
    instrumentId: "BTC-USDT",
    side: oneOf(data.side, new Set(["buy", "sell"] as const), `${path}.side`),
    orderType: "limit",
    quantity,
    limitPrice,
    notional,
    state,
    priorState,
    submitAttemptCount: integer(data.submitAttemptCount, `${path}.submitAttemptCount`, 1, 1) as 1,
    cancelAttemptCount: integer(data.cancelAttemptCount, `${path}.cancelAttemptCount`, 0, 10),
    venueOrderIdSha256,
    lastReceiptId: string(data.lastReceiptId, `${path}.lastReceiptId`, 32),
    lastConfirmationSha256,
    lastRiskDecisionSha256,
    lastErrorCode,
    createdAt: string(data.createdAt, `${path}.createdAt`, 64),
    updatedAt: string(data.updatedAt, `${path}.updatedAt`, 64),
    policyEpoch: integer(data.policyEpoch, `${path}.policyEpoch`),
    controlGeneration: integer(data.controlGeneration, `${path}.controlGeneration`),
    terminal,
    reconciliationRequired,
  };
  if (!optionalAction) return parsed;
  return {
    ...parsed,
    accepted: accepted as boolean,
    action: action as "submit" | "cancel",
  };
}

function paperStatus(value: unknown, path: string, withAvailable = false): PluginPaperStatus & { available?: boolean } {
  const data = record(value, path);
  const required = [
    "schemaVersion", "killSwitchEnabled", "mode", "liveTradingAvailable",
    "secretsAvailable", "brokers",
  ];
  exact(data, withAvailable ? [...required, "available"] : required, [], path);
  if (
    data.schemaVersion !== "candlescope.paper-status/1"
    || data.mode !== "paper-only"
    || data.liveTradingAvailable !== false
    || data.secretsAvailable !== false
  ) fail(path);
  const brokers = array(data.brokers, `${path}.brokers`, 16).map((raw, index) => {
    const broker = record(raw, `${path}.brokers[${index}]`);
    exact(broker, ["brokerId", "pluginId", "displayName", "accounts", "orderTypes", "symbols", "limits"], [], `${path}.brokers[${index}]`);
    const brokerId = string(broker.brokerId, `${path}.brokers[${index}].brokerId`, 64);
    const pluginId = string(broker.pluginId, `${path}.brokers[${index}].pluginId`, 128);
    if (!EXCHANGE_ID.test(brokerId) || !PLUGIN_ID.test(pluginId)) fail(`${path}.brokers[${index}]`);
    const accounts = array(broker.accounts, `${path}.brokers[${index}].accounts`, 64).map((item, accountIndex) => {
      const account = string(item, `${path}.brokers[${index}].accounts[${accountIndex}]`, 128);
      if (!PAPER_ACCOUNT_ID.test(account)) fail(`${path}.brokers[${index}].accounts[${accountIndex}]`);
      return account;
    });
    const orderTypes = array(broker.orderTypes, `${path}.brokers[${index}].orderTypes`, 2).map((item, typeIndex) => (
      oneOf(item, new Set(["market", "limit"] as const), `${path}.brokers[${index}].orderTypes[${typeIndex}]`)
    ));
    const symbols = array(broker.symbols, `${path}.brokers[${index}].symbols`, 128).map((item, symbolIndex) => {
      const symbol = record(item, `${path}.brokers[${index}].symbols[${symbolIndex}]`);
      exact(symbol, ["symbol", "marketType"], [], `${path}.brokers[${index}].symbols[${symbolIndex}]`);
      const symbolId = string(symbol.symbol, `${path}.brokers[${index}].symbols[${symbolIndex}].symbol`, 64);
      const marketType = string(symbol.marketType, `${path}.brokers[${index}].symbols[${symbolIndex}].marketType`, 32);
      if (!PAPER_SYMBOL.test(symbolId) || !MARKET_TYPE_ID.test(marketType)) fail(`${path}.brokers[${index}].symbols[${symbolIndex}]`);
      return { symbol: symbolId, marketType };
    });
    const limits = record(broker.limits, `${path}.brokers[${index}].limits`);
    exact(limits, ["maxOrderQuantity", "maxOrderNotional", "maxPositionNotional", "maxOpenOrders", "maxOrdersPerMinute", "allowShort", "maxQuoteAgeMs"], [], `${path}.brokers[${index}].limits`);
    return {
      brokerId,
      pluginId,
      displayName: string(broker.displayName, `${path}.brokers[${index}].displayName`, 128),
      accounts,
      orderTypes,
      symbols,
      limits: {
        maxOrderQuantity: paperDecimal(limits.maxOrderQuantity, `${path}.brokers[${index}].limits.maxOrderQuantity`),
        maxOrderNotional: paperDecimal(limits.maxOrderNotional, `${path}.brokers[${index}].limits.maxOrderNotional`),
        maxPositionNotional: paperDecimal(limits.maxPositionNotional, `${path}.brokers[${index}].limits.maxPositionNotional`),
        maxOpenOrders: integer(limits.maxOpenOrders, `${path}.brokers[${index}].limits.maxOpenOrders`, 1, 1024),
        maxOrdersPerMinute: integer(limits.maxOrdersPerMinute, `${path}.brokers[${index}].limits.maxOrdersPerMinute`, 1, 10_000),
        allowShort: boolean(limits.allowShort, `${path}.brokers[${index}].limits.allowShort`),
        maxQuoteAgeMs: integer(limits.maxQuoteAgeMs, `${path}.brokers[${index}].limits.maxQuoteAgeMs`, 100, 60_000),
      },
    };
  });
  if (new Set(brokers.map((item) => item.brokerId)).size !== brokers.length) fail(`${path}.brokers`);
  return {
    schemaVersion: "candlescope.paper-status/1",
    killSwitchEnabled: boolean(data.killSwitchEnabled, `${path}.killSwitchEnabled`),
    mode: "paper-only",
    liveTradingAvailable: false,
    secretsAvailable: false,
    brokers,
    ...(withAvailable ? { available: boolean(data.available, `${path}.available`) } : {}),
  };
}

function httpsUrl(value: unknown, path: string): string {
  const result = string(value, path, 2048);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    return fail(path);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.port && parsed.port !== "443")
  ) fail(path);
  return result;
}

function marketplaceScope(value: unknown, path: string): Record<string, JsonValue> | null {
  if (value === null) return null;
  const parsed = jsonValue(value, path);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail(path);
  return parsed;
}

function marketplaceVersion(value: unknown, path: string): string {
  const result = string(value, path, 64);
  if (!MARKETPLACE_SEMVER.test(result)) fail(path);
  return result;
}

function marketplaceLicense(value: unknown, path: string): string {
  const result = string(value, path, 256);
  if (!MARKETPLACE_LICENSE.test(result)) fail(path);
  return result;
}

function marketplaceReleaseV1(value: unknown, path: string): PluginMarketplaceRelease {
  const data = record(value, path);
  exact(data, [
    "pluginId",
    "version",
    "publisherId",
    "artifact",
    "publishedAt",
    "licenseExpression",
    "dependencies",
    "sha256Sums",
    "sha256SumsSha256",
    "publisherKeyId",
    "transparency",
    "revoked",
  ], [], path);
  const pluginId = string(data.pluginId, `${path}.pluginId`, 128);
  const publisherId = string(data.publisherId, `${path}.publisherId`, 128);
  if (!PLUGIN_ID.test(pluginId) || !MARKETPLACE_LOCAL_ID.test(publisherId)) fail(path);
  const artifact = record(data.artifact, `${path}.artifact`);
  exact(artifact, [
    "fileName",
    "url",
    "sha256",
    "size",
    "manifestSha256",
    "sbomSha256",
  ], [], `${path}.artifact`);
  const fileName = string(artifact.fileName, `${path}.artifact.fileName`, 207);
  const artifactSha256 = digest(artifact.sha256, `${path}.artifact.sha256`);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.cspkg$/.test(fileName)
    || rawString(data.sha256Sums, `${path}.sha256Sums`, 512)
      !== `${artifactSha256.slice("sha256:".length)}  ${fileName}\n`
  ) fail(path);
  const dependencies = array(data.dependencies, `${path}.dependencies`, 1_000).map((raw, index) => {
    const item = record(raw, `${path}.dependencies[${index}]`);
    exact(item, ["name", "version", "licenseExpression"], [], `${path}.dependencies[${index}]`);
    const name = string(item.name, `${path}.dependencies[${index}].name`, 128);
    if (!MARKETPLACE_LOCAL_ID.test(name)) fail(`${path}.dependencies[${index}].name`);
    return {
      name,
      version: string(item.version, `${path}.dependencies[${index}].version`, 128),
      licenseExpression: marketplaceLicense(item.licenseExpression, `${path}.dependencies[${index}].licenseExpression`),
    };
  });
  const transparency = record(data.transparency, `${path}.transparency`);
  exact(transparency, ["logIndex", "leafSha256", "recordSha256"], [], `${path}.transparency`);
  return {
    pluginId,
    version: marketplaceVersion(data.version, `${path}.version`),
    publisherId,
    artifact: {
      fileName,
      url: httpsUrl(artifact.url, `${path}.artifact.url`),
      sha256: artifactSha256,
      size: integer(artifact.size, `${path}.artifact.size`, 1, MARKETPLACE_MAX_ARTIFACT_BYTES),
      manifestSha256: digest(artifact.manifestSha256, `${path}.artifact.manifestSha256`),
      sbomSha256: digest(artifact.sbomSha256, `${path}.artifact.sbomSha256`),
    },
    publishedAt: utcTimestamp(data.publishedAt, `${path}.publishedAt`),
    licenseExpression: marketplaceLicense(data.licenseExpression, `${path}.licenseExpression`),
    dependencies,
    sha256Sums: data.sha256Sums as string,
    sha256SumsSha256: digest(data.sha256SumsSha256, `${path}.sha256SumsSha256`),
    publisherKeyId: keyId(data.publisherKeyId, `${path}.publisherKeyId`),
    transparency: {
      logIndex: integer(transparency.logIndex, `${path}.transparency.logIndex`, 0),
      leafSha256: digest(transparency.leafSha256, `${path}.transparency.leafSha256`),
      recordSha256: digest(transparency.recordSha256, `${path}.transparency.recordSha256`),
    },
    revoked: boolean(data.revoked, `${path}.revoked`),
  };
}

function marketplacePermissionDiff(value: unknown, path: string): PluginMarketplacePermissionDiff {
  const data = record(value, path);
  exact(data, [
    "pluginId",
    "publisherIdentityChanged",
    "majorVersionChanged",
    "bundleChanged",
    "requiresConfirmation",
    "permissions",
  ], ["authorizationIdentityChanged"], path);
  const pluginId = string(data.pluginId, `${path}.pluginId`, 128);
  if (!PLUGIN_ID.test(pluginId)) fail(`${path}.pluginId`);
  const permissions = array(data.permissions, `${path}.permissions`, 128).map((raw, index) => {
    const itemPath = `${path}.permissions[${index}]`;
    const item = record(raw, itemPath);
    exact(item, [
      "permissionId",
      "kind",
      "previousKind",
      "change",
      "previousDecision",
      "requestedScope",
      "previousScope",
      "requiresConfirmation",
    ], [], itemPath);
    const permissionKind = item.kind === null
      ? null
      : oneOf(item.kind, new Set(["required", "optional"] as const), `${itemPath}.kind`);
    const previousKind = item.previousKind === null
      ? null
      : oneOf(item.previousKind, new Set(["required", "optional"] as const), `${itemPath}.previousKind`);
    const previousDecision = item.previousDecision === null
      ? null
      : oneOf(item.previousDecision, new Set(["pending", "granted", "denied", "revoked"] as const), `${itemPath}.previousDecision`);
    return {
      permissionId: string(item.permissionId, `${itemPath}.permissionId`, 128),
      kind: permissionKind,
      previousKind,
      change: oneOf(item.change, new Set([
        "added",
        "removed",
        "identity-changed",
        "kind-changed",
        "unchanged",
        "narrowed",
        "expanded",
        "changed",
      ] as const), `${itemPath}.change`),
      previousDecision,
      requestedScope: marketplaceScope(item.requestedScope, `${itemPath}.requestedScope`),
      previousScope: marketplaceScope(item.previousScope, `${itemPath}.previousScope`),
      requiresConfirmation: boolean(item.requiresConfirmation, `${itemPath}.requiresConfirmation`),
    };
  });
  const requiresConfirmation = boolean(data.requiresConfirmation, `${path}.requiresConfirmation`);
  const authorizationIdentityChanged = data.authorizationIdentityChanged === undefined
    ? undefined
    : boolean(data.authorizationIdentityChanged, `${path}.authorizationIdentityChanged`);
  if (requiresConfirmation !== (permissions.some((item) => item.requiresConfirmation) || authorizationIdentityChanged === true)) fail(`${path}.requiresConfirmation`);
  return {
    pluginId,
    publisherIdentityChanged: boolean(data.publisherIdentityChanged, `${path}.publisherIdentityChanged`),
    majorVersionChanged: boolean(data.majorVersionChanged, `${path}.majorVersionChanged`),
    bundleChanged: boolean(data.bundleChanged, `${path}.bundleChanged`),
    ...(authorizationIdentityChanged === undefined ? {} : { authorizationIdentityChanged }),
    requiresConfirmation,
    permissions,
  };
}

function exactAcknowledgements(value: unknown, path: string): string[] {
  const values = array(value, path, 256).map((item, index) => string(item, `${path}[${index}]`, 256));
  if (values.join("\0") !== [...new Set(values)].sort().join("\0")) fail(path);
  return values;
}

function expectedTrustAcknowledgements(
  authorization: PluginTrustAuthorization,
  requests: PluginTrustRequests,
): string[] {
  return [
    "execute-local-code",
    "sandbox-status",
    "live-authority-separate",
    ...authorization.entrypoints.map((item) => `runtime:${item.entrypointId}:${item.runtimeKind}:${item.runtimeId}`),
    ...requests.permissions.map((item) => `permission:${item.permissionId}`),
  ].sort();
}

function localInstallPreview(value: unknown, path: string): PluginLocalInstallPreview {
  const data = record(value, path);
  exact(data, ["schemaVersion", "plugin", "source", "authorization", "permissionDiff", "runtimeDiff", "requests", "requiredAcknowledgements", "warning"], [], path);
  if (data.schemaVersion !== "candlescope.plugin-trust-preview/1") fail(`${path}.schemaVersion`);
  const plugin = record(data.plugin, `${path}.plugin`);
  exact(plugin, ["id", "name", "version", "publisher", "bundleSha256", "manifestSha256"], [], `${path}.plugin`);
  const pluginId = string(plugin.id, `${path}.plugin.id`, 128);
  if (!PLUGIN_ID.test(pluginId)) fail(`${path}.plugin.id`);
  const permissionDiff = marketplacePermissionDiff(data.permissionDiff, `${path}.permissionDiff`);
  if (permissionDiff.pluginId !== pluginId) fail(`${path}.permissionDiff.pluginId`);
  const source = trustSource(data.source, `${path}.source`);
  const authorization = trustAuthorization(data.authorization, `${path}.authorization`);
  const parsedRuntimeDiff = runtimeDiff(data.runtimeDiff, `${path}.runtimeDiff`);
  const requests = trustRequests(data.requests, `${path}.requests`);
  const requiredAcknowledgements = exactAcknowledgements(data.requiredAcknowledgements, `${path}.requiredAcknowledgements`);
  if (
    authorization.mode !== "trusted-local"
    || source.rawTrustLevel !== "local-developer"
    || source.source !== "local-file"
    || source.publisherIdentity !== `manifest:${string(plugin.publisher, `${path}.plugin.publisher`, 128)}`
    || JSON.stringify(parsedRuntimeDiff.current) !== JSON.stringify(authorization.entrypoints)
    || requiredAcknowledgements.join("\0") !== expectedTrustAcknowledgements(authorization, requests).join("\0")
  ) fail(path);
  return {
    schemaVersion: "candlescope.plugin-trust-preview/1",
    plugin: {
      id: pluginId,
      name: string(plugin.name, `${path}.plugin.name`, 128),
      version: string(plugin.version, `${path}.plugin.version`, 64),
      publisher: string(plugin.publisher, `${path}.plugin.publisher`, 128),
      bundleSha256: digest(plugin.bundleSha256, `${path}.plugin.bundleSha256`),
      manifestSha256: digest(plugin.manifestSha256, `${path}.plugin.manifestSha256`),
    },
    source,
    authorization,
    permissionDiff,
    runtimeDiff: parsedRuntimeDiff,
    requests,
    requiredAcknowledgements,
    warning: string(data.warning, `${path}.warning`, 1024),
  };
}

const MARKETPLACE_RUNTIME_KINDS = new Set([
  "python-module",
  "native-executable",
  "java-jar",
  "node-module",
  "wasm-component",
] as const);
const MARKETPLACE_ROLLOUT_STAGES = new Set([
  "internal",
  "opted-in-local",
  "preview",
  "stable",
] as const);

function marketplacePermissionScopes(value: unknown, path: string) {
  const data = record(value, path);
  exact(data, ["required", "optional"], [], path);
  const parse = (rawValue: unknown, childPath: string) => {
    const values = array(rawValue, childPath, 128).map((raw, index) => {
      const itemPath = `${childPath}[${index}]`;
      const item = record(raw, itemPath);
      exact(item, ["id", "scope"], [], itemPath);
      const id = string(item.id, `${itemPath}.id`, 128);
      if (!MARKETPLACE_LOCAL_ID.test(id)) fail(`${itemPath}.id`);
      const scope = marketplaceScope(item.scope, `${itemPath}.scope`);
      if (scope === null) fail(`${itemPath}.scope`);
      return { id, scope };
    });
    if (
      new Set(values.map((item) => item.id)).size !== values.length
      || values.map((item) => item.id).join("\0") !== values.map((item) => item.id).sort().join("\0")
    ) fail(childPath);
    return values;
  };
  const required = parse(data.required, `${path}.required`);
  const optional = parse(data.optional, `${path}.optional`);
  if (required.some((item) => optional.some((other) => other.id === item.id))) fail(path);
  return { required, optional };
}

function marketplaceSignedArtifact(value: unknown, path: string) {
  const data = record(value, path);
  exact(data, [
    "artifactId",
    "os",
    "arch",
    "fileName",
    "url",
    "sha256",
    "size",
    "manifestSha256",
    "sbomSha256",
    "licenseInventorySha256",
    "runtimeBindings",
    "provenance",
    "reviewPolicy",
    "signature",
  ], [], path);
  const artifactId = string(data.artifactId, `${path}.artifactId`, 128);
  if (!MARKETPLACE_LOCAL_ID.test(artifactId)) fail(`${path}.artifactId`);
  const fileName = string(data.fileName, `${path}.fileName`, 207);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.cspkg$/.test(fileName)) fail(`${path}.fileName`);
  const runtimeBindings = array(data.runtimeBindings, `${path}.runtimeBindings`, 32).map((raw, index) => {
    const itemPath = `${path}.runtimeBindings[${index}]`;
    const item = record(raw, itemPath);
    exact(item, [
      "entrypointId",
      "runtimeKind",
      "runtimeId",
      "pluginArtifactPath",
      "pluginArtifactSha256",
      "supplySource",
      "hostRuntime",
    ], [], itemPath);
    const runtimeKind = oneOf(item.runtimeKind, MARKETPLACE_RUNTIME_KINDS, `${itemPath}.runtimeKind`);
    const expectedSupply = runtimeKind === "python-module"
      ? "host-python" as const
      : runtimeKind === "native-executable"
        ? "plugin-bundled" as const
        : "host-managed" as const;
    if (item.supplySource !== expectedSupply) fail(`${itemPath}.supplySource`);
    const hostRuntime = item.hostRuntime === null ? null : (() => {
      const host = record(item.hostRuntime, `${itemPath}.hostRuntime`);
      exact(host, [
        "registryId",
        "registryRevision",
        "registrySha256",
        "runtimeArtifactSha256",
        "licenseExpression",
      ], [], `${itemPath}.hostRuntime`);
      if (!new Set(["java-jar", "node-module", "wasm-component"]).has(runtimeKind)) fail(`${itemPath}.hostRuntime`);
      return {
        registryId: string(host.registryId, `${itemPath}.hostRuntime.registryId`, 128),
        registryRevision: integer(host.registryRevision, `${itemPath}.hostRuntime.registryRevision`, 1),
        registrySha256: digest(host.registrySha256, `${itemPath}.hostRuntime.registrySha256`),
        runtimeArtifactSha256: digest(host.runtimeArtifactSha256, `${itemPath}.hostRuntime.runtimeArtifactSha256`),
        licenseExpression: marketplaceLicense(host.licenseExpression, `${itemPath}.hostRuntime.licenseExpression`),
      };
    })();
    if ((expectedSupply === "host-managed") !== (hostRuntime !== null)) fail(`${itemPath}.hostRuntime`);
    const pluginArtifactPath = string(item.pluginArtifactPath, `${itemPath}.pluginArtifactPath`, 256);
    if (
      pluginArtifactPath.startsWith("/")
      || pluginArtifactPath.includes("\\")
      || pluginArtifactPath.split("/").some((part) => !part || part === "." || part === "..")
    ) fail(`${itemPath}.pluginArtifactPath`);
    return {
      entrypointId: string(item.entrypointId, `${itemPath}.entrypointId`, 128),
      runtimeKind,
      runtimeId: string(item.runtimeId, `${itemPath}.runtimeId`, 128),
      pluginArtifactPath,
      pluginArtifactSha256: digest(item.pluginArtifactSha256, `${itemPath}.pluginArtifactSha256`),
      supplySource: expectedSupply,
      hostRuntime,
    };
  });
  if (
    !runtimeBindings.length
    || new Set(runtimeBindings.map((item) => item.entrypointId)).size !== runtimeBindings.length
    || runtimeBindings.map((item) => item.entrypointId).join("\0")
      !== runtimeBindings.map((item) => item.entrypointId).sort().join("\0")
  ) fail(`${path}.runtimeBindings`);
  const provenance = record(data.provenance, `${path}.provenance`);
  exact(provenance, [
    "sourceRepository",
    "sourceCommit",
    "buildReceiptUrl",
    "buildReceiptSha256",
    "rebuildInstructionsUrl",
    "rebuildInstructionsSha256",
    "reproducibleBuilds",
  ], [], `${path}.provenance`);
  const sourceCommit = string(provenance.sourceCommit, `${path}.provenance.sourceCommit`, 40);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit) || provenance.reproducibleBuilds !== true) fail(`${path}.provenance`);
  const reviewPolicy = record(data.reviewPolicy, `${path}.reviewPolicy`);
  exact(reviewPolicy, [
    "distribution",
    "sourceBuild",
    "systemRuntimeFallback",
    "undeclaredDownloads",
  ], [], `${path}.reviewPolicy`);
  if (
    reviewPolicy.distribution !== "prebuilt-only"
    || reviewPolicy.sourceBuild !== false
    || reviewPolicy.systemRuntimeFallback !== false
    || reviewPolicy.undeclaredDownloads !== false
  ) fail(`${path}.reviewPolicy`);
  const signature = record(data.signature, `${path}.signature`);
  exact(signature, ["algorithm", "keyId", "value"], [], `${path}.signature`);
  if (signature.algorithm !== "ed25519") fail(`${path}.signature.algorithm`);
  return {
    artifactId,
    os: oneOf(data.os, new Set(["windows", "linux", "macos"] as const), `${path}.os`),
    arch: oneOf(data.arch, new Set(["x86_64", "arm64"] as const), `${path}.arch`),
    fileName,
    url: httpsUrl(data.url, `${path}.url`),
    sha256: digest(data.sha256, `${path}.sha256`),
    size: integer(data.size, `${path}.size`, 1, MARKETPLACE_MAX_ARTIFACT_BYTES),
    manifestSha256: digest(data.manifestSha256, `${path}.manifestSha256`),
    sbomSha256: digest(data.sbomSha256, `${path}.sbomSha256`),
    licenseInventorySha256: digest(data.licenseInventorySha256, `${path}.licenseInventorySha256`),
    runtimeBindings,
    provenance: {
      sourceRepository: httpsUrl(provenance.sourceRepository, `${path}.provenance.sourceRepository`),
      sourceCommit,
      buildReceiptUrl: httpsUrl(provenance.buildReceiptUrl, `${path}.provenance.buildReceiptUrl`),
      buildReceiptSha256: digest(provenance.buildReceiptSha256, `${path}.provenance.buildReceiptSha256`),
      rebuildInstructionsUrl: httpsUrl(provenance.rebuildInstructionsUrl, `${path}.provenance.rebuildInstructionsUrl`),
      rebuildInstructionsSha256: digest(provenance.rebuildInstructionsSha256, `${path}.provenance.rebuildInstructionsSha256`),
      reproducibleBuilds: true as const,
    },
    reviewPolicy: {
      distribution: "prebuilt-only" as const,
      sourceBuild: false as const,
      systemRuntimeFallback: false as const,
      undeclaredDownloads: false as const,
    },
    signature: {
      algorithm: "ed25519" as const,
      keyId: keyId(signature.keyId, `${path}.signature.keyId`),
      value: string(signature.value, `${path}.signature.value`, 128),
    },
  };
}

function marketplaceReleaseV2(value: unknown, path: string): PluginMarketplaceRelease {
  const data = record(value, path);
  exact(data, [
    "pluginId",
    "version",
    "publisherId",
    "artifacts",
    "publishedAt",
    "licenseExpression",
    "dependencies",
    "minimumHostVersion",
    "rolloutStage",
    "officialMaintained",
    "permissions",
    "sha256Sums",
    "sha256SumsSha256",
    "publisherKeyId",
    "runtimeKinds",
    "transparency",
    "revoked",
  ], [], path);
  const pluginId = string(data.pluginId, `${path}.pluginId`, 128);
  const publisherId = string(data.publisherId, `${path}.publisherId`, 128);
  if (!PLUGIN_ID.test(pluginId) || !MARKETPLACE_LOCAL_ID.test(publisherId)) fail(path);
  const artifacts = array(data.artifacts, `${path}.artifacts`, 16).map((item, index) => (
    marketplaceSignedArtifact(item, `${path}.artifacts[${index}]`)
  ));
  if (!artifacts.length || new Set(artifacts.map((item) => `${item.os}:${item.arch}`)).size !== artifacts.length) fail(`${path}.artifacts`);
  const publisherKeyId = keyId(data.publisherKeyId, `${path}.publisherKeyId`);
  if (artifacts.some((item) => item.signature.keyId !== publisherKeyId)) fail(`${path}.artifacts.signature.keyId`);
  const dependencies = array(data.dependencies, `${path}.dependencies`, 1_000).map((raw, index) => {
    const itemPath = `${path}.dependencies[${index}]`;
    const item = record(raw, itemPath);
    exact(item, ["name", "version", "licenseExpression"], [], itemPath);
    const name = string(item.name, `${itemPath}.name`, 128);
    if (!MARKETPLACE_LOCAL_ID.test(name)) fail(`${itemPath}.name`);
    return {
      name,
      version: string(item.version, `${itemPath}.version`, 128),
      licenseExpression: marketplaceLicense(item.licenseExpression, `${itemPath}.licenseExpression`),
    };
  });
  const sha256Sums = rawString(data.sha256Sums, `${path}.sha256Sums`, 4_096);
  const expectedSums = [...artifacts]
    .sort((left, right) => left.fileName.localeCompare(right.fileName))
    .map((item) => `${item.sha256.slice("sha256:".length)}  ${item.fileName}\n`)
    .join("");
  if (sha256Sums !== expectedSums) fail(`${path}.sha256Sums`);
  const runtimeKinds = array(data.runtimeKinds, `${path}.runtimeKinds`, 5).map((item, index) => (
    oneOf(item, MARKETPLACE_RUNTIME_KINDS, `${path}.runtimeKinds[${index}]`)
  ));
  const expectedRuntimeKinds = [...new Set(artifacts.flatMap((item) => item.runtimeBindings.map((binding) => binding.runtimeKind)))].sort();
  if (runtimeKinds.join("\0") !== expectedRuntimeKinds.join("\0")) fail(`${path}.runtimeKinds`);
  const transparency = record(data.transparency, `${path}.transparency`);
  exact(transparency, ["logIndex", "leafSha256", "recordSha256"], [], `${path}.transparency`);
  const first = artifacts[0]!;
  return {
    pluginId,
    version: marketplaceVersion(data.version, `${path}.version`),
    publisherId,
    artifact: {
      fileName: first.fileName,
      url: first.url,
      sha256: first.sha256,
      size: first.size,
      manifestSha256: first.manifestSha256,
      sbomSha256: first.sbomSha256,
    },
    artifacts,
    runtimeKinds,
    publishedAt: utcTimestamp(data.publishedAt, `${path}.publishedAt`),
    licenseExpression: marketplaceLicense(data.licenseExpression, `${path}.licenseExpression`),
    dependencies,
    minimumHostVersion: marketplaceVersion(data.minimumHostVersion, `${path}.minimumHostVersion`),
    rolloutStage: oneOf(data.rolloutStage, MARKETPLACE_ROLLOUT_STAGES, `${path}.rolloutStage`),
    officialMaintained: boolean(data.officialMaintained, `${path}.officialMaintained`),
    permissions: marketplacePermissionScopes(data.permissions, `${path}.permissions`),
    sha256Sums,
    sha256SumsSha256: digest(data.sha256SumsSha256, `${path}.sha256SumsSha256`),
    publisherKeyId,
    transparency: {
      logIndex: integer(transparency.logIndex, `${path}.transparency.logIndex`, 1),
      leafSha256: digest(transparency.leafSha256, `${path}.transparency.leafSha256`),
      recordSha256: digest(transparency.recordSha256, `${path}.transparency.recordSha256`),
    },
    revoked: boolean(data.revoked, `${path}.revoked`),
  };
}

function marketplaceRelease(value: unknown, path: string): PluginMarketplaceRelease {
  const data = record(value, path);
  return "artifacts" in data
    ? marketplaceReleaseV2(data, path)
    : marketplaceReleaseV1(data, path);
}

export function parsePluginLocalInstallCandidate(value: unknown): PluginLocalInstallCandidate {
  const data = record(value, "localInstallCandidate");
  exact(data, ["candidateId", "previewSha256", "expiresAt", "preview"], [], "localInstallCandidate");
  const candidateId = string(data.candidateId, "localInstallCandidate.candidateId", 64);
  if (!/^candidate-[0-9a-f]{32}$/.test(candidateId)) fail("localInstallCandidate.candidateId");
  return {
    candidateId,
    previewSha256: digest(data.previewSha256, "localInstallCandidate.previewSha256"),
    expiresAt: utcTimestamp(data.expiresAt, "localInstallCandidate.expiresAt"),
    preview: localInstallPreview(data.preview, "localInstallCandidate.preview"),
  };
}

export function parsePluginTrustReview(value: unknown): PluginTrustReview {
  const data = record(value, "trustReview");
  exact(data, ["candidateId", "previewSha256", "confirmationToken", "expiresAt", "confirmationStep"], [], "trustReview");
  const candidateId = string(data.candidateId, "trustReview.candidateId", 64);
  if (!/^candidate-[0-9a-f]{32}$/.test(candidateId) || data.confirmationStep !== 1) fail("trustReview");
  const confirmationToken = string(data.confirmationToken, "trustReview.confirmationToken", 256);
  if (!/^trust-review-[A-Za-z0-9_-]{32,192}$/.test(confirmationToken)) fail("trustReview.confirmationToken");
  return {
    candidateId,
    previewSha256: digest(data.previewSha256, "trustReview.previewSha256"),
    confirmationToken,
    expiresAt: utcTimestamp(data.expiresAt, "trustReview.expiresAt"),
    confirmationStep: 1,
  };
}

export function parsePluginTrustChangeReview(value: unknown): PluginTrustChangeReview {
  const data = record(value, "trustChangeReview");
  exact(data, ["changeId", "previewSha256", "confirmationToken", "expiresAt", "preview"], [], "trustChangeReview");
  const changeId = string(data.changeId, "trustChangeReview.changeId", 64);
  if (!/^trust-change-[0-9a-f]{32}$/.test(changeId)) fail("trustChangeReview.changeId");
  const preview = record(data.preview, "trustChangeReview.preview");
  exact(preview, ["schemaVersion", "action", "pluginId", "bundleSha256", "source", "from", "to", "permissionDiff", "runtimeDiff", "requests", "requiredAcknowledgements"], [], "trustChangeReview.preview");
  if (preview.schemaVersion !== "candlescope.plugin-trust-preview/1" || preview.action !== "trust-change") fail("trustChangeReview.preview");
  const pluginId = string(preview.pluginId, "trustChangeReview.preview.pluginId", 128);
  if (!PLUGIN_ID.test(pluginId)) fail("trustChangeReview.preview.pluginId");
  const source = trustSource(preview.source, "trustChangeReview.preview.source");
  const from = trustAuthorization(preview.from, "trustChangeReview.preview.from");
  const to = trustAuthorization(preview.to, "trustChangeReview.preview.to");
  const permissionDiff = marketplacePermissionDiff(preview.permissionDiff, "trustChangeReview.preview.permissionDiff");
  const parsedRuntimeDiff = runtimeDiff(preview.runtimeDiff, "trustChangeReview.preview.runtimeDiff");
  const requests = trustRequests(preview.requests, "trustChangeReview.preview.requests");
  const requiredAcknowledgements = exactAcknowledgements(preview.requiredAcknowledgements, "trustChangeReview.preview.requiredAcknowledgements");
  const confirmationToken = string(data.confirmationToken, "trustChangeReview.confirmationToken", 256);
  if (
    !/^trust-change-[A-Za-z0-9_-]{32,192}$/.test(confirmationToken)
    || source.source !== "signed-marketplace"
    || permissionDiff.pluginId !== pluginId
    || from.mode === to.mode
    || !new Set([from.mode, to.mode]).has("marketplace-sandboxed")
    || !new Set([from.mode, to.mode]).has("trusted-local")
    || JSON.stringify(parsedRuntimeDiff.previous) !== JSON.stringify(from.entrypoints)
    || JSON.stringify(parsedRuntimeDiff.current) !== JSON.stringify(to.entrypoints)
    || requiredAcknowledgements.join("\0") !== expectedTrustAcknowledgements(to, requests).join("\0")
  ) fail("trustChangeReview.preview");
  return {
    changeId,
    previewSha256: digest(data.previewSha256, "trustChangeReview.previewSha256"),
    confirmationToken,
    expiresAt: utcTimestamp(data.expiresAt, "trustChangeReview.expiresAt"),
    preview: {
      schemaVersion: "candlescope.plugin-trust-preview/1",
      action: "trust-change",
      pluginId,
      bundleSha256: digest(preview.bundleSha256, "trustChangeReview.preview.bundleSha256"),
      source,
      from,
      to,
      permissionDiff,
      runtimeDiff: parsedRuntimeDiff,
      requests,
      requiredAcknowledgements,
    },
  };
}

function marketplaceCandidate(value: unknown, path: string): PluginMarketplaceCandidate {
  const data = record(value, path);
  exact(data, [
    "pluginId",
    "version",
    "marketplaceId",
    "publisherId",
    "bundleSha256",
    "artifactFile",
    "phase",
    "preparedAt",
    "fromVersion",
    "permissionDiff",
    "compatibility",
    "migration",
    "observation",
  ], [], path);
  const pluginId = string(data.pluginId, `${path}.pluginId`, 128);
  const marketplaceId = string(data.marketplaceId, `${path}.marketplaceId`, 128);
  const publisherId = string(data.publisherId, `${path}.publisherId`, 128);
  if (
    !PLUGIN_ID.test(pluginId)
    || !MARKETPLACE_LOCAL_ID.test(marketplaceId)
    || !MARKETPLACE_LOCAL_ID.test(publisherId)
  ) fail(path);
  const bundleSha256 = digest(data.bundleSha256, `${path}.bundleSha256`);
  const artifactFile = string(data.artifactFile, `${path}.artifactFile`, 128);
  if (artifactFile !== `${bundleSha256.slice("sha256:".length)}.cspkg`) fail(`${path}.artifactFile`);
  const permissionDiff = marketplacePermissionDiff(data.permissionDiff, `${path}.permissionDiff`);
  if (permissionDiff.pluginId !== pluginId) fail(`${path}.permissionDiff.pluginId`);
  const compatibility = record(data.compatibility, `${path}.compatibility`);
  const compatibilityV2 = "marketplaceSchema" in compatibility;
  exact(
    compatibility,
    compatibilityV2
      ? [
        "hostVersion",
        "verified",
        "marketplaceSchema",
        "platform",
        "runtimeKinds",
        "runtimeRegistry",
        "sandboxAvailable",
        "cacheReuse",
        "rolloutStage",
      ]
      : ["hostVersion", "verified"],
    [],
    `${path}.compatibility`,
  );
  const migration = record(data.migration, `${path}.migration`);
  exact(migration, ["required", "supported", "policy"], [], `${path}.migration`);
  const observation = record(data.observation, `${path}.observation`);
  exact(observation, ["status", "observedAt", "detail"], [], `${path}.observation`);
  return {
    pluginId,
    version: marketplaceVersion(data.version, `${path}.version`),
    marketplaceId,
    publisherId,
    bundleSha256,
    artifactFile,
    phase: oneOf(data.phase, new Set([
      "verified-staged",
      "activation-staged",
      "observing",
      "active",
      "rolled-back",
      "failed",
      "quarantined",
    ] as const), `${path}.phase`),
    preparedAt: utcTimestamp(data.preparedAt, `${path}.preparedAt`),
    fromVersion: data.fromVersion === null ? null : marketplaceVersion(data.fromVersion, `${path}.fromVersion`),
    permissionDiff,
    compatibility: {
      hostVersion: string(compatibility.hostVersion, `${path}.compatibility.hostVersion`, 64),
      verified: compatibility.verified === true ? true : fail(`${path}.compatibility.verified`),
      ...(compatibilityV2 ? (() => {
        const platform = record(compatibility.platform, `${path}.compatibility.platform`);
        exact(platform, ["os", "arch", "artifactId"], [], `${path}.compatibility.platform`);
        const runtimeKinds = array(compatibility.runtimeKinds, `${path}.compatibility.runtimeKinds`, 5).map((item, index) => (
          oneOf(item, MARKETPLACE_RUNTIME_KINDS, `${path}.compatibility.runtimeKinds[${index}]`)
        ));
        const runtimeRegistry = array(compatibility.runtimeRegistry, `${path}.compatibility.runtimeRegistry`, 32).map((item, index) => {
          const parsed = jsonValue(item, `${path}.compatibility.runtimeRegistry[${index}]`);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${path}.compatibility.runtimeRegistry[${index}]`);
          return parsed;
        });
        return {
          marketplaceSchema: oneOf(
            compatibility.marketplaceSchema,
            new Set(["candlescope.marketplace-index/1", "candlescope.marketplace-index/2"] as const),
            `${path}.compatibility.marketplaceSchema`,
          ),
          platform: {
            os: string(platform.os, `${path}.compatibility.platform.os`, 16),
            arch: string(platform.arch, `${path}.compatibility.platform.arch`, 16),
            artifactId: string(platform.artifactId, `${path}.compatibility.platform.artifactId`, 128),
          },
          runtimeKinds,
          runtimeRegistry,
          sandboxAvailable: boolean(compatibility.sandboxAvailable, `${path}.compatibility.sandboxAvailable`),
          cacheReuse: boolean(compatibility.cacheReuse, `${path}.compatibility.cacheReuse`),
          rolloutStage: oneOf(compatibility.rolloutStage, MARKETPLACE_ROLLOUT_STAGES, `${path}.compatibility.rolloutStage`),
        };
      })() : {}),
    },
    migration: {
      required: migration.required === false ? false : fail(`${path}.migration.required`),
      supported: migration.supported === true ? true : fail(`${path}.migration.supported`),
      policy: migration.policy === "same-major-only" ? "same-major-only" : fail(`${path}.migration.policy`),
    },
    observation: {
      status: oneOf(observation.status, new Set([
        "not-started",
        "observing",
        "passed",
        "failed",
        "rolled-back",
      ] as const), `${path}.observation.status`),
      observedAt: observation.observedAt === null ? null : utcTimestamp(observation.observedAt, `${path}.observation.observedAt`),
      detail: observation.detail === null ? null : string(observation.detail, `${path}.observation.detail`, 512),
    },
  };
}

function marketplaceUpdate(value: unknown, path: string): PluginMarketplaceUpdate {
  const data = record(value, path);
  exact(data, [
    "policy",
    "automatic",
    "available",
    "ownership",
    "reason",
    "candidate",
    "latest",
  ], [], path);
  const latest = data.latest === null ? null : marketplaceRelease(data.latest, `${path}.latest`);
  const available = boolean(data.available, `${path}.available`);
  if (available !== (latest !== null)) fail(`${path}.available`);
  return {
    policy: data.policy === "signed-marketplace-or-local-artifact"
      ? "signed-marketplace-or-local-artifact"
      : fail(`${path}.policy`),
    automatic: data.automatic === false ? false : fail(`${path}.automatic`),
    available,
    ownership: oneOf(data.ownership, new Set(["signed-marketplace", "local-or-first-party"] as const), `${path}.ownership`),
    reason: data.reason === null ? null : string(data.reason, `${path}.reason`, 128),
    candidate: data.candidate === null ? null : marketplaceCandidate(data.candidate, `${path}.candidate`),
    latest,
  };
}

export function parsePluginMarketplaceCatalog(value: unknown): PluginMarketplaceCatalog {
  const data = record(value, "marketplaceCatalog");
  const schemaVersion = oneOf(
    data.schemaVersion,
    new Set(["candlescope.marketplace-catalog/1", "candlescope.marketplace-catalog/2"] as const),
    "marketplaceCatalog.schemaVersion",
  );
  const schemaV2 = schemaVersion === "candlescope.marketplace-catalog/2";
  exact(
    data,
    schemaV2
      ? ["schemaVersion", "enabled", "rollout", "marketplaces", "plugins"]
      : ["schemaVersion", "enabled", "marketplaces", "plugins"],
    [],
    "marketplaceCatalog",
  );
  const rollout = schemaV2 ? (() => {
    const item = record(data.rollout, "marketplaceCatalog.rollout");
    exact(item, ["channel", "stages"], [], "marketplaceCatalog.rollout");
    const stages = array(item.stages, "marketplaceCatalog.rollout.stages", 4).map((stage, index) => (
      oneOf(stage, MARKETPLACE_ROLLOUT_STAGES, `marketplaceCatalog.rollout.stages[${index}]`)
    ));
    if (stages.join("\0") !== "internal\0opted-in-local\0preview\0stable") fail("marketplaceCatalog.rollout.stages");
    return {
      channel: oneOf(item.channel, MARKETPLACE_ROLLOUT_STAGES, "marketplaceCatalog.rollout.channel"),
      stages: ["internal", "opted-in-local", "preview", "stable"] as const,
    };
  })() : undefined;
  const marketplaces = array(data.marketplaces, "marketplaceCatalog.marketplaces", 32).map((raw, index) => {
    const path = `marketplaceCatalog.marketplaces[${index}]`;
    const item = record(raw, path);
    exact(item, ["marketplaceId", "indexUrl", "keyId", "enabled", "cache"], [], path);
    const marketplaceId = string(item.marketplaceId, `${path}.marketplaceId`, 128);
    if (!MARKETPLACE_LOCAL_ID.test(marketplaceId)) fail(`${path}.marketplaceId`);
    const cache = record(item.cache, `${path}.cache`);
    const status = oneOf(cache.status, new Set(["valid", "invalid-or-empty"] as const), `${path}.cache.status`);
    if (status === "valid") {
      exact(cache, ["status", "sequence", "expiresAt"], [], `${path}.cache`);
      return {
        marketplaceId,
        indexUrl: httpsUrl(item.indexUrl, `${path}.indexUrl`),
        keyId: keyId(item.keyId, `${path}.keyId`),
        enabled: boolean(item.enabled, `${path}.enabled`),
        cache: {
          status,
          sequence: integer(cache.sequence, `${path}.cache.sequence`, 1),
          expiresAt: utcTimestamp(cache.expiresAt, `${path}.cache.expiresAt`),
        },
      };
    }
    exact(cache, ["status", "reason"], [], `${path}.cache`);
    return {
      marketplaceId,
      indexUrl: httpsUrl(item.indexUrl, `${path}.indexUrl`),
      keyId: keyId(item.keyId, `${path}.keyId`),
      enabled: boolean(item.enabled, `${path}.enabled`),
      cache: {
        status,
        reason: cache.reason === null ? null : string(cache.reason, `${path}.cache.reason`, 128),
      },
    };
  });
  if (new Set(marketplaces.map((item) => item.marketplaceId)).size !== marketplaces.length) fail("marketplaceCatalog.marketplaces");
  const plugins = array(data.plugins, "marketplaceCatalog.plugins", 20_000).map((raw, index) => {
    const path = `marketplaceCatalog.plugins[${index}]`;
    const item = record(raw, path);
    exact(
      item,
      schemaV2
        ? ["pluginId", "publisher", "latest", "assurances", "releaseCount", "installedVersion", "installable"]
        : ["pluginId", "publisher", "latest", "releaseCount", "installedVersion", "installable"],
      [],
      path,
    );
    const pluginId = string(item.pluginId, `${path}.pluginId`, 128);
    if (!PLUGIN_ID.test(pluginId)) fail(`${path}.pluginId`);
    const publisher = record(item.publisher, `${path}.publisher`);
    exact(
      publisher,
      schemaV2
        ? ["publisherId", "displayName", "keyId", "status", "verificationTier"]
        : ["publisherId", "displayName", "keyId", "status"],
      [],
      `${path}.publisher`,
    );
    const publisherId = string(publisher.publisherId, `${path}.publisher.publisherId`, 128);
    if (!MARKETPLACE_LOCAL_ID.test(publisherId)) fail(`${path}.publisher.publisherId`);
    const publisherStatus = oneOf(
      publisher.status,
      new Set(["active"] as const),
      `${path}.publisher.status`,
    );
    const latest = marketplaceRelease(item.latest, `${path}.latest`);
    if (latest.pluginId !== pluginId || latest.publisherId !== publisherId) fail(path);
    const verificationTier = schemaV2
      ? oneOf(publisher.verificationTier, new Set(["verified", "official"] as const), `${path}.publisher.verificationTier`)
      : undefined;
    const assurances = schemaV2 ? (() => {
      const assurance = record(item.assurances, `${path}.assurances`);
      exact(assurance, [
        "publisherVerified",
        "officialMaintained",
        "sandbox",
        "permissions",
        "rolloutStage",
        "minimumHostVersion",
        "platform",
      ], [], `${path}.assurances`);
      const sandbox = record(assurance.sandbox, `${path}.assurances.sandbox`);
      exact(sandbox, ["available", "runtimeKinds", "profiles"], [], `${path}.assurances.sandbox`);
      const runtimeKinds = array(sandbox.runtimeKinds, `${path}.assurances.sandbox.runtimeKinds`, 5).map((kind, kindIndex) => (
        oneOf(kind, MARKETPLACE_RUNTIME_KINDS, `${path}.assurances.sandbox.runtimeKinds[${kindIndex}]`)
      ));
      const profiles = array(sandbox.profiles, `${path}.assurances.sandbox.profiles`, 5).map((profile, profileIndex) => (
        trustProfile(profile, `${path}.assurances.sandbox.profiles[${profileIndex}]`)
      ));
      const sandboxAvailable = boolean(assurance.sandbox && sandbox.available, `${path}.assurances.sandbox.available`);
      if (sandboxAvailable !== (profiles.length > 0 && profiles.every((profile) => profile.sandboxSupported))) fail(`${path}.assurances.sandbox.available`);
      const permissions = marketplacePermissionScopes(assurance.permissions, `${path}.assurances.permissions`);
      const platform = record(assurance.platform, `${path}.assurances.platform`);
      exact(platform, ["os", "arch", "available", "artifactId"], [], `${path}.assurances.platform`);
      const publisherVerified = boolean(assurance.publisherVerified, `${path}.assurances.publisherVerified`);
      const officialMaintained = boolean(assurance.officialMaintained, `${path}.assurances.officialMaintained`);
      if (
        !publisherVerified
        || (officialMaintained && verificationTier !== "official")
        || latest.officialMaintained !== officialMaintained
        || latest.rolloutStage !== assurance.rolloutStage
        || JSON.stringify(latest.permissions) !== JSON.stringify(permissions)
      ) fail(`${path}.assurances`);
      return {
        publisherVerified,
        officialMaintained,
        sandbox: { available: sandboxAvailable, runtimeKinds, profiles },
        permissions,
        rolloutStage: oneOf(assurance.rolloutStage, MARKETPLACE_ROLLOUT_STAGES, `${path}.assurances.rolloutStage`),
        minimumHostVersion: assurance.minimumHostVersion === null
          ? null
          : marketplaceVersion(assurance.minimumHostVersion, `${path}.assurances.minimumHostVersion`),
        platform: {
          os: string(platform.os, `${path}.assurances.platform.os`, 16),
          arch: string(platform.arch, `${path}.assurances.platform.arch`, 16),
          available: boolean(platform.available, `${path}.assurances.platform.available`),
          artifactId: platform.artifactId === null ? null : string(platform.artifactId, `${path}.assurances.platform.artifactId`, 128),
        },
      };
    })() : undefined;
    const installable = boolean(item.installable, `${path}.installable`);
    if (installable && latest.artifact.size > MARKETPLACE_MAX_REMOTE_ARTIFACT_BYTES) fail(`${path}.installable`);
    return {
      pluginId,
      publisher: {
        publisherId,
        displayName: string(publisher.displayName, `${path}.publisher.displayName`, 128),
        keyId: keyId(publisher.keyId, `${path}.publisher.keyId`),
        status: publisherStatus,
        ...(verificationTier === undefined ? {} : { verificationTier }),
      },
      latest,
      ...(assurances === undefined ? {} : { assurances }),
      releaseCount: integer(item.releaseCount, `${path}.releaseCount`, 1, 20_000),
      installedVersion: item.installedVersion === null ? null : marketplaceVersion(item.installedVersion, `${path}.installedVersion`),
      installable,
    };
  });
  if (new Set(plugins.map((item) => item.pluginId)).size !== plugins.length) fail("marketplaceCatalog.plugins");
  return {
    schemaVersion,
    enabled: boolean(data.enabled, "marketplaceCatalog.enabled"),
    ...(rollout === undefined ? {} : { rollout }),
    marketplaces,
    plugins,
  };
}

export function parsePluginMarketplaceStatus(value: unknown): PluginMarketplaceStatus {
  const data = record(value, "marketplaceStatus");
  const schemaVersion = oneOf(
    data.schemaVersion,
    new Set(["candlescope.marketplace-status/1", "candlescope.marketplace-status/2"] as const),
    "marketplaceStatus.schemaVersion",
  );
  const schemaV2 = schemaVersion === "candlescope.marketplace-status/2";
  exact(data, schemaV2 ? [
    "schemaVersion",
    "enabled",
    "automaticUpdates",
    "rootCount",
    "validCacheCount",
    "cacheErrors",
    "candidates",
    "updates",
    "rollout",
    "telemetry",
    "quarantine",
  ] : [
    "schemaVersion",
    "enabled",
    "automaticUpdates",
    "rootCount",
    "validCacheCount",
    "cacheErrors",
    "candidates",
    "updates",
  ], [], "marketplaceStatus");
  const cacheErrorsRaw = record(data.cacheErrors, "marketplaceStatus.cacheErrors");
  if (Object.keys(cacheErrorsRaw).length > 32) fail("marketplaceStatus.cacheErrors");
  const cacheErrors = Object.fromEntries(Object.entries(cacheErrorsRaw).map(([marketplaceId, error]) => {
    if (!MARKETPLACE_LOCAL_ID.test(marketplaceId)) fail("marketplaceStatus.cacheErrors");
    return [marketplaceId, string(error, `marketplaceStatus.cacheErrors.${marketplaceId}`, 128)];
  }));
  const candidates = array(data.candidates, "marketplaceStatus.candidates", 2048)
    .map((item, index) => marketplaceCandidate(item, `marketplaceStatus.candidates[${index}]`));
  if (new Set(candidates.map((item) => item.pluginId)).size !== candidates.length) fail("marketplaceStatus.candidates");
  const updates = array(data.updates, "marketplaceStatus.updates", 2048).map((raw, index) => {
    const path = `marketplaceStatus.updates[${index}]`;
    const item = record(raw, path);
    const pluginId = string(item.pluginId, `${path}.pluginId`, 128);
    if (!PLUGIN_ID.test(pluginId)) fail(`${path}.pluginId`);
    const update = marketplaceUpdate(
      Object.fromEntries(Object.entries(item).filter(([key]) => key !== "pluginId")),
      path,
    );
    return { pluginId, ...update };
  });
  if (new Set(updates.map((item) => item.pluginId)).size !== updates.length) fail("marketplaceStatus.updates");
  const rollout = schemaV2 ? (() => {
    const item = record(data.rollout, "marketplaceStatus.rollout");
    exact(item, ["channel", "stages"], [], "marketplaceStatus.rollout");
    const stages = array(item.stages, "marketplaceStatus.rollout.stages", 4).map((stage, index) => (
      oneOf(stage, MARKETPLACE_ROLLOUT_STAGES, `marketplaceStatus.rollout.stages[${index}]`)
    ));
    if (stages.join("\0") !== "internal\0opted-in-local\0preview\0stable") fail("marketplaceStatus.rollout.stages");
    return {
      channel: oneOf(item.channel, MARKETPLACE_ROLLOUT_STAGES, "marketplaceStatus.rollout.channel"),
      stages: ["internal", "opted-in-local", "preview", "stable"] as const,
    };
  })() : undefined;
  const telemetry = schemaV2 ? (() => {
    const item = record(data.telemetry, "marketplaceStatus.telemetry");
    exact(item, ["enabled", "uploadEnabled", "storage", "privacy", "counters"], [], "marketplaceStatus.telemetry");
    if (item.uploadEnabled !== false || item.storage !== "local-aggregate-only") fail("marketplaceStatus.telemetry");
    const privacy = record(item.privacy, "marketplaceStatus.telemetry.privacy");
    exact(privacy, ["identifiers", "strategyInputs", "accounts", "pluginPrivateData"], [], "marketplaceStatus.telemetry.privacy");
    if (Object.values(privacy).some((entry) => entry !== false)) fail("marketplaceStatus.telemetry.privacy");
    const runtimeKinds = new Set([...MARKETPLACE_RUNTIME_KINDS, "mixed", "none"] as const);
    const operations = new Set([
      "refresh", "cache-reuse", "prepare", "apply", "activate", "observation", "rollback", "revocation-quarantine",
    ] as const);
    const outcomes = new Set(["success", "failure", "quarantined"] as const);
    const counters = array(item.counters, "marketplaceStatus.telemetry.counters", 10_000).map((raw, index) => {
      const counterPath = `marketplaceStatus.telemetry.counters[${index}]`;
      const counter = record(raw, counterPath);
      exact(counter, ["runtimeKind", "operation", "outcome", "count"], [], counterPath);
      return {
        runtimeKind: oneOf(counter.runtimeKind, runtimeKinds, `${counterPath}.runtimeKind`),
        operation: oneOf(counter.operation, operations, `${counterPath}.operation`),
        outcome: oneOf(counter.outcome, outcomes, `${counterPath}.outcome`),
        count: integer(counter.count, `${counterPath}.count`, 1),
      };
    });
    return {
      enabled: boolean(item.enabled, "marketplaceStatus.telemetry.enabled"),
      uploadEnabled: false as const,
      storage: "local-aggregate-only" as const,
      privacy: {
        identifiers: false as const,
        strategyInputs: false as const,
        accounts: false as const,
        pluginPrivateData: false as const,
      },
      counters,
    };
  })() : undefined;
  const quarantine = schemaV2 ? array(data.quarantine, "marketplaceStatus.quarantine", 10_000).map((raw, index) => {
    const itemPath = `marketplaceStatus.quarantine[${index}]`;
    const item = record(raw, itemPath);
    exact(item, [
      "schemaVersion",
      "pluginId",
      "version",
      "bundleSha256",
      "reason",
      "quarantinedAt",
      "artifactFile",
      "payloadMoved",
    ], [], itemPath);
    if (item.schemaVersion !== "candlescope.marketplace-quarantine/1") fail(`${itemPath}.schemaVersion`);
    const pluginId = string(item.pluginId, `${itemPath}.pluginId`, 128);
    if (!PLUGIN_ID.test(pluginId)) fail(`${itemPath}.pluginId`);
    return {
      schemaVersion: "candlescope.marketplace-quarantine/1" as const,
      pluginId,
      version: marketplaceVersion(item.version, `${itemPath}.version`),
      bundleSha256: digest(item.bundleSha256, `${itemPath}.bundleSha256`),
      reason: string(item.reason, `${itemPath}.reason`, 128),
      quarantinedAt: utcTimestamp(item.quarantinedAt, `${itemPath}.quarantinedAt`),
      artifactFile: item.artifactFile === null ? null : string(item.artifactFile, `${itemPath}.artifactFile`, 128),
      payloadMoved: boolean(item.payloadMoved, `${itemPath}.payloadMoved`),
    };
  }) : undefined;
  return {
    schemaVersion,
    enabled: boolean(data.enabled, "marketplaceStatus.enabled"),
    automaticUpdates: data.automaticUpdates === false ? false : fail("marketplaceStatus.automaticUpdates"),
    rootCount: integer(data.rootCount, "marketplaceStatus.rootCount", 0, 32),
    validCacheCount: integer(data.validCacheCount, "marketplaceStatus.validCacheCount", 0, 32),
    cacheErrors,
    candidates,
    updates,
    ...(rollout === undefined ? {} : { rollout }),
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(quarantine === undefined ? {} : { quarantine }),
  };
}

export function parsePluginManagementDetail(value: unknown): PluginManagementDetail {
  const data = record(value, "detail");
  exact(data, ["schemaVersion", "plugin", "permissions", "health", "update", "rollback", "paperTrading", "dataRetention"], ["trust"], "detail");
  if (data.schemaVersion !== "candlescope.plugin-management-detail/1") fail("detail.schemaVersion");
  const contributionIds = new Set<string>();
  const plugin = catalogPlugin(data.plugin, "detail.plugin", contributionIds);
  const permissions = array(data.permissions, "detail.permissions", 4).map((raw, index) => {
    const item = record(raw, `detail.permissions[${index}]`);
    exact(item, ["pluginId", "activationReady", "requiredSatisfied", "permissions"], [], `detail.permissions[${index}]`);
    const rawPermissions = array(item.permissions, `detail.permissions[${index}].permissions`, 128);
    return {
      pluginId: string(item.pluginId, `detail.permissions[${index}].pluginId`, 128),
      activationReady: boolean(item.activationReady, `detail.permissions[${index}].activationReady`),
      requiredSatisfied: boolean(item.requiredSatisfied, `detail.permissions[${index}].requiredSatisfied`),
      permissions: rawPermissions.map((rawPermission, permissionIndex) => {
        const permission = record(rawPermission, `detail.permissions[${index}].permissions[${permissionIndex}]`);
        exact(permission, ["permissionId", "kind", "decision", "requestedScope", "grantedScope"], [], `detail.permissions[${index}].permissions[${permissionIndex}]`);
        const requested = jsonValue(permission.requestedScope, "detail.permission.requestedScope");
        const granted = permission.grantedScope === null ? null : jsonValue(permission.grantedScope, "detail.permission.grantedScope");
        if (requested == null || typeof requested !== "object" || Array.isArray(requested) || (granted !== null && (typeof granted !== "object" || Array.isArray(granted)))) fail("detail.permissions");
        return {
          permissionId: string(permission.permissionId, "detail.permission.permissionId", 128),
          kind: oneOf(permission.kind, new Set(["required", "optional"] as const), "detail.permission.kind"),
          decision: oneOf(permission.decision, new Set(["pending", "granted", "denied", "revoked"] as const), "detail.permission.decision"),
          requestedScope: requested,
          grantedScope: granted,
        };
      }),
    };
  });
  if (permissions.some((item) => item.pluginId !== plugin.id)) fail("detail.permissions.pluginId");
  const health = record(data.health, "detail.health");
  const update = record(data.update, "detail.update");
  const rollback = record(data.rollback, "detail.rollback");
  const retention = record(data.dataRetention, "detail.dataRetention");
  exact(health, ["available", "entrypoints"], ["unavailableReason"], "detail.health");
  exact(rollback, ["available"], ["reason", "target"], "detail.rollback");
  exact(retention, ["retainedOnDisable", "retainedOnUninstall", "automaticDeletion", "storage"], [], "detail.dataRetention");
  const parsedUpdate = marketplaceUpdate(update, "detail.update");
  if (
    (parsedUpdate.candidate !== null && parsedUpdate.candidate.pluginId !== plugin.id)
    || (parsedUpdate.latest !== null && parsedUpdate.latest.pluginId !== plugin.id)
  ) fail("detail.update");
  const storage = jsonValue(retention.storage, "detail.dataRetention.storage");
  if (storage == null || typeof storage !== "object" || Array.isArray(storage)) fail("detail.dataRetention.storage");
  const target = rollback.target === undefined ? undefined : record(rollback.target, "detail.rollback.target");
  if (target !== undefined) exact(target, ["state", "version"], [], "detail.rollback.target");
  const rollbackAvailable = boolean(rollback.available, "detail.rollback.available");
  if (rollbackAvailable !== (target !== undefined) || (rollbackAvailable && rollback.reason !== undefined)) fail("detail.rollback");
  return {
    schemaVersion: "candlescope.plugin-management-detail/1",
    plugin,
    ...(data.trust === undefined ? {} : { trust: trustSummary(data.trust, "detail.trust") }),
    permissions,
    health: {
      available: boolean(health.available, "detail.health.available"),
      ...(health.unavailableReason == null ? {} : { unavailableReason: string(health.unavailableReason, "detail.health.unavailableReason", 128) }),
      entrypoints: array(health.entrypoints, "detail.health.entrypoints", 64).map((raw, index) => {
        const item = record(raw, `detail.health.entrypoints[${index}]`);
        exact(item, ["entrypointId", "state", "generation"], ["runtimeKind", "runtimeId", "artifactSha256", "runtimeSupply"], `detail.health.entrypoints[${index}]`);
        return {
          entrypointId: string(item.entrypointId, "detail.health.entrypointId", 128),
          state: string(item.state, "detail.health.state", 64),
          generation: integer(item.generation, "detail.health.generation"),
          ...(item.runtimeSupply === undefined ? {} : { runtimeSupply: runtimeSupply(item.runtimeSupply, `detail.health.entrypoints[${index}].runtimeSupply`) }),
        };
      }),
    },
    update: parsedUpdate,
    rollback: {
      available: rollbackAvailable,
      ...(rollback.reason === undefined ? {} : { reason: string(rollback.reason, "detail.rollback.reason", 128) }),
      ...(target === undefined ? {} : { target: { state: string(target.state, "detail.rollback.target.state", 64), version: target.version === null ? null : string(target.version, "detail.rollback.target.version", 64) } }),
    },
    paperTrading: paperStatus(data.paperTrading, "detail.paperTrading", true) as PluginPaperStatus & { available: boolean },
    dataRetention: {
      retainedOnDisable: retention.retainedOnDisable === true ? true : fail("detail.dataRetention.retainedOnDisable"),
      retainedOnUninstall: retention.retainedOnUninstall === true ? true : fail("detail.dataRetention.retainedOnUninstall"),
      automaticDeletion: retention.automaticDeletion === false ? false : fail("detail.dataRetention.automaticDeletion"),
      storage,
    },
  };
}
