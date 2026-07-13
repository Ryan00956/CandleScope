/**
 * TextFormatBar — Floating PPT-style format toolbar that appears above a
 * selected text annotation on the chart.
 *
 * Receives a "snapshot" of the current selected text's style fields and a
 * callback to apply patches to the live primitive.
 */
import { useState } from "react";
import type { SyntheticEvent } from "react";
import type { TextDrawingPatch } from "../features/drawings/drawingTypes.js";
import type { SelectedTextSnapshot } from "../features/drawings/drawingSelectionController.js";

const PRESET_COLORS = [
  "#f8fafc", "#e2e8f0", "#94a3b8", "#475569", "#0f172a",
  "#fbbf24", "#f97316", "#ef4444", "#ec4899",
  "#22c55e", "#10b981", "#06b6d4", "#3b82f6", "#8b5cf6",
];

const FONT_SIZE_PRESETS = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80];

interface ColorSwatchProps {
  value: string | null;
  onChange(value: string | null): void;
  allowNone?: boolean;
  title: string;
}

function ColorSwatch({ value, onChange, allowNone = false, title }: ColorSwatchProps) {
  const [open, setOpen] = useState(false);
  const isNone = !value || value === "transparent";

  return (
    <div className="tfb-color-wrap" title={title}>
      <button
        type="button"
        className="tfb-btn tfb-color-btn"
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="tfb-color-chip"
          style={{
            background: isNone
              ? "repeating-linear-gradient(45deg,#e11d48 0 2px,transparent 2px 5px)"
              : value,
          }}
        />
      </button>
      {open && (
        <div
          className="tfb-popover"
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="tfb-color-grid">
            {allowNone && (
              <button
                type="button"
                className="tfb-color-cell tfb-color-cell-none"
                onClick={() => { onChange(null); setOpen(false); }}
                title="无 / None"
              />
            )}
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="tfb-color-cell"
                style={{ background: c }}
                onClick={() => { onChange(c); setOpen(false); }}
              />
            ))}
          </div>
          <input
            type="color"
            className="tfb-color-input"
            value={isNone ? "#000000" : value}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

export interface TextFormatBarProps {
  position: { x: number; y: number } | null;
  snapshot: SelectedTextSnapshot | null;
  onPatch(patch: TextDrawingPatch): void;
  onDelete?: () => void;
  containerWidth?: number;
}

export default function TextFormatBar({
  position,            // { x, y } in CSS px relative to chart container
  snapshot,            // { color, fontSize, bold, italic, underline, align, bgColor, borderColor }
  onPatch,             // (partial) => void
  onDelete,            // () => void
  containerWidth = 0,  // chart container CSS width — used to clamp position
}: TextFormatBarProps) {
  // Local string state for the font-size input so the user can freely clear
  // and retype without the controlled value snapping back mid-edit.
  const snapshotFontSize = snapshot?.fontSize ?? 14;
  const [previousSnapshotFontSize, setPreviousSnapshotFontSize] = useState(snapshotFontSize);
  const [fontSizeText, setFontSizeText] = useState(String(snapshotFontSize));
  if (snapshotFontSize !== previousSnapshotFontSize) {
    setPreviousSnapshotFontSize(snapshotFontSize);
    setFontSizeText(String(snapshotFontSize));
  }

  if (!position || !snapshot) return null;

  // Clamp horizontally so the bar stays inside the chart.
  const BAR_WIDTH = 360;
  let left = position.x;
  if (containerWidth > 0) {
    if (left + BAR_WIDTH > containerWidth - 8) left = containerWidth - BAR_WIDTH - 8;
    if (left < 8) left = 8;
  }

  // Eat all mouse-related events so they don't bubble to chart-container.
  const stopAll = (event: SyntheticEvent) => { event.stopPropagation(); };

  return (
    <div
      className="text-format-bar"
      style={{
        position: "absolute",
        left,
        top: position.y,
        zIndex: 110,
      }}
      onMouseDown={(e) => { e.stopPropagation(); /* keep textarea focused if editing */ }}
      onMouseUp={stopAll}
      onClick={stopAll}
      onDoubleClick={stopAll}
      onWheel={stopAll}
      onContextMenu={stopAll}
    >
      {/* Font size */}
      <div className="tfb-group">
        <button
          type="button"
          className="tfb-btn tfb-btn-icon"
          title="缩小字号"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPatch({ fontSize: Math.max(8, (snapshot.fontSize || 14) - 2) })}
        >A−</button>
        <input
          type="number"
          min={8}
          max={200}
          step={1}
          className="tfb-fontsize-input"
          value={fontSizeText}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const raw = e.target.value;
            setFontSizeText(raw);
            // Only push to the primitive when the value is a valid in-range number.
            // This lets the user clear the field and retype freely.
            if (raw === "") return;
            const v = Number(raw);
            if (Number.isFinite(v) && v >= 8 && v <= 200) {
              onPatch({ fontSize: v });
            }
          }}
          onBlur={() => {
            // On blur, snap back to the current primitive value if the field
            // was left empty or out of range.
            const v = Number(fontSizeText);
            if (!Number.isFinite(v) || v < 8 || v > 200) {
              setFontSizeText(String(snapshot.fontSize));
            }
          }}
        />
        <button
          type="button"
          className="tfb-btn tfb-btn-icon"
          title="放大字号"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPatch({ fontSize: Math.min(200, (snapshot.fontSize || 14) + 2) })}
        >A+</button>
      </div>

      <div className="tfb-divider" />

      {/* Bold / Italic / Underline */}
      <div className="tfb-group">
        <button
          type="button"
          className={`tfb-btn tfb-btn-toggle ${snapshot.bold ? "active" : ""}`}
          title="粗体 (B)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPatch({ bold: !snapshot.bold })}
        ><b>B</b></button>
        <button
          type="button"
          className={`tfb-btn tfb-btn-toggle ${snapshot.italic ? "active" : ""}`}
          title="斜体 (I)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPatch({ italic: !snapshot.italic })}
        ><i>I</i></button>
        <button
          type="button"
          className={`tfb-btn tfb-btn-toggle ${snapshot.underline ? "active" : ""}`}
          title="下划线 (U)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPatch({ underline: !snapshot.underline })}
        ><u>U</u></button>
      </div>

      <div className="tfb-divider" />

      {/* Alignment */}
      <div className="tfb-group">
        {([
          { id: "left", label: "⇤" },
          { id: "center", label: "≡" },
          { id: "right", label: "⇥" },
        ] satisfies Array<{ id: SelectedTextSnapshot["align"]; label: string }>).map((a) => (
          <button
            key={a.id}
            type="button"
            className={`tfb-btn tfb-btn-toggle ${snapshot.align === a.id ? "active" : ""}`}
            title={`对齐: ${a.id}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPatch({ align: a.id })}
          >{a.label}</button>
        ))}
      </div>

      <div className="tfb-divider" />

      {/* Text color / Background / Border */}
      <div className="tfb-group">
        <span className="tfb-label" title="文字颜色">A</span>
        <ColorSwatch
          value={snapshot.color}
          onChange={(c) => c && onPatch({ color: c })}
          title="文字颜色"
        />
        <span className="tfb-label" title="背景色">▣</span>
        <ColorSwatch
          value={snapshot.bgColor}
          onChange={(c) => onPatch({ bgColor: c })}
          allowNone
          title="背景色"
        />
        <span className="tfb-label" title="边框">□</span>
        <ColorSwatch
          value={snapshot.borderColor}
          onChange={(c) => onPatch({ borderColor: c })}
          allowNone
          title="边框颜色"
        />
      </div>

      <div className="tfb-divider" />

      <button
        type="button"
        className="tfb-btn tfb-btn-danger"
        title="删除"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onDelete?.()}
      >Del</button>
    </div>
  );
}
