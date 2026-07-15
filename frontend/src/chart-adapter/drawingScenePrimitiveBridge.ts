import type { DrawingFrameSnapshot } from "./drawingFrameSnapshot.js";

export interface DrawingSceneBridgePlan {
  readonly stamp: Readonly<{ surfaceGeneration: number }>;
}

export interface DrawingSceneBridgePrimitive<TPlan extends DrawingSceneBridgePlan> {
  publishPlan(plan: TPlan): boolean;
  clearPlan(requestUpdate?: boolean): void;
  releaseSurfaceCredentials(): void;
}

export interface DrawingScenePrimitiveBridgeOptions<
  TPrimitive extends DrawingSceneBridgePrimitive<TPlan>,
  TPlan extends DrawingSceneBridgePlan,
> {
  readonly primitive: TPrimitive;
  readonly attachPrimitive: (primitive: TPrimitive) => boolean;
  readonly detachPrimitive: (primitive: TPrimitive) => boolean;
  readonly captureDrawingFrame: () => DrawingFrameSnapshot | null;
  readonly isDrawingFrameCurrent: (frame: DrawingFrameSnapshot) => boolean;
}

export interface DrawingScenePrimitiveBridgeSnapshot {
  readonly attached: boolean;
  readonly attachedPrimitiveCount: 0 | 1;
  readonly surfaceGeneration: number | null;
}

export interface DrawingScenePrimitiveBridge<TPlan extends DrawingSceneBridgePlan> {
  attach(): boolean;
  detach(): boolean;
  publish(plan: TPlan): boolean;
  clearPlan(requestUpdate?: boolean): void;
  releaseSurfaceCredentials(): void;
  snapshot(): DrawingScenePrimitiveBridgeSnapshot;
}

/**
 * Generation-safe adapter boundary for the one visible drawing primitive.
 * Failed attach/detach operations retain their credentials so lifecycle code
 * can retry without silently duplicating ownership on another series.
 */
export function createDrawingScenePrimitiveBridge<
  TPrimitive extends DrawingSceneBridgePrimitive<TPlan>,
  TPlan extends DrawingSceneBridgePlan,
>({
  primitive,
  attachPrimitive,
  detachPrimitive,
  captureDrawingFrame,
  isDrawingFrameCurrent,
}: DrawingScenePrimitiveBridgeOptions<TPrimitive, TPlan>): DrawingScenePrimitiveBridge<TPlan> {
  let attached = false;
  let surfaceGeneration: number | null = null;

  const bridge: DrawingScenePrimitiveBridge<TPlan> = {
    attach() {
      if (attached) {
        const current = captureDrawingFrame();
        return !!current
          && isDrawingFrameCurrent(current)
          && current.surfaceGeneration === surfaceGeneration;
      }
      const frame = captureDrawingFrame();
      if (!frame || !isDrawingFrameCurrent(frame)) return false;
      if (!attachPrimitive(primitive)) return false;
      const attachedFrame = captureDrawingFrame();
      if (!attachedFrame
        || !isDrawingFrameCurrent(attachedFrame)
        || attachedFrame.surfaceGeneration !== frame.surfaceGeneration) {
        attached = true;
        surfaceGeneration = frame.surfaceGeneration;
        if (detachPrimitive(primitive)) {
          attached = false;
          surfaceGeneration = null;
          primitive.releaseSurfaceCredentials();
        }
        return false;
      }
      attached = true;
      surfaceGeneration = attachedFrame.surfaceGeneration;
      return true;
    },
    detach() {
      if (!attached) {
        primitive.clearPlan(false);
        return true;
      }
      if (!detachPrimitive(primitive)) return false;
      attached = false;
      surfaceGeneration = null;
      primitive.releaseSurfaceCredentials();
      return true;
    },
    publish(plan) {
      if (!attached || plan.stamp.surfaceGeneration !== surfaceGeneration) return false;
      const frame = captureDrawingFrame();
      if (!frame
        || !isDrawingFrameCurrent(frame)
        || frame.surfaceGeneration !== surfaceGeneration) return false;
      return primitive.publishPlan(plan);
    },
    clearPlan(requestUpdate = true) {
      primitive.clearPlan(requestUpdate);
    },
    releaseSurfaceCredentials() {
      attached = false;
      surfaceGeneration = null;
      primitive.releaseSurfaceCredentials();
    },
    snapshot() {
      return Object.freeze({
        attached,
        attachedPrimitiveCount: attached ? 1 as const : 0 as const,
        surfaceGeneration,
      });
    },
  };
  return Object.freeze(bridge);
}
