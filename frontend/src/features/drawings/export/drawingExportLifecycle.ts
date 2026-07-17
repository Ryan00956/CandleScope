import type { DrawingExportLease } from "../drawingInteractionController.js";

const MAX_EXPORT_LIFECYCLE_TRANSACTIONS = 8;

export type DrawingExportLifecycleEventType =
  | "lease-prepared"
  | "capture-source-fixed"
  | "post-capture-revalidate"
  | "lease-restored"
  | "image-encoded"
  | "preview-published";

export interface DrawingExportLifecycleBounds {
  readonly entityId: string;
  readonly kind: string;
  readonly leftCssPx: number;
  readonly topCssPx: number;
  readonly rightCssPx: number;
  readonly bottomCssPx: number;
  readonly paddingCssPx: number;
}

export interface DrawingExportLifecycleEvent {
  readonly eventSequence: number;
  readonly type: DrawingExportLifecycleEventType;
  readonly observedAt: string;
  readonly valid?: boolean;
  readonly bytes?: number;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly mimeType?: string;
  readonly optionsKey?: string;
}

export interface DrawingExportLifecycleTransactionSnapshot {
  readonly transactionId: string;
  readonly transactionSequence: number;
  readonly leaseId: number;
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly hideDrawings: boolean;
  readonly persistence: Readonly<{
    persistedRevision: number;
    writePerformed: boolean;
  }>;
  readonly sceneKind: "settled-exact" | "hidden-frame" | "legacy-frame" | "unknown";
  readonly sceneStamp: Readonly<Record<string, unknown>> | null;
  readonly surfaceGeneration: number | null;
  readonly sceneEpoch: number | null;
  readonly attachmentRevision: number | null;
  readonly paintSequence: number | null;
  readonly barrierFrame: number;
  readonly drawableEntityCount: number;
  readonly drawingBounds: readonly DrawingExportLifecycleBounds[];
  readonly events: readonly DrawingExportLifecycleEvent[];
}

export interface DrawingExportLifecycleSnapshot {
  readonly schemaVersion: 1;
  readonly transactionCount: number;
  readonly transactions: readonly DrawingExportLifecycleTransactionSnapshot[];
}

export interface DrawingExportEncodedResult {
  readonly blob: Readonly<{ size: number }>;
  readonly width: number;
  readonly height: number;
  readonly mimeType: string;
  readonly optionsKey: string;
}

interface MutableDrawingExportLifecycleTransaction {
  readonly transactionId: string;
  readonly transactionSequence: number;
  readonly leaseId: number;
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly hideDrawings: boolean;
  readonly persistence: Readonly<{
    persistedRevision: number;
    writePerformed: boolean;
  }>;
  readonly sceneKind: DrawingExportLifecycleTransactionSnapshot["sceneKind"];
  readonly sceneStamp: Readonly<Record<string, unknown>> | null;
  readonly surfaceGeneration: number | null;
  readonly sceneEpoch: number | null;
  readonly attachmentRevision: number | null;
  readonly paintSequence: number | null;
  readonly barrierFrame: number;
  readonly drawableEntityCount: number;
  readonly drawingBounds: readonly DrawingExportLifecycleBounds[];
  readonly events: DrawingExportLifecycleEvent[];
}

export interface DrawingExportLifecycleTransaction {
  readonly transactionId: string;
  readonly leaseId: number;
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly hideDrawings: boolean;
  readonly surfaceGeneration: number | null;
  readonly sceneStamp: Readonly<Record<string, unknown>> | null;
  readonly sceneKind: DrawingExportLifecycleTransactionSnapshot["sceneKind"];
  readonly drawableEntityCount: number;
  readonly drawingBounds: readonly DrawingExportLifecycleBounds[];
}

let transactionSequence = 0;
let eventSequence = 0;
const transactions: MutableDrawingExportLifecycleTransaction[] = [];
const transactionRecords = new WeakMap<
  DrawingExportLifecycleTransaction,
  MutableDrawingExportLifecycleTransaction
>();

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function safeFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function copiedStamp(value: unknown): Readonly<Record<string, unknown>> | null {
  const stamp = objectValue(value);
  return stamp ? Object.freeze({ ...stamp }) : null;
}

function sceneKind(value: Record<string, unknown> | null): DrawingExportLifecycleTransactionSnapshot["sceneKind"] {
  if (value?.kind === "hidden-frame") return "hidden-frame";
  if (value?.kind === "legacy-frame") return "legacy-frame";
  if (value?.lodToleranceClass === "settledExact" && objectValue(value.stamp)) {
    return "settled-exact";
  }
  return "unknown";
}

