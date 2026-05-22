# Feature Boundaries

`src/features` is the long-term home for CandleScope business capabilities.
A feature owns a vertical behavior such as chart session, market data,
indicators, drawings, watchlist, symbol search, settings, alerts, or export.

The purpose of a feature is to answer one question clearly: who owns this
behavior? Do not use this directory as another technical layer for unrelated
helpers.

## Standard Shape

Use the smallest structure that explains the feature. A mature feature usually
looks like this:

```text
feature-name/
  README.md
  useFeatureRuntime.js
  featureModel.js
  featureStore.js
  featureService.js
  FeaturePanel.jsx
```

Runtime hooks should expose a stable contract shaped like:

```js
{
  view: {},
  actions: {},
  status: {},
  events: {},
}
```

Only include `events` when another runtime needs to subscribe to feature-owned
events through the app composition root.

## Allowed Dependencies

- Feature UI may import its own feature view models, actions, and local UI
  components.
- Feature UI may import generic UI or helpers from `src/shared`.
- Feature runtime may import its own model, service, storage, and controllers.
- Feature runtime may consume another feature only through a stable view model
  or action object passed in by `App.jsx` or the app shell.
- Feature runtime may depend on the `src/chart-adapter` contract when it needs
  chart operations.
- Feature service or storage modules may import shared utilities and backend
  client functions that are still in `src/services` during migration.

## Forbidden Dependencies

- Do not import `src/App.jsx` or app shell internals from a feature.
- Do not import sibling feature internals; wire cross-feature collaboration in
  the app composition root.
- Do not let feature UI call `fetch`, create `WebSocket`, or access
  `localStorage` directly.
- Do not let feature service or storage modules import React or return JSX.
- Do not put Lightweight Charts raw refs, series instances, or primitives in a
  feature public contract; use `src/chart-adapter` instead.
- Do not put generic utilities here when no CandleScope business capability
  owns them; use `src/shared`.

## Migration Notes

Phase 11 removed the old `src/hooks` business entrypoints and folded feature-owned
`src/runtime` modules back into their owning features. Existing UI and service
code may still live in `src/components` or `src/services` during migration. New
feature work should move ownership one capability at a time according to the
architecture rebuild phases, keeping each phase independently lintable and
buildable.