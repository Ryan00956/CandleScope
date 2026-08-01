import assert from "node:assert/strict";
import test from "node:test";

import { SeriesWindowStore } from "../../market-data/window/seriesWindowStore.js";
import {
  ReplayHistoryProvider,
  ReplayHistoryProtocolError,
  applyReplayHistoryPage,
  replayHistoryInitialBeforeMs,
  replayHistoryRevealRepairBeforeMs,
  replayHistoryStoreBeforeMs,
  replayHistoryViewportTransferNeedsLatestWindow,
  replayHistoryViewportTransferUnavailable,
  replayHistoryViewportBeforeMs,
} from "../replayHistoryProvider.js";
import type {
  ReplayHistoryIdentity,
  ReplayHistoryPage,
} from "../replayHistoryProvider.js";


const DATA_EPOCH = `sha256:${"a".repeat(64)}` as const;
const HISTORY_EPOCH = `sha256:${"b".repeat(64)}` as const;
const BOUNDARY_MS = 1_800_000_300_000;
const IDENTITY: ReplayHistoryIdentity = {
  exchange: "binance",
  market_type: "spot",
  symbol: "BTCUSDT",
  source_kind: "BAR",
  base_interval: "1m",
  display_interval: "1m",
};

function bar(openTimeMs: number, intervalMs = 60_000) {
  return {
    open_time_ms: openTimeMs,
    close_time_ms: openTimeMs + intervalMs - 1,
    open: "100",
    high: "102",
    low: "99",
    close: "101",
    volume: "10",
    quote_volume: "1000",
    trades: 5,
    taker_buy_base: "4",
    taker_buy_quote: "400",
    first_base_open_ms: openTimeMs,
    last_base_open_ms: openTimeMs,
    component_count: 1,
    expected_components: 1,
    is_closed: true,
    synthetic: false,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "replay.v2",
    schema_version: "replay.history.v3",
    run_id: "run-1",
    session_id: "adapter-1",
    track_id: "track-1",
    identity: IDENTITY,
    data_epoch: DATA_EPOCH,
    history_epoch: HISTORY_EPOCH,
    history_boundary_ms: 1_800_000_000_000,
    history_policy: {
      schema_version: "replay.data-policy.v1",
      indicator_warmup_bars: 200,
      visible_history_lookback: {
        mode: "DURATION",
        duration_ms: 300_000,
      },
      visible_history_rows: 5,
      effective_warmup_bars: 200,
      forward_cache_ms: 86_400_000,
      interval_ms: 60_000,
      policy_hash: `sha256:${"c".repeat(64)}`,
    },
    revealed_boundary_ms: BOUNDARY_MS,
    bars: [bar(1_800_000_120_000), bar(1_800_000_180_000)],
    excluded_ranges: [],
    next_before_ms: 1_800_000_120_000,
    has_more: true,
    ...overrides,
  };
}

function provider(fetcher: typeof fetch) {
  return new ReplayHistoryProvider({
    sessionId: "adapter-1",
    trackId: "track-1",
    identity: IDENTITY,
    fetcher,
  });
}

test("history provider deduplicates an in-flight before-page and stays on replay routes", async () => {
  const urls: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = provider(async (input) => {
    urls.push(String(input));
    await gate;
    return new Response(JSON.stringify(response()), { status: 200 });
  });
  const request = {
    beforeMs: BOUNDARY_MS,
    revealedBoundaryMs: BOUNDARY_MS,
    dataEpoch: DATA_EPOCH,
    limit: 250,
  } as const;

  const first = runtime.loadBefore(request);
  const duplicate = runtime.loadBefore(request);
  assert.equal(urls.length, 1);
  release();
  assert.deepEqual(await first, await duplicate);
  assert.equal(urls.length, 1);
  assert.match(urls[0] ?? "", /^\/api\/v1\/replay\/runs\/session\/adapter-1\/history\?/);
  assert.match(urls[0] ?? "", /display_interval=1m/);
  assert.doesNotMatch(urls[0] ?? "", /klines|market|order.?book|liquidation|indicator/i);
});

