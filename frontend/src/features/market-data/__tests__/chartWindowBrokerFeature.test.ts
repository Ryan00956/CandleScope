import assert from "node:assert/strict";
import test from "node:test";

import { resolveChartWindowBrokerEnabled } from "../chartWindowBrokerFeature.js";

test("window broker rollback flag is default-off and only accepts explicit enablement", () => {
  assert.equal(resolveChartWindowBrokerEnabled(), false);
  assert.equal(resolveChartWindowBrokerEnabled({ CHART_WINDOW_BROKER_ENABLED: "true" }), false);
  assert.equal(resolveChartWindowBrokerEnabled({ CHART_WINDOW_BROKER_ENABLED: "1" }), true);
  assert.equal(resolveChartWindowBrokerEnabled({ CHART_WINDOW_BROKER_ENABLED: true }), true);
});
