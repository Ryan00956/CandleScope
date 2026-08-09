import assert from "node:assert/strict";
import test from "node:test";

import { ReplayV2ApiClient, ReplayV2ApiError } from "../replayV2Api.js";
import {
  parseReplayOrderCapacity,
  parseReplayOrderPreview,
  parseReplayV2CommandResult,
  parseReplayViewerStateResponse,
} from "../replayV2Types.js";
import type {
  ReplayOrderCapacityRequest,
  ReplayOrderPreviewRequest,
  ReplayV2Command,
} from "../replayV2Types.js";


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
    protocol: "replay.v3",
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
    protocol: "replay.v3",
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

function orderCapacity() {
  const preview = orderPreview();
  return {
    protocol: "replay.v3",
    schema_version: "replay.order-capacity.v1",
    run_id: preview.run_id,
    track_id: preview.track_id,
    position_intent: preview.position_intent,
    revision: preview.revision,
    cursor: preview.cursor,
    state_hash: preview.state_hash,
    execution_fidelity: preview.execution_fidelity,
    context: {
      side: "BUY",
      order_type: "MARKET",
      reduce_only: false,
      limit_price: null,
      stop_price: null,
      leverage: "5",
    },
    reference_price: "100",
    max_quantity: "10",
    quote_asset: "USDT",
    max_leverage: "5",
  };
}

