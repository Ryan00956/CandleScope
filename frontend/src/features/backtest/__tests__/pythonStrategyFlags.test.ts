import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isPythonStrategyEntryEnabled,
  isPythonTrustedLocalEnabled,
  pythonHostOwnsCopy,
} from "../backtestFlags.js";

describe("python strategy studio flag", () => {
  it("defaults off", () => {
    assert.equal(isPythonStrategyEntryEnabled({}), false);
    assert.equal(
      isPythonStrategyEntryEnabled({ VITE_BACKTEST_PYTHON_STRATEGY_ENABLED: "0" }),
      false,
    );
  });

  it("enables only on explicit truthy values", () => {
    assert.equal(
      isPythonStrategyEntryEnabled({ VITE_BACKTEST_PYTHON_STRATEGY_ENABLED: "1" }),
      true,
    );
  });

  it("states Host owns orders fills and reports", () => {
    assert.match(pythonHostOwnsCopy("zh-CN"), /Host/);
    assert.match(pythonHostOwnsCopy("zh-CN"), /成交/);
    assert.doesNotMatch(pythonHostOwnsCopy("en"), /成交/);
  });

  it("keeps TRUSTED_LOCAL off unless the frontend flag is explicit", () => {
    assert.equal(isPythonTrustedLocalEnabled({}), false);
    assert.equal(
      isPythonTrustedLocalEnabled({ VITE_BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED: "0" }),
      false,
    );
    assert.equal(
      isPythonTrustedLocalEnabled({ VITE_BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED: "1" }),
      true,
    );
  });
});
