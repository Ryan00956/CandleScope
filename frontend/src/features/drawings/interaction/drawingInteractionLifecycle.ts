export type DrawingInteractionBoundaryKind = "chart-type" | "interval";
export type DrawingInteractionBoundaryCancellationReason =
  | "surface-dispose"
  | "coordinate-change";

export interface DrawingInteractionPointerDownEvent {
  readonly type: "pointer-down";
  readonly transactionId: string;
  readonly gestureId: string;
  readonly observedAt: string;
  readonly activeAfter: true;
}

export interface DrawingInteractionBoundaryChangeEvent {
  readonly type: "boundary-change";
  readonly transactionId: string;
  readonly gestureId: string;
  readonly observedAt: string;
  readonly boundaryKind: DrawingInteractionBoundaryKind;
  readonly beforeValue: string;
  readonly afterValue: string;
  readonly activeBefore: true;
}

export interface DrawingInteractionGestureCancelEvent {
  readonly type: "gesture-cancel";
  readonly transactionId: string;
  readonly gestureId: string;
  readonly observedAt: string;
  readonly reason: DrawingInteractionBoundaryCancellationReason;
  readonly activeAfter: false;
}

export interface DrawingInteractionBoundaryDescriptor {
  readonly kind: DrawingInteractionBoundaryKind;
  readonly beforeValue: string;
  readonly afterValue: string;
}

export interface DrawingInteractionLifecycleActiveGesture {
  readonly transactionId: string;
  readonly gestureId: string;
  readonly events: readonly [
    DrawingInteractionPointerDownEvent,
    ...DrawingInteractionBoundaryChangeEvent[],
  ];
}

export interface DrawingInteractionLifecycleCompletedGesture {
  readonly kind: DrawingInteractionBoundaryKind;
  readonly transactionId: string;
  readonly gestureId: string;
  readonly events: readonly [
    DrawingInteractionPointerDownEvent,
    DrawingInteractionBoundaryChangeEvent,
    DrawingInteractionGestureCancelEvent,
  ];
}

export interface DrawingInteractionLifecycleSnapshot {
  readonly active: DrawingInteractionLifecycleActiveGesture | null;
  readonly lastCompleted: DrawingInteractionLifecycleCompletedGesture | null;
}

export interface DrawingInteractionLifecycleRecorder {
  beginFreehandGesture(): DrawingInteractionLifecycleActiveGesture;
  markBoundaryChange(
    descriptor: DrawingInteractionBoundaryDescriptor,
  ): DrawingInteractionLifecycleActiveGesture | null;
  completeBoundaryCancellation(
    reason: DrawingInteractionBoundaryCancellationReason,
  ): DrawingInteractionLifecycleCompletedGesture | null;
  rollbackBoundaryChange(): boolean;
  abandonActiveGesture(): boolean;
  snapshot(): DrawingInteractionLifecycleSnapshot;
  reset(): void;
}

interface DrawingInteractionLifecycleRecorderOptions {
  readonly now?: () => number;
  readonly sessionId?: string;
}

function timestamp(now: () => number): string {
  const value = now();
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
}

function normalizedBoundaryDescriptor(
  descriptor: DrawingInteractionBoundaryDescriptor,
): DrawingInteractionBoundaryDescriptor | null {
  const beforeValue = descriptor.beforeValue.trim();
  const afterValue = descriptor.afterValue.trim();
  if ((descriptor.kind !== "chart-type" && descriptor.kind !== "interval")
    || !beforeValue
    || !afterValue
    || beforeValue === afterValue) return null;
  return Object.freeze({ kind: descriptor.kind, beforeValue, afterValue });
}

function expectedBoundaryReason(
  kind: DrawingInteractionBoundaryKind,
): DrawingInteractionBoundaryCancellationReason {
  return kind === "chart-type" ? "surface-dispose" : "coordinate-change";
}

function activeGesture(
  pointerDown: DrawingInteractionPointerDownEvent,
  boundaryChange?: DrawingInteractionBoundaryChangeEvent,
): DrawingInteractionLifecycleActiveGesture {
  return Object.freeze({
    transactionId: pointerDown.transactionId,
    gestureId: pointerDown.gestureId,
    events: Object.freeze(boundaryChange
      ? [pointerDown, boundaryChange] as const
      : [pointerDown] as const),
  });
}