test("Phase 3 viewer and command response parsers are strict at the network boundary", () => {
  const viewer = parseReplayViewerStateResponse({
    protocol: "replay.v3",
    viewer_state: viewerState(),
  });
  assert.equal(viewer.viewer_state.display_interval, "15m");
  assert.equal(parseReplayV2CommandResult(commandResult()).data.consumed, 14);

  assert.throws(() => parseReplayViewerStateResponse({
    protocol: "replay.v3",
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

test("order capacity parser keeps the quantity-independent contract strict", () => {
  const parsed = parseReplayOrderCapacity(orderCapacity());
  assert.equal(parsed.max_quantity, "10");
  assert.equal(parsed.context.side, "BUY");
  assert.throws(() => parseReplayOrderCapacity({
    ...orderCapacity(),
    max_quantity: 10,
  }), /canonical Decimal string/);
  assert.throws(() => parseReplayOrderCapacity({
    ...orderCapacity(),
    quantity: "1",
  }), /unknown/);
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
    protocol: "replay.v3" as const,
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

test("order capacity API is run-scoped and never sends a draft quantity", async () => {
  const requests: Array<{ url: string; body: string | null }> = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input, init) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : null,
      });
      return new Response(JSON.stringify(orderCapacity()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const payload: ReplayOrderCapacityRequest = {
    protocol: "replay.v3",
    expected_revision: 6,
    expected_cursor: orderCapacity().cursor,
    position_intent: "OPEN",
    context: orderCapacity().context as ReplayOrderCapacityRequest["context"],
  };

  const result = await client.orderCapacity("run-1", payload);

  assert.equal(result.max_quantity, "10");
  assert.deepEqual(requests, [{
    url: "/api/v1/replay/runs/run-1/order-capacity",
    body: JSON.stringify(payload),
  }]);
  assert.equal(requests[0]?.body?.includes("quantity"), false);
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
        payload = { protocol: "replay.v3", viewer_state: viewerState() };
      } else if (url.endsWith("/commands")) {
        payload = commandResult();
      } else {
        payload = {
          protocol: "replay.v3",
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
    protocol: "replay.v3",
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

test("read-only replay.v3 API retries one transport failure", async () => {
  let requestCount = 0;
  const client = new ReplayV2ApiClient({
    fetcher: async () => {
      requestCount += 1;
      if (requestCount === 1) throw new TypeError("socket reset");
      return new Response(JSON.stringify({
        protocol: "replay.v3",
        viewer_state: viewerState(),
      }), { status: 200 });
    },
  });

  const result = await client.viewerBySession("adapter-1");

  assert.equal(result.viewer_state.run_id, "run-1");
  assert.equal(requestCount, 2);
});

test("read-only replay.v3 API never retries an intentional abort", async () => {
  let requestCount = 0;
  const client = new ReplayV2ApiClient({
    fetcher: async () => {
      requestCount += 1;
      throw new DOMException("request canceled", "AbortError");
    },
  });

  await assert.rejects(
    client.viewerBySession("adapter-1"),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(requestCount, 1);
});

test("read-only replay.v3 API retries one bodyless proxy 5xx", async () => {
  let requestCount = 0;
  const client = new ReplayV2ApiClient({
    fetcher: async () => {
      requestCount += 1;
      if (requestCount === 1) return new Response("", { status: 500 });
      return new Response(JSON.stringify({
        protocol: "replay.v3",
        viewer_state: viewerState(),
      }), { status: 200 });
    },
  });

  const result = await client.viewerBySession("adapter-1");

  assert.equal(result.viewer_state.selected_track_id, "track-1");
  assert.equal(requestCount, 2);
});

test("read-only replay.v3 API does not retry a structured server failure", async () => {
  let requestCount = 0;
  const client = new ReplayV2ApiClient({
    fetcher: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        protocol: "replay.v3",
        error: {
          code: "STORAGE_DEGRADED",
          message: "track read failed",
          details: { retryable: false },
        },
      }), { status: 503 });
    },
  });

  await assert.rejects(
    client.viewerBySession("adapter-1"),
    (error: unknown) => {
      assert.ok(error instanceof ReplayV2ApiError);
      assert.equal(error.code, "STORAGE_DEGRADED");
      assert.equal(error.status, 503);
      return true;
    },
  );
  assert.equal(requestCount, 1);
});

test("read-only replay.v3 API does not retry invalid JSON from a successful response", async () => {
  let requestCount = 0;
  const client = new ReplayV2ApiClient({
    fetcher: async () => {
      requestCount += 1;
      return new Response("", { status: 200 });
    },
  });

  await assert.rejects(
    client.viewerBySession("adapter-1"),
    (error: unknown) => {
      assert.ok(error instanceof ReplayV2ApiError);
      assert.equal(error.code, "REPLAY_V2_PROTOCOL_ERROR");
      return true;
    },
  );
  assert.equal(requestCount, 1);
});

test("replay.v3 command POST retries one bodyless 5xx with the identical envelope", async () => {
  let requestCount = 0;
  const requestBodies: string[] = [];
  const command: ReplayV2Command = {
    protocol: "replay.v3",
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
  const client = new ReplayV2ApiClient({
    fetcher: async (_input, init) => {
      requestCount += 1;
      requestBodies.push(String(init?.body ?? ""));
      if (requestCount === 1) return new Response("", { status: 500 });
      return new Response(JSON.stringify(commandResult()), { status: 200 });
    },
  });

  const result = await client.commandRun("run-1", command);

  assert.equal(result.command_id, command.command_id);
  assert.equal(requestCount, 2);
  assert.deepEqual(requestBodies, [JSON.stringify(command), JSON.stringify(command)]);
});

test("replay.v3 command outcome recovery is capped at one retry", async () => {
  let requestCount = 0;
  const command: ReplayV2Command = {
    protocol: "replay.v3",
    run_id: "run-1",
    command_id: "step-display-loss-1",
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
  const client = new ReplayV2ApiClient({
    fetcher: async () => {
      requestCount += 1;
      throw new TypeError("socket reset");
    },
  });

  await assert.rejects(
    client.commandRun("run-1", command),
    (error: unknown) => error instanceof ReplayV2ApiError
      && error.code === "REPLAY_V2_TRANSPORT_ERROR",
  );
  assert.equal(requestCount, 2);
});

test("fast replay.v3 clock control aborts a lost acknowledgement and retries the same command once", async () => {
  let requestCount = 0;
  const requestBodies: string[] = [];
  const command: ReplayV2Command = {
    protocol: "replay.v3",
    run_id: "run-1",
    command_id: "set-speed-timeout-1",
    client_instance_id: "browser-1",
    expected_revision: 6,
    expected_cursor: {
      virtual_time_ms: 1_710_000_059_999,
      source_sequence: 1,
      revision: 6,
    },
    type: "set_speed",
    payload: { basis: "BASE_BAR", rate: 600 },
  };
  const client = new ReplayV2ApiClient({
    commandAcknowledgementTimeoutMs: 5,
    fetcher: async (_input, init) => {
      requestCount += 1;
      requestBodies.push(String(init?.body ?? ""));
      if (requestCount === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("request canceled", "AbortError"));
          }, { once: true });
        });
      }
      return new Response(JSON.stringify({
        ...commandResult(),
        command_id: command.command_id,
      }), { status: 200 });
    },
  });

  const result = await client.commandRun("run-1", command);

  assert.equal(result.command_id, command.command_id);
  assert.equal(requestCount, 2);
  assert.deepEqual(requestBodies, [JSON.stringify(command), JSON.stringify(command)]);
});

test("replay.v3 command does not retry a structured rejection or external abort", async () => {
  const command: ReplayV2Command = {
    protocol: "replay.v3",
    run_id: "run-1",
    command_id: "set-speed-rejected-1",
    client_instance_id: "browser-1",
    expected_revision: 6,
    expected_cursor: {
      virtual_time_ms: 1_710_000_059_999,
      source_sequence: 1,
      revision: 6,
    },
    type: "set_speed",
    payload: { basis: "BASE_BAR", rate: 600 },
  };
  let structuredRequests = 0;
  const structuredClient = new ReplayV2ApiClient({
    commandAcknowledgementTimeoutMs: 50,
    fetcher: async () => {
      structuredRequests += 1;
      return new Response(JSON.stringify({
        protocol: "replay.v3",
        error: {
          code: "CONTROLLER_CONFLICT",
          message: "controller belongs to another client",
          details: {},
        },
      }), { status: 409 });
    },
  });
  await assert.rejects(
    structuredClient.commandRun("run-1", command),
    (error: unknown) => error instanceof ReplayV2ApiError
      && error.code === "CONTROLLER_CONFLICT",
  );
  assert.equal(structuredRequests, 1);

  let abortedRequests = 0;
  const abort = new AbortController();
  const abortedClient = new ReplayV2ApiClient({
    commandAcknowledgementTimeoutMs: 50,
    fetcher: async (_input, init) => {
      abortedRequests += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("request canceled", "AbortError"));
        }, { once: true });
      });
    },
  });
  const pending = abortedClient.commandRun("run-1", command, abort.signal);
  abort.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(abortedRequests, 1);
});

