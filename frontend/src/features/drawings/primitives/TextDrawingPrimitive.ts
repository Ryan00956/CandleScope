/**
 * TextDrawingPrimitive — Lightweight Charts v5 Plugin API (ISeriesPrimitive)
 *
 * Renders a PPT-style text annotation directly inside the chart's native
 * Canvas pipeline via series.attachPrimitive(). The text anchor (top-left
 * of the box content area, in data coords time + price) survives timeframe
 * switches and follows pan/zoom with zero lag.
 *
 * Features:
 *   - Multi-line text (\n separated) with optional word-wrap when widthPx is set
 *   - Color / fontSize / bold / italic / underline / horizontal alignment
 *   - Optional rounded background fill + border
 *   - Selection bounding box with 8 resize handles (4 corners + 4 sides)
 *   - Hit-testing returns whether body, corner handle, or side handle was hit
 *   - Hover highlight for eraser tool
 */

import { drawingDataPointsToCoordinates } from "./coordinateUtils.js";
import type {
  DrawingAttachedParameter,
  DrawingDataPoint,
  DrawingHit,
  PrimitiveCanvasTarget,
  PrimitivePaneRenderer,
  PrimitivePaneView,
  ScreenPoint,
  TextAlign,
  TextDrawingPatch,
  TextPrimitiveOptions,
} from "../drawingTypes.js";

interface FontDescriptor {
  italic: boolean;
  bold: boolean;
  fontSize: number;
  fontFamily: string;
}

interface TextRenderData extends FontDescriptor {
  x: number | null;
  y: number | null;
  hidden: boolean;
  text: string;
  color: string;
  underline: boolean;
  align: TextAlign;
  bgColor: string | null;
  borderColor: string | null;
  borderWidth: number;
  widthPx: number | null;
  padding: number;
  selected: boolean;
  hovered: boolean;
}

interface TextBox extends ScreenPoint {
  width: number;
  height: number;
  lineCount: number;
}

// ── Word-wrap helper (CSS-px space) ──
//
// Wraps a logical line (already split per explicit \n) into multiple visual
// lines so each fits within `maxWidth` (CSS px). Falls back to per-character
// breaking when a single token exceeds maxWidth (CJK-friendly).

function wrapLine(
  ctx: CanvasRenderingContext2D,
  line: string,
  maxWidth: number | null,
): string[] {
  if (!line) return [""];
  if (maxWidth == null || maxWidth <= 0) return [line];
  if (ctx.measureText(line).width <= maxWidth) return [line];

  const out: string[] = [];

  // Try splitting on whitespace first.
  const tokens = line.split(/(\s+)/); // keep separators
  let buf = "";
  for (const tok of tokens) {
    const candidate = buf + tok;
    if (ctx.measureText(candidate).width <= maxWidth) {
      buf = candidate;
      continue;
    }
    if (buf) {
      out.push(buf.trimEnd());
      buf = "";
    }
    // Token alone may still exceed width (CJK / very long word). Break per char.
    if (ctx.measureText(tok).width > maxWidth) {
      let chunk = "";
      for (const ch of tok) {
        const next = chunk + ch;
        if (ctx.measureText(next).width <= maxWidth) {
          chunk = next;
        } else {
          if (chunk) out.push(chunk);
          chunk = ch;
        }
      }
      if (chunk) buf = chunk;
    } else {
      buf = tok;
    }
  }
  if (buf) out.push(buf.trimEnd());
  return out.length ? out : [""];
}

function buildFontString({ italic, bold, fontSize, fontFamily }: FontDescriptor): string {
  let s = "";
  if (italic) s += "italic ";
  if (bold) s += "bold ";
  s += `${fontSize}px ${fontFamily}`;
  return s;
}

// ── Pane Renderer ──

class TextRenderer implements PrimitivePaneRenderer {
  _data: TextRenderData | null;

  constructor() {
    this._data = null;
  }

  update(data: TextRenderData): void {
    this._data = data;
  }

