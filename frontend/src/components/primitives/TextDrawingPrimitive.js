/**
 * TextDrawingPrimitive — Lightweight Charts v5 Plugin API (ISeriesPrimitive)
 *
 * Renders a text annotation directly inside the chart's native Canvas
 * rendering pipeline via series.attachPrimitive(). The text position is
 * stored in data coordinates (logical index + price), so it automatically
 * follows pan/zoom with zero lag.
 *
 * Supports:
 *   - Multi-line plain text rendering with configurable font, size, color, bold/italic
 *   - Selection handles (corner dots)
 *   - Hit-testing for selection and dragging
 *   - Hover highlight for eraser tool
 */

// ── Pane Renderer ──

class TextRenderer {
  constructor() {
    this._data = null;
  }

  update(data) {
    this._data = data;
  }

  draw(target) {
    const data = this._data;
    if (!data || data.x == null || data.y == null || !data.text) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const {
        x, y, text, color, fontSize, fontFamily, bold, italic,
        backgroundColor, borderColor, selected, hovered, padding,
      } = data;

      const bx = x * hRatio;
      const by = y * vRatio;
      const scaledFontSize = fontSize * Math.min(hRatio, vRatio);

      ctx.save();

      // Build font string
      let fontStr = "";
      if (italic) fontStr += "italic ";
      if (bold) fontStr += "bold ";
      fontStr += `${scaledFontSize}px ${fontFamily}`;
      ctx.font = fontStr;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";

      // Measure text (multi-line)
      const lines = text.split("\n");
      const lineHeight = scaledFontSize * 1.3;
      let maxWidth = 0;
      for (const line of lines) {
        const m = ctx.measureText(line);
        if (m.width > maxWidth) maxWidth = m.width;
      }

      const textW = maxWidth;
      const textH = lines.length * lineHeight;

      // Draw text only (no background box)
      if (hovered && !selected) {
        // Eraser hover: strikethrough style
        ctx.fillStyle = "#ff6b6b";
        ctx.globalAlpha = 0.7;
      } else {
        ctx.fillStyle = color;
        ctx.globalAlpha = 1;
      }

      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], bx, by + i * lineHeight);
      }

      // Selected: draw small corner handles around text bounds
      if (selected) {
        const handleR = 3.5 * Math.min(hRatio, vRatio);
        const handleLineW = 1.5 * Math.min(hRatio, vRatio);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = color;
        ctx.lineWidth = handleLineW;
        const corners = [
          [bx, by],
          [bx + textW, by],
          [bx, by + textH],
          [bx + textW, by + textH],
        ];
        for (const [cx, cy] of corners) {
          ctx.beginPath();
          ctx.arc(cx, cy, handleR, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }

      // Eraser hover: strikethrough line
      if (hovered && !selected) {
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = "#ff6b6b";
        ctx.lineWidth = 1.5 * Math.min(hRatio, vRatio);
        ctx.beginPath();
        ctx.moveTo(bx, by + textH / 2);
        ctx.lineTo(bx + textW, by + textH / 2);
        ctx.stroke();
      }

      ctx.restore();
    });
  }
}

// ── Pane View ──

class TextPaneView {
  constructor(source) {
    this._source = source;
    this._renderer = new TextRenderer();
  }

  update() {
    const source = this._source;
    const series = source._series;
    const chart = source._chart;

    if (!series || !chart) return;

    const timeScale = chart.timeScale();
    const x = timeScale.logicalToCoordinate(source._dataPoint.logical);
    const y = series.priceToCoordinate(source._dataPoint.price);

    this._renderer.update({
      x,
      y,
      text: source._text,
      color: source._color,
      fontSize: source._fontSize,
      fontFamily: source._fontFamily,
      bold: source._bold,
      italic: source._italic,
      backgroundColor: source._backgroundColor,
      borderColor: source._borderColor,
      selected: source._selected,
      hovered: source._hovered,
      padding: source._padding,
    });
  }

  renderer() {
    return this._renderer;
  }

  zOrder() {
    return "normal";
  }
}

// ── The Primitive ──

export class TextDrawingPrimitive {
  /**
   * @param {object} opts
   * @param {string} opts.id - unique identifier
   * @param {{logical: number, price: number}} opts.dataPoint - position in data coords
   * @param {string} opts.text - the text content
   * @param {string} [opts.color] - text color
   * @param {number} [opts.fontSize] - font size in CSS pixels
   * @param {string} [opts.fontFamily] - font family
   * @param {boolean} [opts.bold] - bold
   * @param {boolean} [opts.italic] - italic
   * @param {string} [opts.backgroundColor] - box background color
   * @param {string} [opts.borderColor] - box border color (null = no border)
   * @param {number} [opts.padding] - inner padding in CSS pixels
   */
  constructor(opts) {
    this._id = opts.id;
    this._dataPoint = opts.dataPoint || { logical: 0, price: 0 };
    this._text = opts.text || "Text";
    this._color = opts.color || "#e2e8f0";
    this._fontSize = opts.fontSize || 14;
    this._fontFamily = opts.fontFamily || "'Inter', 'Segoe UI', sans-serif";
    this._bold = opts.bold || false;
    this._italic = opts.italic || false;
    this._backgroundColor = opts.backgroundColor || "rgba(15, 23, 42, 0.85)";
    this._borderColor = opts.borderColor || "rgba(148, 163, 184, 0.3)";
    this._padding = opts.padding || 6;
    this._selected = opts.selected || false;
    this._hovered = false;

    this._series = null;
    this._chart = null;
    this._paneView = new TextPaneView(this);
    this._requestUpdate = null;
  }

