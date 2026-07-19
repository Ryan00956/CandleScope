# Trade Flow

This feature owns the append-only aggregate-trade stream, historical K-line
order-flow projection, tape/profile presentation, and large-trade marker source.

Performance boundaries:

- Every accepted trade is appended synchronously and in aggregate-trade ID
  order. UI notification is frame-coalesced; ingestion is never latest-only.
- Raw memory is bounded to 2,000 records. Tape rows and large-trade markers are
  separately capped, while profile rendering is rate-limited by its subscriber.
- High-frequency records stay in an external store. They do not update `App`,
  the shell view model, or the chart React tree.
- Large-trade markers attach through the chart-adapter contract and update their
  own Lightweight Charts plugin.
- Any delivery or aggregate-trade ID gap clears derived live output and exposes
  a fail-closed status until a fresh recent-to-live handoff succeeds.