  draw(target: PrimitiveCanvasTarget): void {
    const data = this._data;
    if (!data || data.x == null || data.y == null) return;
    if (data.hidden) return;
    const renderX = data.x;
    const renderY = data.y;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;

      ctx.save();
      // Work in CSS-pixel coordinates: scale once and forget about DPR.
      ctx.scale(hRatio, vRatio);

      const {
        text, color, fontSize, fontFamily, bold, italic, underline,
        align, bgColor, borderColor, borderWidth,
        widthPx, padding,
        selected, hovered,
      } = data;

      ctx.font = buildFontString({ italic, bold, fontSize, fontFamily });
      ctx.textBaseline = "top";

      // Compute lines (with optional word-wrap when widthPx is set)
      const explicitLines = (text || "").split("\n");
      const innerWidthCap = widthPx ? Math.max(0, widthPx - 2 * padding) : null;

      const lines: string[] = [];
      for (const raw of explicitLines) {
        const wrapped = wrapLine(ctx, raw, innerWidthCap);
        for (const w of wrapped) lines.push(w);
      }
      if (lines.length === 0) lines.push("");

      // Measure
      let maxLineWidth = 0;
      for (const l of lines) {
        const w = ctx.measureText(l).width;
        if (w > maxLineWidth) maxLineWidth = w;
      }
      const lineHeight = fontSize * 1.3;
      const innerWidth = innerWidthCap != null ? innerWidthCap : maxLineWidth;
      const innerHeight = lines.length * lineHeight;

      // Box (screen / CSS-px) — anchored at (x, y) top-left
      const boxX = renderX;
      const boxY = renderY;
      const boxW = innerWidth + 2 * padding;
      const boxH = innerHeight + 2 * padding;

      // ── Background fill ──
      if (bgColor && bgColor !== "transparent") {
        ctx.fillStyle = bgColor;
        roundedRect(ctx, boxX, boxY, boxW, boxH, 4);
        ctx.fill();
      }

      // ── Border ──
      if (borderColor && borderColor !== "transparent") {
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = borderWidth || 1;
        roundedRect(ctx, boxX, boxY, boxW, boxH, 4);
        ctx.stroke();
      }

      // ── Text body ──
      const textColor = (hovered && !selected) ? "#ff6b6b" : color;
      ctx.fillStyle = textColor;
      ctx.globalAlpha = (hovered && !selected) ? 0.8 : 1;

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line === undefined) continue;
        const lineW = ctx.measureText(line).width;
        let lx = boxX + padding;
        if (align === "center") lx = boxX + padding + (innerWidth - lineW) / 2;
        else if (align === "right") lx = boxX + padding + (innerWidth - lineW);
        const ly = boxY + padding + i * lineHeight;
        ctx.fillText(line, lx, ly);

        if (underline) {
          const uy = ly + fontSize + 1;
          ctx.beginPath();
          ctx.moveTo(lx, uy);
          ctx.lineTo(lx + lineW, uy);
          ctx.lineWidth = Math.max(1, fontSize / 14);
          ctx.strokeStyle = textColor;
          ctx.stroke();
        }
      }

      // ── Eraser strikethrough ──
      if (hovered && !selected) {
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = "#ff6b6b";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(boxX + 2, boxY + boxH / 2);
        ctx.lineTo(boxX + boxW - 2, boxY + boxH / 2);
        ctx.stroke();
      }

      // ── Selection bounding box + 8 handles ──
      if (selected) {
        ctx.globalAlpha = 1;
        // Dashed bbox
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(boxX - 0.5, boxY - 0.5, boxW + 1, boxH + 1);
        ctx.setLineDash([]);

        // Handles (4 corners as squares + 4 side midpoints as squares)
        const handles = computeHandlePositions(boxX, boxY, boxW, boxH);
        const hSize = 7;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 1.25;
        for (const k of HANDLE_KEYS) {
          const p = handles[k];
          ctx.beginPath();
          ctx.rect(p.x - hSize / 2, p.y - hSize / 2, hSize, hSize);
          ctx.fill();
          ctx.stroke();
        }
      }

      ctx.restore();
    });
  }
}

// ── Helpers ──

const HANDLE_KEYS = ["tl", "t", "tr", "r", "br", "b", "bl", "l"] as const;
type TextHandleKey = typeof HANDLE_KEYS[number];

