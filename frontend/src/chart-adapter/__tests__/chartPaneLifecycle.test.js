import assert from "node:assert/strict";
import test from "node:test";

import { buildLocalizationOptions } from "../chartPaneLifecycle.js";

test("localization formatters resolve public and internal ordinal source time", () => {
  const options = buildLocalizationOptions("UTC", "1h");
  const sourceTime = 1_700_000_000;
  const publicOrdinal = { order: 5, sourceTime, sourceOrdinal: 0 };
  const internalOrdinal = { _ordinal_order: 5, _ordinal_sourceTime: sourceTime };

  assert.equal(
    options.localization.timeFormatter(publicOrdinal),
    options.localization.timeFormatter(sourceTime),
  );
  assert.equal(
    options.localization.timeFormatter(internalOrdinal),
    options.localization.timeFormatter(sourceTime),
  );
  assert.equal(
    options.timeScale.tickMarkFormatter(publicOrdinal, 3),
    options.timeScale.tickMarkFormatter(sourceTime, 3),
  );
});