test("history parser rejects source, epoch, unknown-field, and lookahead drift", async () => {
  const cases = [
    response({ identity: { ...IDENTITY, symbol: "ETHUSDT" } }),
    response({ data_epoch: `sha256:${"c".repeat(64)}` }),
    response({ bars: [bar(BOUNDARY_MS + 1)] }),
    response({
      bars: [bar(1_800_000_120_000), bar(1_800_000_240_000)],
    }),
    { ...response(), future_field: true },
  ];
  for (const payload of cases) {
    const runtime = provider(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await assert.rejects(
      runtime.loadBefore({
        beforeMs: BOUNDARY_MS,
        revealedBoundaryMs: BOUNDARY_MS,
        dataEpoch: DATA_EPOCH,
        limit: 250,
      }),
      ReplayHistoryProtocolError,
    );
  }
});

test("declared exchange gaps remain empty while history continues before them", async () => {
  const payload = response({
    bars: [bar(1_800_000_120_000), bar(1_800_000_240_000)],
    excluded_ranges: [{
      start_ms: 1_800_000_180_000,
      end_ms: 1_800_000_239_999,
      reason: "source_gap",
      source_reason: "replay_archive_gap",
    }],
    next_before_ms: 1_800_000_120_000,
  });
  const runtime = provider(async () => new Response(JSON.stringify(payload), { status: 200 }));
  const page = await runtime.loadBefore({
    beforeMs: BOUNDARY_MS,
    revealedBoundaryMs: BOUNDARY_MS,
    dataEpoch: DATA_EPOCH,
    limit: 250,
  });
  const store = new SeriesWindowStore({ maxBars: 100 });
  store.replace([
    { time: 1_800_000_300, open: 103, high: 104, low: 102, close: 103.5, volume: 8 },
  ]);

  applyReplayHistoryPage(store, page, {
    expectedBeforeMs: BOUNDARY_MS,
    contextHistory: true,
  });

  assert.deepEqual(store.snapshot().map((row) => Number(row.time)), [
    1_800_000_120,
    1_800_000_240,
    1_800_000_300,
  ]);
  assert.equal(store.snapshot().some((row) => Number(row.time) === 1_800_000_180), false);
  assert.deepEqual(page.excluded_ranges, payload.excluded_ranges);
});

test("all-available policy may expose more rows than the execution warmup", async () => {
  const payload = response({
    history_policy: {
      schema_version: "replay.data-policy.v1",
      indicator_warmup_bars: 200,
      visible_history_lookback: {
        mode: "ALL_AVAILABLE",
        duration_ms: null,
      },
      visible_history_rows: 250_000,
      effective_warmup_bars: 200,
      forward_cache_ms: 86_400_000,
      interval_ms: 60_000,
      policy_hash: `sha256:${"d".repeat(64)}`,
    },
  });
  const runtime = provider(async () => new Response(JSON.stringify(payload), { status: 200 }));
  const page = await runtime.loadBefore({
    beforeMs: BOUNDARY_MS,
    revealedBoundaryMs: BOUNDARY_MS,
    dataEpoch: DATA_EPOCH,
    limit: 250,
  });
  assert.equal(page.history_policy.visible_history_rows, 250_000);
  assert.equal(page.history_policy.effective_warmup_bars, 200);
});

test("history application prepends once and preserves the authoritative replay tail", async () => {
  const runtime = provider(async () => new Response(JSON.stringify(response()), { status: 200 }));
  const page = await runtime.loadBefore({
    beforeMs: BOUNDARY_MS,
    revealedBoundaryMs: BOUNDARY_MS,
    dataEpoch: DATA_EPOCH,
    limit: 250,
  });
  const store = new SeriesWindowStore({ maxBars: 100 });
  store.replace([
    { time: 1_800_000_240, open: 103, high: 104, low: 102, close: 103.5, volume: 8 },
  ]);

  const expectedBeforeMs = replayHistoryStoreBeforeMs(store);
  assert.equal(expectedBeforeMs, 1_800_000_240_000);
  const first = applyReplayHistoryPage(store, page, {
    expectedBeforeMs: expectedBeforeMs!,
    contextHistory: true,
  });
  const duplicate = applyReplayHistoryPage(store, page, {
    contextHistory: true,
  });
  assert.equal(first.type, "prepend");
  assert.equal(duplicate.type, "noop");
  assert.deepEqual(store.snapshot().map((row) => Number(row.time)), [
    1_800_000_120,
    1_800_000_180,
    1_800_000_240,
  ]);
  assert.equal(store.last()?.close, 103.5);
  assert.equal(store.first()?.replayContextHistory, true);
  assert.equal(store.last()?.replayContextHistory, undefined);
});

test("initial display history starts at the replay seam instead of an incomplete warmup bucket", () => {
  assert.equal(
    replayHistoryInitialBeforeMs(946_684_800_000, "1h"),
    946_684_800_000,
  );
  assert.equal(
    replayHistoryInitialBeforeMs(946_684_860_000, "1h"),
    946_684_800_000,
  );
  assert.equal(replayHistoryInitialBeforeMs(null, "1h"), null);
  assert.equal(replayHistoryInitialBeforeMs(946_684_800_000, "invalid"), null);
});

test("viewport history targets the aligned bucket around an uncovered interval anchor", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 3_600 });
  store.replace([{
    time: 946_771_200,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    replayCloseTimeMs: 946_774_799_999,
    replayLastBaseOpenMs: 946_772_000_000,
    sourceFromTime: 946_771_200,
    sourceToTime: 946_772_000,
  }]);

  assert.equal(replayHistoryViewportBeforeMs(store, {
    anchorSourceTime: 946_684_800,
    displayInterval: "1h",
    revealedBoundaryMs: 946_800_000_000,
  }), 946_688_400_000);
  assert.equal(replayHistoryViewportBeforeMs(store, {
    anchorSourceTime: 946_772_000,
    displayInterval: "1h",
    revealedBoundaryMs: 946_800_000_000,
  }), null);
  assert.equal(replayHistoryViewportBeforeMs(store, {
    anchorSourceTime: 946_774_000,
    displayInterval: "1h",
    revealedBoundaryMs: 946_800_000_000,
  }), 946_774_800_000, "a forming bucket's nominal close is not revealed coverage");
  assert.equal(replayHistoryViewportBeforeMs(store, {
    anchorSourceTime: 946_900_000,
    displayInterval: "1h",
    revealedBoundaryMs: 946_800_000_000,
  }), null);
});

