import { resolveLocale, type LocaleId } from "../../i18n/index.js";
import type {
  PluginCatalogContribution,
  PluginContributionLocalization,
  PluginJsonSchema,
  PluginSchemaLocalization,
} from "./pluginPlatformTypes.js";

function selectLocalization(
  localizations: Record<string, PluginContributionLocalization> | undefined,
  locale: LocaleId,
): PluginContributionLocalization | null {
  if (!localizations) return null;
  const selected = resolveLocale(locale, Object.keys(localizations).map((id) => ({ id })));
  return selected ? localizations[selected] ?? null : null;
}

function localizeSchema(
  schema: PluginJsonSchema,
  localized: PluginSchemaLocalization | undefined,
): PluginJsonSchema {
  if (!localized) return schema;
  const properties = schema.properties && localized.properties
    ? Object.fromEntries(Object.entries(schema.properties).map(([name, property]) => [
      name,
      localizeSchema(property, localized.properties?.[name]),
    ]))
    : schema.properties;
  const items = schema.items && localized.items
    ? localizeSchema(schema.items, localized.items)
    : schema.items;
  return {
    ...schema,
    ...(localized.title === undefined ? {} : { title: localized.title }),
    ...(localized.description === undefined ? {} : { description: localized.description }),
    ...(localized.enumLabels === undefined ? {} : { enumLabels: localized.enumLabels }),
    ...(properties === undefined ? {} : { properties }),
    ...(items === undefined ? {} : { items }),
  };
}

export function localizePluginContribution(
  contribution: PluginCatalogContribution,
  locale: LocaleId,
): PluginCatalogContribution {
  const localized = selectLocalization(contribution.localizations, locale);
  if (!localized) return contribution;
  const title = localized.title ?? contribution.title;
  if (contribution.kind === "command/1") {
    return {
      ...contribution,
      title,
      configuration: {
        ...contribution.configuration,
        ...(contribution.configuration.inputSchema && localized.schema
          ? { inputSchema: localizeSchema(contribution.configuration.inputSchema, localized.schema) }
          : {}),
      },
    };
  }
  if (contribution.kind === "settings/1") {
    return {
      ...contribution,
      title,
      configuration: {
        ...contribution.configuration,
        schema: localizeSchema(contribution.configuration.schema, localized.schema),
      },
    };
  }
  if (contribution.kind === "view/1") {
    if (contribution.configuration.renderer === "sandbox") return { ...contribution, title };
    return {
      ...contribution,
      title,
      configuration: {
        ...contribution.configuration,
        fields: contribution.configuration.fields.map((field) => ({
          ...field,
          label: localized.fields?.[field.field] ?? field.label,
        })),
        emptyState: localized.emptyState ?? contribution.configuration.emptyState,
      },
    };
  }
  if (contribution.kind === "symbol-provider/1") {
    return {
      ...contribution,
      title,
      configuration: {
        ...contribution.configuration,
        displayName: localized.displayName ?? contribution.configuration.displayName,
        marketTypes: contribution.configuration.marketTypes.map((market) => ({
          ...market,
          label: localized.marketTypes?.[market.id] ?? market.label,
        })),
      },
    };
  }
  if (contribution.kind === "account-provider/1") {
    return {
      ...contribution,
      title,
      configuration: {
        ...contribution.configuration,
        accounts: contribution.configuration.accounts.map((account) => ({
          ...account,
          label: localized.accounts?.[account.id] ?? account.label,
        })),
      },
    };
  }
  return { ...contribution, title };
}
