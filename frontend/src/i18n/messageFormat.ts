export type MessageVariables = Readonly<Record<string, string | number>>;
type Catalog = Readonly<Record<string, string | undefined>>;
const TOKEN = /\{([A-Za-z0-9_]+)\}/g;
const pluralRules = new Map<string, Intl.PluralRules>();

export function formatCatalogMessage(catalog: Catalog, key: string, vars?: MessageVariables): string {
  const template = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] ?? key : key;
  if (!vars) return template;
  return template.replace(TOKEN, (match, name: string) => {
    const value = vars[name];
    return value == null ? match : String(value);
  });
}

export function formatCatalogPlural(
  catalog: Catalog,
  locale: string,
  key: string,
  count: number,
  vars?: MessageVariables,
): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  const categoryKey = `${key}.${rules.select(count)}`;
  const otherKey = `${key}.other`;
  const selected = Object.prototype.hasOwnProperty.call(catalog, categoryKey)
    ? categoryKey
    : Object.prototype.hasOwnProperty.call(catalog, otherKey) ? otherKey : key;
  return formatCatalogMessage(catalog, selected, { ...vars, count });
}
