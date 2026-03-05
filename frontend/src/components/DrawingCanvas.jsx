/**
 * DrawingCanvas — transparent canvas overlay on the chart for freehand drawing.
 * Supports pen and eraser tools.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";

const DrawingCanvas = forwardRef(function DrawingCanvas(
  { activeTool, penColor, penSize, eraserSize },
  ref,
) {
  const canvasRef = useRef(null);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef(null);

  // Expose clearAll to parent
  useImperativeHandle(ref, () => ({
    clearAll: () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  }));

  // Resize canvas to match container
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      // Save current drawing
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const tempCtx = tempCanvas.getContext("2d");
      tempCtx.drawImage(canvas, 0, 0);

      // Resize
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;

      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);

      // Restore drawing (scale if needed)
      if (tempCanvas.width > 0 && tempCanvas.height > 0) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
    };

    resize();

    const resizeObserver = new ResizeObserver(() => resize());
    if (canvas.parentElement) {
      resizeObserver.observe(canvas.parentElement);
    }

    return () => resizeObserver.disconnect();
  }, []);

  const getCanvasPos = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();

    let clientX, clientY;
    if (e.touches) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }, []);

  const startDrawing = useCallback(
    (e) => {
      if (!activeTool) return;
      e.preventDefault();
      e.stopPropagation();

      isDrawingRef.current = true;
      const pos = getCanvasPos(e);
      if (!pos) return;
      lastPosRef.current = pos;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");

      if (activeTool === "pen") {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = penColor;
        ctx.lineWidth = penSize;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        // Draw a dot for single clicks
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, penSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = penColor;
        ctx.fill();
      } else if (activeTool === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.lineWidth = eraserSize;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        // Erase a dot for single clicks
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, eraserSize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    [activeTool, penColor, penSize, eraserSize, getCanvasPos],
  );

  const draw = useCallback(
    (e) => {
      if (!isDrawingRef.current || !activeTool) return;
      e.preventDefault();
      e.stopPropagation();

      const pos = getCanvasPos(e);
      if (!pos || !lastPosRef.current) return;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");

      if (activeTool === "pen") {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = penColor;
        ctx.lineWidth = penSize;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
      } else if (activeTool === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.lineWidth = eraserSize;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
      }

      ctx.beginPath();
      ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();

      lastPosRef.current = pos;
    },
    [activeTool, penColor, penSize, eraserSize, getCanvasPos],
  );

  const stopDrawing = useCallback((e) => {
    if (isDrawingRef.current) {
      e?.preventDefault();
      e?.stopPropagation();
    }
    isDrawingRef.current = false;
    lastPosRef.current = null;
  }, []);

  // Attach listeners
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Mouse events
    canvas.addEventListener("mousedown", startDrawing);
    canvas.addEventListener("mousemove", draw);
    canvas.addEventListener("mouseup", stopDrawing);
    canvas.addEventListener("mouseleave", stopDrawing);

    // Touch events
    canvas.addEventListener("touchstart", startDrawing, { passive: false });
    canvas.addEventListener("touchmove", draw, { passive: false });
    canvas.addEventListener("touchend", stopDrawing);
    canvas.addEventListener("touchcancel", stopDrawing);

    return () => {
      canvas.removeEventListener("mousedown", startDrawing);
      canvas.removeEventListener("mousemove", draw);
      canvas.removeEventListener("mouseup", stopDrawing);
      canvas.removeEventListener("mouseleave", stopDrawing);
      canvas.removeEventListener("touchstart", startDrawing);
      canvas.removeEventListener("touchmove", draw);
      canvas.removeEventListener("touchend", stopDrawing);
      canvas.removeEventListener("touchcancel", stopDrawing);
    };
  }, [startDrawing, draw, stopDrawing]);

  // Determine cursor style
  let cursorStyle = "default";
  if (activeTool === "pen") {
    cursorStyle = "crosshair";
  } else if (activeTool === "eraser") {
    cursorStyle = `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="${eraserSize}" height="${eraserSize}"><circle cx="${eraserSize / 2}" cy="${eraserSize / 2}" r="${eraserSize / 2 - 1}" fill="none" stroke="white" stroke-width="1.5"/></svg>') ${eraserSize / 2} ${eraserSize / 2}, auto`;
  }

  return (
    <canvas
      ref={canvasRef}
      className="drawing-canvas"
      style={{
        cursor: cursorStyle,
        pointerEvents: activeTool ? "auto" : "none",
      }}
    />
  );
});

export default DrawingCanvas;
