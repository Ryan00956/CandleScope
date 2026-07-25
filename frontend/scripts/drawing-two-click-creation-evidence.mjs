function ids(items) {
  return Array.isArray(items)
    ? items.map((item) => item?.id).filter((id) => typeof id === "string").sort()
    : [];
}

function addedIds(previousItems, currentItems) {
  const previous = new Set(ids(previousItems));
  return ids(currentItems).filter((id) => !previous.has(id));
}

function sameIds(left, right) {
  return JSON.stringify(ids(left)) === JSON.stringify(ids(right));
}

function count(snapshot, field) {
  const value = snapshot?.[field];
  return Number.isSafeInteger(value) ? value : null;
}

function runtimeCount(snapshot) {
  const value = snapshot?.runtimeSummary?.entityCount;
  return Number.isSafeInteger(value) ? value : null;
}

function runtimeTypeCount(snapshot, kind) {
  const value = snapshot?.runtimeSummary?.typeCounts?.[kind];
  return Number.isSafeInteger(value) ? value : 0;
}

function validLineSavedDrawing(drawing, expectedLineType) {
  if (drawing?.type !== "line" || drawing?.lineType !== expectedLineType) return false;
  if (!Array.isArray(drawing.dataPoints) || drawing.dataPoints.length < 2) return false;
  return JSON.stringify(drawing.dataPoints[0]) !== JSON.stringify(drawing.dataPoints.at(-1));
}

function validLineDocumentEntity(entity, expectedLineType) {
  if (entity?.kind !== "line"
    || entity?.geometryKind !== "line"
    || entity?.lineType !== expectedLineType) return false;
  return Number.isSafeInteger(entity.dataPointCount) && entity.dataPointCount >= 2;
}

/**
 * Proves that one two-point drawing is committed by exactly two pointer clicks.
 *
 * The first click may create an in-memory preview, but it must not mutate any
 * persisted/runtime entity count. The second click must add exactly one
 * matching line to localStorage, the IndexedDB document, and the runtime
 * summary. Comparing IDs also catches replacement or duplicate commits.
 */
export function assessTwoClickDrawingCreationEvidence({
  beforeFirstClick,
  afterFirstClick,
  afterSecondClick,
  expectedLineType = "line-segment",
} = {}) {
  const savedCountBefore = count(beforeFirstClick, "savedDrawingCount");
  const savedCountAfterFirst = count(afterFirstClick, "savedDrawingCount");
  const savedCountAfterSecond = count(afterSecondClick, "savedDrawingCount");
  const entityCountBefore = count(beforeFirstClick, "entityCount");
  const entityCountAfterFirst = count(afterFirstClick, "entityCount");
  const entityCountAfterSecond = count(afterSecondClick, "entityCount");
  const runtimeCountBefore = runtimeCount(beforeFirstClick);
  const runtimeCountAfterFirst = runtimeCount(afterFirstClick);
  const runtimeCountAfterSecond = runtimeCount(afterSecondClick);

  const firstClickCountsUnchanged = savedCountBefore !== null
    && entityCountBefore !== null
    && runtimeCountBefore !== null
    && savedCountAfterFirst === savedCountBefore
    && entityCountAfterFirst === entityCountBefore
    && runtimeCountAfterFirst === runtimeCountBefore;
  const firstClickIdsUnchanged = sameIds(
    beforeFirstClick?.savedDrawings,
    afterFirstClick?.savedDrawings,
  ) && sameIds(beforeFirstClick?.entities, afterFirstClick?.entities);

  const addedSavedIds = addedIds(
    beforeFirstClick?.savedDrawings,
    afterSecondClick?.savedDrawings,
  );
  const addedEntityIds = addedIds(
    beforeFirstClick?.entities,
    afterSecondClick?.entities,
  );
  const secondClickAddedExactlyOne = savedCountAfterSecond === savedCountBefore + 1
    && entityCountAfterSecond === entityCountBefore + 1
    && runtimeCountAfterSecond === runtimeCountBefore + 1
    && addedSavedIds.length === 1
    && addedEntityIds.length === 1
    && addedSavedIds[0] === addedEntityIds[0];

  const addedDrawingId = secondClickAddedExactlyOne ? addedSavedIds[0] : null;
  const addedSavedDrawing = addedDrawingId
    ? afterSecondClick?.savedDrawings?.find((drawing) => drawing?.id === addedDrawingId) ?? null
    : null;
  const addedEntity = addedDrawingId
    ? afterSecondClick?.entities?.find((entity) => entity?.id === addedDrawingId) ?? null
    : null;
  const lineGeometryValid = validLineSavedDrawing(addedSavedDrawing, expectedLineType)
    && validLineDocumentEntity(addedEntity, expectedLineType);
  const runtimeLineCountAdvanced = runtimeTypeCount(afterSecondClick, "line")
    === runtimeTypeCount(beforeFirstClick, "line") + 1;
  const documentRevisionAdvanced = Number.isSafeInteger(beforeFirstClick?.documentRevision)
    && Number.isSafeInteger(afterSecondClick?.documentRevision)
    && afterSecondClick.documentRevision > beforeFirstClick.documentRevision;

  return {
    passed: firstClickCountsUnchanged
      && firstClickIdsUnchanged
      && secondClickAddedExactlyOne
      && lineGeometryValid
      && runtimeLineCountAdvanced
      && documentRevisionAdvanced,
    expectedLineType,
    addedDrawingId,
    firstClickCountsUnchanged,
    firstClickIdsUnchanged,
    secondClickAddedExactlyOne,
    lineGeometryValid,
    runtimeLineCountAdvanced,
    documentRevisionAdvanced,
    counts: {
      beforeFirstClick: {
        saved: savedCountBefore,
        document: entityCountBefore,
        runtime: runtimeCountBefore,
      },
      afterFirstClick: {
        saved: savedCountAfterFirst,
        document: entityCountAfterFirst,
        runtime: runtimeCountAfterFirst,
      },
      afterSecondClick: {
        saved: savedCountAfterSecond,
        document: entityCountAfterSecond,
        runtime: runtimeCountAfterSecond,
      },
    },
    addedSavedIds,
    addedEntityIds,
  };
}
