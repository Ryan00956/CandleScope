import assert from "node:assert/strict";
import test from "node:test";

import type {
  KlineApi,
  KlineStreamController,
  KlineStreamOptions,
} from "../klineContracts.js";
import { toEpochSeconds, type MarketSeries } from "../marketDataTypes.js";
import { SharedKlineStreamCoordinator } from "../feed/sharedKlineStreamCoordinator.js";

type StreamSeries = Pick<MarketSeries, "exchange" | "marketType" | "symbol">;

interface PhysicalStreamRecord {
  series: StreamSeries;
  options: KlineStreamOptions;
  controller: KlineStreamController;
  intervalUpdates: string[][];
  closed: boolean;
}

function createHarness() {
  const physicalStreams: PhysicalStreamRecord[] = [];
  const coordinator = new SharedKlineStreamCoordinator({} as KlineApi, {
    createPhysicalStream: (series, options) => {
      const record: PhysicalStreamRecord = {
        series,
        options,
        controller: null as unknown as KlineStreamController,
        intervalUpdates: [],
        closed: false,
      };
      record.controller = {
        readyState: () => record.closed ? 3 : 1,
        isOpen: () => !record.closed,
        send: () => !record.closed,
        sendPing: () => !record.closed,
        updateIntervals: (intervals) => {
          record.intervalUpdates.push([...intervals]);
        },
        close: () => {
          record.closed = true;
        },
      };
      physicalStreams.push(record);
      return record.controller;
    },
  });
  return { coordinator, physicalStreams };
}

const BTC: StreamSeries = {
  exchange: "binance",
  marketType: "spot",
  symbol: "BTCUSDT",
};

test("same-instrument chart cells share one physical stream and receive only their intervals", () => {
  const { coordinator, physicalStreams } = createHarness();
  const firstTicks: string[] = [];
  const secondTicks: string[] = [];
  const firstControls: string[][] = [];
  const secondControls: string[][] = [];
  let firstOpened = 0;
  let secondOpened = 0;

  const first = coordinator.subscribe(BTC, {
    intervals: ["1m"],
    onOpen: () => { firstOpened += 1; },
    onControlMessage: (message) => firstControls.push(message.active_intervals || []),
    onKline: (event) => firstTicks.push(event.interval),
  });
  const second = coordinator.subscribe(BTC, {
    intervals: ["5m"],
    onOpen: () => { secondOpened += 1; },
    onControlMessage: (message) => secondControls.push(message.active_intervals || []),
    onKline: (event) => secondTicks.push(event.interval),
  });

  assert.equal(physicalStreams.length, 1);
  const physical = physicalStreams[0]!;
  assert.deepEqual(physical.intervalUpdates.at(-1), ["1m", "5m"]);

  physical.options.onOpen?.(physical.controller);
  assert.equal(firstOpened, 1);
  assert.equal(secondOpened, 1);

  physical.options.onControlMessage?.({
    type: "subscribed",
    requested_intervals: ["1m", "5m"],
    intervals: ["1m", "5m"],
    active_intervals: ["1m", "5m"],
  }, physical.controller);
  assert.deepEqual(firstControls, [["1m"]]);
  assert.deepEqual(secondControls, [["5m"]]);

  const tickTime = toEpochSeconds(1)!;
  physical.options.onKline?.({
    interval: "1m",
    tick: { time: tickTime, open: 1, high: 1, low: 1, close: 1 },
    message: {
      type: "kline",
      interval: "1m",
      data: { time: tickTime, open: 1, high: 1, low: 1, close: 1 },
    },
  }, physical.controller);
  assert.deepEqual(firstTicks, ["1m"]);
  assert.deepEqual(secondTicks, []);

  second.updateIntervals(["15m"]);
  assert.deepEqual(physical.intervalUpdates.at(-1), ["1m", "15m"]);
  first.close();
  assert.equal(physical.closed, false);
  assert.deepEqual(physical.intervalUpdates.at(-1), ["15m"]);
  second.close();
  assert.equal(physical.closed, true);
  assert.equal(coordinator.activePhysicalStreamCount(), 0);
});

test("different instruments keep independent physical streams", () => {
  const { coordinator, physicalStreams } = createHarness();
  const btc = coordinator.subscribe(BTC, { intervals: ["1m"] });
  const eth = coordinator.subscribe({ ...BTC, symbol: "ETHUSDT" }, { intervals: ["1m"] });

  assert.equal(physicalStreams.length, 2);
  assert.equal(coordinator.activePhysicalStreamCount(), 2);
  btc.close();
  eth.close();
  assert.equal(coordinator.activePhysicalStreamCount(), 0);
});

test("workspace handoff reuses the physical stream until the previous chart cells release it", () => {
  const { coordinator, physicalStreams } = createHarness();
  const previousOneHour = coordinator.subscribe(BTC, { intervals: ["1h"] });
  const previousFifteenMinute = coordinator.subscribe(BTC, { intervals: ["15m"] });

  const nextOneHour = coordinator.subscribe(BTC, { intervals: ["1h"] });
  assert.equal(physicalStreams.length, 1);
  assert.equal(coordinator.activePhysicalStreamCount(), 1);
  assert.deepEqual(physicalStreams[0]!.intervalUpdates.at(-1), ["1h", "15m"]);

  previousOneHour.close();
  previousFifteenMinute.close();
  assert.equal(physicalStreams[0]!.closed, false);
  assert.deepEqual(physicalStreams[0]!.intervalUpdates.at(-1), ["1h"]);

  nextOneHour.close();
  assert.equal(physicalStreams[0]!.closed, true);
  assert.equal(coordinator.activePhysicalStreamCount(), 0);
});