test("command API fails closed when request and response identities diverge", async () => {
  const command: ReplayV2Command = {
    protocol: "replay.v3",
    run_id: "run-1",
    command_id: "set-speed-1",
    client_instance_id: "browser-1",
    expected_revision: 6,
    expected_cursor: {
      virtual_time_ms: 1_710_000_059_999,
      source_sequence: 1,
      revision: 6,
    },
    type: "set_speed",
    payload: { basis: "BASE_BAR", rate: 120 },
  };
  let requestCount = 0;
  const client = new ReplayV2ApiClient({
    fetcher: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        ...commandResult(),
        command_id: "pause-before-set-speed",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await assert.rejects(
    client.commandRun("run-1", command),
    (error: unknown) => {
      assert.ok(error instanceof ReplayV2ApiError);
      assert.equal(error.code, "REPLAY_V2_RESPONSE_IDENTITY_MISMATCH");
      assert.deepEqual(error.details, {
        request_command_id: "set-speed-1",
        request_run_id: "run-1",
        response_command_id: "pause-before-set-speed",
        response_run_id: "run-1",
      });
      return true;
    },
  );
  assert.equal(requestCount, 1);
});

test("command API rejects a route and payload run mismatch before transport", async () => {
  let requestCount = 0;
  const client = new ReplayV2ApiClient({
    fetcher: async () => {
      requestCount += 1;
      return new Response(JSON.stringify(commandResult()), { status: 200 });
    },
  });
  const command: ReplayV2Command = {
    protocol: "replay.v3",
    run_id: "run-other",
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

  await assert.rejects(
    client.commandRun("run-1", command),
    (error: unknown) => {
      assert.ok(error instanceof ReplayV2ApiError);
      assert.equal(error.code, "REPLAY_V2_PROTOCOL_ERROR");
      return true;
    },
  );
  assert.equal(requestCount, 0);
});
