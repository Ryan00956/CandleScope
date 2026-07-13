import assert from "node:assert/strict";
import test from "node:test";

import { readCanaryValue } from "./entry.js";

test("JS tests resolve TS sources whose TS dependency uses a .js specifier", () => {
  assert.equal(readCanaryValue(), "mixed-mode-ok");
});
