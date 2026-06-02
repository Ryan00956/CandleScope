# Settings Feature

`features/settings` owns chart appearance preferences, proxy settings, exchange registry display, cache limit sync, storage maintenance, and the current database tools surface.

## Public Contract

`useSettingsRuntime(props)` exposes:

```js
{
  view: {
    appearance,
    proxy,
    exchanges,
    cacheLimits,
    maintenance,
    database,
    actionTypes,
  },
  actions: {
    proxy,
    exchanges,
    cacheLimits,
    maintenance,
  },
  status: {},
}
```

`SettingsModal.jsx` is the lazy-loaded modal entry. It renders the modal chrome
and mounts feature-owned panel props from `useSettingsRuntime`.

## Internal Ownership

- `chartAppearanceSettings.js` owns local chart/theme settings storage and document theme application.
- `cacheLimitSettingsRuntime.js` owns backend cache-limit synchronization.
- `proxySettingsRuntime.js` owns proxy load, save, and test actions.
- `exchangeSettingsRuntime.js` owns supported exchange metadata loading for the settings panel.
- `maintenanceSettingsRuntime.js` owns storage repair, gap scan, and exchange refresh actions.
- `databaseSettingsRuntime.js` owns the current mock database tool action surface.
- `settingsActionTypes.js` records whether each settings action is `mock`, `local_only`, or a real `backend_endpoint`.

## Action Types

- `mock`: database inventory, scan, backfill, and delete actions currently use `src/services/databaseToolsApi` mock behavior.
- `local_only`: chart appearance preferences are stored locally and applied in the browser.
- `backend_endpoint`: proxy, exchange registry, storage maintenance, and cache limit sync actions call backend endpoints.

## Allowed Dependencies

- May call backend clients in `src/services/api` while services remain shared during migration.
- May use `src/utils/symbolKey` to derive maintenance scopes from watchlists.
- May receive current chart session and watchlist view data from `App.jsx` for scoped maintenance actions.

## Forbidden Dependencies

- Do not load chart candles, indicators, drawings, alerts, export options, or watchlist price streams here.
- Do not import App internals or sibling feature internals.
- Do not let settings UI call backend services directly; route actions through this feature runtime or feature service boundary.
- Do not present mock maintenance behavior as a real backend capability.

## Migration Notes

Phase 11 removed the old settings runtime compatibility wrappers. Settings
runtime imports should go directly through `features/settings` modules.