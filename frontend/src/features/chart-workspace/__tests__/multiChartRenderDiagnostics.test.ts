import assert from "node:assert/strict";
import test from "node:test";

import { MultiChartRenderDiagnostics } from "../multiChartRenderDiagnostics.js";

test("multi-chart diagnostics keep React renders and DOM commits separate", () => {
  const diagnostics = new MultiChartRenderDiagnostics();
  diagnostics.recordRender("cell-2");
  diagnostics.recordRender("cell-1");
  diagnostics.recordRender("cell-1");
  diagnostics.recordCommit("cell-1");

  assert.deepEqual(diagnostics.snapshot(), {
    cells: [
      { cellId: "cell-1", reactRenders: 2, domCommits: 1 },
      { cellId: "cell-2", reactRenders: 1, domCommits: 0 },
    ],
    totalReactRenders: 3,
    totalDomCommits: 1,
  });

  diagnostics.reset();
  assert.deepEqual(diagnostics.snapshot(), {
    cells: [],
    totalReactRenders: 0,
    totalDomCommits: 0,
  });
});
