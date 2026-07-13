import { useCallback, useEffect, useRef, useState } from "react";
import { useDrawing } from "./drawingInteractionController.js";
import TextEditOverlay from "../../components/TextEditOverlay";
import TextFormatBar from "../../components/TextFormatBar";
import type { MutableRefObject } from "react";
import type {
    DrawingAnchorMode,
    DrawingChartAdapter,
    DrawingToolId,
    FibonacciLevel,
} from "./drawingTypes.js";
import type { DrawingStylePatch } from "./drawingInteractionController.js";
import type { SelectedDrawingMeta } from "./drawingSelectionController.js";

export interface DrawingEngineApi {
    clearAll(): void;
    prepareSurfaceDispose(): void;
    setHidden(hidden: boolean): void;
    updateSelectedDrawingStyle(patch: DrawingStylePatch): void;
    prepareExport(): void;
}

export interface DrawingEngineHostProps {
    chartAdapter: DrawingChartAdapter | null;
    chartContainerRef: MutableRefObject<HTMLElement | null>;
    activeTool: DrawingToolId | null;
    onToolChange?: ((tool: DrawingToolId | null) => void) | null;
    penColor: string;
    penSize: number;
    textFontSize: number;
    textBold: boolean;
    textItalic: boolean;
    fibLevels: FibonacciLevel[] | null;
    fibInverted: boolean;
    positionSize: number;
    drawingSnapEnabled: boolean;
    drawingKey: string;
    drawingSeriesGeneration: number;
    drawingCoordinateKey: string;
    drawingAnchorMode: DrawingAnchorMode;
    initialHidden?: boolean;
    onApiChange?: ((api: DrawingEngineApi | null) => void) | null;
    onSelectedDrawingChange?: ((drawing: SelectedDrawingMeta | null) => void) | null;
}

export default function DrawingEngineHost({
    chartAdapter,
    chartContainerRef,
    activeTool,
    onToolChange,
    penColor,
    penSize,
    textFontSize,
    textBold,
    textItalic,
    fibLevels,
    fibInverted,
    positionSize,
    drawingSnapEnabled,
    drawingKey,
    drawingSeriesGeneration,
    drawingCoordinateKey,
    drawingAnchorMode,
    initialHidden = false,
    onApiChange,
    onSelectedDrawingChange,
}: DrawingEngineHostProps) {
    const drawing = useDrawing({
        chartAdapter,
        chartContainerRef,
        activeTool,
        onToolChange,
        penColor,
        penSize,
        textFontSize,
        textBold,
        textItalic,
        fibLevels,
        fibInverted,
        positionSize,
        drawingSnapEnabled,
        symbol: drawingKey,
        seriesReady: drawingSeriesGeneration,
        drawingCoordinateKey,
        drawingAnchorMode,
    });
    const {
        clearAll,
        commitTextEditing,
        editingTextId,
        prepareSurfaceDispose,
        selectedDrawingMeta,
        setHidden,
        updateSelectedDrawingStyle,
    } = drawing;
    const appliedInitialHiddenRef = useRef(false);
    const editingTextIdRef = useRef(editingTextId);
    const commitTextEditingRef = useRef(commitTextEditing);
    const [chartContainerWidth, setChartContainerWidth] = useState<number>(0);

    useEffect(() => {
        editingTextIdRef.current = editingTextId;
        commitTextEditingRef.current = commitTextEditing;
    }, [commitTextEditing, editingTextId]);

    const prepareExport = useCallback(() => {
        if (editingTextIdRef.current) {
            commitTextEditingRef.current?.({ clearSelection: true, exitTool: false });
        }
    }, []);

    useEffect(() => {
        const el = chartContainerRef.current;
        if (!el) return undefined;

        const updateWidth = () => setChartContainerWidth(el.clientWidth || 0);
        updateWidth();

        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", updateWidth);
            return () => window.removeEventListener("resize", updateWidth);
        }

        const ro = new ResizeObserver(updateWidth);
        ro.observe(el);
        return () => ro.disconnect();
    }, [chartContainerRef]);

    useEffect(() => {
        if (appliedInitialHiddenRef.current) return;
        appliedInitialHiddenRef.current = true;
        if (initialHidden) setHidden(true);
    }, [initialHidden, setHidden]);

    useEffect(() => {
        onSelectedDrawingChange?.(selectedDrawingMeta);
    }, [onSelectedDrawingChange, selectedDrawingMeta]);

    useEffect(() => () => {
        onSelectedDrawingChange?.(null);
    }, [onSelectedDrawingChange]);

    useEffect(() => {
        onApiChange?.({
            clearAll,
            prepareSurfaceDispose,
            setHidden,
            updateSelectedDrawingStyle,
            prepareExport,
        });

        return () => {
            onApiChange?.(null);
        };
    }, [
        clearAll,
        onApiChange,
        prepareExport,
        prepareSurfaceDispose,
        setHidden,
        updateSelectedDrawingStyle,
    ]);

    return (
        <>
            <span data-drawing-engine="ready" hidden />

            {drawing.editingTextId && drawing.editingTextPos && (
                <TextEditOverlay
                    box={drawing.editingTextPos}
                    value={drawing.editingTextValue}
                    onChange={drawing.setEditingTextValue}
                    onCommit={drawing.commitTextEditing}
                    onCancel={drawing.cancelTextEditing}
                    fontSize={drawing.selectedTextSnapshot?.fontSize ?? textFontSize}
                    fontFamily={drawing.selectedTextSnapshot?.fontFamily}
                    bold={drawing.selectedTextSnapshot?.bold ?? textBold}
                    italic={drawing.selectedTextSnapshot?.italic ?? textItalic}
                    underline={drawing.selectedTextSnapshot?.underline ?? false}
                    align={drawing.selectedTextSnapshot?.align ?? "left"}
                    color={drawing.selectedTextSnapshot?.color ?? penColor}
                    bgColor={drawing.selectedTextSnapshot?.bgColor ?? null}
                    borderColor={drawing.selectedTextSnapshot?.borderColor ?? null}
                    padding={drawing.selectedTextSnapshot?.padding ?? 6}
                    widthPx={drawing.selectedTextSnapshot?.widthPx ?? null}
                    inputRef={drawing.editInputRef}
                />
            )}

            {!drawing.editingTextId && drawing.selectedTextSnapshot && drawing.selectedTextBox && (
                <TextFormatBar
                    position={{
                        x: drawing.selectedTextBox.x,
                        y: Math.max(2, drawing.selectedTextBox.y - 44),
                    }}
                    snapshot={drawing.selectedTextSnapshot}
                    onPatch={drawing.updateSelectedText}
                    onDelete={drawing.deleteSelected}
                    containerWidth={chartContainerWidth}
                />
            )}
        </>
    );
}
