const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32];

function formatPositionSize(positionSize) {
  if (positionSize < 1000) return positionSize;
  return `${(positionSize / 1000).toFixed(positionSize % 1000 === 0 ? 0 : 1)}K`;
}

export default function DrawingStyleControls({
  freehandOptionLabel,
  onOpenPositionSettings,
  onPenColorChange,
  onPenSizeChange,
  onTextBoldChange,
  onTextFontSizeChange,
  onTextItalicChange,
  penColor,
  penSize,
  positionSize,
  showFibonacciOptions,
  showLineOptions,
  showPenOptions,
  showPositionOptions,
  showShapeOptions,
  showTextOptions,
  textBold,
  textFontSize,
  textItalic,
}) {
  return (
    <>
      {showPenOptions && (
        <>
          <div className="drawing-tool-option" title={`${freehandOptionLabel} color`}>
            <input
              type="color"
              className="drawing-color-picker"
              value={penColor}
              onChange={(event) => onPenColorChange(event.target.value)}
            />
          </div>
          <div className="drawing-tool-option" title={`${freehandOptionLabel} size: ${penSize}px`}>
            <input
              type="range"
              className="drawing-size-slider"
              min="1"
              max="10"
              value={penSize}
              onChange={(event) => onPenSizeChange(Number(event.target.value))}
            />
          </div>
        </>
      )}

      {(showLineOptions || showShapeOptions || showFibonacciOptions) && (
        <>
          <div className="drawing-tool-option" title="Line color">
            <input
              type="color"
              className="drawing-color-picker"
              value={penColor}
              onChange={(event) => onPenColorChange(event.target.value)}
            />
          </div>
          <div className="drawing-tool-option" title={`Line width: ${penSize}px`}>
            <input
              type="range"
              className="drawing-size-slider"
              min="1"
              max="10"
              value={penSize}
              onChange={(event) => onPenSizeChange(Number(event.target.value))}
            />
          </div>
        </>
      )}

      {showTextOptions && (
        <>
          <div className="drawing-tool-option" title="Text color">
            <input
              type="color"
              className="drawing-color-picker"
              value={penColor}
              onChange={(event) => onPenColorChange(event.target.value)}
            />
          </div>
          <div className="drawing-tool-option" title="Font size">
            <select
              className="drawing-font-size-select"
              value={textFontSize}
              onChange={(event) => onTextFontSizeChange?.(Number(event.target.value))}
            >
              {FONT_SIZES.map((size) => (
                <option key={size} value={size}>{size}px</option>
              ))}
            </select>
          </div>
          <div className="drawing-tool-option">
            <button
              className={`drawing-tool-btn drawing-format-btn ${textBold ? "active" : ""}`}
              onClick={() => onTextBoldChange?.(!textBold)}
              title="Bold"
              style={{ fontWeight: "bold", fontSize: 14, minWidth: 28 }}
            >
              B
            </button>
          </div>
          <div className="drawing-tool-option">
            <button
              className={`drawing-tool-btn drawing-format-btn ${textItalic ? "active" : ""}`}
              onClick={() => onTextItalicChange?.(!textItalic)}
              title="Italic"
              style={{ fontStyle: "italic", fontSize: 14, minWidth: 28 }}
            >
              I
            </button>
          </div>
        </>
      )}

      {showPositionOptions && (
        <div className="drawing-tool-option" title="Position size">
          <button
            className="drawing-tool-btn drawing-format-btn position-settings-trigger"
            onClick={onOpenPositionSettings}
            title="Position settings"
            style={{ fontSize: 11, minWidth: 50 }}
          >
            ${formatPositionSize(positionSize)}
          </button>
        </div>
      )}
    </>
  );
}
