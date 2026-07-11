const CornerTriangle = (
  <svg
    className="tool-variant-indicator"
    width="6"
    height="6"
    viewBox="0 0 6 6"
    style={{ position: "absolute", right: 2, bottom: 2 }}
  >
    <polygon points="6,0 6,6 0,6" fill="currentColor" opacity="0.55" />
  </svg>
);

export default function DrawingToolButton({
  active,
  anchorRef,
  children,
  dataDrawingTool,
  disabled = false,
  icon,
  onClick,
  onContextMenu,
  onDoubleClick,
  showVariantIndicator = false,
  title,
}) {
  return (
    <div className="drawing-tool-wrapper" ref={anchorRef}>
      <button
        type="button"
        className={`drawing-tool-btn ${active ? "active" : ""}`.trim()}
        data-drawing-tool={dataDrawingTool}
        disabled={disabled}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        title={title}
        aria-label={title}
      >
        {icon}
        {showVariantIndicator && CornerTriangle}
      </button>
      {!disabled && children}
    </div>
  );
}
