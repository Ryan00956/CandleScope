# App Locale

`src/i18n` owns the host locale, message catalogs, and `t()` used by shell
chrome. It is app-wide infrastructure, not a business feature.

## Public Contract

- Default locale is `zh-CN`. Supported locales are `zh-CN`, `en`, and `ja`.
- `registry.ts` is the single registration point for catalogs, native labels,
  aliases and optional date/number format locales. `LocaleId`, the settings
  options, locale normalization and catalog checks are derived from it.
- Persistence lives in `features/settings` (`candlescope-settings.locale`).
- `hydrateLocale` / `setLocale` write `document.documentElement.lang` so plugin
  sandbox snapshots stay in sync, and apply the registered text direction.
- `bindDocumentLocale` also writes CSS custom properties used by `content:`
  fallbacks in `index.css`, so chrome that lives in stylesheets follows locale.
- Components call `useLocale()` from `useLocale.ts` plus `t(key)` from this
  folder. Non-React modules import `t()` from `index.ts` and must not import
  the React hook.

## Rules

- Do not import features, services, or app shell internals.
- Do not persist storage keys here.
- Do not translate identifiers: symbols, intervals, indicator tickers, plugin
  error codes, or exchange ids.
- Missing keys must surface as the key itself; do not silently mix catalogs.
- Use `getDateTimeLocale()` / `getNumberLocale()` when formatting localized
  dates and numbers. English retains its existing `en-GB` date and `en-US`
  number preferences. Other languages use their registered tag unless overridden.
- Market-price fixed precision, protocol timestamps, and compact numerical
  notation remain domain formatting; do not localize values used in calculations
  or interchange formats.

## Adding a Language

1. Add `catalogs/<locale>.ts`, exporting an object that `satisfies MessageCatalog`
   from `messageCatalog.ts`. Translate every reference key, including the manual
   history messages. Keep interpolation tokens such as `{count}` unchanged.
2. Import that catalog in `registry.ts` and add its BCP 47 locale tag,
   `nativeLabel`, and `messages`. Optional `aliases` handle alternative tags;
   optional `dateTimeLocale`, `numberLocale` and `direction` customize formatting.
   The picker, saved settings and runtime translation lookup need no changes.
3. `tPlural()` uses `Intl.PluralRules`. An unsuffixed key is the `other` form;
   existing `.one` keys define plural families. Add `.zero`, `.two`, `.few` or
   `.many` as required by the new language. These variants are local to the
   target catalog and need not be added to Chinese. The checker validates all
   required categories and compares every variant's placeholders with its base.
4. Run `npm run check:i18n`, `npm run typecheck` and the locale/UI tests. Check
   translated layouts, number/date presentation and switching in the app;
   right-to-left languages also need layout review beyond the `dir` attribute.
5. Add plugin-owned translations in each plugin's resources and manifest.
   Plugins may support a smaller language set than the Host.

Locale matching tries exact tags, then aliases and successively less specific
parents, case-insensitively. Unsupported or malformed stored locales use the
product default. `check:i18n` visits every registered catalog, checks required
keys and placeholders, and keeps English-specific checks scoped to English.

## Plugin Boundary

- The Host translates plugin platform chrome, permission/risk copy, status,
  errors, dates, numbers, and locale selection.
- A plugin owns its contribution title, command/settings schema labels,
  declarative-view fields and empty state, and provider/account display names.
- The Host validates plugin `localizations`, selects exact locale then parent
  language, and falls back to the manifest's default text. Plugin text never
  enters the Host message catalogs.
- Sandboxed plugin UIs receive the current locale through the existing UI
  bridge and own all content rendered inside their frame.
- The bundled Pyne sandbox and Market Scanner resolve their own registered
  resources and retain English defaults for unsupported Host languages.
- The legacy v1 Pyne Monaco intelligence remains a Host compatibility adapter
  until a bounded editor-intelligence ABI exists. New plugins must not add
  plugin-domain completion text to the Host catalogs or depend on that adapter.
  Its legacy Chinese/English documentation uses English for other Host languages.
