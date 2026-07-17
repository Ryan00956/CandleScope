import type { DrawingFrameSnapshot } from "./drawingFrameSnapshot.js";

export interface DrawingSceneBridgePlan {
  readonly stamp: Readonly<{
    surfaceGeneration: number;
    dataRevision: number;
    projectionRevision: number;
    lineageIndexRevision: number;
    viewportRevision: number;
    themeRevision: number;
    widthCssPx: number;
    heightCssPx: number;
    dpr: number;
  }>;
}

export interface DrawingSceneBridgePaintAck<TPlan extends DrawingSceneBridgePlan> {
  readonly plan: TPlan;
  readonly stamp: TPlan["stamp"];
  readonly attachmentRevision: number;
  readonly paintSequence: number;
}

export type DrawingSceneBridgePaintListener<TPlan extends DrawingSceneBridgePlan> = (
  ack: DrawingSceneBridgePaintAck<TPlan>
) => void;

export interface DrawingSceneBridgePrimitive<TPlan extends DrawingSceneBridgePlan> {
  publishPlan(plan: TPlan): boolean;
  clearPlan(requestUpdate?: boolean): void;
  releaseSurfaceCredentials(): void;
  subscribePainted(listener: DrawingSceneBridgePaintListener<TPlan>): () => void;
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
  /** Rebuild after the current plan was painted against an advanced adapter frame. */
  readonly onCurrentPaintRejected?: () => void;
}

export interface DrawingScenePrimitiveBridgeSnapshot<TPlan extends DrawingSceneBridgePlan> {
  readonly attached: boolean;
  readonly attachedPrimitiveCount: 0 | 1;
  readonly surfaceGeneration: number | null;
  /** Exact plan currently owned by the composite primitive; null means visually blank. */
  readonly publishedPlan: TPlan | null;
  readonly lastPaintedStamp: TPlan["stamp"] | null;
}

export interface DrawingScenePrimitiveBridge<TPlan extends DrawingSceneBridgePlan> {
  attach(): boolean;
  detach(): boolean;
  publish(plan: TPlan): boolean;
  clearPlan(requestUpdate?: boolean): void;
  releaseSurfaceCredentials(): void;
  subscribePainted(listener: DrawingSceneBridgePaintListener<TPlan>): () => void;
  snapshot(): DrawingScenePrimitiveBridgeSnapshot<TPlan>;
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
  onCurrentPaintRejected,
}: DrawingScenePrimitiveBridgeOptions<TPrimitive, TPlan>): DrawingScenePrimitiveBridge<TPlan> {
  let attached = false;
  let surfaceGeneration: number | null = null;
  let publishedPlan: TPlan | null = null;
  let paintRecoveryRequestedForPlan: TPlan | null = null;
  let lastPaintedStamp: TPlan["stamp"] | null = null;
  let unsubscribePrimitivePaint: (() => void) | null = null;
  const paintListeners = new Set<DrawingSceneBridgePaintListener<TPlan>>();

  const planMatchesFrame = (
    plan: TPlan,
    frame: DrawingFrameSnapshot,
  ): boolean => plan.stamp.surfaceGeneration === frame.surfaceGeneration
    && plan.stamp.dataRevision === frame.dataRevision
    && plan.stamp.projectionRevision === frame.projectionRevision
    && plan.stamp.lineageIndexRevision === frame.lineageIndexRevision
    && plan.stamp.viewportRevision === frame.viewportRevision
    && plan.stamp.themeRevision === frame.themeRevision
    && plan.stamp.widthCssPx === frame.widthCssPx
    && plan.stamp.heightCssPx === frame.heightCssPx
    && plan.stamp.dpr === frame.dpr;

  const disconnectPrimitivePaint = (): void => {
    unsubscribePrimitivePaint?.();
    unsubscribePrimitivePaint = null;
  };

  const subscribeToPrimitivePaint = (): void => {
    unsubscribePrimitivePaint?.();
    unsubscribePrimitivePaint = primitive.subscribePainted((ack) => {
      if (!attached
        || surfaceGeneration === null
        || ack.plan !== publishedPlan
        || ack.stamp !== ack.plan.stamp
        || ack.stamp.surfaceGeneration !== surfaceGeneration) return;
      const frame = captureDrawingFrame();
      if (!frame || !isDrawingFrameCurrent(frame)) return;
      if (frame.surfaceGeneration !== surfaceGeneration) return;
      if (!planMatchesFrame(ack.plan, frame)) {
        // The renderer consumed the exact plan currently owned by this bridge,
        // so this is not a superseded draw. Ask the scene runtime to rebuild
        // from the newer atomic frame instead of waiting forever for an ACK
        // that can no longer become valid.
        if (paintRecoveryRequestedForPlan !== ack.plan) {
          paintRecoveryRequestedForPlan = ack.plan;
          try { onCurrentPaintRejected?.(); } catch { /* recovery is best effort */ }
        }
        return;
      }
      paintRecoveryRequestedForPlan = null;
      lastPaintedStamp = ack.stamp;
      for (const listener of Array.from(paintListeners)) {
        if (!paintListeners.has(listener)) continue;
        try {
          listener(ack);
        } catch {
          // Adapter observers must not escape into the LWC paint callback.
        }
      }
    });
  };

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
      publishedPlan = null;
      paintRecoveryRequestedForPlan = null;
      lastPaintedStamp = null;
      subscribeToPrimitivePaint();
      return true;
    },
    detach() {
      if (!attached) {
        primitive.clearPlan(false);
        publishedPlan = null;
        paintRecoveryRequestedForPlan = null;
        lastPaintedStamp = null;
        disconnectPrimitivePaint();
        return true;
      }
      if (!detachPrimitive(primitive)) return false;
      attached = false;
      surfaceGeneration = null;
      publishedPlan = null;
      paintRecoveryRequestedForPlan = null;
      lastPaintedStamp = null;
      disconnectPrimitivePaint();
      primitive.releaseSurfaceCredentials();
      return true;
    },
    publish(plan) {
      if (!attached || plan.stamp.surfaceGeneration !== surfaceGeneration) return false;
      const frame = captureDrawingFrame();
      if (!frame
        || !isDrawingFrameCurrent(frame)
        || frame.surfaceGeneration !== surfaceGeneration
        || !planMatchesFrame(plan, frame)) return false;
      const published = primitive.publishPlan(plan);
      if (!published) return false;
      // LWC paints only after publication returns. A synchronous callback from
      // a non-conforming primitive is intentionally ignored rather than
      // acknowledging a plan whose publication result was not yet known.
      publishedPlan = plan;
      paintRecoveryRequestedForPlan = null;
      lastPaintedStamp = null;
      return published;
    },
    clearPlan(requestUpdate = true) {
      publishedPlan = null;
      paintRecoveryRequestedForPlan = null;
      lastPaintedStamp = null;
      primitive.clearPlan(requestUpdate);
    },
    releaseSurfaceCredentials() {
      attached = false;
      surfaceGeneration = null;
      publishedPlan = null;
      paintRecoveryRequestedForPlan = null;
      lastPaintedStamp = null;
      disconnectPrimitivePaint();
      primitive.releaseSurfaceCredentials();
    },
    subscribePainted(listener) {
      if (!attached || typeof listener !== "function") return () => {};
      paintListeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        paintListeners.delete(listener);
      };
    },
    snapshot() {
      return Object.freeze({
        attached,
        attachedPrimitiveCount: attached ? 1 as const : 0 as const,
        surfaceGeneration,
        publishedPlan,
        lastPaintedStamp,
      });
    },
  };
  return Object.freeze(bridge);
}
