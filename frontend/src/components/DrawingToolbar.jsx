/**
 * Drawing toolbar — sits on the left side of the chart area.
 * Provides pen and eraser tools for freehand drawing on the chart.
 */
import { memo } from "react";

const TOOLS = [
  {
    id: "pen",
    label: "画笔",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        <path d="m15 5 4 4" />
      </svg>
    ),
  },
  {
    id: "eraser",
    label: "橡皮",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
        <path d="M22 21H7" />
        <path d="m5 11 9 9" />
      </svg>
    ),
  },
];

const DrawingToolbar = memo(function DrawingToolbar({
  activeTool,
  onToolChange,
  penColor,
  onPenColorChange,
  penSize,
  onPenSizeChange,
  eraserSize,
  onEraserSizeChange,
  onClearAll,
}) {
  const handleToolClick = (toolId) => {
    // Toggle: clicking the active tool deactivates it
    onToolChange(activeTool === toolId ? null : toolId);
  };

  return (
    <div className="drawing-toolbar">
      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          className={`drawing-tool-btn ${activeTool === tool.id ? "active" : ""}`}
          onClick={() => handleToolClick(tool.id)}
          title={tool.label}
        >
          {tool.icon}
        </button>
      ))}

      {/* Divider */}
      <div className="drawing-toolbar-divider" />

      {/* Pen color picker — only visible when pen is active */}
      {activeTool === "pen" && (
        <>
          <div className="drawing-tool-option" title="画笔颜色">
            <input
              type="color"
              className="drawing-color-picker"
              value={penColor}
              onChange={(e) => onPenColorChange(e.target.value)}
            />
          </div>
          <div className="drawing-tool-option" title={`画笔大小: ${penSize}px`}>
            <input
              type="range"
              className="drawing-size-slider"
              min="1"
              max="10"
              value={penSize}
              onChange={(e) => onPenSizeChange(Number(e.target.value))}
            />
          </div>
        </>
      )}

      {/* Eraser size — only visible when eraser is active */}
      {activeTool === "eraser" && (
        <div className="drawing-tool-option" title={`橡皮大小: ${eraserSize}px`}>
          <input
            type="range"
            className="drawing-size-slider"
            min="5"
            max="50"
            value={eraserSize}
            onChange={(e) => onEraserSizeChange(Number(e.target.value))}
          />
        </div>
      )}

      {/* Clear all button */}
      <div style={{ flex: 1 }} />
      <button
        className="drawing-tool-btn drawing-clear-btn"
        onClick={onClearAll}
        title="清除所有绘图"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
        </svg>
      </button>
    </div>
  );
});

export default DrawingToolbar;
