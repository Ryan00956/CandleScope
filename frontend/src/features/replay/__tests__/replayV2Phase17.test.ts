import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createDrawingDocument,
  createDrawingEntity,
} from "../../drawings/core/drawingDocument.js";
import {
  parseReplayReviewControlResponse,
  parseReplayReviewForkResponse,
  parseReplayReviewResponse,
  parseReplayRunRulesResponse,
} from "../replayIntegrityModel.js";
import {
  replayReviewDocumentHash,
  replayReviewDrawingDocument,
  replayReviewDrawingRecord,
} from "../replayReviewDrawing.js";
import { replaySha256Utf8 } from "../replaySha256.js";
import { ReplayV2ApiClient } from "../replayV2Api.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const cursor = { virtual_time_ms: 946_684_800_000, source_sequence: 7 };
const publicTime = {
  policy: "HIDE_ALL",
  timeline_ms: 946_684_800_000,
  relative_ms: 420_000,
  sequence: 7,
  label: "D+1 T+00:07:00",
};

function rulesPayload() {
  const common = {
    revision: 1,
    effective_cursor: cursor,
    public_time: publicTime,
    fidelity: "USER_CONFIGURED_AUDITED",
    reason: "training creation",
    command_id: null,
    old: null,
  };
  const fee = {
    ...common,
    kind: "FEE_POLICY",
    maker_fee_bps: "1",
    taker_fee_bps: "4",
    policy_hash: digest("a"),
    new: { maker_fee_bps: "1", taker_fee_bps: "4" },
  };
  const leverage = {
    ...common,
    kind: "LEVERAGE_CAP",
    max_leverage: "10",
    policy_hash: digest("b"),
    new: { max_leverage: "10" },
  };
  const funding = {
    ...common,
    kind: "FUNDING_POLICY",
    funding_mode: "OFF",
    fixed_funding_rate: null,
    funding_interval_ms: null,
    policy_hash: digest("c"),
    new: {
      funding_mode: "OFF",
      fixed_funding_rate: null,
      funding_interval_ms: null,
    },
  };
  return {
    protocol: "replay.v3",
    schema_version: "replay.run-rules.v1",
    run_id: "run-17",
    effective_cursor: cursor,
    fee_policy: fee,
    leverage_policy: leverage,
    funding_policy: funding,
    instrument_rules: [{
      track_id: "track-btc",
      revision: 1,
      effective_virtual_time_ms: cursor.virtual_time_ms,
      rule: {
        price_tick: "0.1",
        quantity_step: "0.001",
        exchange_max_leverage: "20",
      },
      rule_hash: digest("d"),
      fidelity: "EXCHANGE_RULE_ARCHIVE_EXACT",
      immutable_exchange_rule: true,
    }],
    effective_leverage_by_track: { "track-btc": "10" },
    history: [fee, leverage, funding],
  };
}

function projectionPayload() {
  return {
    schema_version: "replay.review.timeline.v1",
    run_id: "run-17",
    cursor,
    tracks: [{
      track_id: "track-btc",
      exchange: "binance",
      market_type: "spot",
      symbol: "BTCUSDT",
      source_kind: "BAR",
      position: { quantity: "0.5" },
      account: { available_equity: "9980" },
    }],
    orders: [{ order_id: "order-1", state: "FILLED" }],
    fills: [{ fill_id: "fill-1", price: "100" }],
    ledger: [{ ledger_sequence: 1, cash_delta: "-20" }],
    markers: [{ marker_id: "marker-1", text: "breakout" }],
    liquidations: [],
    books: [],
    account: {
      account_model: "PERPETUAL_LINEAR",
      ledger_tail_hash: digest("e"),
    },
    account_hash: digest("f"),
    rules: rulesPayload(),
    viewer_state: {
      run_id: "run-17",
      selected_track_id: "track-btc",
      display_interval: "15m",
      semantic_view_revision: 3,
    },
    viewer_hash: digest("1"),
    drawing_document_hash: null,
    drawing_revision: 0,
    domain: {
      equity: "9980",
      order_count: 1,
      fill_count: 1,
      ledger_count: 1,
    },
  };
}

