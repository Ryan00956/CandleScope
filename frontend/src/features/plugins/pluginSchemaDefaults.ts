import type { JsonValue, PluginJsonSchema } from "./pluginPlatformTypes.js";

export function defaultForPluginSchema(schema: PluginJsonSchema): JsonValue {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.[0] !== undefined) return schema.enum[0];
  if (schema.type === "object") {
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, defaultForPluginSchema(child)]));
  }
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return schema.minimum ?? 0;
  if (schema.type === "string") return "";
  return null;
}
