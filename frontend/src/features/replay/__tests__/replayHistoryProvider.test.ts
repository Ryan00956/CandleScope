import assert from "node:assert/strict";
import test from "node:test";

import { SeriesWindowStore } from "../../market-data/window/seriesWindowStore.js";
import {
  ReplayHistoryProvider,
  ReplayHistoryProtocolError,
  applyReplayHistoryPage,
} from "../replayHistoryProvider.js";
import type { ReplayHistoryIdentity } from "../replayHistoryProvider.js";


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

function bar(openTimeMs: number) {
  return {
    open_time_ms: openTimeMs,
    close_time_ms: openTimeMs + 59_999,
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
    schema_version: "replay.history.v2",
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
  assert.doesNotMatch(urls[0] ?? "", /klines|market|order.?book|liquidation|indicator/i);
});

test("history parser rejects source, epoch, unknown-field, and lookahead drift", async () => {
  const cases = [
    response({ identity: { ...IDENTITY, symbol: "ETHUSDT" } }),
    response({ data_epoch: `sha256:${"c".repeat(64)}` }),
    response({ bars: [bar(BOUNDARY_MS + 1)] }),
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

  const first = applyReplayHistoryPage(store, page);
  const duplicate = applyReplayHistoryPage(store, page);
  assert.equal(first.type, "prepend");
  assert.equal(duplicate.type, "noop");
  assert.deepEqual(store.snapshot().map((row) => Number(row.time)), [
    1_800_000_120,
    1_800_000_180,
    1_800_000_240,
  ]);
  assert.equal(store.last()?.close, 103.5);
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
