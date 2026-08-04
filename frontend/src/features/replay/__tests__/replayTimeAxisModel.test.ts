import assert from "node:assert/strict";
import test from "node:test";

import { TickMarkType } from "../../../chart-adapter/chartAdapterTypes.js";

import {
  formatReplayTimeAxisLabel,
  replayTimeAxisMaxCharacterLength,
} from "../replayPublicTimeModel.js";
import type { ReplayV2TimeDisclosurePolicy } from "../replayV2Types.js";

const cases: readonly {
  readonly policy: ReplayV2TimeDisclosurePolicy;
  readonly full: string;
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly time: string;
  readonly seconds: string;
}[] = [
  {
    policy: "NONE",
    full: "2024-03-09 16:05:07",
    year: "2024",
    month: "2024-03",
    day: "03-09",
    time: "16:05",
    seconds: "16:05:07",
  },
  {
    policy: "HIDE_YEAR",
    full: "03-09 16:05:07",
    year: "03",
    month: "03",
    day: "03-09",
    time: "16:05",
    seconds: "16:05:07",
  },
  {
    policy: "HIDE_MONTH",
    full: "09 16:05:07",
    year: "09",
    month: "09",
    day: "09",
    time: "16:05",
    seconds: "16:05:07",
  },
  {
    policy: "HIDE_DAY",
    full: "D+3 16:05:07",
    year: "D+3",
    month: "D+3",
    day: "D+3",
    time: "16:05",
    seconds: "16:05:07",
  },
  {
    policy: "HIDE_HOUR",
    full: "T+52h 05:07",
    year: "T+52h",
    month: "T+52h",
    day: "T+52h",
    time: "T+52h 05",
    seconds: "T+52h 05:07",
  },
  {
    policy: "HIDE_MINUTE",
    full: "T+3125m 07",
    year: "T+3125m",
    month: "T+3125m",
    day: "T+3125m",
    time: "T+3125m",
    seconds: "T+3125m 07",
  },
  {
    policy: "HIDE_ALL",
    full: "D+3 T+16:05:07",
    year: "D+3",
    month: "D+3",
    day: "D+3",
    time: "16:05",
    seconds: "16:05:07",
  },
];

test("replay time axis compacts every disclosure policy by tick weight", () => {
  for (const value of cases) {
    assert.equal(
      formatReplayTimeAxisLabel(value.policy, value.full, TickMarkType.Year),
      value.year,
    );
    assert.equal(
      formatReplayTimeAxisLabel(value.policy, value.full, TickMarkType.Month),
      value.month,
    );
    assert.equal(
      formatReplayTimeAxisLabel(value.policy, value.full, TickMarkType.DayOfMonth),
      value.day,
    );
    assert.equal(
      formatReplayTimeAxisLabel(value.policy, value.full, TickMarkType.Time),
      value.time,
    );
    assert.equal(
      formatReplayTimeAxisLabel(value.policy, value.full, TickMarkType.TimeWithSeconds),
      value.seconds,
    );
  }
});

test("safe relative cache-miss labels compact without reconstructing hidden units", () => {
  for (const policy of ["HIDE_YEAR", "HIDE_MONTH", "HIDE_HOUR", "HIDE_MINUTE", "HIDE_ALL"] as const) {
    assert.equal(
      formatReplayTimeAxisLabel(policy, "D+3 16:05:07", TickMarkType.DayOfMonth),
      "D+3",
    );
    assert.equal(
      formatReplayTimeAxisLabel(policy, "D+3 16:05:07", TickMarkType.Time),
      "16:05",
    );
  }
});

test("unexpected authoritative labels remain exact and density follows disclosure length", () => {
  assert.equal(
    formatReplayTimeAxisLabel("HIDE_ALL", "SERVER-PUBLIC-LABEL", TickMarkType.Time),
    "SERVER-PUBLIC-LABEL",
  );
  assert.equal(replayTimeAxisMaxCharacterLength("NONE"), 8);
  assert.equal(replayTimeAxisMaxCharacterLength("HIDE_ALL"), 8);
  assert.equal(replayTimeAxisMaxCharacterLength("HIDE_HOUR"), 12);
  assert.equal(replayTimeAxisMaxCharacterLength("HIDE_MINUTE"), 12);
});
