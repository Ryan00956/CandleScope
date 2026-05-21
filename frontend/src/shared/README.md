# Shared Boundaries

`src/shared` contains reusable code with no CandleScope business owner. Shared
code should be boring, generic, and safe to reuse from any feature.

Put code here only when it does not naturally belong to chart session, market
data, indicators, drawings, watchlist, symbol search, settings, alerts, export,
or the chart adapter.

## Allowed Contents

- Generic UI primitives that do not know CandleScope domain concepts.
- Generic hooks that do not fetch CandleScope data or mutate feature state.
- Generic storage wrappers, serializers, parsers, and browser-safe utilities.
- Generic formatting helpers with no exchange, symbol, interval, indicator, or
  drawing ownership.
- Constants that are not product policy and do not encode backend capability
  rules.

## Allowed Dependencies

- Shared UI may import React and external UI-neutral libraries.
- Shared utilities may import browser APIs only through generic wrappers.
- Shared modules may import other shared modules.

## Forbidden Dependencies

- Do not import from `src/app`, `src/features`, `src/runtime`, or
  `src/components/app-shell`.
- Do not import backend clients from `src/services`.
- Do not create CandleScope API endpoints, WebSocket URLs, or request payloads.
- Do not own localStorage keys for symbols, drawings, indicators, watchlists,
  settings, or export options.
- Do not encode exchange-specific behavior or frontend fallbacks for backend
  capability metadata.
- Do not use this directory as a dumping ground for code that has an unclear
  feature owner.

## Promotion Rule

Start code inside the feature that owns the behavior. Move it to `src/shared`
only after at least two owners need the same generic helper and the helper can
be named without CandleScope business language.