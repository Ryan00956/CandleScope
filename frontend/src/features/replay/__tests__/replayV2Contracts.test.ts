import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveReplayEntry } from "../replayEntry.js";
import {
  REPLAY_V2_ENUMS,
  assertReplayV2NoDisclosureDowngrade,
  parseReplayV2Command,
  parseReplayV2Event,
  parseReplayV2MarketTrack,
  parseReplayV2TrainingRun,
} from "../replayV2Types.js";

const GOLDEN_URL = new URL(
  "../../../../../backend/tests/fixtures/replay/v2_contract_golden.json",
  import.meta.url,
);

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, fieldName: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return value as JsonObject;
}

function golden(): JsonObject {
  return asObject(JSON.parse(readFileSync(GOLDEN_URL, "utf8")), "golden");
}

function cloneObject(value: unknown, fieldName: string): JsonObject {
  return asObject(structuredClone(value), fieldName);
}

function setNested(payload: JsonObject, path: readonly string[], value: unknown): void {
  let target = payload;
  for (const key of path.slice(0, -1)) target = asObject(target[key], key);
  target[path.at(-1) as string] = value;
}

function parseSection(section: string, payload: unknown): unknown {
  if (section === "sample_run") return parseReplayV2TrainingRun(payload);
  if (section === "sample_track") return parseReplayV2MarketTrack(payload);
  if (section === "sample_command") return parseReplayV2Command(payload);
  if (section === "sample_event") return parseReplayV2Event(payload);
  throw new TypeError(`unsupported fixture section ${section}`);
}

test("replay.v2 TypeScript enum registry matches the cross-language golden", () => {
  assert.deepEqual(REPLAY_V2_ENUMS, golden().enums);
});

test("replay.v2 run, track, command and event golden values cross strict parsers", () => {
  const fixture = golden();
  const run = parseReplayV2TrainingRun(fixture.sample_run);
  const track = parseReplayV2MarketTrack(fixture.sample_track, run.source_kind);
  const command = parseReplayV2Command(fixture.sample_command);
  const event = parseReplayV2Event(
    fixture.sample_event,
    run.time_disclosure_policy,
  );

  assert.deepEqual(run, fixture.sample_run);
  assert.deepEqual(track, fixture.sample_track);
  assert.deepEqual(command, fixture.sample_command);
  assert.deepEqual(event, fixture.sample_event);
});

for (const [section, path, value] of [
  ["sample_run", ["protocol"], "replay.v1"],
  ["sample_run", ["run_id"], "bad id"],
  ["sample_run", ["state"], "RUNNING"],
  ["sample_run", ["source_kind"], "RAW_TRADE"],
  ["sample_run", ["integrity_mode"], "CHEAT"],
  ["sample_run", ["time_disclosure_policy"], "CLIENT_ONLY"],
  ["sample_run", ["initial_equity"], "NaN"],
  ["sample_run", ["initial_equity"], 10_000],
  ["sample_run", ["active_rule_revision"], -1],
  ["sample_run", ["cursor", "source_sequence"], true],
  ["sample_track", ["subscription_tier"], "LIVE"],
  ["sample_track", ["capabilities", "ORDER_BOOK"], "AVAILABLE"],
  ["sample_track", ["capabilities", "FUTURE_CAPABILITY"], "AVAILABLE_EXACT"],
  ["sample_command", ["type"], "skip_everything"],
  ["sample_command", ["expected_revision"], -1],
  ["sample_event", ["type"], "FUTURE_EVENT"],
] as const) {
  test(`replay.v2 ${section}.${path.join(".")} rejects invalid wire values`, () => {
    const payload = cloneObject(golden()[section], section);
    setNested(payload, path, value);
    assert.throws(() => parseSection(section, payload));
  });
}

test("replay.v2 rejects source mixing and silent time-disclosure downgrade", () => {
  const fixture = golden();
  const mismatched = cloneObject(fixture.sample_track, "sample_track");
  mismatched.source_kind = "AGG_TRADE";
  assert.throws(
    () => parseReplayV2MarketTrack(mismatched, "BAR"),
    /source_kind/,
  );

  assert.doesNotThrow(() => assertReplayV2NoDisclosureDowngrade("HIDE_DAY", "HIDE_ALL"));
  assert.doesNotThrow(() => assertReplayV2NoDisclosureDowngrade("HIDE_DAY", "HIDE_DAY"));
  assert.throws(
    () => assertReplayV2NoDisclosureDowngrade("HIDE_ALL", "HIDE_DAY"),
    /downgrade/,
  );

  const event = cloneObject(fixture.sample_event, "sample_event");
  event.time_disclosure_policy = "NONE";
  assert.throws(() => parseReplayV2Event(event, "HIDE_DAY"), /downgrade/);
});

test("replay.v2 direct URL remains closed to product selectors", () => {
  assert.deepEqual(
    resolveReplayEntry({ pathname: "/replay.html", search: "?product=v2" }),
    {
      kind: "error",
      code: "REPLAY_ENTRY_INVALID",
      message: "Replay URL query parameters are invalid.",
    },
  );
});

test("replay-only root has one v2 composition and no product selector", () => {
  const replayMain = readFileSync(new URL("../../../replay-main.tsx", import.meta.url), "utf8");
  const replayApp = readFileSync(new URL("../ReplayApp.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(replayMain, /replayV2|REPLAY_PRODUCT_V2|VITE_REPLAY_PRODUCT_V2/);
  assert.match(replayApp, /ReplayTrainingHubApp/);
  assert.match(replayApp, /ReplayTrainingRunApp/);
  assert.match(replayApp, /ReplayInitialMarketPicker/);
  assert.match(replayApp, /ReplayInitializedRun/);
  assert.doesNotMatch(replayApp, /ReplayV1App|ReplayPageShell|resolveReplayProduct|PRODUCT_V2_ENABLED/);
});
