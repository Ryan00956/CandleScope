import assert from "node:assert/strict";
import test from "node:test";

import type { IndicatorPreset } from "../indicators/indicatorTypes.js";
import {
  createLocalIndicatorCatalog,
  resolveLocalIndicatorSupport,
} from "./localIndicatorCatalog.js";
import type { LocalDatasetManifest } from "./localDataTypes.js";


function preset(engineName: string): IndicatorPreset {
  return {
    id: engineName.toLowerCase(),
    name: engineName,
    engineName,
    script: `# __ENGINE__:${engineName}`,
    params: {},
    description: `${engineName} shared preset`,
    category: "shared",
    paramSchema: [],
    outputs: [engineName],
    is_builtin: true,
    defaultEnabled: false,
    paneTarget: engineName === "MA" ? "main" : "sub",
  };
}

const manifest = {
  dataset_id: "local-0123456789abcdef0123456789abcdef",
  data_epoch: `sha256:${"1".repeat(64)}`,
  volume_available: false,
} as LocalDatasetManifest;

test("local catalog projects the shared server presets without a second product list", async () => {
  const presets = ["MA", "EMA", "RSI", "MACD", "BOLL", "ATR", "VOL"].map(preset);
  const catalog = createLocalIndicatorCatalog(presets);

  assert.equal(catalog.presets, presets);
  const first = await catalog.resolvePresetForChart(presets[0]!);
  const second = await catalog.resolvePresetForChart(presets[0]!);
  assert.notEqual(first.id, second.id);
  assert.equal(first.executionTarget, "local");
  assert.equal(first.engineName, "MA");
});

test("local support is capability driven and leaves unavailable shared items visible", () => {
  assert.deepEqual(resolveLocalIndicatorSupport(preset("ATR"), manifest), {
    supported: true,
    reason: null,
  });
  assert.deepEqual(resolveLocalIndicatorSupport(preset("VOL"), manifest), {
    supported: false,
    reason: "当前数据集没有 volume 列",
  });
  assert.deepEqual(resolveLocalIndicatorSupport({
    id: "custom",
    kind: "script",
    script: "plot(close)",
  }, manifest), {
    supported: false,
    reason: "离线 profile 未启动自定义脚本运行时",
  });
});
