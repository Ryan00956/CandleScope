# App Locale

`src/i18n` owns the host locale, message catalogs, and `t()` used by shell
chrome. It is app-wide infrastructure, not a business feature.

## Public Contract

- Default locale is `zh-CN`. Supported locales are `zh-CN` and `en`.
- Persistence lives in `features/settings` (`candlescope-settings.locale`).
- `hydrateLocale` / `setLocale` write `document.documentElement.lang` so plugin
  sandbox snapshots stay in sync.
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

## Plugin Boundary

- The Host translates plugin platform chrome, permission/risk copy, status,
  errors, dates, numbers, and locale selection.
- A plugin owns its contribution title, command/settings schema labels,
  declarative-view fields and empty state, and provider/account display names.
- The Host validates plugin `localizations`, selects exact locale then base
  language, and falls back to the manifest's default text. Plugin text never
  enters the Host message catalogs.
- Sandboxed plugin UIs receive the current locale through the existing UI
  bridge and own all content rendered inside their frame.
- The legacy v1 Pyne Monaco intelligence remains a Host compatibility adapter
  until a bounded editor-intelligence ABI exists. New plugins must not add
  plugin-domain completion text to the Host catalogs or depend on that adapter.
