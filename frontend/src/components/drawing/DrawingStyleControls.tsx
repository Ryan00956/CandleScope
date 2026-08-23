import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";

const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32];
const COLOR_INPUT_FALLBACK_COMMIT_MS = 400;

export interface DrawingStyleControlsProps {
  freehandOptionLabel: string;
  onOpenPositionSettings(): void;
  onPenColorChange(color: string): void;
  onPenSizeChange(size: number): void;
  onTextBoldChange?: (bold: boolean) => void;
  onTextFontSizeChange?: (size: number) => void;
  onTextItalicChange?: (italic: boolean) => void;
  penColor: string;
  penSize: number;
  positionSize: number;
  showFibonacciOptions: boolean;
  showLineOptions: boolean;
  showPenOptions: boolean;
  showPositionOptions: boolean;
  showShapeOptions: boolean;
  showTextOptions: boolean;
  textBold: boolean;
  textFontSize: number;
  textItalic: boolean;
}

function formatPositionSize(positionSize: number): string | number {
  if (positionSize < 1000) return positionSize;
  return `${(positionSize / 1000).toFixed(positionSize % 1000 === 0 ? 0 : 1)}K`;
}

/**
 * A native color input emits `input` continuously while its palette is open.
 * Keep intermediate values local so palette movement never becomes a full
 * drawing-document update; a final event, quiet fallback, or the next chart
 * pointerdown promotes the last color exactly once.
 */
function DrawingColorPicker({
  color,
  onColorCommit,
}: Readonly<{
  color: string;
  onColorCommit(color: string): void;
}>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onColorCommitRef = useRef(onColorCommit);
  const previewColorRef = useRef(color);
  const committedColorRef = useRef(color);
  const pendingCommitColorRef = useRef<string | null>(null);
  const fallbackCommitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingRef = useRef(false);
  const [previewColor, setPreviewColor] = useState(color);

  useEffect(() => {
    onColorCommitRef.current = onColorCommit;
  }, [onColorCommit]);

  useEffect(() => {
    if (editingRef.current) return;
    if (pendingCommitColorRef.current !== null) {
      if (pendingCommitColorRef.current === color) {
        pendingCommitColorRef.current = null;
      } else {
        // The parent has not yet accepted our last commit. Do not briefly
        // restore its stale value while the selected drawing catches up.
        return;
      }
    }
    if (committedColorRef.current === color) return;
    committedColorRef.current = color;
    previewColorRef.current = color;
    setPreviewColor(color);
  }, [color]);

  const clearFallbackCommit = useCallback(() => {
    if (fallbackCommitTimeoutRef.current === null) return;
    clearTimeout(fallbackCommitTimeoutRef.current);
    fallbackCommitTimeoutRef.current = null;
  }, []);

  const commitPreviewColor = useCallback((
    nextColor = previewColorRef.current,
    synchronously = false,
  ) => {
    clearFallbackCommit();
    editingRef.current = false;
    previewColorRef.current = nextColor;
    setPreviewColor((currentColor) => (
      currentColor === nextColor ? currentColor : nextColor
    ));
    if (committedColorRef.current === nextColor) return;
    committedColorRef.current = nextColor;
    pendingCommitColorRef.current = nextColor;
    const commit = () => onColorCommitRef.current(nextColor);
    if (synchronously) flushSync(commit);
    else commit();
  }, [clearFallbackCommit]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return undefined;
    const handleNativeChange = () => commitPreviewColor(input.value, true);
    input.addEventListener("change", handleNativeChange);
    return () => input.removeEventListener("change", handleNativeChange);
  }, [commitPreviewColor]);

  const scheduleFallbackCommit = useCallback(() => {
    clearFallbackCommit();
    fallbackCommitTimeoutRef.current = setTimeout(() => {
      fallbackCommitTimeoutRef.current = null;
      commitPreviewColor();
    }, COLOR_INPUT_FALLBACK_COMMIT_MS);
  }, [clearFallbackCommit, commitPreviewColor]);

  useEffect(() => clearFallbackCommit, [clearFallbackCommit]);

  useEffect(() => {
    const commitBeforeDrawing = (event: PointerEvent) => {
      if (!editingRef.current || event.target === inputRef.current) return;
      // Some native color dialogs close without delivering `change` to the
      // page. A chart pointerdown must still see the last palette color.
      commitPreviewColor(previewColorRef.current, true);
    };
    window.addEventListener("pointerdown", commitBeforeDrawing, true);
    return () => window.removeEventListener("pointerdown", commitBeforeDrawing, true);
  }, [commitPreviewColor]);

  const handleInput = useCallback((event: FormEvent<HTMLInputElement>) => {
    const nextColor = event.currentTarget.value;
    editingRef.current = true;
    pendingCommitColorRef.current = null;
    previewColorRef.current = nextColor;
    setPreviewColor(nextColor);
    scheduleFallbackCommit();
  }, [scheduleFallbackCommit]);

  return (
    <input
      ref={inputRef}
      type="color"
      className="drawing-color-picker"
      value={previewColor}
      onFocus={() => { editingRef.current = true; }}
      onInput={handleInput}
      onBlur={() => commitPreviewColor(previewColorRef.current, true)}
    />
  );
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
}: DrawingStyleControlsProps) {
  useLocale();
  return (
    <>
      {showPenOptions && (
        <>
          <div className="drawing-tool-option" title={t("drawing.settings.freehandColor", { tool: freehandOptionLabel })}>
            <DrawingColorPicker color={penColor} onColorCommit={onPenColorChange} />
          </div>
          <div className="drawing-tool-option" title={t("drawing.settings.freehandSize", { tool: freehandOptionLabel, size: penSize })}>
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
          <div className="drawing-tool-option" title={t("drawing.settings.lineColor")}>
            <DrawingColorPicker color={penColor} onColorCommit={onPenColorChange} />
          </div>
          <div className="drawing-tool-option" title={t("drawing.settings.lineWidth", { size: penSize })}>
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
          <div className="drawing-tool-option" title={t("drawing.settings.textColor")}>
            <DrawingColorPicker color={penColor} onColorCommit={onPenColorChange} />
          </div>
          <div className="drawing-tool-option" title={t("drawing.settings.fontSize")}>
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
              title={t("drawing.settings.bold")}
              style={{ fontWeight: "bold", fontSize: 14, minWidth: 28 }}
            >
              B
            </button>
          </div>
          <div className="drawing-tool-option">
            <button
              className={`drawing-tool-btn drawing-format-btn ${textItalic ? "active" : ""}`}
              onClick={() => onTextItalicChange?.(!textItalic)}
              title={t("drawing.settings.italic")}
              style={{ fontStyle: "italic", fontSize: 14, minWidth: 28 }}
            >
              I
            </button>
          </div>
        </>
      )}

      {showPositionOptions && (
        <div className="drawing-tool-option" title={t("drawing.settings.positionSize")}>
          <button
            className="drawing-tool-btn drawing-format-btn position-settings-trigger"
            onClick={onOpenPositionSettings}
            title={t("drawing.settings.position")}
            style={{ fontSize: 11, minWidth: 50 }}
          >
            ${formatPositionSize(positionSize)}
          </button>
        </div>
      )}
    </>
  );
}