test("a targeted history page settles when a display-bucket gap still leaves no anchor coverage", () => {
  const start = 946_684_800;
  const store = new SeriesWindowStore({ intervalSeconds: 900 });
  store.replace([
    {
      time: start,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      sourceFromTime: start,
      sourceToTime: start + 5 * 60,
    },
    {
      time: start + 15 * 60,
      open: 101,
      high: 102,
      low: 100,
      close: 101,
      sourceFromTime: start + 15 * 60,
      sourceToTime: start + 20 * 60,
    },
  ]);
  const transfer = {
    anchorSourceTime: start + 7 * 60,
    anchorTime: start + 7 * 60,
    axisMode: "time",
    barSpacing: 6,
    datasetKey: "viewer:1m",
    logicalSpan: 100,
    screenOffset: 50,
    sourceRange: null,
    surfaceConfigKey: "time",
  } as const;

  assert.equal(
    replayHistoryViewportTransferUnavailable(store, transfer, (start + 15 * 60) * 1_000),
    true,
  );
  assert.equal(replayHistoryViewportTransferUnavailable(store, transfer, null), false);
});

test("a forming anchor restores latest from a reactivated right-truncated interval cache", () => {
  const start = 946_684_800;
  const store = new SeriesWindowStore({
    intervalSeconds: 900,
    maxBars: 2,
    seriesKey: "replay-base|viewer:15m",
  });
  store.replace([{
    time: start + 15 * 60,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    sourceFromTime: start + 15 * 60,
    sourceToTime: start + 17 * 60,
  }]);
  store.applyRange([
    {
      time: start - 15 * 60,
      open: 98,
      high: 99,
      low: 97,
      close: 98,
      sourceFromTime: start - 15 * 60,
      sourceToTime: start - 60,
    },
    {
      time: start,
      open: 99,
      high: 100,
      low: 98,
      close: 99,
      sourceFromTime: start,
      sourceToTime: start + 14 * 60,
    },
  ]);
  const transfer = {
    anchorSourceTime: start + 17 * 60,
    anchorTime: start + 17 * 60,
    axisMode: "time",
    barSpacing: 6,
    datasetKey: "replay-base|viewer:1m",
    logicalSpan: 100,
    screenOffset: 50,
    sourceRange: null,
    surfaceConfigKey: "time",
  } as const;

  assert.equal(store.rightTruncated, true);
  assert.equal(replayHistoryViewportTransferNeedsLatestWindow(store, transfer, {
    displayInterval: "15m",
    revealedBoundaryMs: (start + 17 * 60) * 1_000,
  }), true);
});

test("viewport history uses calendar boundaries for monthly display intervals", () => {
  const store = new SeriesWindowStore();
  const january = Date.UTC(2000, 0, 15) / 1_000;
  assert.equal(replayHistoryViewportBeforeMs(store, {
    anchorSourceTime: january,
    displayInterval: "1M",
    revealedBoundaryMs: Date.UTC(2000, 5, 1),
  }), Date.UTC(2000, 1, 1));
});

