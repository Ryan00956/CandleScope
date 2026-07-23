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
import type { MouseEvent } from "react";
import {
  CHART_DRAWING_ANCHOR_MODES,
  getChartTypeDescriptor,
} from "../features/chart-representation/chartTypeRegistry.js";
import {
  drawingToolForAnchorMode,
  hasSupportedDrawingVariant,
  supportsDrawingAnchorMode,
  supportsDrawingTool,
} from "../features/drawings/drawingCapabilities.js";
import { markPerfOnce } from "../runtime/performance/perfMarks";
import DrawingActionButtons from "./drawing/DrawingActionButtons.js";
import DrawingStyleControls from "./drawing/DrawingStyleControls.js";
import DrawingToolButton from "./drawing/DrawingToolButton.js";
import DrawingVariantToolButton from "./drawing/DrawingVariantToolButton.js";
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
} from "./drawing/drawingToolbarDefinitions.js";
import FibLevelsPanel from "./drawing/FibLevelsPanel.js";
import PositionSettingsPanel from "./drawing/PositionSettingsPanel.js";
import { useDrawingToolbarController } from "./drawing/useDrawingToolbarController.js";
import type { ToolbarVariant } from "./drawing/drawingToolbarDefinitions.js";
import type { DrawingStylePatch } from "../features/drawings/drawingInteractionController.js";
import type { SelectedDrawingMeta } from "../features/drawings/drawingSelectionController.js";
import type { DrawingToolId, FibonacciLevel } from "../features/drawings/drawingTypes.js";
import type { MainChartType } from "../shared/mainChartTypes.js";

export interface DrawingToolbarProps {
  activeTool: DrawingToolId | null;
  onToolChange?: (tool: DrawingToolId | null) => void;
  drawingInteractionReady?: boolean;
  penColor: string;
  onPenColorChange?: (color: string) => void;
  penSize: number;
  onPenSizeChange?: (size: number) => void;
  onClearAll(): void;
  drawingsHidden?: boolean;
  onToggleDrawingsHidden(): void;
  drawingSnapEnabled?: boolean;
  onDrawingSnapEnabledChange?: (enabled: boolean) => void;
  textFontSize?: number;
  onTextFontSizeChange?: (size: number) => void;
  textBold?: boolean;
  onTextBoldChange?: (bold: boolean) => void;
  textItalic?: boolean;
  onTextItalicChange?: (italic: boolean) => void;
  fibLevels?: FibonacciLevel[] | null;
  onFibLevelsChange?: (levels: FibonacciLevel[] | null) => void;
  fibInverted?: boolean;
  onFibInvertedChange?: (inverted: boolean) => void;
  positionSize?: number;
  onPositionSizeChange(size: number): void;
  selectedDrawing?: SelectedDrawingMeta | null;
  onSelectedDrawingStyleChange?: (patch: DrawingStylePatch) => void;
  exportPanelOpen?: boolean;
  exportInProgress?: boolean;
  onToggleExportPanel?: () => void;
  chartType?: MainChartType;
  onChartTypeChange?: (chartType: MainChartType) => void;
}

const DEFAULT_LINE_VARIANT = (() => {
  const variant = LINE_VARIANTS.find((item) => item.id === "line-segment");
  if (!variant) throw new Error("Missing required line-segment toolbar variant");
  return variant;
})();

