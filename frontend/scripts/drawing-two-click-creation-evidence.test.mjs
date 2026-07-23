import assert from "node:assert/strict";
import test from "node:test";

import { assessTwoClickDrawingCreationEvidence } from "./drawing-two-click-creation-evidence.mjs";

function snapshot({
  documentRevision,
  drawings,
}) {
  return {
    documentRevision,
    savedDrawingCount: drawings.length,
    entityCount: drawings.length,
    runtimeSummary: {
      entityCount: drawings.length,
      typeCounts: {
        freehand: drawings.filter((drawing) => drawing.type === "freehand").length,
        line: drawings.filter((drawing) => drawing.type === "line").length,
      },
    },
    savedDrawings: drawings,
    entities: drawings.map((drawing) => ({
      id: drawing.id,
      kind: drawing.type,
      geometryKind: drawing.type,
      lineType: drawing.lineType ?? null,
      dataPointCount: drawing.dataPoints?.length ?? 0,
    })),
  };
}

const pen = {
  id: "pen-1",
  type: "freehand",
};
const firstLine = {
  id: "line-1",
  type: "line",
  lineType: "line-segment",
  dataPoints: [
    { time: 1, price: 100 },
    { time: 2, price: 101 },
  ],
};

test("accepts a line added on the second click with storage, document, and runtime agreement", () => {
  const before = snapshot({ documentRevision: 1, drawings: [pen] });
  const afterFirst = snapshot({ documentRevision: 1, drawings: [pen] });
  const afterSecond = snapshot({ documentRevision: 2, drawings: [pen, firstLine] });

  const evidence = assessTwoClickDrawingCreationEvidence({
    beforeFirstClick: before,
    afterFirstClick: afterFirst,
    afterSecondClick: afterSecond,
  });

  assert.equal(evidence.passed, true);
  assert.equal(evidence.addedDrawingId, "line-1");
  assert.deepEqual(evidence.counts, {
    beforeFirstClick: { saved: 1, document: 1, runtime: 1 },
    afterFirstClick: { saved: 1, document: 1, runtime: 1 },
    afterSecondClick: { saved: 2, document: 2, runtime: 2 },
  });
});

test("rejects the swallowed-first-click sequence where two clicks do not commit a line", () => {
  const before = snapshot({ documentRevision: 1, drawings: [pen] });
  const afterFirst = snapshot({ documentRevision: 1, drawings: [pen] });
  const afterSecond = snapshot({ documentRevision: 1, drawings: [pen] });

  const evidence = assessTwoClickDrawingCreationEvidence({
    beforeFirstClick: before,
    afterFirstClick: afterFirst,
    afterSecondClick: afterSecond,
  });

  assert.equal(evidence.passed, false);
  assert.equal(evidence.firstClickCountsUnchanged, true);
  assert.equal(evidence.secondClickAddedExactlyOne, false);
});

test("rejects a premature or duplicate commit even when the final count is higher", () => {
  const duplicateLine = {
    ...firstLine,
    id: "line-2",
  };
  const before = snapshot({ documentRevision: 1, drawings: [pen] });
  const afterFirst = snapshot({ documentRevision: 2, drawings: [pen, firstLine] });
  const afterSecond = snapshot({
    documentRevision: 3,
    drawings: [pen, firstLine, duplicateLine],
  });

  const evidence = assessTwoClickDrawingCreationEvidence({
    beforeFirstClick: before,
    afterFirstClick: afterFirst,
    afterSecondClick: afterSecond,
  });

  assert.equal(evidence.passed, false);
  assert.equal(evidence.firstClickCountsUnchanged, false);
  assert.equal(evidence.secondClickAddedExactlyOne, false);
});
