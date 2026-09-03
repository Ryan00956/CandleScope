import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getLocale, setLocale } from "../../i18n/index.js";
import IntervalSelector from "../IntervalSelector.js";
import type { IntervalSelectorProps } from "../IntervalSelector.js";
import type {
  CustomIntervalRecord,
  NativeInterval,
} from "../../features/chart-session/chartSessionTypes.js";

function native(value: string, seconds: number): NativeInterval {
  return { value, seconds, label: value };
}

function custom(value: string, pinned = false): CustomIntervalRecord {
  return {
    value,
    createdAt: 1,
    lastUsedAt: 1,
    usageCount: 2,
    pinned,
    order: 0,
  };
}

function render(overrides: Partial<IntervalSelectorProps> = {}): string {
  const natives = [
    native("1m", 60),
    native("5m", 300),
    native("15m", 900),
    native("1h", 3600),
    native("4h", 14400),
    native("1d", 86400),
  ];
  const customs = [custom("45m", true), custom("90m")];
  const previousLocale = getLocale();
  try {
    setLocale("zh-CN");
    return renderToStaticMarkup(
      <IntervalSelector
        interval="45m"
        capabilityReady
        capabilityLoading={false}
        nativeIntervals={natives}
        intervalGroups={[
          { label: "分钟级", labelZh: "分钟级", items: natives.filter((item) => item.seconds < 3600).map((item) => ({ ...item, isCustom: false })) },
          { label: "小时级", labelZh: "小时级", items: natives.filter((item) => item.seconds >= 3600 && item.seconds < 86400).map((item) => ({ ...item, isCustom: false })) },
          { label: "日线+", labelZh: "日线+", items: natives.filter((item) => item.seconds >= 86400).map((item) => ({ ...item, isCustom: false })) },
          { label: "自定义", labelZh: "自定义", items: customs.map((record) => ({ value: record.value, label: record.value, seconds: record.value === "45m" ? 2700 : 5400, isCustom: true })) },
        ]}
        customIntervalRecords={customs}
        savedCustomIntervals={customs.map((record) => record.value)}
        onSelectInterval={() => {}}
        onCreateCustomInterval={() => ({ ok: true, added: true })}
        onRemoveCustomInterval={() => {}}
        onRestoreCustomInterval={() => {}}
        onTogglePinCustomInterval={() => {}}
        onClearCustomIntervals={() => {}}
        intervalNotice={null}
        defaultOpen
        {...overrides}
      />,
    );
  } finally {
    setLocale(previousLocale);
  }
}

test("closed interval picker keeps the compact toolbar without the management table", () => {
  const html = render({ defaultOpen: false });
  assert.match(html, /class="interval-more-btn"/);
  assert.match(html, /id="interval-1m"/);
  assert.match(html, /class="interval-btn active custom-interval-btn/);
  assert.doesNotMatch(html, /class="interval-panel"/);
  assert.doesNotMatch(html, /class="interval-panel-row"/);
});

test("open interval picker uses a chip grid and keeps the create composer collapsed on the common tab", () => {
  const html = render();
  assert.match(html, /class="interval-panel"/);
  assert.match(html, /data-interval-chip="1m"/);
  assert.match(html, /data-interval-chip="45m"/);
  assert.match(html, /我的/);
  assert.doesNotMatch(html, /class="interval-panel-row"/);
  assert.doesNotMatch(html, /不用记格式/);
  assert.doesNotMatch(html, /data-interval-composer="true"/);
  assert.doesNotMatch(html, /2700s/);
});
