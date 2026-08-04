import assert from "node:assert/strict";
import test from "node:test";

import { ReplayV2ApiClient } from "../replayV2Api.js";
import {
  parseReplayOrderPreview,
  parseReplayV2CommandResult,
  parseReplayViewerStateResponse,
} from "../replayV2Types.js";
import type { ReplayOrderPreviewRequest, ReplayV2Command } from "../replayV2Types.js";


function viewerState() {
  return {
    run_id: "run-1",
    selected_track_id: "track-1",
    display_interval: "15m",
    chart_type: "candles",
    visible_range: null,
    pane_layout: {},
    rail_layout: {},
    semantic_view_revision: 2,
  };
}

function commandResult() {
  return {
    protocol: "replay.v2",
    run_id: "run-1",
    session_id: "adapter-1",
    command_id: "step-display-1",
    revision: 7,
    sequence: 9,
    state: "PAUSED",
    state_hash: `sha256:${"a".repeat(64)}`,
    cursor: {
      virtual_time_ms: 1_710_000_899_999,
      source_sequence: 15,
      last_base_bar_open_ms: 1_710_000_840_000,
      last_trade_time_ms: null,
      last_agg_trade_id: null,
      at_end: false,
    },
    viewer_state: viewerState(),
    data: { consumed: 14, plan: { grain: "DISPLAY" } },
  };
}

function orderPreview() {
  return {
    protocol: "replay.v2",
    schema_version: "replay.order-preview.v1",
    run_id: "run-1",
    track_id: "track-1",
    accepted: true,
    position_intent: "OPEN",
    revision: 6,
    cursor: {
      virtual_time_ms: 1_710_000_059_999,
      source_sequence: 1,
      revision: 6,
    },
    state_hash: `sha256:${"b".repeat(64)}`,
    execution_fidelity: "BAR_CONSERVATIVE",
    order: {
      client_order_id: "ticket-1",
      side: "BUY",
      order_type: "MARKET",
      quantity: "1",
      reduce_only: false,
      limit_price: null,
      stop_price: null,
    },
    reference_price: "100",
    estimated_fill_price: "100.1",
    estimated_notional: "100.1",
    reserved_margin: "20",
    estimated_fee: "0.04004",
    fee_basis: "TAKER_WORST_CASE",
    available_equity_after: "9980",
    max_quantity: "10",
    quote_asset: "USDT",
    max_leverage: "5",
  };
}

test("Phase 3 viewer and command response parsers are strict at the network boundary", () => {
  const viewer = parseReplayViewerStateResponse({
    protocol: "replay.v2",
    viewer_state: viewerState(),
  });
  assert.equal(viewer.viewer_state.display_interval, "15m");
  assert.equal(parseReplayV2CommandResult(commandResult()).data.consumed, 14);

  assert.throws(() => parseReplayViewerStateResponse({
    protocol: "replay.v2",
    viewer_state: { ...viewerState(), domain_hash: "forbidden" },
  }), /unknown/);
  assert.throws(() => parseReplayV2CommandResult({
    ...commandResult(),
    cursor: { ...commandResult().cursor, revision: 7 },
  }), /unknown/);
});

test("order preview parser preserves exact Decimal strings and rejects drift", () => {
  const parsed = parseReplayOrderPreview(orderPreview());
  assert.equal(parsed.estimated_fee, "0.04004");
  assert.equal(parsed.position_intent, "OPEN");
  assert.throws(() => parseReplayOrderPreview({
    ...orderPreview(),
    estimated_fee: 0.04004,
  }), /canonical Decimal string/);
  assert.throws(() => parseReplayOrderPreview({
    ...orderPreview(),
    cursor: { ...orderPreview().cursor, revision: 7 },
  }), /revision is inconsistent/);
});

test("order preview API is run-scoped and sends the cursor-bound intent", async () => {
  const requests: Array<{ url: string; body: string | null }> = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input, init) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : null,
      });
      return new Response(JSON.stringify(orderPreview()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const payload: ReplayOrderPreviewRequest = {
    protocol: "replay.v2" as const,
    expected_revision: 6,
    expected_cursor: orderPreview().cursor,
    position_intent: "OPEN" as const,
    order: {
      ...orderPreview().order,
      side: "BUY",
      order_type: "MARKET",
    },
  };

  const result = await client.previewOrder("run-1", payload);

  assert.equal(result.max_quantity, "10");
  assert.deepEqual(requests, [{
    url: "/api/v1/replay/runs/run-1/order-preview",
    body: JSON.stringify(payload),
  }]);
});

test("Phase 3 API uses run-scoped viewer, command, and progress routes", async () => {
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      let payload: unknown;
      if (url.endsWith("/viewer")) {
        payload = { protocol: "replay.v2", viewer_state: viewerState() };
      } else if (url.endsWith("/commands")) {
        payload = commandResult();
      } else {
        payload = {
          protocol: "replay.v2",
          run_id: "run-1",
          command_id: "step-display-1",
          progress: {
            status: "RUNNING",
            current_virtual_time_ms: 1_710_000_300_000,
            target_virtual_time_ms: 1_710_000_899_999,
            ratio_ppm: 333_333,
            consumed: 5,
            chunks: 1,
            cancelable: true,
          },
        };
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const command: ReplayV2Command = {
    protocol: "replay.v2",
    run_id: "run-1",
    command_id: "step-display-1",
    client_instance_id: "browser-1",
    expected_revision: 6,
    expected_cursor: {
      virtual_time_ms: 1_710_000_059_999,
      source_sequence: 1,
      revision: 6,
    },
    type: "step_display",
    payload: { count: 1, display_interval: "15m", viewer_revision: 2 },
  };

  await client.viewerBySession("adapter-1");
  await client.commandRun("run-1", command);
  const progress = await client.advanceProgress("run-1", "step-display-1");
  assert.equal(progress.progress.ratio_ppm, 333_333);
  assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
    { url: "/api/v1/replay/runs/session/adapter-1/viewer", method: "GET" },
    { url: "/api/v1/replay/runs/run-1/commands", method: "POST" },
    { url: "/api/v1/replay/runs/run-1/advances/step-display-1", method: "GET" },
  ]);
  assert.deepEqual(JSON.parse(requests[1]?.body ?? "null"), command);
});
