import { t, type LocaleId } from "../../i18n/index.js";
import type { JsonValue, PluginJsonSchema } from "./pluginPlatformTypes.js";
import { defaultForPluginSchema } from "./pluginSchemaDefaults.js";

function displayLabel(name: string, schema: PluginJsonSchema): string {
  return schema.title ?? name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function PluginNativeField({
  name,
  schema,
  value,
  onChange,
  locale,
}: {
  name: string;
  schema: PluginJsonSchema;
  value: JsonValue | undefined;
  onChange(value: JsonValue): void;
  locale: LocaleId;
}) {
  const label = displayLabel(name, schema);
  if (schema.type === "object") {
    const current = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return (
      <fieldset className="plugin-native-group">
        {name !== "root" && <legend>{label}</legend>}
        {schema.description && <p>{schema.description}</p>}
        {Object.entries(schema.properties ?? {}).map(([key, child]) => (
          <PluginNativeField
            key={key}
            name={key}
            schema={child}
            value={current[key]}
            locale={locale}
            onChange={(next) => onChange({ ...current, [key]: next })}
          />
        ))}
      </fieldset>
    );
  }
  if (schema.type === "array") {
    const current = Array.isArray(value) ? value : [];
    return (
      <div className="plugin-native-field">
        <span>{label}</span>
        {schema.description && <small>{schema.description}</small>}
        <div className="plugin-native-array">
          {current.map((item, index) => (
            <div className="plugin-native-array-row" key={`${name}-${index}`}>
              <PluginNativeField
                name={`${label} ${index + 1}`}
                schema={schema.items!}
                value={item}
                locale={locale}
                onChange={(next) => onChange(current.map((entry, entryIndex) => entryIndex === index ? next : entry))}
              />
              <button
                type="button"
                disabled={current.length <= (schema.minItems ?? 0)}
                onClick={() => onChange(current.filter((_, entryIndex) => entryIndex !== index))}
              >
                {t("plugin.host.removeItem", {}, locale)}
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={current.length >= (schema.maxItems ?? 256)}
            onClick={() => onChange([...current, defaultForPluginSchema(schema.items!)])}
          >
            {t("plugin.host.addItem", {}, locale)}
          </button>
        </div>
      </div>
    );
  }
  if (schema.type === "boolean") {
    return (
      <label className="plugin-native-field plugin-native-checkbox">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>{label}</span>
        {schema.description && <small>{schema.description}</small>}
      </label>
    );
  }
  if (schema.enum) {
    return (
      <label className="plugin-native-field">
        <span>{label}</span>
        {schema.description && <small>{schema.description}</small>}
        <select
          value={JSON.stringify(value ?? schema.enum[0])}
          onChange={(event) => {
            const selected = schema.enum?.find((item) => JSON.stringify(item) === event.target.value);
            if (selected !== undefined) onChange(selected);
          }}
        >
          {schema.enum.map((item, index) => (
            <option key={JSON.stringify(item)} value={JSON.stringify(item)}>
              {schema.enumLabels?.[index] ?? String(item)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (schema.type === "number" || schema.type === "integer") {
    return (
      <label className="plugin-native-field">
        <span>{label}</span>
        {schema.description && <small>{schema.description}</small>}
        <input
          type="number"
          value={typeof value === "number" ? value : Number(defaultForPluginSchema(schema))}
          min={schema.minimum}
          max={schema.maximum}
          step={schema.type === "integer" ? 1 : "any"}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            if (Number.isFinite(next)) onChange(schema.type === "integer" ? Math.trunc(next) : next);
          }}
        />
      </label>
    );
  }
  if (schema.type === "null") return <div className="plugin-native-field"><span>{label}</span><code>null</code></div>;
  return (
    <label className="plugin-native-field">
      <span>{label}</span>
      {schema.description && <small>{schema.description}</small>}
      <input
        type="text"
        value={typeof value === "string" ? value : ""}
        minLength={schema.minLength}
        maxLength={schema.maxLength}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
