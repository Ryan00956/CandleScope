import assert from "node:assert/strict";
import test from "node:test";

import { applyDrawingCommands } from "../drawingCommands.js";
import type { DrawingCommand } from "../drawingCommands.js";
import {
  createDrawingDocument,
  createDrawingEntity,
  MAX_DRAWING_DOCUMENT_ENTITIES,
} from "../drawingDocument.js";
import type {
  DrawingDocument,
  DrawingEntityInput,
} from "../drawingDocument.js";

const SAMPLE_ROUNDS = 25;
const TRANSACTIONS_PER_SAMPLE = 12;
const WARMUP_ROUNDS = 6;
const COMMAND_KINDS = ["style", "move", "reorder"] as const;

type MeasuredCommandKind = (typeof COMMAND_KINDS)[number];

function lineInput(id: string, index: number): DrawingEntityInput {
  return {
    id,
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [
        { time: index * 10, price: index },
        { time: index * 10 + 5, price: index + 1 },
      ],
    },
    style: { kind: "line", color: "#000000", lineWidth: 2 },
  };
}

function percentile(samples: readonly number[], percentileValue: number): number {
  const sorted = [...samples].sort((first, second) => first - second);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

test("512-entity style, move, and reorder commands finish synchronously below the latency budget", (context) => {
  const ids = Array.from(
    { length: MAX_DRAWING_DOCUMENT_ENTITIES },
    (_, index) => `line-${index}`,
  );
  let document = createDrawingDocument({
    scopeKey: "performance-scope",
    entities: ids.map((id, index) => createDrawingEntity(lineInput(id, index))),
  });
  const forwardOrder = [...ids];
  const reverseOrder = [...ids].reverse();
  const commandVariants = {
    style: [
      [{ type: "update-style", id: ids[0] as string, patch: { color: "#ff3344" } }],
      [{ type: "update-style", id: ids[0] as string, patch: { color: "#33aaff" } }],
    ],
    move: [
      [{
        type: "move",
        id: ids[0] as string,
        geometry: {
          kind: "line",
          lineType: "line-segment",
          dataPoints: [{ time: 1, price: 1 }, { time: 6, price: 2 }],
        },
      }],
      [{
        type: "move",
        id: ids[0] as string,
        geometry: {
          kind: "line",
          lineType: "line-segment",
          dataPoints: [{ time: 2, price: 2 }, { time: 7, price: 3 }],
        },
      }],
    ],
    reorder: [
      [{ type: "reorder", order: forwardOrder }],
      [{ type: "reorder", order: reverseOrder }],
    ],
  } satisfies Record<
    MeasuredCommandKind,
    readonly [readonly DrawingCommand[], readonly DrawingCommand[]]
  >;
  const commandVariantIndexes: Record<MeasuredCommandKind, 0 | 1> = {
    move: 0,
    reorder: 0,
    style: 0,
  };

  assert.equal(document.entities.size, MAX_DRAWING_DOCUMENT_ENTITIES);

  function nextCommandBatch(kind: MeasuredCommandKind): readonly DrawingCommand[] {
    const nextIndex = commandVariantIndexes[kind] === 0 ? 1 : 0;
    commandVariantIndexes[kind] = nextIndex;
    return commandVariants[kind][nextIndex];
  }

  function nextMixedCommandBatch(): readonly DrawingCommand[] {
    return COMMAND_KINDS.flatMap((kind) => nextCommandBatch(kind));
  }

  function applySynchronously(commands: readonly DrawingCommand[]): void {
    const previousRevision = document.documentRevision;
    const previousEntity = document.entities.get(ids[0] as string);
    assert.ok(previousEntity);
    const previousFirstId = document.zOrder[0];
    const result = applyDrawingCommands(document, commands);
    assert.equal(
      typeof (result as unknown as { readonly then?: unknown }).then,
      "undefined",
      "drawing commands must return synchronously",
    );
    if (!result.ok) assert.fail(result.error);
    assert.equal(result.changed, true);
    assert.equal(result.document.documentRevision, previousRevision + 1);
    const nextEntity = result.document.entities.get(ids[0] as string);
    assert.ok(nextEntity);
    assert.equal(nextEntity.styleRevision, previousEntity.styleRevision + 1);
    assert.equal(nextEntity.geometryRevision, previousEntity.geometryRevision + 1);
    assert.notEqual(result.document.zOrder[0], previousFirstId);
    document = result.document;
  }

  function measureSample(): number {
    const transactions = Array.from(
      { length: TRANSACTIONS_PER_SAMPLE },
      () => COMMAND_KINDS.map((kind) => nextCommandBatch(kind)),
    ).flat();
    const revisionBeforeBatch = document.documentRevision;
    const startedAt = process.hrtime.bigint();
    for (const commands of transactions) {
      const result = applyDrawingCommands(document, commands);
      if (!result.ok) throw new Error(result.error);
      if (!result.changed) throw new Error("benchmark command batch was unexpectedly a no-op");
      document = result.document;
    }
    const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    assert.equal(document.documentRevision, revisionBeforeBatch + transactions.length);
    assert.equal(document.entities.size, MAX_DRAWING_DOCUMENT_ENTITIES);
    return elapsedMilliseconds / transactions.length;
  }

  // Confirm the contract before timing, then let V8 optimize the complete 512-entity path.
  applySynchronously(nextMixedCommandBatch());
  for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
    measureSample();
  }

  const samples: number[] = [];
  for (let round = 0; round < SAMPLE_ROUNDS; round += 1) {
    samples.push(measureSample());
  }

  const medianMilliseconds = percentile(samples, 0.5);
  const p95Milliseconds = percentile(samples, 0.95);
  context.diagnostic(
    `style/move/reorder: median=${medianMilliseconds.toFixed(3)}ms, p95=${p95Milliseconds.toFixed(3)}ms per command`,
  );
  assert.ok(
    p95Milliseconds < 1,
    `command p95 ${p95Milliseconds.toFixed(3)}ms exceeded the 1ms budget`,
  );
});
