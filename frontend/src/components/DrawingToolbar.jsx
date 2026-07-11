/**
 * Drawing toolbar sits on the left side of the chart area.
 *
 * Buttons: Mouse cursor, Pen/Highlighter, Eraser, Line, Shape, Text, Fibonacci, Position (Long/Short).
 * Left-click toggles the tool on/off.
 * Right-click or double-click on Cursor / Pen / Line / Shape opens a flyout to switch variants.
 *
 * All drawing is native (Plugin API), no pixel overlays.
 */
import { memo, useCallback, useEffect } from "react";
import { markPerfOnce } from "../runtime/performance/perfMarks";
import DrawingActionButtons from "./drawing/DrawingActionButtons.jsx";
import DrawingStyleControls from "./drawing/DrawingStyleControls.jsx";
import DrawingToolButton from "./drawing/DrawingToolButton.jsx";
import DrawingVariantToolButton from "./drawing/DrawingVariantToolButton.jsx";
import {
  CHART_TYPE_VARIANTS,
  CURSOR_VARIANTS,
  EraserIcon,
  FibonacciIcon,
  FREEHAND_VARIANTS,
  LINE_VARIANTS,
  MagnetIcon,
  POSITION_VARIANTS,
  SHAPE_VARIANTS,
  TextIcon,
} from "./drawing/drawingToolbarDefinitions.jsx";
import FibLevelsPanel from "./drawing/FibLevelsPanel.jsx";
import PositionSettingsPanel from "./drawing/PositionSettingsPanel.jsx";
import { useDrawingToolbarController } from "./drawing/useDrawingToolbarController.js";

