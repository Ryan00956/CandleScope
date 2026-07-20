import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeCustomIntervalRecords } from "../customIntervalStore.js";

test("persisted custom interval aliases migrate and merge into canonical records", () => {
  assert.deepEqual(sanitizeCustomIntervalRecords([
    {
      value: "60m",
      createdAt: 20,
      lastUsedAt: 30,
      usageCount: 2,
      pinned: false,
      order: 4,
    },
    {
      value: "1h",
      createdAt: 10,
      lastUsedAt: 40,
      usageCount: 3,
      pinned: true,
      order: 2,
    },
    {
      value: "7d",
      createdAt: 50,
      lastUsedAt: 0,
      usageCount: 0,
      pinned: false,
      order: 3,
    },
    {
      value: "1w",
      createdAt: 60,
      lastUsedAt: 0,
      usageCount: 0,
      pinned: false,
      order: 5,
    },
  ]), [
    {
      value: "1h",
      createdAt: 10,
      lastUsedAt: 40,
      usageCount: 5,
      pinned: true,
      order: 2,
    },
    {
      value: "7d",
      createdAt: 50,
      lastUsedAt: 0,
      usageCount: 0,
      pinned: false,
      order: 3,
    },
    {
      value: "1w",
      createdAt: 60,
      lastUsedAt: 0,
      usageCount: 0,
      pinned: false,
      order: 5,
    },
  ]);
});