test("revealed history repair replaces an elapsed partial left bucket without reading the future", () => {
  const dayMs = 86_400_000;
  const replayStartMs = 946_684_800_000;
  const store = new SeriesWindowStore({ intervalSeconds: dayMs / 1_000 });
  store.replace([
    {
      ...bar(replayStartMs - dayMs, dayMs),
      time: (replayStartMs - dayMs) / 1_000,
      replayCloseTimeMs: replayStartMs - 1,
      replayClosed: true,
      replayContextHistory: true,
    },
    {
      ...bar(replayStartMs + 3 * dayMs, dayMs),
      time: (replayStartMs + 3 * dayMs) / 1_000,
      replayCloseTimeMs: replayStartMs + 4 * dayMs - 1,
      replayClosed: false,
    },
    {
      ...bar(replayStartMs + 4 * dayMs, dayMs),
      time: (replayStartMs + 4 * dayMs) / 1_000,
      replayCloseTimeMs: replayStartMs + 5 * dayMs - 1,
      replayClosed: true,
    },
  ]);

  assert.equal(
    replayHistoryRevealRepairBeforeMs(
      store,
      replayStartMs,
      replayStartMs + 5 * dayMs - 1,
      "1d",
    ),
    replayStartMs + 4 * dayMs,
  );

  const forming = new SeriesWindowStore({ intervalSeconds: dayMs / 1_000 });
  forming.replace([{
    ...bar(replayStartMs, dayMs),
    time: replayStartMs / 1_000,
    replayCloseTimeMs: replayStartMs + dayMs - 1,
    replayClosed: false,
  }]);
  assert.equal(
    replayHistoryRevealRepairBeforeMs(
      forming,
      replayStartMs,
      replayStartMs + 60_000,
      "1d",
    ),
    null,
  );
});

test("revealed history repair detects a missing replay prefix and stops after continuity is restored", () => {
  const hourMs = 3_600_000;
  const replayStartMs = 946_684_800_000;
  const store = new SeriesWindowStore({ intervalSeconds: hourMs / 1_000 });
  store.replace([
    {
      ...bar(replayStartMs - hourMs, hourMs),
      time: (replayStartMs - hourMs) / 1_000,
      replayCloseTimeMs: replayStartMs - 1,
      replayClosed: true,
      replayContextHistory: true,
    },
    {
      ...bar(replayStartMs + 2 * hourMs, hourMs),
      time: (replayStartMs + 2 * hourMs) / 1_000,
      replayCloseTimeMs: replayStartMs + 3 * hourMs - 1,
      replayClosed: true,
    },
  ]);
  assert.equal(
    replayHistoryRevealRepairBeforeMs(
      store,
      replayStartMs,
      replayStartMs + 3 * hourMs - 1,
      "1h",
    ),
    replayStartMs + 2 * hourMs,
  );

  store.applyRange([
    {
      ...bar(replayStartMs, hourMs),
      time: replayStartMs / 1_000,
      replayCloseTimeMs: replayStartMs + hourMs - 1,
      replayClosed: true,
      replayContextHistory: true,
    },
    {
      ...bar(replayStartMs + hourMs, hourMs),
      time: (replayStartMs + hourMs) / 1_000,
      replayCloseTimeMs: replayStartMs + 2 * hourMs - 1,
      replayClosed: true,
      replayContextHistory: true,
    },
  ]);
  assert.equal(
    replayHistoryRevealRepairBeforeMs(
      store,
      replayStartMs,
      replayStartMs + 3 * hourMs - 1,
      "1h",
    ),
    null,
  );
});

test("initial display page replaces an overlapping partial warmup bucket", async () => {
  const runtime = provider(async () => new Response(JSON.stringify(response()), { status: 200 }));
  const page = await runtime.loadBefore({
    beforeMs: 1_800_000_240_000,
    revealedBoundaryMs: BOUNDARY_MS,
    dataEpoch: DATA_EPOCH,
    limit: 250,
  });
  const store = new SeriesWindowStore({ maxBars: 100 });
  store.replace([
    {
      time: 1_800_000_180,
      open: 90,
      high: 91,
      low: 89,
      close: 90.5,
      volume: 1,
      replayClosed: false,
    },
    {
      time: 1_800_000_240,
      open: 103,
      high: 104,
      low: 102,
      close: 103.5,
      volume: 8,
      replayClosed: true,
    },
  ]);

  const delta = applyReplayHistoryPage(store, page, {
    expectedBeforeMs: 1_800_000_240_000,
    contextHistory: true,
  });
  assert.equal(delta.type, "mid-merge");
  assert.deepEqual(store.snapshot().map((row) => Number(row.time)), [
    1_800_000_120,
    1_800_000_180,
    1_800_000_240,
  ]);
  assert.equal(store.snapshot()[1]?.replayClosed, true);
  assert.equal(store.snapshot()[1]?.replayContextHistory, true);
  assert.equal(store.last()?.replayContextHistory, undefined);
});