function lineWidthCssPx(value: unknown): number {
  const renderSpec = objectValue(value);
  const lineWidth = safeFinite(renderSpec?.lineWidthCssPx);
  return lineWidth !== null && lineWidth > 0 ? lineWidth : 2;
}

function copiedDrawingBounds(scene: Record<string, unknown> | null): readonly DrawingExportLifecycleBounds[] {
  const plan = objectValue(scene?.plan);
  const entities = Array.isArray(plan?.entities) ? plan.entities : [];
  const rawBboxes = plan?.bboxes;
  if (!ArrayBuffer.isView(rawBboxes)) return Object.freeze([]);
  const bboxes = rawBboxes as unknown as ArrayLike<number>;
  const output: DrawingExportLifecycleBounds[] = [];
  for (let index = 0; index < entities.length; index += 1) {
    const entity = objectValue(entities[index]);
    const offset = index * 4;
    const left = safeFinite(bboxes[offset]);
    const top = safeFinite(bboxes[offset + 1]);
    const right = safeFinite(bboxes[offset + 2]);
    const bottom = safeFinite(bboxes[offset + 3]);
    if (!entity
      || typeof entity.id !== "string"
      || !entity.id
      || typeof entity.kind !== "string"
      || left === null
      || top === null
      || right === null
      || bottom === null
      || right < left
      || bottom < top) continue;
    const paddingCssPx = Math.max(6, Math.ceil(lineWidthCssPx(entity.renderSpec) * 2 + 4));
    output.push(Object.freeze({
      entityId: entity.id,
      kind: entity.kind,
      leftCssPx: left,
      topCssPx: top,
      rightCssPx: right,
      bottomCssPx: bottom,
      paddingCssPx,
    }));
  }
  return Object.freeze(output);
}

function appendEvent(
  transaction: DrawingExportLifecycleTransaction,
  type: DrawingExportLifecycleEventType,
  fields: Omit<DrawingExportLifecycleEvent, "eventSequence" | "type" | "observedAt"> = {},
): void {
  const record = transactionRecords.get(transaction);
  if (!record || !transactions.includes(record)) return;
  eventSequence += 1;
  record.events.push(Object.freeze({
    eventSequence,
    type,
    observedAt: new Date().toISOString(),
    ...fields,
  }));
}

function hasEvent(
  transaction: DrawingExportLifecycleTransaction,
  type: DrawingExportLifecycleEventType,
): boolean {
  return transactionRecords.get(transaction)?.events.some((event) => event.type === type) === true;
}

function lastEventType(
  transaction: DrawingExportLifecycleTransaction,
): DrawingExportLifecycleEventType | null {
  return transactionRecords.get(transaction)?.events.at(-1)?.type ?? null;
}

function revalidatedCurrent(
  transaction: DrawingExportLifecycleTransaction,
): boolean {
  const event = transactionRecords.get(transaction)?.events.find((candidate) => (
    candidate.type === "post-capture-revalidate"
  ));
  return event?.valid === true;
}

export function beginDrawingExportLifecycle(
  lease: DrawingExportLease,
  hideDrawings: boolean,
): DrawingExportLifecycleTransaction {
  const receipt = lease.receipt;
  const scene = objectValue(receipt.scene);
  const stamp = copiedStamp(scene?.stamp);
  const persistence = objectValue(receipt.persistence);
  transactionSequence += 1;
  const transactionId = `drawing-export-${transactionSequence}-lease-${lease.leaseId}`;
  const bounds = copiedDrawingBounds(scene);
  const record: MutableDrawingExportLifecycleTransaction = {
    transactionId,
    transactionSequence,
    leaseId: lease.leaseId,
    scopeKey: receipt.scopeKey,
    documentRevision: receipt.documentRevision,
    hideDrawings,
    persistence: Object.freeze({
      persistedRevision: safeNonNegativeInteger(persistence?.persistedRevision) ?? -1,
      writePerformed: persistence?.writePerformed === true,
    }),
    sceneKind: sceneKind(scene),
    sceneStamp: stamp,
    surfaceGeneration: safeNonNegativeInteger(stamp?.surfaceGeneration),
    sceneEpoch: safeNonNegativeInteger(scene?.sceneEpoch),
    attachmentRevision: safeNonNegativeInteger(scene?.attachmentRevision),
    paintSequence: safeNonNegativeInteger(scene?.paintSequence),
    barrierFrame: receipt.paint,
    drawableEntityCount: bounds.length,
    drawingBounds: bounds,
    events: [],
  };
  transactions.push(record);
  if (transactions.length > MAX_EXPORT_LIFECYCLE_TRANSACTIONS) transactions.shift();
  const transaction: DrawingExportLifecycleTransaction = Object.freeze({
    transactionId,
    leaseId: record.leaseId,
    scopeKey: record.scopeKey,
    documentRevision: record.documentRevision,
    hideDrawings: record.hideDrawings,
    surfaceGeneration: record.surfaceGeneration,
    sceneStamp: record.sceneStamp,
    sceneKind: record.sceneKind,
    drawableEntityCount: record.drawableEntityCount,
    drawingBounds: record.drawingBounds,
  });
  transactionRecords.set(transaction, record);
  appendEvent(transaction, "lease-prepared");
  return transaction;
}