function budgetPayload() {
  return {
    critical_events: 7,
    critical_event_limit: 8_192,
    viewport_samples: 2,
    viewport_sample_limit: 2_048,
    anchor_used_bytes: 8_192,
    anchor_limit_bytes: 512 * 1_024 * 1_024,
    artifact_used_bytes: 4_096,
    artifact_limit_bytes: 128 * 1_024 * 1_024,
  };
}

function eventPayload() {
  return {
    event_id: "review-event-00000007",
    event_type: "FILL",
    category: "FILL",
    timeline_sequence: 7,
    checkpoint_id: 7,
    source_sequence: 7,
    event_sequence: 9,
    state_hash: digest("2"),
    account_hash: digest("f"),
    ledger_tail_hash: digest("e"),
    viewer_revision: 3,
    anchor_set_hash: digest("3"),
    event_hash: digest("4"),
    public_time: publicTime,
    detail: { text: "filled at touch" },
  };
}

function reviewPayload() {
  return {
    protocol: "replay.v3",
    schema_version: "replay.review.timeline.v1",
    review_id: "review-17",
    run_id: "run-17",
    read_only: true,
    selected_event_id: "review-event-00000007",
    selected_timeline_sequence: 7,
    selected_state_hash: digest("2"),
    original_state_hash: digest("2"),
    original_cursor: cursor,
    dataset_epoch: digest("5"),
    cursor_revision: 1,
    playback_state: "PAUSED",
    playback_rate: "1",
    projection: projectionPayload(),
    drawing_document: null,
    immutability_proof: {
      original_account_hash: digest("f"),
      original_ledger_tail_hash: digest("e"),
      original_viewer_revision: 3,
      original_viewer_hash: digest("1"),
      verified: true,
    },
    budget: budgetPayload(),
    events: [eventPayload()],
    jump_targets: [{
      event_id: "review-event-00000007",
      event_type: "FILL",
      category: "FILL",
    }],
  };
}

test("Phase 17 rules keep exchange instruments immutable and overlays independent", () => {
  const rules = parseReplayRunRulesResponse(rulesPayload());
  assert.equal(rules.instrument_rules[0]?.immutable_exchange_rule, true);
  assert.equal(rules.instrument_rules[0]?.rule.exchange_max_leverage, "20");
  assert.equal(rules.leverage_policy.max_leverage, "10");
  assert.equal(rules.effective_leverage_by_track["track-btc"], "10");
  assert.deepEqual(rules.history.map((item) => item.kind), [
    "FEE_POLICY",
    "LEVERAGE_CAP",
    "FUNDING_POLICY",
  ]);
});

test("Phase 17 ReviewMode strictly parses cursor controls and rejects private archive fields", () => {
  const review = parseReplayReviewResponse(reviewPayload());
  assert.equal(review.read_only, true);
  assert.equal(review.projection.viewer_state.display_interval, "15m");
  assert.equal(review.immutability_proof.verified, true);
  const control = parseReplayReviewControlResponse({
    protocol: "replay.v3",
    schema_version: "replay.review.timeline.v1",
    review_id: "review-17",
    run_id: "run-17",
    read_only: true,
    selected_event_id: "review-event-00000007",
    selected_timeline_sequence: 7,
    selected_state_hash: digest("2"),
    original_state_hash: digest("2"),
    cursor_revision: 2,
    playback_state: "PLAYING",
    playback_rate: "2",
    selected_event: {
      event_id: "review-event-00000007",
      event_type: "FILL",
      category: "FILL",
      timeline_sequence: 7,
      public_time: publicTime,
      detail: { text: "filled at touch" },
    },
    projection: projectionPayload(),
    drawing_document: null,
    immutability_proof: reviewPayload().immutability_proof,
    budget: budgetPayload(),
  });
  assert.equal(control.cursor_revision, 2);
  assert.equal(control.playback_state, "PLAYING");

  const leaked = {
    ...reviewPayload(),
    projection: {
      ...projectionPayload(),
      books: [{ archive_id: "private-archive" }],
    },
  };
  assert.throws(
    () => parseReplayReviewResponse(leaked),
    /crosses the review disclosure boundary/,
  );
  const overBudget = {
    ...reviewPayload(),
    budget: { ...budgetPayload(), viewport_samples: 2_049 },
  };
  assert.throws(
    () => parseReplayReviewResponse(overBudget),
    /contradicts the Phase 17 hard budgets/,
  );
});