const DrawingToolbar = memo(function DrawingToolbar({
  activeTool,
  onToolChange,
  drawingInteractionReady = true,
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
}: DrawingToolbarProps) {
  useEffect(() => {
    markPerfOnce("lazy.drawingToolbar.ready");
  }, []);

  const chartTypeDescriptor = getChartTypeDescriptor(chartType);
  const drawingAnchorMode = chartTypeDescriptor.drawingAnchorMode;
  const usesSourceLineageAnchors = drawingAnchorMode
    === CHART_DRAWING_ANCHOR_MODES.SOURCE_LINEAGE;
  const drawingFeaturesEnabled = supportsDrawingAnchorMode(drawingAnchorMode);
  const effectiveActiveTool = drawingToolForAnchorMode(drawingAnchorMode, activeTool);
  const handleCapabilityToolChange = useCallback((nextTool: DrawingToolId | null) => {
    if (nextTool == null || supportsDrawingTool(drawingAnchorMode, nextTool)) {
      onToolChange?.(nextTool);
    }
  }, [drawingAnchorMode, onToolChange]);
  const isVariantDisabled = useCallback(
    (variant: ToolbarVariant<DrawingToolId>) => !supportsDrawingTool(drawingAnchorMode, variant.id),
    [drawingAnchorMode],
  );

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
    activeTool: effectiveActiveTool,
    chartType,
    onToolChange: handleCapabilityToolChange,
    ...(onChartTypeChange === undefined ? {} : { onChartTypeChange }),
    ...(onToggleExportPanel === undefined ? {} : { onToggleExportPanel }),
  });

  const handleStrokeColorChange = useCallback((color: string) => {
    onPenColorChange?.(color);
    if (selectedDrawing) {
      onSelectedDrawingStyleChange?.({ color });
    }
  }, [onPenColorChange, onSelectedDrawingStyleChange, selectedDrawing]);

  const handleStrokeSizeChange = useCallback((lineWidth: number) => {
    onPenSizeChange?.(lineWidth);
    if (selectedDrawing) {
      onSelectedDrawingStyleChange?.({ lineWidth });
    }
  }, [onPenSizeChange, onSelectedDrawingStyleChange, selectedDrawing]);
  const drawingCapabilitiesDisabled = !drawingFeaturesEnabled;
  const drawingGestureToolsDisabled = drawingCapabilitiesDisabled || !drawingInteractionReady;
  const cursorToolsDisabled = !hasSupportedDrawingVariant(drawingAnchorMode, CURSOR_VARIANTS);
  const freehandToolsDisabled = drawingGestureToolsDisabled
    || !hasSupportedDrawingVariant(drawingAnchorMode, FREEHAND_VARIANTS);
  const eraserDisabled = drawingGestureToolsDisabled
    || !supportsDrawingTool(drawingAnchorMode, "eraser");
  const lineToolsDisabled = drawingGestureToolsDisabled
    || !hasSupportedDrawingVariant(drawingAnchorMode, LINE_VARIANTS);
  const shapeToolsDisabled = drawingGestureToolsDisabled
    || !hasSupportedDrawingVariant(drawingAnchorMode, SHAPE_VARIANTS);
  const textDisabled = drawingGestureToolsDisabled
    || !supportsDrawingTool(drawingAnchorMode, "text");
  const fibonacciDisabled = drawingGestureToolsDisabled
    || !supportsDrawingTool(drawingAnchorMode, "fibonacci");
  const positionToolsDisabled = drawingGestureToolsDisabled
    || !hasSupportedDrawingVariant(drawingAnchorMode, POSITION_VARIANTS);
  const lineVariantSupported = supportsDrawingTool(drawingAnchorMode, lineVariant);
  const displayedLineVariant = lineVariantSupported
    ? (LINE_VARIANTS.find((variant) => variant.id === lineVariant) || DEFAULT_LINE_VARIANT)
    : DEFAULT_LINE_VARIANT;
  const handleCapabilityLineClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (lineVariantSupported) {
      handleLineClick(event);
      return;
    }
    if (event?.detail > 1) return;
    if (isLineActive) handleCapabilityToolChange(null);
    else handleSelectLineVariant(DEFAULT_LINE_VARIANT.id);
    closeFlyout();
  }, [
    closeFlyout,
    handleCapabilityToolChange,
    handleLineClick,
    handleSelectLineVariant,
    isLineActive,
    lineVariantSupported,
  ]);
  const drawingToolTitle = !drawingFeaturesEnabled
    ? `${currentChartType.label} 当前坐标模式暂不支持此绘图工具`
    : "绘图引擎正在初始化";
  const selectedStyleType = selectedDrawing?.type ?? null;
  const selectedStyleControls = selectedStyleType === null ? null : {
    fibonacci: selectedStyleType === "fibonacci",
    line: selectedStyleType === "line"
      || selectedStyleType === "axis-line"
      || selectedStyleType === "angle",
    pen: selectedStyleType === "freehand" || selectedStyleType === "highlighter",
    position: selectedStyleType === "position",
    shape: selectedStyleType === "shape",
    text: selectedStyleType === "text",
  };
  const snapTitle = usesSourceLineageAnchors
    ? (drawingSnapEnabled
        ? "Snap enabled; drawings use absolute source time in future space (hold Alt to disable price snap)"
        : "Price snap disabled; drawings still use absolute source time in future space")
    : (drawingSnapEnabled
        ? "Snap enabled (hold Alt to disable temporarily)"
        : "Snap disabled");

  return (
    <div
      className="drawing-toolbar"
      data-drawing-toolbar-state={drawingInteractionReady ? "ready" : "waiting-for-engine"}
      aria-busy={!drawingInteractionReady}
    >
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
        disabled={cursorToolsDisabled}
        flyoutKey="cursor"
        flyoutOpen={flyoutOpen}
        icon={currentCursorIcon}
        onClick={handleCursorClick}
        onCloseFlyout={closeFlyout}
        onContextMenu={handleCursorContextMenu}
        onDoubleClick={handleCursorDblClick}
        onSelect={handleSelectCursorVariant}
        title={cursorToolsDisabled ? drawingToolTitle : `${currentCursorLabel} (right-click or double-click to switch cursor)`}
        variants={CURSOR_VARIANTS}
        isVariantDisabled={isVariantDisabled}
      />

      <DrawingVariantToolButton
        active={isFreehandActive}
        anchorRef={freehandBtnRef}
        currentId={currentFreehandId}
        dataDrawingTool={currentFreehandId}
        disabled={freehandToolsDisabled}
        flyoutKey="freehand"
        flyoutOpen={flyoutOpen}
        icon={currentFreehandIcon}
        onClick={handleFreehandClick}
        onCloseFlyout={closeFlyout}
        onContextMenu={handleFreehandContextMenu}
        onDoubleClick={handleFreehandDblClick}
        onSelect={handleSelectFreehandVariant}
        title={freehandToolsDisabled ? drawingToolTitle : `${currentFreehandLabel} (right-click or double-click to switch pen type)`}
        variants={FREEHAND_VARIANTS}
        isVariantDisabled={isVariantDisabled}
      />

      <DrawingToolButton
        active={isEraserActive}
        dataDrawingTool="eraser"
        disabled={eraserDisabled}
        icon={EraserIcon}
        onClick={handleEraserClick}
        title={eraserDisabled ? drawingToolTitle : "Eraser"}
      />

      <DrawingVariantToolButton
        active={isLineActive}
        anchorRef={lineBtnRef}
        currentId={displayedLineVariant.id}
        dataDrawingTool={displayedLineVariant.id}
        disabled={lineToolsDisabled}
        flyoutKey="line"
        flyoutOpen={flyoutOpen}
        icon={lineVariantSupported ? currentLineIcon : displayedLineVariant.icon}
        onClick={handleCapabilityLineClick}
        onCloseFlyout={closeFlyout}
        onContextMenu={handleLineContextMenu}
        onDoubleClick={handleLineDblClick}
        onSelect={handleSelectLineVariant}
        title={lineToolsDisabled ? drawingToolTitle : `${lineVariantSupported ? currentLineLabel : displayedLineVariant.label} (right-click or double-click to switch mode)`}
        variants={LINE_VARIANTS}
        isVariantDisabled={isVariantDisabled}
      />

      <DrawingVariantToolButton
        active={isShapeActive}
        anchorRef={shapeBtnRef}
        currentId={shapeVariant}
        dataDrawingTool={shapeVariant}
        disabled={shapeToolsDisabled}
        flyoutKey="shape"
        flyoutOpen={flyoutOpen}
        icon={currentShapeIcon}
        onClick={handleShapeClick}
        onCloseFlyout={closeFlyout}
        onContextMenu={handleShapeContextMenu}
        onDoubleClick={handleShapeDblClick}
        onSelect={handleSelectShapeVariant}
        title={shapeToolsDisabled ? drawingToolTitle : `${currentShapeLabel} (right-click or double-click to switch shape; Shift locks square/circle)`}
        variants={SHAPE_VARIANTS}
        isVariantDisabled={isVariantDisabled}
      />

      <DrawingToolButton
        active={isTextActive}
        dataDrawingTool="text"
        disabled={textDisabled}
        icon={TextIcon}
        onClick={handleTextClick}
        title={textDisabled ? drawingToolTitle : "Text note"}
      />

      <DrawingToolButton
        active={isFibonacciActive}
        anchorRef={fibBtnRef}
        dataDrawingTool="fibonacci"
        disabled={fibonacciDisabled}
        icon={FibonacciIcon}
        onClick={handleFibonacciClick}
        onContextMenu={handleFibonacciSettingsContextMenu}
        onDoubleClick={handleToggleFibonacciSettings}
        showVariantIndicator
        title={fibonacciDisabled ? drawingToolTitle : "Fibonacci retracement (right-click or double-click for settings)"}
      >
        {flyoutOpen === "fib-levels" && (
          <FibLevelsPanel
            {...(fibLevels === undefined ? {} : { levels: fibLevels })}
            onLevelsChange={(levels) => {
              onFibLevelsChange?.(levels);
            }}
            inverted={fibInverted}
            onInvertedChange={(v) => {
              onFibInvertedChange?.(v);
            }}
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
        disabled={positionToolsDisabled}
        flyoutKey="position"
        flyoutOpen={flyoutOpen}
        icon={currentPosIcon}
        onClick={handlePositionClick}
        onCloseFlyout={closeFlyout}
        onContextMenu={handlePositionContextMenu}
        onDoubleClick={handlePositionDblClick}
        onSelect={handleSelectPositionVariant}
        title={positionToolsDisabled ? drawingToolTitle : `${currentPosLabel} (right-click or double-click to switch long/short)`}
        variants={POSITION_VARIANTS}
        isVariantDisabled={isVariantDisabled}
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
        disabled={drawingCapabilitiesDisabled}
        icon={MagnetIcon}
        onClick={() => onDrawingSnapEnabledChange?.(!drawingSnapEnabled)}
        title={drawingCapabilitiesDisabled
          ? drawingToolTitle
          : snapTitle}
      />

      {/* Divider */}
      <div className="drawing-toolbar-divider" />

      {!drawingCapabilitiesDisabled && <DrawingStyleControls
        freehandOptionLabel={freehandOptionLabel}
        onOpenPositionSettings={handleTogglePositionSettings}
        onPenColorChange={handleStrokeColorChange}
        onPenSizeChange={handleStrokeSizeChange}
        {...(onTextBoldChange === undefined ? {} : { onTextBoldChange })}
        {...(onTextFontSizeChange === undefined ? {} : { onTextFontSizeChange })}
        {...(onTextItalicChange === undefined ? {} : { onTextItalicChange })}
        penColor={penColor}
        penSize={penSize}
        positionSize={positionSize}
        showFibonacciOptions={selectedStyleControls?.fibonacci ?? showFibonacciOptions}
        showLineOptions={selectedStyleControls?.line ?? showLineOptions}
        showPenOptions={selectedStyleControls?.pen ?? showPenOptions}
        showPositionOptions={selectedStyleControls?.position ?? showPositionOptions}
        showShapeOptions={selectedStyleControls?.shape ?? showShapeOptions}
        showTextOptions={selectedStyleControls?.text ?? showTextOptions}
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