export function createDrawingInteractionLifecycleRecorder({
  now = () => Date.now(),
  sessionId = `session-${Date.now().toString(36)}`,
}: DrawingInteractionLifecycleRecorderOptions = {}): DrawingInteractionLifecycleRecorder {
  const identityPrefix = sessionId.trim() || "drawing-interaction";
  let sequence = 0;
  let active: DrawingInteractionLifecycleActiveGesture | null = null;
  let lastCompleted: DrawingInteractionLifecycleCompletedGesture | null = null;

  return Object.freeze({
    beginFreehandGesture() {
      sequence = sequence >= Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
      const identity = `${identityPrefix}-${sequence}`;
      const transactionId = `transaction-${identity}`;
      const gestureId = `gesture-${identity}`;
      const pointerDown: DrawingInteractionPointerDownEvent = Object.freeze({
        type: "pointer-down",
        transactionId,
        gestureId,
        observedAt: timestamp(now),
        activeAfter: true,
      });
      active = activeGesture(pointerDown);
      return active;
    },

    markBoundaryChange(descriptor: DrawingInteractionBoundaryDescriptor) {
      const normalized = normalizedBoundaryDescriptor(descriptor);
      const pointerDown = active?.events[0];
      if (!normalized || !active || active.events.length !== 1 || !pointerDown) return null;
      const boundaryChange: DrawingInteractionBoundaryChangeEvent = Object.freeze({
        type: "boundary-change",
        transactionId: active.transactionId,
        gestureId: active.gestureId,
        observedAt: timestamp(now),
        boundaryKind: normalized.kind,
        beforeValue: normalized.beforeValue,
        afterValue: normalized.afterValue,
        activeBefore: true,
      });
      active = activeGesture(pointerDown, boundaryChange);
      return active;
    },

    completeBoundaryCancellation(reason: DrawingInteractionBoundaryCancellationReason) {
      const pointerDown = active?.events[0];
      const boundaryChange = active?.events[1];
      if (!active
        || active.events.length !== 2
        || !pointerDown
        || !boundaryChange
        || reason !== expectedBoundaryReason(boundaryChange.boundaryKind)) return null;
      const cancellation: DrawingInteractionGestureCancelEvent = Object.freeze({
        type: "gesture-cancel",
        transactionId: active.transactionId,
        gestureId: active.gestureId,
        observedAt: timestamp(now),
        reason,
        activeAfter: false,
      });
      lastCompleted = Object.freeze({
        kind: boundaryChange.boundaryKind,
        transactionId: active.transactionId,
        gestureId: active.gestureId,
        events: Object.freeze([pointerDown, boundaryChange, cancellation] as const),
      });
      active = null;
      return lastCompleted;
    },

    rollbackBoundaryChange() {
      const pointerDown = active?.events[0];
      if (!active || active.events.length !== 2 || !pointerDown) return false;
      active = activeGesture(pointerDown);
      return true;
    },

    abandonActiveGesture() {
      // Once a boundary-change receipt exists, that boundary owns terminal
      // telemetry. The physical cancel path may call this ordinary abandon
      // hook, but it must leave the two-event transaction intact so the
      // boundary owner can append the verified cancellation event afterward.
      if (!active || active.events.length !== 1) return false;
      active = null;
      return true;
    },

    snapshot() {
      return Object.freeze({ active, lastCompleted });
    },

    reset() {
      active = null;
      lastCompleted = null;
    },
  });
}

const drawingInteractionLifecycleRecorder = createDrawingInteractionLifecycleRecorder();

export function beginDrawingInteractionLifecycleFreehandGesture(
): DrawingInteractionLifecycleActiveGesture {
  return drawingInteractionLifecycleRecorder.beginFreehandGesture();
}

export function markDrawingInteractionLifecycleBoundaryChange(
  descriptor: DrawingInteractionBoundaryDescriptor,
): DrawingInteractionLifecycleActiveGesture | null {
  return drawingInteractionLifecycleRecorder.markBoundaryChange(descriptor);
}

export function completeDrawingInteractionLifecycleBoundaryCancellation(
  reason: DrawingInteractionBoundaryCancellationReason,
): DrawingInteractionLifecycleCompletedGesture | null {
  return drawingInteractionLifecycleRecorder.completeBoundaryCancellation(reason);
}

export function rollbackDrawingInteractionLifecycleBoundaryChange(): boolean {
  return drawingInteractionLifecycleRecorder.rollbackBoundaryChange();
}

export function abandonDrawingInteractionLifecycleActiveGesture(): boolean {
  return drawingInteractionLifecycleRecorder.abandonActiveGesture();
}

export function readDrawingInteractionLifecycle(): DrawingInteractionLifecycleSnapshot {
  return drawingInteractionLifecycleRecorder.snapshot();
}

export function resetDrawingInteractionLifecycle(): void {
  drawingInteractionLifecycleRecorder.reset();
}