test("Phase 17 Review Fork requires immutable lineage and exact child identity", () => {
  const fork = parseReplayReviewForkResponse({
    protocol: "replay.v3",
    parent_run_id: "run-17",
    parent_event_id: "review-event-00000007",
    parent_timeline_sequence: 7,
    anchor_set_hash: digest("3"),
    run: {
      run_id: "run-child",
      adapter_session_id: "adapter-child",
      dataset_epoch: digest("5"),
      state_hash: digest("2"),
    },
    tracks: [{
      run_id: "run-child",
      track_id: "track-btc",
      adapter_session_id: "adapter-child",
    }],
    account_audit: { status: "MATCH" },
  });
  assert.equal(fork.parent_timeline_sequence, 7);
  assert.equal(fork.run.dataset_epoch, digest("5"));
  assert.equal(fork.tracks.length, 1);
});

test("Phase 17 API client binds every review mutation to run-scoped strict protocols", async () => {
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input, init) => {
      const url = String(input);
      requests.push(init === undefined ? { url } : { url, init });
      let payload: unknown;
      if (url.endsWith("/rules")) {
        payload = rulesPayload();
      } else if (url.endsWith("/drawings/current")) {
        payload = {
          protocol: "replay.v3",
          schema_version: "replay.review.drawing-current.v1",
          run_id: "run-17",
          document_hash: digest("6"),
          revision: 1,
          entity_count: 0,
          document: {
            documentSchemaVersion: 1,
            scopeKey: "replay-run:run-17",
            documentRevision: 0,
            updatedAt: 1,
            entities: [],
          },
          budget: budgetPayload(),
        };
      } else if (url.endsWith("/drawings")) {
        payload = {
          protocol: "replay.v3",
          schema_version: "replay.review.drawing-document.v1",
          run_id: "run-17",
          document_hash: digest("6"),
          revision: 1,
          entity_count: 0,
          deduplicated: false,
          budget: budgetPayload(),
        };
      } else if (url.endsWith("/markers")) {
        payload = {
          protocol: "replay.v3",
          schema_version: "replay.review.marker.v1",
          run_id: "run-17",
          marker_id: "marker-1",
          command_id: "marker-command-1",
          text: "breakout",
          content_hash: digest("7"),
          event_id: "review-event-00000007",
          timeline_sequence: 7,
          deduplicated: false,
          budget: budgetPayload(),
        };
      } else if (url.endsWith("/review")) {
        payload = reviewPayload();
      } else if (url.endsWith("/cursor")) {
        payload = {
          protocol: "replay.v3",
          schema_version: "replay.review.timeline.v1",
          review_id: "review-17",
          run_id: "run-17",
          read_only: true,
          selected_event_id: "review-event-00000007",
          selected_timeline_sequence: 7,
          selected_state_hash: digest("2"),
          original_state_hash: digest("2"),
          cursor_revision: 2,
          playback_state: "PLAYING",
          playback_rate: "2",
          selected_event: {
            event_id: "review-event-00000007",
            event_type: "FILL",
            category: "FILL",
            timeline_sequence: 7,
            public_time: publicTime,
            detail: null,
          },
          projection: projectionPayload(),
          drawing_document: null,
          immutability_proof: reviewPayload().immutability_proof,
          budget: budgetPayload(),
        };
      } else if (url.endsWith("/fork")) {
        payload = {
          protocol: "replay.v3",
          parent_run_id: "run-17",
          parent_event_id: "review-event-00000007",
          parent_timeline_sequence: 7,
          anchor_set_hash: digest("3"),
          run: {
            run_id: "run-child",
            adapter_session_id: "adapter-child",
            dataset_epoch: digest("5"),
            state_hash: digest("2"),
          },
          tracks: [{ track_id: "track-btc" }],
          account_audit: null,
        };
      } else {
        throw new Error(`unexpected Phase 17 API route ${url}`);
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await client.rulesRun("run-17");
  await client.currentDrawingRun("run-17");
  await client.recordDrawingRun("run-17", {
    command_id: "drawing-command-1",
    document_hash: digest("6"),
    document: {
      documentSchemaVersion: 1,
      scopeKey: "replay-run:run-17",
      documentRevision: 0,
      updatedAt: 1,
      entities: [],
    },
    entity_count: 0,
  });
  await client.recordMarkerRun("run-17", "breakout", "marker-command-1");
  await client.reviewRun("run-17");
  await client.controlReviewRun("run-17", "review-17", {
    action: "PLAY",
    event_id: null,
    expected_cursor_revision: 1,
    playback_rate: "2",
  });
  await client.forkRun("run-17", "review-event-00000007");

  assert.deepEqual(requests.map((request) => request.url), [
    "/api/v1/replay/runs/run-17/rules",
    "/api/v1/replay/runs/run-17/drawings/current",
    "/api/v1/replay/runs/run-17/drawings",
    "/api/v1/replay/runs/run-17/markers",
    "/api/v1/replay/runs/run-17/review",
    "/api/v1/replay/runs/run-17/reviews/review-17/cursor",
    "/api/v1/replay/runs/run-17/fork",
  ]);
  const drawingBody = JSON.parse(String(requests[2]?.init?.body)) as {
    readonly protocol: string;
  };
  const markerBody = JSON.parse(String(requests[3]?.init?.body)) as {
    readonly protocol: string;
  };
  const controlBody = JSON.parse(String(requests[5]?.init?.body)) as {
    readonly expected_cursor_revision: number;
  };
  assert.equal(drawingBody.protocol, "replay.review.drawing-document.v1");
  assert.equal(markerBody.protocol, "replay.review.marker.v1");
  assert.equal(controlBody.expected_cursor_revision, 1);
  assert.equal(requests[0]?.init?.method, undefined);
  assert.equal(requests[6]?.init?.method, "POST");
});

test("Phase 17 drawing evidence wraps floats, hashes deterministically, and restores read-only geometry", async () => {
  const document = createDrawingDocument({
    scopeKey: "replay-run:run-17__main",
    documentRevision: 9,
    entities: [createDrawingEntity({
      id: "line-17",
      kind: "line",
      geometry: {
        kind: "line",
        lineType: "line-segment",
        dataPoints: [
          { time: 100.125, price: 10.25 },
          { time: 200.875, price: 20.75 },
        ],
      },
      style: { kind: "line", color: "#ffffff", lineWidth: 2.5 },
    })],
  });
  const record = replayReviewDrawingRecord(document, "run-17", 123_456);
  const serialized = JSON.stringify(record);
  assert.match(serialized, /"\$replay_decimal_v1":"100\.125"/);
  assert.match(serialized, /"\$replay_decimal_v1":"2\.5"/);
  assert.equal(record.scopeKey, "replay-run:run-17");
  const firstHash = await replayReviewDocumentHash(record);
  const secondHash = await replayReviewDocumentHash(structuredClone(record));
  assert.equal(firstHash, secondHash);
  assert.equal(
    firstHash,
    "sha256:57ab1912cecb3107e24d3c6bf3a004fac6b38613621fd2820c62480b2a54de02",
  );

  const restored = replayReviewDrawingDocument(
    record,
    "replay-review:review-17__main",
  );
  assert.equal(restored.scopeKey, "replay-review:review-17__main");
  assert.equal(restored.documentRevision, 9);
  const line = restored.entities.get("line-17");
  assert.equal(line?.style.kind, "line");
  if (line?.geometry.kind !== "line" || line.style.kind !== "line") {
    throw new Error("restored drawing kind drifted");
  }
  assert.equal(line.geometry.dataPoints?.[0]?.time, 100.125);
  assert.equal(line.style.lineWidth, 2.5);
});

test("Phase 17 drawing SHA-256 fallback matches standard UTF-8 vectors", () => {
  const vectors = [
    "",
    "abc",
    "回放绘图 / replay drawing",
    "x".repeat(1_000_000),
  ];
  for (const value of vectors) {
    assert.equal(
      replaySha256Utf8(value),
      createHash("sha256").update(value, "utf8").digest("hex"),
    );
  }
  assert.equal(
    replaySha256Utf8("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
