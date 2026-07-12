import ToolFlyout from "./ToolFlyout.jsx";

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

export default function DrawingVariantToolButton({
  active,
  anchorRef,
  buttonClassName = "",
  children,
  currentId,
  dataChartType,
  dataDrawingTool,
  disabled = false,
  flyoutClassName = "",
  flyoutKey,
  flyoutOpen,
  icon,
  isVariantDisabled,
  onClick,
  onCloseFlyout,
  onContextMenu,
  onDoubleClick,
  onSelect,
  title,
  variants,
  wrapperClassName = "",
}) {
  return (
    <div className={`drawing-tool-wrapper ${wrapperClassName}`.trim()} ref={anchorRef}>
      <button
        type="button"
        className={`drawing-tool-btn ${buttonClassName} ${active ? "active" : ""}`.trim()}
        data-chart-type={dataChartType}
        data-drawing-tool={dataDrawingTool}
        disabled={disabled}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        title={title}
        aria-label={title}
      >
        {icon}
        {CornerTriangle}
      </button>
      {!disabled && flyoutOpen === flyoutKey && (
        <ToolFlyout
          variants={variants}
          currentId={currentId}
          onSelect={onSelect}
          onClose={onCloseFlyout}
          anchorRef={anchorRef}
          className={flyoutClassName}
          isVariantDisabled={isVariantDisabled}
        />
      )}
      {!disabled && children}
    </div>
  );
}