function computeHandlePositions(
  x: number,
  y: number,
  w: number,
  h: number,
): Record<TextHandleKey, ScreenPoint> {
  return {
    tl: { x, y },
    t:  { x: x + w / 2, y },
    tr: { x: x + w, y },
    r:  { x: x + w, y: y + h / 2 },
    br: { x: x + w, y: y + h },
    b:  { x: x + w / 2, y: y + h },
    bl: { x, y: y + h },
    l:  { x, y: y + h / 2 },
  };
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

// ── Pane View ──

class TextPaneView implements PrimitivePaneView {
  _source: TextDrawingPrimitive;
  _renderer: TextRenderer;

  constructor(source: TextDrawingPrimitive) {
    this._source = source;
    this._renderer = new TextRenderer();
  }

  update(): void {
    const source = this._source;
    const series = source._series;
    const chart = source._chart;
    if (!series || !chart) return;
    const base: Omit<TextRenderData, "x" | "y" | "hidden"> = {
      text: source._text,
      color: source._color,
      fontSize: source._fontSize,
      fontFamily: source._fontFamily,
      bold: source._bold,
      italic: source._italic,
      underline: source._underline,
      align: source._align,
      bgColor: source._bgColor,
      borderColor: source._borderColor,
      borderWidth: source._borderWidth,
      widthPx: source._widthPx,
      padding: source._padding,
      selected: source._selected,
      hovered: source._hovered,
    };
    if (source._hidden) {
      this._renderer.update({ x: null, y: null, hidden: true, ...base });
      return;
    }

    const screen = source._anchorScreen();
    if (!screen) {
      this._renderer.update({ x: null, y: null, hidden: false, ...base });
      return;
    }

    this._renderer.update({
      x: screen.x,
      y: screen.y,
      hidden: false,
      ...base,
    });
  }

  renderer(): TextRenderer { return this._renderer; }
  zOrder(): "top" { return "top"; }
}

// ── The Primitive ──

export class TextDrawingPrimitive {
  _id: string;
  _dataPoint: DrawingDataPoint;
  _text: string;
  _color: string;
  _fontSize: number;
  _fontFamily: string;
  _bold: boolean;
  _italic: boolean;
  _underline: boolean;
  _align: TextAlign;
  _bgColor: string | null;
  _borderColor: string | null;
  _borderWidth: number;
  _widthPx: number | null;
  _padding: number;
  _selected: boolean;
  _hovered: boolean;
  _hidden: boolean;
  _geometryRevision: number;
  _series: DrawingAttachedParameter["series"] | null;
  _chart: DrawingAttachedParameter["chart"] | null;
  _paneView: TextPaneView;
  _requestUpdate: (() => void) | null;

  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {{time?: number, logical?: number, price: number}} opts.dataPoint - top-left anchor (data coords)
   * @param {string} opts.text
   * @param {string} [opts.color]
   * @param {number} [opts.fontSize]
   * @param {string} [opts.fontFamily]
   * @param {boolean} [opts.bold]
   * @param {boolean} [opts.italic]
   * @param {boolean} [opts.underline]
   * @param {'left'|'center'|'right'} [opts.align]
   * @param {string|null} [opts.bgColor]
   * @param {string|null} [opts.borderColor]
   * @param {number} [opts.borderWidth]
   * @param {number|null} [opts.widthPx] - if set, text word-wraps to fit this width (CSS px)
   * @param {number} [opts.padding]
   */
  constructor(opts: TextPrimitiveOptions) {
    this._id = opts.id;
    this._dataPoint = opts.dataPoint || { logical: 0, price: 0 };
    this._text = opts.text != null ? opts.text : "Text";
    this._color = opts.color || "#e2e8f0";
    this._fontSize = opts.fontSize || 14;
    this._fontFamily = opts.fontFamily || "'Inter', 'Segoe UI', sans-serif";
    this._bold = !!opts.bold;
    this._italic = !!opts.italic;
    this._underline = !!opts.underline;
    this._align = opts.align || "left";
    this._bgColor = opts.bgColor === undefined ? null : opts.bgColor;
    this._borderColor = opts.borderColor === undefined ? null : opts.borderColor;
    this._borderWidth = opts.borderWidth != null ? opts.borderWidth : 1;
    this._widthPx = (opts.widthPx != null && isFinite(opts.widthPx)) ? opts.widthPx : null;
    this._padding = opts.padding != null ? opts.padding : 6;

    this._selected = !!opts.selected;
    this._hovered = false;
    this._hidden = false;
    this._geometryRevision = 1;

    this._series = null;
    this._chart = null;
    this._paneView = new TextPaneView(this);
    this._requestUpdate = null;
  }

  // ── ISeriesPrimitive ──

  attached({ chart, series, requestUpdate }: DrawingAttachedParameter): void {
    this._chart = chart;
    this._series = series;
    this._requestUpdate = requestUpdate;
  }
  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }
  updateAllViews(): void { this._paneView.update(); }
  paneViews(): readonly PrimitivePaneView[] { return [this._paneView]; }

  // ── Public getters ──

  get id() { return this._id; }
  get text() { return this._text; }
  get dataPoint() { return this._dataPoint; }
  get color() { return this._color; }
  get fontSize() { return this._fontSize; }
  get fontFamily() { return this._fontFamily; }
  get bold() { return this._bold; }
  get italic() { return this._italic; }
  get underline() { return this._underline; }
  get align() { return this._align; }
  get bgColor() { return this._bgColor; }
  get borderColor() { return this._borderColor; }
  get borderWidth() { return this._borderWidth; }
  get widthPx() { return this._widthPx; }
  get padding() { return this._padding; }
  get selected() { return this._selected; }
  get geometryRevision() { return this._geometryRevision; }

  // ── Setters ──

  setText(t: string): void { this._text = t; this._requestUpdate?.(); }
  setDataPoint(dp: DrawingDataPoint): void {
    this._dataPoint = dp;
    this._geometryRevision += 1;
    this._requestUpdate?.();
  }
  setColor(c: string): void { this._color = c; this._requestUpdate?.(); }
  setFontSize(s: number): void { this._fontSize = s; this._requestUpdate?.(); }
  setFontFamily(f: string): void { this._fontFamily = f; this._requestUpdate?.(); }
  setBold(v: boolean): void { this._bold = !!v; this._requestUpdate?.(); }
  setItalic(v: boolean): void { this._italic = !!v; this._requestUpdate?.(); }
  setUnderline(v: boolean): void { this._underline = !!v; this._requestUpdate?.(); }
  setAlign(a: TextAlign): void { this._align = a; this._requestUpdate?.(); }
  setBgColor(c: string | null): void { this._bgColor = c; this._requestUpdate?.(); }
  setBorderColor(c: string | null): void { this._borderColor = c; this._requestUpdate?.(); }
  setBorderWidth(w: number): void { this._borderWidth = w; this._requestUpdate?.(); }
  setWidthPx(w: number | null): void {
    this._widthPx = (w == null || !isFinite(w)) ? null : w;
    this._requestUpdate?.();
  }
  setPadding(p: number): void { this._padding = p; this._requestUpdate?.(); }

  setSelected(v: boolean): void {
    const next = !!v;
    if (this._selected !== next) { this._selected = next; this._requestUpdate?.(); }
  }
  setHovered(v: boolean): void {
    const next = !!v;
    if (this._hovered !== next) { this._hovered = next; this._requestUpdate?.(); }
  }
  setHidden(v: boolean, request = true): void {
    const next = !!v;
    if (this._hidden !== next) {
      this._hidden = next;
      if (request) this._requestUpdate?.();
    }
  }
  requestUpdate(): void { this._requestUpdate?.(); }

  /** Apply many properties at once (skip undefined keys). Returns true if anything changed. */
  applyPatch(patch: TextDrawingPatch | null | undefined): boolean {
    if (!patch) return false;
    let changed = false;
    if (patch.text !== undefined && this._text !== patch.text) { this._text = patch.text; changed = true; }
    if (patch.color !== undefined && this._color !== patch.color) { this._color = patch.color; changed = true; }
    if (patch.fontSize !== undefined && this._fontSize !== patch.fontSize) { this._fontSize = patch.fontSize; changed = true; }
    if (patch.fontFamily !== undefined && this._fontFamily !== patch.fontFamily) { this._fontFamily = patch.fontFamily; changed = true; }
    if (patch.bold !== undefined && this._bold !== patch.bold) { this._bold = patch.bold; changed = true; }
    if (patch.italic !== undefined && this._italic !== patch.italic) { this._italic = patch.italic; changed = true; }
    if (patch.underline !== undefined && this._underline !== patch.underline) { this._underline = patch.underline; changed = true; }
    if (patch.align !== undefined && this._align !== patch.align) { this._align = patch.align; changed = true; }
    if (patch.bgColor !== undefined && this._bgColor !== patch.bgColor) { this._bgColor = patch.bgColor; changed = true; }
    if (patch.borderColor !== undefined && this._borderColor !== patch.borderColor) { this._borderColor = patch.borderColor; changed = true; }
    if (patch.borderWidth !== undefined && this._borderWidth !== patch.borderWidth) { this._borderWidth = patch.borderWidth; changed = true; }
    if (patch.widthPx !== undefined && this._widthPx !== patch.widthPx) { this._widthPx = patch.widthPx; changed = true; }
    if (patch.padding !== undefined && this._padding !== patch.padding) { this._padding = patch.padding; changed = true; }
    if (changed) this._requestUpdate?.();
    return changed;
  }

  // ── Anchor → screen coords (CSS px relative to chart container) ──
  _anchorScreen(): ScreenPoint | null {
    if (!this._series || !this._chart) return null;
    const coordinateContext = {};
    const sx = drawingDataPointsToCoordinates(
      this._chart,
      this._series,
      [this._dataPoint],
      coordinateContext,
      { cacheToken: this, geometryRevision: this._geometryRevision },
    )[0] ?? null;
    const sy = this._series.priceToCoordinate(this._dataPoint.price);
    if (sx == null || sy == null || !isFinite(sx) || !isFinite(sy)) return null;
    return { x: sx, y: sy };
  }

  /**
   * Compute bounding box (CSS pixels, screen coords).
   * Returns { x, y, width, height, lineCount } or null. x/y is top-left
   * of the box (including padding). Used by hit-testing AND by the React
   * overlay (edit textarea + format toolbar).
   */
  getBoundingBoxScreen(): TextBox | null {
    const screen = this._anchorScreen();
    if (!screen) return null;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.font = buildFontString({
      italic: this._italic, bold: this._bold,
      fontSize: this._fontSize, fontFamily: this._fontFamily,
    });

    const padding = this._padding;
    const innerWidthCap = this._widthPx ? Math.max(0, this._widthPx - 2 * padding) : null;
    const explicitLines = (this._text || "").split("\n");
    const lines: string[] = [];
    for (const raw of explicitLines) {
      const wrapped = wrapLine(ctx, raw, innerWidthCap);
      for (const w of wrapped) lines.push(w);
    }
    if (lines.length === 0) lines.push("");

    let maxLineWidth = 0;
    for (const l of lines) {
      const w = ctx.measureText(l).width;
      if (w > maxLineWidth) maxLineWidth = w;
    }
    const innerWidth = innerWidthCap != null ? innerWidthCap : maxLineWidth;
    const innerHeight = lines.length * (this._fontSize * 1.3);
    const boxW = innerWidth + 2 * padding;
    const boxH = innerHeight + 2 * padding;

    return {
      x: screen.x,
      y: screen.y,
      width: boxW,
      height: boxH,
      lineCount: lines.length,
    };
  }

  /**
   * Hit testing.
   * Returns false if no hit, otherwise:
   *   { handle: 'tl'|'t'|'tr'|'r'|'br'|'b'|'bl'|'l' }   — handle hit (only when selected)
   *   { body: true }                                       — body hit
   */
  hitTestGeometry(x: number, y: number): DrawingHit | false {
    if (this._hidden) return false;
    const box = this.getBoundingBoxScreen();
    if (!box) return false;

    if (this._selected) {
      const handles = computeHandlePositions(box.x, box.y, box.width, box.height);
      const hitR = 7;
      for (const k of HANDLE_KEYS) {
        const p = handles[k];
        if (Math.abs(x - p.x) <= hitR && Math.abs(y - p.y) <= hitR) {
          return { handle: k };
        }
      }
    }

    const margin = 2;
    if (
      x >= box.x - margin && x <= box.x + box.width + margin &&
      y >= box.y - margin && y <= box.y + box.height + margin
    ) {
      return { body: true };
    }
    return false;
  }
}

export default TextDrawingPrimitive;