  // ── ISeriesPrimitive interface ──

  attached({ chart, series, requestUpdate }) {
    this._chart = chart;
    this._series = series;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  updateAllViews() {
    this._paneView.update();
  }

  paneViews() {
    return [this._paneView];
  }

  // ── Public API ──

  get id() { return this._id; }
  get text() { return this._text; }
  get dataPoint() { return this._dataPoint; }
  get color() { return this._color; }
  get fontSize() { return this._fontSize; }
  get bold() { return this._bold; }
  get italic() { return this._italic; }
  get selected() { return this._selected; }

  setText(t) {
    this._text = t;
    this._requestUpdate?.();
  }

  setDataPoint(dp) {
    this._dataPoint = dp;
    this._requestUpdate?.();
  }

  setColor(c) {
    this._color = c;
    this._requestUpdate?.();
  }

  setFontSize(s) {
    this._fontSize = s;
    this._requestUpdate?.();
  }

  setBold(v) {
    this._bold = v;
    this._requestUpdate?.();
  }

  setItalic(v) {
    this._italic = v;
    this._requestUpdate?.();
  }

  setBackgroundColor(c) {
    this._backgroundColor = c;
    this._requestUpdate?.();
  }

  setBorderColor(c) {
    this._borderColor = c;
    this._requestUpdate?.();
  }

  setSelected(v) {
    if (this._selected !== v) {
      this._selected = v;
      this._requestUpdate?.();
    }
  }

  setHovered(v) {
    if (this._hovered !== v) {
      this._hovered = v;
      this._requestUpdate?.();
    }
  }

  requestUpdate() {
    this._requestUpdate?.();
  }

  // ── Bounding box calculation (in screen/CSS-pixel coordinates) ──

  _getBoundingBox() {
    if (!this._series || !this._chart) return null;

    const timeScale = this._chart.timeScale();
    const sx = timeScale.logicalToCoordinate(this._dataPoint.logical);
    const sy = this._series.priceToCoordinate(this._dataPoint.price);
    if (sx == null || sy == null) return null;

    // We need to measure text to get the bounding box.
    // Use an offscreen canvas for measurement.
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    let fontStr = "";
    if (this._italic) fontStr += "italic ";
    if (this._bold) fontStr += "bold ";
    fontStr += `${this._fontSize}px ${this._fontFamily}`;
    ctx.font = fontStr;

    const lines = this._text.split("\n");
    const lineHeight = this._fontSize * 1.3;
    let maxWidth = 0;
    for (const line of lines) {
      const m = ctx.measureText(line);
      if (m.width > maxWidth) maxWidth = m.width;
    }

    const boxW = maxWidth;
    const boxH = lines.length * lineHeight;

    return { x: sx, y: sy, width: boxW, height: boxH };
  }

  // ── Hit testing (screen/CSS-pixel coordinates) ──

  /**
   * Returns false if no hit, or an object describing the hit:
   *   { body: true }           — hit the text body (for dragging)
   *   { corner: 0|1|2|3 }     — hit a corner handle (for resizing)
   * Corner indices: 0=TL, 1=TR, 2=BL, 3=BR
   */
  hitTest(x, y) {
    const box = this._getBoundingBox();
    if (!box) return false;

    // Check corner handles first (only when selected)
    if (this._selected) {
      const handleRadius = 6; // generous hit area for corners
      const corners = [
        { cx: box.x, cy: box.y },                              // 0: top-left
        { cx: box.x + box.width, cy: box.y },                  // 1: top-right
        { cx: box.x, cy: box.y + box.height },                 // 2: bottom-left
        { cx: box.x + box.width, cy: box.y + box.height },     // 3: bottom-right
      ];
      for (let i = 0; i < corners.length; i++) {
        const dx = x - corners[i].cx;
        const dy = y - corners[i].cy;
        if (dx * dx + dy * dy <= handleRadius * handleRadius) {
          return { corner: i };
        }
      }
    }

    // Check body
    const margin = 4;
    if (
      x >= box.x - margin &&
      x <= box.x + box.width + margin &&
      y >= box.y - margin &&
      y <= box.y + box.height + margin
    ) {
      return { body: true };
    }

    return false;
  }
}

export default TextDrawingPrimitive;
