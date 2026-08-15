import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../BacktestApp.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../backtestApi.ts", import.meta.url), "utf8");
const chart = readFileSync(new URL("../BacktestResultChart.tsx", import.meta.url), "utf8");

test("M9 workspace exposes immutable revision compile, smoke, trace, compare and clone paths", () => {
  for (const token of ["StrategyRevision V2", "静态检查、编译并保存", "smoke 已通过",
    "rsi-trace-pane", "decision / fill", "生成新不可变 Run"]) {
    assert.match(app, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const path of ["/strategy-revisions", "/signal-trace", "/compare/pair", "/clone", "/review-bridge", "/review-bridges/"]) {
    assert.ok(api.includes(path));
  }
  for (const token of ["交易差异", "成本差异", "drawdownDaily", "完成后检查并揭示只读对比"]) {
    assert.ok(app.includes(token));
  }
});

test("M9 long curves and tables have explicit render bounds", () => {
  assert.match(app, /boundedRows\(report\.fills\)/);
  assert.match(app, /limit = 1_000/);
  assert.match(chart, /data\.length <= 2_000/);
  assert.match(chart, /slice\(-2_000\)/);
});
