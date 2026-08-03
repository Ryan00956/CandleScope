import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChartPaneOptions,
  buildLocalizationOptions,
} from "../chartPaneLifecycle.js";
import { structuralMock } from "../../test/testHelpers.js";

test("localization formatters resolve public and internal ordinal source time", () => {
  const options = buildLocalizationOptions("UTC", "1h");
  const formatters = structuralMock<{
    localization: { timeFormatter: (time: unknown) => string };
    timeScale: { tickMarkFormatter: (time: unknown, weight: number) => string };
  }>(options);
  const sourceTime = 1_700_000_000;
  const publicOrdinal = { order: 5, sourceTime, sourceOrdinal: 0 };
  const internalOrdinal = { _ordinal_order: 5, _ordinal_sourceTime: sourceTime };

  assert.equal(
    formatters.localization.timeFormatter(publicOrdinal),
    formatters.localization.timeFormatter(sourceTime),
  );
  assert.equal(
    formatters.localization.timeFormatter(internalOrdinal),
    formatters.localization.timeFormatter(sourceTime),
  );
  assert.equal(
    formatters.timeScale.tickMarkFormatter(publicOrdinal, 3),
    formatters.timeScale.tickMarkFormatter(sourceTime, 3),
  );
});

test("chart pane forwards the custom tick-label width budget", () => {
  const options = buildChartPaneOptions({
    container: structuralMock<HTMLElement>({
      clientWidth: 900,
      clientHeight: 500,
    }),
    tickMarkMaxCharacterLength: 12,
  });

  assert.equal(options.timeScale?.tickMarkMaxCharacterLength, 12);
});
