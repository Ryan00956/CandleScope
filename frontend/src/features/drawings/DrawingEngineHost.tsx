import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useDrawing } from "./drawingInteractionController.js";
import TextEditOverlay from "../../components/TextEditOverlay";
import TextFormatBar from "../../components/TextFormatBar";
import DrawingInteractionOverlay from "./rendering/DrawingInteractionOverlay.js";
import {
    resolveDrawingInteractionSurfaceMode,
    resolveEffectiveDrawingInteractionSurfaceMode,
} from "./interactionSurfaceMode.js";
import { resolvePhase4DrawingEngineMode } from "./drawingEngineMode.js";
import { drawingPerfCounters } from "./performance/drawingPerfCounters.js";
import type { MutableRefObject } from "react";
import type {
    DrawingAnchorMode,
    DrawingChartAdapter,
    DrawingToolId,
    FibonacciLevel,
} from "./drawingTypes.js";
import type {
    DrawingExportLease,
    DrawingExportPrepareOptions,
    DrawingStylePatch,
} from "./drawingInteractionController.js";
import type { SelectedDrawingMeta } from "./drawingSelectionController.js";

export interface DrawingEngineApi {
    clearAll(): void;
    completeSurfaceDispose(): void;
    invalidateSurfaceCredentialsForSeriesReplacement(): void;
    prepareSurfaceDispose(): boolean;
    setHidden(hidden: boolean): void;
    updateSelectedDrawingStyle(patch: DrawingStylePatch): void;
    prepareExport(options?: DrawingExportPrepareOptions): Promise<DrawingExportLease>;
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

function DrawingEngineHost({
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
    const dynamicCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const liveInkCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const [interactionSurfaceMode, setInteractionSurfaceMode] = useState(
        () => {
            const requested = resolveDrawingInteractionSurfaceMode().mode;
            return resolveEffectiveDrawingInteractionSurfaceMode(
                requested,
                resolvePhase4DrawingEngineMode().effective,
            );
        },
    );
    const handleInteractionSurfaceFallback = useCallback(() => {
        // The rollout flag is mount-locked, but a scene-canary initialization
        // failure is allowed to make one fail-closed transition. Keep the
        // interaction owner aligned with the legacy static surface that the
        // persistence lifecycle just restored.
        setInteractionSurfaceMode("legacy");
    }, []);
    const drawing = useDrawing({
        chartAdapter,
        chartContainerRef,
        activeTool,
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
        interactionSurfaceMode,
        dynamicCanvasRef,
        liveInkCanvasRef,
        onInteractionSurfaceFallback: handleInteractionSurfaceFallback,
        ...(onToolChange === undefined ? {} : { onToolChange }),
    });
    const {
        clearAll,
        completeSurfaceDispose,
        invalidateSurfaceCredentialsForSeriesReplacement,
        prepareExport,
        prepareSurfaceDispose,
        selectedDrawingMeta,
        setHidden,
        updateSelectedDrawingStyle,
    } = drawing;
    const legacyPrimitiveEvidence = drawing.getLegacyPrimitiveRuntimeEvidence();
    const appliedInitialHiddenRef = useRef(false);
    const [chartContainerWidth, setChartContainerWidth] = useState<number>(0);

    useEffect(() => {
        drawingPerfCounters.incrementCounter("reactRenderCount");
    });

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
            completeSurfaceDispose,
            invalidateSurfaceCredentialsForSeriesReplacement,
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
        completeSurfaceDispose,
        invalidateSurfaceCredentialsForSeriesReplacement,
        onApiChange,
        prepareExport,
        prepareSurfaceDispose,
        setHidden,
        updateSelectedDrawingStyle,
    ]);

    return (
        <>
            <span data-drawing-engine="ready" hidden />
            <span
                data-drawing-interaction-mode={interactionSurfaceMode}
                data-drawing-editing-text-id={drawing.editingTextId ?? ""}
                data-drawing-editing-text-position={drawing.editingTextPos
                    ? `${drawing.editingTextPos.x},${drawing.editingTextPos.y}`
                    : ""}
                hidden
            />
            <span
                data-drawing-registry-kind={legacyPrimitiveEvidence.registryKind}
                data-drawing-legacy-instances={legacyPrimitiveEvidence.legacyPrimitiveInstanceCount}
                data-drawing-legacy-attached={legacyPrimitiveEvidence.legacyPrimitiveAttachedCount}
                data-drawing-zero-legacy={legacyPrimitiveEvidence.zeroLegacyPrimitiveInvariant ? "true" : "false"}
                hidden
            />

            {interactionSurfaceMode === "overlay" && (
                <DrawingInteractionOverlay
                    dynamicCanvasRef={dynamicCanvasRef}
                    liveInkCanvasRef={liveInkCanvasRef}
                />
            )}

            {drawing.editingTextId && drawing.editingTextPos && (
                <TextEditOverlay
                    box={drawing.editingTextPos}
                    value={drawing.editingTextValue}
                    onChange={drawing.setEditingTextValue}
                    onCommit={drawing.commitTextEditing}
                    onCancel={drawing.cancelTextEditing}
                    fontSize={drawing.selectedTextSnapshot?.fontSize ?? textFontSize}
                    {...(drawing.selectedTextSnapshot?.fontFamily === undefined
                        ? {}
                        : { fontFamily: drawing.selectedTextSnapshot.fontFamily })}
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

export default memo(DrawingEngineHost);