export function recordDrawingExportCaptureSourceFixed(
  transaction: DrawingExportLifecycleTransaction | null,
): void {
  if (!transaction
    || hasEvent(transaction, "capture-source-fixed")
    || lastEventType(transaction) !== "lease-prepared") return;
  appendEvent(transaction, "capture-source-fixed");
}

export function recordDrawingExportPostCaptureRevalidate(
  transaction: DrawingExportLifecycleTransaction | null,
  valid: boolean,
): void {
  if (!transaction
    || hasEvent(transaction, "post-capture-revalidate")
    || lastEventType(transaction) !== "capture-source-fixed") return;
  appendEvent(transaction, "post-capture-revalidate", { valid: valid === true });
}

export function recordDrawingExportLeaseRestored(
  transaction: DrawingExportLifecycleTransaction | null,
): void {
  if (!transaction || hasEvent(transaction, "lease-restored")) return;
  const previous = lastEventType(transaction);
  if (previous !== "lease-prepared"
    && previous !== "capture-source-fixed"
    && previous !== "post-capture-revalidate") return;
  appendEvent(transaction, "lease-restored");
}

export function recordDrawingExportImageEncoded(
  transaction: DrawingExportLifecycleTransaction | null,
  result: DrawingExportEncodedResult,
): void {
  if (!transaction
    || hasEvent(transaction, "image-encoded")
    || lastEventType(transaction) !== "lease-restored"
    || !revalidatedCurrent(transaction)) return;
  appendEvent(transaction, "image-encoded", {
    bytes: result.blob.size,
    widthPx: result.width,
    heightPx: result.height,
    mimeType: result.mimeType,
    optionsKey: result.optionsKey,
  });
}

export function recordDrawingExportPreviewPublished(
  transaction: DrawingExportLifecycleTransaction | null,
): void {
  if (!transaction
    || hasEvent(transaction, "preview-published")
    || lastEventType(transaction) !== "image-encoded") return;
  appendEvent(transaction, "preview-published");
}

function snapshotTransaction(
  transaction: MutableDrawingExportLifecycleTransaction,
): DrawingExportLifecycleTransactionSnapshot {
  return Object.freeze({
    transactionId: transaction.transactionId,
    transactionSequence: transaction.transactionSequence,
    leaseId: transaction.leaseId,
    scopeKey: transaction.scopeKey,
    documentRevision: transaction.documentRevision,
    hideDrawings: transaction.hideDrawings,
    persistence: transaction.persistence,
    sceneKind: transaction.sceneKind,
    sceneStamp: transaction.sceneStamp,
    surfaceGeneration: transaction.surfaceGeneration,
    sceneEpoch: transaction.sceneEpoch,
    attachmentRevision: transaction.attachmentRevision,
    paintSequence: transaction.paintSequence,
    barrierFrame: transaction.barrierFrame,
    drawableEntityCount: transaction.drawableEntityCount,
    drawingBounds: transaction.drawingBounds,
    events: Object.freeze(transaction.events.map((event) => Object.freeze({ ...event }))),
  });
}

export function readDrawingExportLifecycle(): DrawingExportLifecycleSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    transactionCount: transactions.length,
    transactions: Object.freeze(transactions.map(snapshotTransaction)),
  });
}

export function resetDrawingExportLifecycle(): void {
  transactionSequence = 0;
  eventSequence = 0;
  transactions.length = 0;
}
