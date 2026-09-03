export interface LocaleRegistration<Id extends string = string> {
  readonly id: Id;
  readonly aliases?: readonly string[];
}

/** Match the most specific registered tag before trying its parents or aliases. */
export function resolveLocale<Id extends string>(
  value: unknown,
  registrations: readonly LocaleRegistration<Id>[],
): Id | undefined {
  if (typeof value !== "string") return undefined;
  let candidate: string;
  try {
    candidate = new Intl.Locale(value.trim()).baseName.toLowerCase();
  } catch {
    return undefined;
  }
  while (candidate) {
    const exact = registrations.find(({ id }) => id.toLowerCase() === candidate);
    if (exact) return exact.id;
    const alias = registrations.find(({ aliases }) => (
      aliases?.some((entry) => entry.toLowerCase() === candidate)
    ));
    if (alias) return alias.id;
    const separator = candidate.lastIndexOf("-");
    candidate = separator < 0 ? "" : candidate.slice(0, separator);
  }
  return undefined;
}
