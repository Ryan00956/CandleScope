import type {
  JsonScalar,
  JsonValue,
  PluginCatalog,
  PluginCatalogPlugin,
  PluginChartLayer,
  PluginCommandContribution,
  PluginFieldFormat,
  PluginJsonSchema,
  PluginManagementDetail,
  PluginPlacement,
  PluginSettingsContribution,
  PluginUiContribution,
  PluginUiSnapshot,
  PluginViewContribution,
  PluginViewProjection,
  PluginViewRenderer,
  PluginViewSlot,
} from "./pluginPlatformTypes.js";

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const LOCAL_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const COLOR = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/;
const PLACEMENTS = new Set<PluginPlacement>(["commandPalette", "topToolbar", "chartContextMenu"]);
const VIEW_SLOTS = new Set<PluginViewSlot>(["sidePanel", "bottomPanel", "statusArea"]);
const VIEW_RENDERERS = new Set<PluginViewRenderer>(["table", "list", "detail", "status"]);
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

function contribution(value: unknown, path: string, pluginId: string): PluginUiContribution | null {
  const data = record(value, path);
  const kind = string(data.kind, `${path}.kind`, 64);
  if (!["command/1", "settings/1", "view/1"].includes(kind)) return null;
  exact(data, ["id", "localId", "kind", "title", "entrypointId", "configuration", "available"], ["unavailableReason"], path);
  const base = contributionBase(data, path, pluginId);
  const config = record(data.configuration, `${path}.configuration`);
  if (kind === "command/1") {
    exact(config, ["placements"], ["requiresUserAction", "inputSchema"], `${path}.configuration`);
    const placements = array(config.placements, `${path}.configuration.placements`, 3).map((item, index) => oneOf(item, PLACEMENTS, `${path}.configuration.placements[${index}]`));
    if (!placements.length || new Set(placements).size !== placements.length) fail(`${path}.configuration.placements`);
    return {
      ...base,
      kind: "command/1",
      configuration: {
        placements,
        ...(config.requiresUserAction === undefined ? {} : { requiresUserAction: boolean(config.requiresUserAction, `${path}.configuration.requiresUserAction`) }),
        ...(config.inputSchema === undefined ? {} : { inputSchema: schema(config.inputSchema, `${path}.configuration.inputSchema`) }),
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

function catalogPlugin(value: unknown, path: string, contributionIds: Set<string>): PluginCatalogPlugin {
  const data = record(value, path);
  exact(data, ["id", "name", "version", "publisher", "state", "enabled", "trustLevel", "available", "permissions", "contributions", "runtime"], ["unavailableReason"], path);
  const pluginId = string(data.id, `${path}.id`, 128);
  if (!PLUGIN_ID.test(pluginId)) fail(`${path}.id`);
  const permissions = record(data.permissions, `${path}.permissions`);
  exact(permissions, ["activationReady", "requiredSatisfied", "permissions", "requiredPermissionIds"], [], `${path}.permissions`);
  const runtime = record(data.runtime, `${path}.runtime`);
  exact(runtime, ["entrypoints"], [], `${path}.runtime`);
  const parsedContributions: PluginUiContribution[] = [];
  for (const [index, raw] of array(data.contributions, `${path}.contributions`, 256).entries()) {
    const rawData = record(raw, `${path}.contributions[${index}]`);
    const contributionId = string(rawData.id, `${path}.contributions[${index}].id`, 256);
    if (contributionIds.has(contributionId)) fail(`${path}.contributions[${index}].id`);
    contributionIds.add(contributionId);
    const parsed = contribution(raw, `${path}.contributions[${index}]`, pluginId);
    if (parsed) parsedContributions.push(parsed);
  }
  const commandIds = new Set(parsedContributions.filter((item) => item.kind === "command/1").map((item) => item.localId));
  if (parsedContributions.some((item) => item.kind === "view/1" && item.configuration.primaryCommand !== undefined && !commandIds.has(item.configuration.primaryCommand))) {
    fail(`${path}.contributions`);
  }
  return {
    id: pluginId,
    name: string(data.name, `${path}.name`, 128),
    version: string(data.version, `${path}.version`, 64),
    publisher: string(data.publisher, `${path}.publisher`, 128),
    state: oneOf(data.state, new Set(["active", "disabled", "staged"] as const), `${path}.state`),
    enabled: boolean(data.enabled, `${path}.enabled`),
    trustLevel: oneOf(data.trustLevel, new Set(["first-party-pinned", "local-trusted", "untrusted"] as const), `${path}.trustLevel`),
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
        exact(item, ["entrypointId", "state", "generation"], [], `${path}.runtime.entrypoints[${index}]`);
        return {
          entrypointId: string(item.entrypointId, `${path}.runtime.entrypoints[${index}].entrypointId`, 128),
          state: string(item.state, `${path}.runtime.entrypoints[${index}].state`, 64),
          generation: integer(item.generation, `${path}.runtime.entrypoints[${index}].generation`),
        };
      }),
    },
  };
}

export function parsePluginCatalog(value: unknown): PluginCatalog {
  if (JSON.stringify(value).length > 2 * 1024 * 1024) fail("catalog");
  const data = record(value, "catalog");
  exact(data, ["schemaVersion", "platform", "plugins"], [], "catalog");
  if (data.schemaVersion !== "candlescope.plugin-catalog/1") fail("catalog.schemaVersion");
  const platform = record(data.platform, "catalog.platform");
  exact(platform, ["enabled", "started", "status", "registryRevision"], [], "catalog.platform");
  const contributionIds = new Set<string>();
  const plugins = array(data.plugins, "catalog.plugins", 256).map((item, index) => catalogPlugin(item, `catalog.plugins[${index}]`, contributionIds));
  if (new Set(plugins.map((item) => item.id)).size !== plugins.length) fail("catalog.plugins");
  return {
    schemaVersion: "candlescope.plugin-catalog/1",
    platform: {
      enabled: boolean(platform.enabled, "catalog.platform.enabled"),
      started: boolean(platform.started, "catalog.platform.started"),
      status: oneOf(platform.status, new Set(["disabled", "ok", "degraded"] as const), "catalog.platform.status"),
      registryRevision: integer(platform.registryRevision, "catalog.platform.registryRevision"),
    },
    plugins,
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
  exact(data, ["id", "pluginId", "generation", "revision", "context", "series", "itemCount", "schemaVersion", "render"], [], path);
  const context = record(data.context, `${path}.context`);
  const series = record(data.series, `${path}.series`);
  const render = record(data.render, `${path}.render`);
  exact(context, ["mode", "exchange", "marketType"], [], `${path}.context`);
  exact(series, ["symbol", "interval"], [], `${path}.series`);
  exact(render, ["schemaVersion", "items"], [], `${path}.render`);
  if (context.mode !== "live" || render.schemaVersion !== "candlescope.render/1" || data.schemaVersion !== "candlescope.render/1") fail(path);
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
    id: string(data.id, `${path}.id`, 256),
    pluginId: string(data.pluginId, `${path}.pluginId`, 128),
    generation: integer(data.generation, `${path}.generation`, 1),
    revision: integer(data.revision, `${path}.revision`, 1),
    context: { mode: "live", exchange: string(context.exchange, `${path}.context.exchange`, 64), marketType: string(context.marketType, `${path}.context.marketType`, 64) },
    series: { symbol: string(series.symbol, `${path}.series.symbol`, 64), interval: string(series.interval, `${path}.series.interval`, 64) },
    render: { schemaVersion: "candlescope.render/1", items },
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

export function parsePluginManagementDetail(value: unknown): PluginManagementDetail {
  const data = record(value, "detail");
  exact(data, ["schemaVersion", "plugin", "permissions", "health", "update", "rollback", "dataRetention"], [], "detail");
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
  exact(update, ["policy", "automatic", "available"], [], "detail.update");
  exact(rollback, ["available"], ["reason", "target"], "detail.rollback");
  exact(retention, ["retainedOnDisable", "retainedOnUninstall", "automaticDeletion", "storage"], [], "detail.dataRetention");
  const storage = jsonValue(retention.storage, "detail.dataRetention.storage");
  if (storage == null || typeof storage !== "object" || Array.isArray(storage)) fail("detail.dataRetention.storage");
  const target = rollback.target === undefined ? undefined : record(rollback.target, "detail.rollback.target");
  if (target !== undefined) exact(target, ["state", "version"], [], "detail.rollback.target");
  const rollbackAvailable = boolean(rollback.available, "detail.rollback.available");
  if (rollbackAvailable !== (target !== undefined) || (rollbackAvailable && rollback.reason !== undefined)) fail("detail.rollback");
  return {
    schemaVersion: "candlescope.plugin-management-detail/1",
    plugin,
    permissions,
    health: {
      available: boolean(health.available, "detail.health.available"),
      ...(health.unavailableReason == null ? {} : { unavailableReason: string(health.unavailableReason, "detail.health.unavailableReason", 128) }),
      entrypoints: array(health.entrypoints, "detail.health.entrypoints", 64).map((raw, index) => {
        const item = record(raw, `detail.health.entrypoints[${index}]`);
        exact(item, ["entrypointId", "state", "generation"], [], `detail.health.entrypoints[${index}]`);
        return { entrypointId: string(item.entrypointId, "detail.health.entrypointId", 128), state: string(item.state, "detail.health.state", 64), generation: integer(item.generation, "detail.health.generation") };
      }),
    },
    update: {
      policy: update.policy === "local-artifact-only" ? "local-artifact-only" : fail("detail.update.policy"),
      automatic: update.automatic === false ? false : fail("detail.update.automatic"),
      available: update.available === false ? false : fail("detail.update.available"),
    },
    rollback: {
      available: rollbackAvailable,
      ...(rollback.reason === undefined ? {} : { reason: string(rollback.reason, "detail.rollback.reason", 128) }),
      ...(target === undefined ? {} : { target: { state: string(target.state, "detail.rollback.target.state", 64), version: target.version === null ? null : string(target.version, "detail.rollback.target.version", 64) } }),
    },
    dataRetention: {
      retainedOnDisable: retention.retainedOnDisable === true ? true : fail("detail.dataRetention.retainedOnDisable"),
      retainedOnUninstall: retention.retainedOnUninstall === true ? true : fail("detail.dataRetention.retainedOnUninstall"),
      automaticDeletion: retention.automaticDeletion === false ? false : fail("detail.dataRetention.automaticDeletion"),
      storage,
    },
  };
}
