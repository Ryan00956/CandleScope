/**
 * TextEditOverlay — PPT-style inline text editor for chart text annotations.
 *
 * Renders an absolutely-positioned <textarea> over the chart at the same
 * pixel position, font, color and width as the underlying TextDrawingPrimitive,
 * giving the illusion of editing the text "in place".
 *
 * Behavior:
 *   - Multi-line: Enter inserts a newline, Ctrl/Cmd+Enter commits, Esc cancels
 *   - IME-friendly: Enter during composition is NOT treated as commit
 *   - Auto-grows in height to fit content
 *   - Width either matches the primitive's widthPx (when set) or grows with content
 *   - Stops mousedown/wheel/dblclick from bubbling to chart container
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type {
  KeyboardEvent,
  MutableRefObject,
  SyntheticEvent,
} from "react";
import type { ScreenPoint, TextAlign } from "../features/drawings/drawingTypes.js";

export interface TextEditOverlayProps {
  box: ScreenPoint | null;
  value: string;
  onChange(value: string): void;
  onCommit?(): boolean | void;
  onCancel?(): void;
  fontSize: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: TextAlign;
  color?: string;
  bgColor?: string | null;
  borderColor?: string | null;
  padding?: number;
  widthPx?: number | null;
  inputRef?: MutableRefObject<HTMLTextAreaElement | null>;
}

export default function TextEditOverlay({
  box,                  // { x, y, width, height } in CSS px relative to chart container
  value,
  onChange,
  onCommit,
  onCancel,
  fontSize,
  fontFamily = "'Inter', 'Segoe UI', sans-serif",
  bold = false,
  italic = false,
  underline = false,
  align = "left",
  color = "#e2e8f0",
  bgColor = null,
  borderColor = null,
  padding = 6,
  widthPx = null,
  inputRef,
}: TextEditOverlayProps) {
  const composingRef = useRef(false);
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = inputRef || localRef;

  // Auto-focus on mount
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Small delay so initial render places it correctly first
    const t = setTimeout(() => {
      el.focus();
      el.select();
    }, 10);
    return () => clearTimeout(t);
  }, [ref]);

  // Auto-size the textarea height to fit content
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, fontSize, bold, italic, widthPx, ref]);

  if (!box) return null;

  const stopBubble = (event: SyntheticEvent) => {
    event.stopPropagation();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel?.();
      return;
    }
    if (event.key === "Enter") {
      // Don't commit during IME composition — let Enter pick the candidate.
      if (composingRef.current || event.nativeEvent?.isComposing) return;
      // Ctrl/Cmd+Enter = commit; plain Enter = insert newline (default behavior)
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        onCommit?.();
      }
    }
  };

  const widthStyle =
    widthPx && isFinite(widthPx) ? { width: `${widthPx}px` } : { minWidth: "60px" };

  return (
    <div
      className="text-edit-overlay"
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        zIndex: 100,
        // Make the wrapper itself non-blocking outside the textarea so
        // selection of nearby UI still works, but allow events on the input.
        pointerEvents: "none",
      }}
    >
      <textarea
        ref={ref}
        className="text-edit-input"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onBlur={() => {
          // Defer so that mousedown on format-bar buttons (which preventDefault
          // to keep focus) doesn't immediately trigger commit before the click
          // fires.
          setTimeout(() => onCommit?.(), 0);
        }}
        onMouseDown={stopBubble}
        onMouseUp={stopBubble}
        onClick={stopBubble}
        onDoubleClick={stopBubble}
        onWheel={stopBubble}
        onContextMenu={stopBubble}
        spellCheck={false}
        rows={1}
        style={{
          pointerEvents: "auto",
          boxSizing: "border-box",
          padding: `${padding}px`,
          margin: 0,
          fontFamily,
          fontSize: `${fontSize}px`,
          fontWeight: bold ? "bold" : "normal",
          fontStyle: italic ? "italic" : "normal",
          textDecoration: underline ? "underline" : "none",
          textAlign: align,
          lineHeight: 1.3,
          color,
          background: bgColor || "transparent",
          border: `1px dashed ${borderColor || "#3b82f6"}`,
          borderRadius: "4px",
          outline: "none",
          resize: "none",
          overflow: "hidden",
          whiteSpace: widthPx ? "pre-wrap" : "pre",
          wordBreak: "break-word",
          caretColor: color,
          ...widthStyle,
        }}
      />
    </div>
  );
}
