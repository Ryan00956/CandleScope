import assert from "node:assert/strict";
import test from "node:test";

import { resolveAdvancedMarketCapabilities } from "../advancedMarketCapabilities.js";

function channel(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    channel: name,
    market_types: ["futures"],
    realtime: true,
    history: false,
    ...overrides,
  };
}

test("capabilities fail closed until exchange metadata is available", () => {
  const snapshot = resolveAdvancedMarketCapabilities({ marketType: "futures", raw: null });

  assert.equal(snapshot.summarySupported, false);
  assert.equal(snapshot.channels.funding_rate.supported, false);
  assert.match(snapshot.channels.funding_rate.reason || "", /尚未就绪/);
});

test("funding and OI are resolved independently instead of as one bundle", () => {
  const snapshot = resolveAdvancedMarketCapabilities({
    marketType: "futures",
    raw: {
      channels: [
        channel("mark_price"),
        channel("index_price"),
        channel("funding_rate", { history: true }),
      ],
    },
  });

  assert.equal(snapshot.summarySupported, true);
  assert.equal(snapshot.channels.basis.supported, true);
  assert.equal(snapshot.channels.funding_rate.supported, true);
  assert.equal(snapshot.channels.open_interest.supported, false);
});

test("realtime-only metric studies remain available without issuing history reads", () => {
  const snapshot = resolveAdvancedMarketCapabilities({
    marketType: "futures",
    raw: { channels: [channel("open_interest", { history: false })] },
  });

  assert.equal(snapshot.channels.open_interest.realtime, true);
  assert.equal(snapshot.channels.open_interest.history, false);
  assert.equal(snapshot.channels.open_interest.supported, true);
  assert.equal(snapshot.channels.open_interest.reason, null);
});

test("history-only metric studies remain available without opening a live stream", () => {
  const snapshot = resolveAdvancedMarketCapabilities({
    marketType: "futures",
    raw: {
      channels: [channel("funding_rate", { realtime: false, history: true })],
    },
  });

  assert.equal(snapshot.channels.funding_rate.realtime, false);
  assert.equal(snapshot.channels.funding_rate.history, true);
  assert.equal(snapshot.channels.funding_rate.supported, true);
  assert.equal(snapshot.channels.funding_rate.reason, null);
});

test("spot sessions expose a contract-only reason and no market studies", () => {
  const snapshot = resolveAdvancedMarketCapabilities({
    marketType: "spot",
    raw: { channels: [channel("funding_rate", { history: true })] },
  });

  assert.equal(snapshot.channels.funding_rate.supported, false);
  assert.equal(snapshot.channels.funding_rate.reason, "仅合约市场支持");
});
