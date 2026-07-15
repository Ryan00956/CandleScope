import type { MutableRefObject } from "react";

export interface DrawingInteractionOverlayProps {
  readonly dynamicCanvasRef: MutableRefObject<HTMLCanvasElement | null>;
  readonly liveInkCanvasRef: MutableRefObject<HTMLCanvasElement | null>;
}

/** Two presentation-only surfaces. Pointer ownership always stays with LWC. */
export default function DrawingInteractionOverlay({
  dynamicCanvasRef,
  liveInkCanvasRef,
}: DrawingInteractionOverlayProps) {
  return (
    <div className="drawing-interaction-overlay" aria-hidden="true">
      <canvas
        ref={dynamicCanvasRef}
        className="drawing-interaction-canvas drawing-interaction-canvas-dynamic"
        data-drawing-overlay="dynamic"
      />
      <canvas
        ref={liveInkCanvasRef}
        className="drawing-interaction-canvas drawing-interaction-canvas-live-ink"
        data-drawing-overlay="live-ink"
      />
    </div>
  );
}