const DrawingToolbar = memo(function DrawingToolbar({
  activeTool,
  onToolChange,
  penColor,
  onPenColorChange,
  penSize,
  onPenSizeChange,
  onClearAll,
  drawingsHidden = false,
  onToggleDrawingsHidden,
  drawingSnapEnabled = true,
  onDrawingSnapEnabledChange,
  // Text settings
  textFontSize = 14,
  onTextFontSizeChange,
  textBold = false,
  onTextBoldChange,
  textItalic = false,
  onTextItalicChange,
  // Fibonacci settings
  fibLevels,
  onFibLevelsChange,
  fibInverted = false,
  onFibInvertedChange,
  // Position settings
  positionSize = 1000,
  onPositionSizeChange,
  // Current stylable selection. The regular stroke controls update both this
  // existing drawing and the default style for subsequently created drawings.
  selectedDrawing = null,
  onSelectedDrawingStyleChange,
  exportPanelOpen = false,
  exportInProgress = false,
  onToggleExportPanel,
  chartType = "candlestick",
  onChartTypeChange,
}) {
  useEffect(() => {
    markPerfOnce("lazy.drawingToolbar.ready");
  }, []);

  const {
    chartTypeBtnRef,
    closeFlyout,
    currentChartType,
    currentCursorIcon,
    currentCursorId,
    currentCursorLabel,
    currentFreehandIcon,
    currentFreehandId,
    currentFreehandLabel,
    currentLineIcon,
    currentLineLabel,
    currentPosIcon,
    currentPosLabel,
    currentShapeIcon,
    currentShapeLabel,
    cursorBtnRef,
    fibBtnRef,
    flyoutOpen,
    freehandBtnRef,
    freehandOptionLabel,
    handleChartTypeClick,
    handleCursorClick,
    handleCursorContextMenu,
    handleCursorDblClick,
    handleEraserClick,
    handleExportClick,
    handleFibonacciClick,
    handleFibonacciSettingsContextMenu,
    handleFreehandClick,
    handleFreehandContextMenu,
    handleFreehandDblClick,
    handleLineClick,
    handleLineContextMenu,
    handleLineDblClick,
    handlePositionClick,
    handlePositionContextMenu,
    handlePositionDblClick,
    handleSelectChartType,
    handleSelectCursorVariant,
    handleSelectFreehandVariant,
    handleSelectLineVariant,
    handleSelectPositionVariant,
    handleSelectShapeVariant,
    handleShapeClick,
    handleShapeContextMenu,
    handleShapeDblClick,
    handleTextClick,
    handleToggleFibonacciSettings,
    handleTogglePositionSettings,
    isCursorActive,
    isEraserActive,
    isFibonacciActive,
    isFreehandActive,
    isLineActive,
    isPositionActive,
    isShapeActive,
    isTextActive,
    lineBtnRef,
    lineVariant,
    posBtnRef,
    posVariant,
    shapeBtnRef,
    shapeVariant,
    showFibonacciOptions,
    showLineOptions,
    showPenOptions,
    showPositionOptions,
    showShapeOptions,
    showTextOptions,
  } = useDrawingToolbarController({
    activeTool,
    chartType,
    onChartTypeChange,
    onToolChange,
    onToggleExportPanel,
  });

  const handleStrokeColorChange = useCallback((color) => {
    onPenColorChange?.(color);
    if (selectedDrawing) {
      onSelectedDrawingStyleChange?.({ color });
    }
  }, [onPenColorChange, onSelectedDrawingStyleChange, selectedDrawing]);

  const handleStrokeSizeChange = useCallback((lineWidth) => {
    onPenSizeChange?.(lineWidth);
    if (selectedDrawing) {
      onSelectedDrawingStyleChange?.({ lineWidth });
    }
  }, [onPenSizeChange, onSelectedDrawingStyleChange, selectedDrawing]);
  const drawingToolsDisabled = chartType === "renko";
  const drawingToolTitle = "Renko 暂不支持绘图工具";

  return (
    <div className="drawing-toolbar">
      <DrawingVariantToolButton
        active={flyoutOpen === "chart-type"}
        anchorRef={chartTypeBtnRef}
        buttonClassName="chart-type-tool-btn"
        currentId={chartType}
        dataChartType={chartType}
        flyoutClassName="chart-type-flyout"
        flyoutKey="chart-type"
        flyoutOpen={flyoutOpen}
        icon={currentChartType.icon}
        onClick={handleChartTypeClick}
        onCloseFlyout={closeFlyout}
        onSelect={handleSelectChartType}
        title={`Chart type: ${currentChartType.label}`}
        variants={CHART_TYPE_VARIANTS}
        wrapperClassName="chart-type-tool-wrapper"
      />

      <div className="drawing-toolbar-divider" />

      <DrawingVariantToolButton
        active={isCursorActive}
        anchorRef={cursorBtnRef}
        currentId={currentCursorId}
        dataDrawingTool="cursor"
        disabled={drawingToolsDisabled}
        flyoutKey="cursor"
        flyoutOpen={flyoutOpen}
        icon={currentCursorIcon}
        onClick={handleCursorClick}
        onCloseFlyout={closeFlyout}
        onContextMenu={handleCursorContextMenu}
        onDoubleClick={handleCursorDblClick}
        onSelect={handleSelectCursorVariant}
        title={drawingToolsDisabled ? drawingToolTitle : `${currentCursorLabel} (right-click or double-click to switch cursor)`}
        variants={CURSOR_VARIANTS}
      />

      <DrawingVariantToolButton
        active={isFreehandActive}
        anchorRef={freehandBtnRef}
        currentId={currentFreehandId}
        dataDrawingTool={currentFreehandId}
        disabled={drawingToolsDisabled}
        flyoutKey="freehand"
        flyoutOpen={flyoutOpen}
        icon={currentFreehandIcon}
        onClick={handleFreehandClick}
        onCloseFlyout={closeFlyout}
        onContextMenu={handleFreehandContextMenu}
        onDoubleClick={handleFreehandDblClick}
        onSelect={handleSelectFreehandVariant}
        title={drawingToolsDisabled ? drawingToolTitle : `${currentFreehandLabel} (right-click or double-click to switch pen type)`}
        variants={FREEHAND_VARIANTS}
      />

      <DrawingToolButton
        active={isEraserActive}
        dataDrawingTool="eraser"
        disabled={drawingToolsDisabled}
        icon={EraserIcon}
        onClick={handleEraserClick}
        title={drawingToolsDisabled ? drawingToolTitle : "Eraser"}
      />

      <DrawingVariantToolButton
        active={isLineActive}
        anchorRef={lineBtnRef}
        currentId={lineVariant}
        dataDrawingTool={lineVariant}
        disabled={drawingToolsDisabled}
        flyoutKey="line"
        flyoutOpen={flyoutOpen}
        icon={currentLineIcon}
        onClick={handleLineClick}
        onCloseFlyout={closeFlyout}
        onContextMenu={handleLineContextMenu}
        onDoubleClick={handleLineDblClick}
        onSelect={handleSelectLineVariant}
        title={drawingToolsDisabled ? drawingToolTitle : `${currentLineLabel} (right-click or double-click to switch mode)`}
        variants={LINE_VARIANTS}
      />

      <DrawingVariantToolButton
        active={isShapeActive}
        anchorRef={shapeBtnRef}
        currentId={shapeVariant}
        dataDrawingTool={shapeVariant}
        disabled={drawingToolsDisabled}
        flyoutKey="shape"
        flyoutOpen={flyoutOpen}
        icon={currentShapeIcon}
        onClick={handleShapeClick}
        onCloseFlyout={closeFlyout}
        onContextMenu={handleShapeContextMenu}
        onDoubleClick={handleShapeDblClick}
        onSelect={handleSelectShapeVariant}
        title={drawingToolsDisabled ? drawingToolTitle : `${currentShapeLabel} (right-click or double-click to switch shape; Shift locks square/circle)`}
        variants={SHAPE_VARIANTS}
      />

      <DrawingToolButton
        active={isTextActive}
        dataDrawingTool="text"
        disabled={drawingToolsDisabled}
        icon={TextIcon}
        onClick={handleTextClick}
        title={drawingToolsDisabled ? drawingToolTitle : "Text note"}
      />

      <DrawingToolButton
        active={isFibonacciActive}
        anchorRef={fibBtnRef}
        dataDrawingTool="fibonacci"
        disabled={drawingToolsDisabled}
        icon={FibonacciIcon}
        onClick={handleFibonacciClick}
        onContextMenu={handleFibonacciSettingsContextMenu}
        onDoubleClick={handleToggleFibonacciSettings}
        showVariantIndicator
        title={drawingToolsDisabled ? drawingToolTitle : "Fibonacci retracement (right-click or double-click for settings)"}
      >
        {flyoutOpen === "fib-levels" && (
          <FibLevelsPanel
            levels={fibLevels}
            onLevelsChange={(levels) => onFibLevelsChange?.(levels)}
            inverted={fibInverted}
            onInvertedChange={(v) => onFibInvertedChange?.(v)}
            onClose={closeFlyout}
            anchorRef={fibBtnRef}
          />
        )}
      </DrawingToolButton>

      <DrawingVariantToolButton
        active={isPositionActive}
        anchorRef={posBtnRef}
        currentId={posVariant}
        dataDrawingTool={posVariant}
        disabled={drawingToolsDisabled}
        flyoutKey="position"
        flyoutOpen={flyoutOpen}
        icon={currentPosIcon}
        onClick={handlePositionClick}
        onCloseFlyout={closeFlyout}
        onContextMenu={handlePositionContextMenu}
        onDoubleClick={handlePositionDblClick}
        onSelect={handleSelectPositionVariant}
        title={drawingToolsDisabled ? drawingToolTitle : `${currentPosLabel} (right-click or double-click to switch long/short)`}
        variants={POSITION_VARIANTS}
      >
        {flyoutOpen === "position-settings" && (
          <PositionSettingsPanel
            positionSize={positionSize}
            onPositionSizeChange={onPositionSizeChange}
            onClose={closeFlyout}
            anchorRef={posBtnRef}
          />
        )}
      </DrawingVariantToolButton>

      <DrawingToolButton
        active={drawingSnapEnabled}
        disabled={drawingToolsDisabled}
        icon={MagnetIcon}
        onClick={() => onDrawingSnapEnabledChange?.(!drawingSnapEnabled)}
        title={drawingToolsDisabled
          ? drawingToolTitle
          : (drawingSnapEnabled ? "Snap enabled (hold Alt to disable temporarily)" : "Snap disabled")}
      />

      {/* Divider */}
      <div className="drawing-toolbar-divider" />

      {!drawingToolsDisabled && <DrawingStyleControls
        freehandOptionLabel={freehandOptionLabel}
        onOpenPositionSettings={handleTogglePositionSettings}
        onPenColorChange={handleStrokeColorChange}
        onPenSizeChange={handleStrokeSizeChange}
        onTextBoldChange={onTextBoldChange}
        onTextFontSizeChange={onTextFontSizeChange}
        onTextItalicChange={onTextItalicChange}
        penColor={penColor}
        penSize={penSize}
        positionSize={positionSize}
        showFibonacciOptions={showFibonacciOptions}
        showLineOptions={showLineOptions}
        showPenOptions={showPenOptions}
        showPositionOptions={showPositionOptions}
        showShapeOptions={showShapeOptions}
        showTextOptions={showTextOptions}
        textBold={textBold}
        textFontSize={textFontSize}
        textItalic={textItalic}
      />}

      <DrawingActionButtons
        drawingsHidden={drawingsHidden}
        exportInProgress={exportInProgress}
        exportPanelOpen={exportPanelOpen}
        onClearAll={onClearAll}
        onToggleDrawingsHidden={onToggleDrawingsHidden}
        onToggleExportPanel={handleExportClick}
      />
    </div>
  );
});

export default DrawingToolbar;