test("history application rejects a page that skips the authoritative source cursor", async () => {
  const runtime = provider(async () => new Response(JSON.stringify(response()), { status: 200 }));
  const page = await runtime.loadBefore({
    beforeMs: BOUNDARY_MS,
    revealedBoundaryMs: BOUNDARY_MS,
    dataEpoch: DATA_EPOCH,
    limit: 250,
  });
  const store = new SeriesWindowStore({ maxBars: 100 });
  store.replace([
    { time: 1_800_000_300, open: 103, high: 104, low: 102, close: 103.5, volume: 8 },
  ]);
  const expectedBeforeMs = replayHistoryStoreBeforeMs(store);
  assert.equal(expectedBeforeMs, 1_800_000_300_000);

  assert.throws(
    () => applyReplayHistoryPage(store, page, {
      expectedBeforeMs: expectedBeforeMs!,
    }),
    /does not connect to the authoritative replay source window/,
  );
  assert.deepEqual(store.snapshot().map((row) => Number(row.time)), [
    1_800_000_300,
  ]);
});

test("display-owned cursor extends coarse history without mutating execution bars", () => {
  const hourMs = 3_600_000;
  const initialFirstMs = 946_670_400_000;
  const execution = new SeriesWindowStore({ maxBars: 10_000 });
  execution.replace(Array.from({ length: 658 }, (_, index) => ({
    time: (initialFirstMs + index * 60_000) / 1_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  })));
  const executionSnapshot = structuredClone(execution.snapshot());
  const viewer = new SeriesWindowStore({ maxBars: 10_000, intervalSeconds: 3_600 });
  viewer.replace(Array.from({ length: 3 }, (_, index) => ({
    time: (initialFirstMs + index * hourMs) / 1_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  })));

  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const beforeMs = replayHistoryStoreBeforeMs(viewer);
    assert.notEqual(beforeMs, null);
    const pageStartMs = beforeMs! - 500 * hourMs;
    const bars = Array.from(
      { length: 500 },
      (_, index) => bar(pageStartMs + index * hourMs, hourMs),
    );
    const page = response({
      identity: { ...IDENTITY, display_interval: "1h" },
      history_boundary_ms: initialFirstMs - 20_000 * hourMs,
      revealed_boundary_ms: initialFirstMs + 658 * 60_000,
      bars,
      next_before_ms: pageStartMs,
      has_more: true,
    }) as unknown as ReplayHistoryPage;
    applyReplayHistoryPage(viewer, page, {
      expectedBeforeMs: beforeMs!,
      contextHistory: true,
    });
  }

  assert.deepEqual(execution.snapshot(), executionSnapshot);
  const rows = viewer.snapshot();
  assert.equal(rows.length, 1_503);
  for (let index = 1; index < rows.length; index += 1) {
    assert.equal(
      Number(rows[index]?.time) - Number(rows[index - 1]?.time),
      3_600,
    );
  }
  assert.equal(rows[0]?.replayContextHistory, true);
  assert.equal(rows.at(-4)?.replayContextHistory, true);
  assert.equal(rows.at(-3)?.replayContextHistory, undefined);
});

test("cancel aborts the active history request and a later epoch starts cleanly", async () => {
  const captured: { signal: AbortSignal | null } = { signal: null };
  const runtime = provider(async (_input, init) => {
    captured.signal = init?.signal ?? null;
    return await new Promise<Response>((_resolve, reject) => {
      captured.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  const pending = runtime.loadBefore({
    beforeMs: BOUNDARY_MS,
    revealedBoundaryMs: BOUNDARY_MS,
    dataEpoch: DATA_EPOCH,
    limit: 250,
  });
  runtime.cancel();
  await assert.rejects(pending, /aborted/i);
  assert.equal(captured.signal?.aborted, true);
  assert.equal(runtime.historyEpoch, null);
});
