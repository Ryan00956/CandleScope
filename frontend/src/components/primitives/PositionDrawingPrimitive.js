/**
 * PositionDrawingPrimitive — Lightweight Charts v5 Plugin API (ISeriesPrimitive)
 *
 * Renders a long/short position tool similar to TradingView.
 * User clicks to set entry price, then drags to set TP/SL.
 *
 * Features:
 *   - Entry price line (solid)
 *   - Take-profit zone (green for long, red for short)
 *   - Stop-loss zone (red for long, green for short)
 *   - Draggable TP/SL handles
 *   - Info panel: entry price, TP, SL, R:R ratio, P&L amounts, %
 *   - Current price unrealized P&L
 *   - Position size (in currency)
 *   - Uses K-line colors from CSS variables
 */

import { timeToCoordinateInterpolated } from "./coordinateUtils.js";

// ── Color helpers ──

function adjustAlpha(hex, alpha) {
  let r = 0, g = 0, b = 0;
  if (hex.startsWith("rgba")) {
    const match = hex.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) { r = +match[1]; g = +match[2]; b = +match[3]; }
  } else if (hex.startsWith("rgb")) {
    const match = hex.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) { r = +match[1]; g = +match[2]; b = +match[3]; }
  } else if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  } else {
    return hex;
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Compute P&L percentage for a position.
 * For long:  (price - entry) / entry
 * For short: (entry - price) / entry   ← price drops = profit
 */
function calcPnlPct(entryPrice, price, isLong) {
  if (!entryPrice || entryPrice === 0) return 0;
  return isLong
    ? ((price - entryPrice) / entryPrice) * 100
    : ((entryPrice - price) / entryPrice) * 100;
}

// ── Smart price formatter ──

function formatPrice(price) {
  if (price == null) return "--";
  if (price >= 1000) return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  return price.toFixed(8);
}

// ── Renderer ──

class PositionRenderer {
  constructor() {
    this._data = null;
  }

  update(data) {
    this._data = data;
  }

  draw(target) {
    const data = this._data;
    if (!data) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const ratio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;

      const {
        entryY, tpY, slY,
        leftX, rightX,
        direction, // "long" or "short"
        selected, hovered, isPreview,
        entryPrice, tpPrice, slPrice,
        positionSize,
        upColor, downColor, // K-line colors from CSS variables
        currentPrice,
      } = data;

      if (entryY == null || leftX == null || rightX == null) return;

      const eY = entryY * vRatio;
      const tY = tpY != null ? tpY * vRatio : null;
      const sY = slY != null ? slY * vRatio : null;
      const lX = leftX * ratio;
      const rX = rightX * ratio;

      const isLong = direction === "long";

      // Colors — use K-line colors
      const kUpColor = upColor || "#22c55e";    // color for price going UP
      const kDownColor = downColor || "#ef4444"; // color for price going DOWN
      const entryColor = "#2196f3";   // blue

      // Zone colors follow PRICE DIRECTION relative to entry:
      //   price above entry → upColor (green)
      //   price below entry → downColor (red)
      // This is consistent with K-line coloring convention.
      // For LONG:  TP is above (green), SL is below (red)
      // For SHORT: TP is below (red),   SL is above (green)
      const tpZoneColor = (tpPrice != null && tpPrice > entryPrice) ? kUpColor : kDownColor;
      const slZoneColor = (slPrice != null && slPrice > entryPrice) ? kUpColor : kDownColor;

      ctx.save();

      // ── Draw TP zone ──
      if (tY != null) {
        ctx.fillStyle = adjustAlpha(tpZoneColor, isPreview ? 0.10 : 0.15);
        const zoneTop = Math.min(eY, tY);
        const zoneH = Math.abs(tY - eY);
        ctx.fillRect(lX, zoneTop, rX - lX, zoneH);

        // TP line
        ctx.strokeStyle = adjustAlpha(tpZoneColor, 0.8);
        ctx.lineWidth = 2 * Math.min(ratio, vRatio);
        ctx.setLineDash([6 * ratio, 3 * ratio]);
        ctx.beginPath();
        ctx.moveTo(lX, tY);
        ctx.lineTo(rX, tY);
        ctx.stroke();
        ctx.setLineDash([]);

        // TP label — use the zone color (matches visual)
        if (tpPrice != null && !isPreview) {
          const pct = calcPnlPct(entryPrice, tpPrice, isLong);
          const pnl = positionSize ? (positionSize * pct / 100) : 0;
          this._drawPriceLabel(ctx, ratio, vRatio, rX, tY, tpPrice, pct, pnl, tpZoneColor);
        }
      }

      // ── Draw SL zone ──
      if (sY != null) {
        ctx.fillStyle = adjustAlpha(slZoneColor, isPreview ? 0.10 : 0.15);
        const zoneTop = Math.min(eY, sY);
        const zoneH = Math.abs(sY - eY);
        ctx.fillRect(lX, zoneTop, rX - lX, zoneH);

        // SL line
        ctx.strokeStyle = adjustAlpha(slZoneColor, 0.8);
        ctx.lineWidth = 2 * Math.min(ratio, vRatio);
        ctx.setLineDash([6 * ratio, 3 * ratio]);
        ctx.beginPath();
        ctx.moveTo(lX, sY);
        ctx.lineTo(rX, sY);
        ctx.stroke();
        ctx.setLineDash([]);

        // SL label — use the zone color (matches visual)
        if (slPrice != null && !isPreview) {
          const pct = calcPnlPct(entryPrice, slPrice, isLong);
          const pnl = positionSize ? (positionSize * pct / 100) : 0;
          this._drawPriceLabel(ctx, ratio, vRatio, rX, sY, slPrice, pct, pnl, slZoneColor);
        }
      }

      // ── Draw entry line ──
      ctx.strokeStyle = entryColor;
      ctx.lineWidth = 2.5 * Math.min(ratio, vRatio);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(lX, eY);
      ctx.lineTo(rX, eY);
      ctx.stroke();

      // ── Draw info panel on the right side ──
      if (!isPreview && entryPrice != null) {
        this._drawInfoPanel(ctx, ratio, vRatio, rX, eY, tY, sY, data);
      }

      // ── Direction badge ──
      if (!isPreview) {
        const badgeW = 48 * ratio;
        const badgeH = 20 * vRatio;
        const badgeX = lX + 4 * ratio;
        const badgeY = eY - badgeH - 4 * vRatio;
        const badgeColor = isLong ? kUpColor : kDownColor;

        ctx.fillStyle = badgeColor;
        this._roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 4 * Math.min(ratio, vRatio));
        ctx.fill();

        ctx.fillStyle = "#ffffff";
        ctx.font = `bold ${11 * Math.min(ratio, vRatio)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(isLong ? "LONG" : "SHORT", badgeX + badgeW / 2, badgeY + badgeH / 2);
      }

      // ── Drag handles when selected ──
      if (selected) {
        const handleR = 5 * Math.min(ratio, vRatio);
        const handleLineW = 2 * Math.min(ratio, vRatio);
        const midX = (lX + rX) / 2;

        // Entry handle
        this._drawHandle(ctx, midX, eY, handleR, handleLineW, entryColor, ratio, vRatio);

        // TP handle
        if (tY != null) {
          this._drawDragBar(ctx, lX, rX, tY, tpZoneColor, ratio, vRatio, isLong ? "up" : "down");
        }

        // SL handle
        if (sY != null) {
          this._drawDragBar(ctx, lX, rX, sY, slZoneColor, ratio, vRatio, isLong ? "down" : "up");
        }

        // ── Left/Right edge handles ──
        const edgeHandleColor = "#90a4ae";
        const topY = tY != null ? Math.min(eY, tY, sY != null ? sY : Infinity) : eY;
        const botY = sY != null ? Math.max(eY, sY, tY != null ? tY : -Infinity) : eY;
        const edgeMidY = (topY + botY) / 2;
        this._drawEdgeHandle(ctx, lX, edgeMidY, topY, botY, edgeHandleColor, ratio, vRatio);
        this._drawEdgeHandle(ctx, rX, edgeMidY, topY, botY, edgeHandleColor, ratio, vRatio);
      }

      // Hover glow
      if (hovered && !selected) {
        ctx.strokeStyle = adjustAlpha(entryColor, 0.3);
        ctx.lineWidth = 8 * Math.min(ratio, vRatio);
        ctx.beginPath();
        ctx.moveTo(lX, eY);
        ctx.lineTo(rX, eY);
        ctx.stroke();
      }

      ctx.restore();
    });
  }

  _drawHandle(ctx, x, y, r, lineW, color, ratio, vRatio) {
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.shadowColor = "rgba(0,0,0,0.3)";
    ctx.shadowBlur = 4 * Math.min(ratio, vRatio);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  _drawDragBar(ctx, lX, rX, y, color, ratio, vRatio, arrowDir) {
    const barH = 6 * vRatio;
    const barW = Math.min(60 * ratio, (rX - lX) * 0.4);
    const midX = (lX + rX) / 2;
    const bx = midX - barW / 2;

    ctx.fillStyle = adjustAlpha(color, 0.6);
    this._roundRect(ctx, bx, y - barH / 2, barW, barH, 3 * Math.min(ratio, vRatio));
    ctx.fill();

    // Arrow
    const arrSize = 4 * Math.min(ratio, vRatio);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    if (arrowDir === "up") {
      ctx.moveTo(midX, y - arrSize);
      ctx.lineTo(midX - arrSize, y + arrSize * 0.5);
      ctx.lineTo(midX + arrSize, y + arrSize * 0.5);
    } else {
      ctx.moveTo(midX, y + arrSize);
      ctx.lineTo(midX - arrSize, y - arrSize * 0.5);
      ctx.lineTo(midX + arrSize, y - arrSize * 0.5);
    }
    ctx.closePath();
    ctx.fill();
  }

  _drawEdgeHandle(ctx, x, midY, topY, botY, color, ratio, vRatio) {
    const handleW = 4 * ratio;
    const handleH = Math.min(24 * vRatio, Math.abs(botY - topY) * 0.4);
    if (handleH < 4 * vRatio) return;

    const hx = x - handleW / 2;
    const hy = midY - handleH / 2;

    ctx.fillStyle = adjustAlpha(color, 0.7);
    this._roundRect(ctx, hx, hy, handleW, handleH, 2 * Math.min(ratio, vRatio));
    ctx.fill();

    ctx.strokeStyle = adjustAlpha("#ffffff", 0.6);
    ctx.lineWidth = 1 * Math.min(ratio, vRatio);
    const gripGap = 3 * vRatio;
    const numGrips = Math.min(3, Math.floor(handleH / (gripGap * 1.5)));
    const gripStart = midY - (numGrips - 1) * gripGap / 2;
    for (let i = 0; i < numGrips; i++) {
      const gy = gripStart + i * gripGap;
      ctx.beginPath();
      ctx.moveTo(hx + 1 * ratio, gy);
      ctx.lineTo(hx + handleW - 1 * ratio, gy);
      ctx.stroke();
    }
  }

  /**
   * Draw a price label badge next to the TP/SL line.
   * pct and pnl are pre-calculated with correct long/short logic.
   */
  _drawPriceLabel(ctx, ratio, vRatio, rX, y, price, pct, pnl, color) {
    const priceText = formatPrice(price);
    const pctText = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    const pnlText = pnl !== 0 ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}` : "";

    const fontSize = 10 * Math.min(ratio, vRatio);
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    const labelParts = [priceText, pctText];
    if (pnlText) labelParts.push(pnlText);
    const text = labelParts.join("  ");

    const textW = ctx.measureText(text).width;
    const padX = 6 * ratio;
    const padY = 4 * vRatio;
    const boxW = textW + padX * 2;
    const boxH = fontSize + padY * 2;
    const boxX = rX + 4 * ratio;
    const boxY = y - boxH / 2;

    ctx.fillStyle = adjustAlpha(color, 0.9);
    this._roundRect(ctx, boxX, boxY, boxW, boxH, 3 * Math.min(ratio, vRatio));
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, boxX + padX, y);
  }

  _drawInfoPanel(ctx, ratio, vRatio, rX, eY, tY, sY, data) {
    const { entryPrice, tpPrice, slPrice, positionSize, direction, currentPrice, upColor, downColor } = data;
    const isLong = direction === "long";
    const kUpColor = upColor || "#22c55e";
    const kDownColor = downColor || "#ef4444";

    // Calculate R:R
    let rrRatio = null;
    if (tpPrice != null && slPrice != null && entryPrice) {
      const reward = Math.abs(tpPrice - entryPrice);
      const risk = Math.abs(slPrice - entryPrice);
      if (risk > 0) {
        rrRatio = reward / risk;
      }
    }

    // Build info lines
    const lines = [];
    lines.push({ label: "入场", value: formatPrice(entryPrice), color: "#2196f3" });

    if (tpPrice != null) {
      const tpPct = calcPnlPct(entryPrice, tpPrice, isLong);
      const tpPnl = positionSize ? (positionSize * tpPct / 100) : null;
      // Color follows price direction: above entry = upColor, below entry = downColor
      const tpColor = tpPrice > entryPrice ? kUpColor : kDownColor;
      lines.push({
        label: "止盈",
        value: `${formatPrice(tpPrice)} (${tpPct >= 0 ? "+" : ""}${tpPct.toFixed(2)}%)`,
        extra: tpPnl != null ? `${tpPnl >= 0 ? "+" : ""}${tpPnl.toFixed(2)}` : null,
        color: tpColor,
      });
    }

    if (slPrice != null) {
      const slPct = calcPnlPct(entryPrice, slPrice, isLong);
      const slPnl = positionSize ? (positionSize * slPct / 100) : null;
      const slColor = slPrice > entryPrice ? kUpColor : kDownColor;
      lines.push({
        label: "止损",
        value: `${formatPrice(slPrice)} (${slPct >= 0 ? "+" : ""}${slPct.toFixed(2)}%)`,
        extra: slPnl != null ? `${slPnl >= 0 ? "+" : ""}${slPnl.toFixed(2)}` : null,
        color: slColor,
      });
    }

    // ── Current price unrealized P&L ──
    if (currentPrice != null && isFinite(currentPrice)) {
      const curPct = calcPnlPct(entryPrice, currentPrice, isLong);
      const curPnl = positionSize ? (positionSize * curPct / 100) : null;
      const isProfit = curPct >= 0;
      // Color follows price direction
      const curColor = currentPrice > entryPrice ? kUpColor : kDownColor;
      lines.push({
        label: "现价",
        value: `${formatPrice(currentPrice)} (${isProfit ? "+" : ""}${curPct.toFixed(2)}%)`,
        extra: curPnl != null ? `${isProfit ? "+" : ""}${curPnl.toFixed(2)}` : null,
        color: curColor,
      });
    }

    if (rrRatio != null) {
      lines.push({ label: "盈亏比", value: `1 : ${rrRatio.toFixed(2)}`, color: "#ffab40" });
    }

    if (positionSize) {
      lines.push({ label: "仓位", value: `$${positionSize.toFixed(0)}`, color: "#b0bec5" });
    }

    if (lines.length === 0) return;

    const fontSize = 11 * Math.min(ratio, vRatio);
    ctx.font = `${fontSize}px sans-serif`;
    const lineH = (fontSize + 6 * vRatio);
    const padX = 8 * ratio;
    const padY = 6 * vRatio;

    // Measure max width
    let maxW = 0;
    for (const line of lines) {
      const text = `${line.label}: ${line.value}${line.extra ? " " + line.extra : ""}`;
      const w = ctx.measureText(text).width;
      if (w > maxW) maxW = w;
    }

    const boxW = maxW + padX * 2;
    const boxH = lineH * lines.length + padY * 2;

    // Position panel above entry line on right side
    const boxX = rX - boxW - 8 * ratio;
    const targetY = eY - boxH - 8 * vRatio;
    const boxY = Math.max(4 * vRatio, targetY);

    // Background
    ctx.fillStyle = "rgba(30, 33, 40, 0.92)";
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 8 * Math.min(ratio, vRatio);
    this._roundRect(ctx, boxX, boxY, boxW, boxH, 6 * Math.min(ratio, vRatio));
    ctx.fill();
    ctx.shadowBlur = 0;

    // Border
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1 * Math.min(ratio, vRatio);
    this._roundRect(ctx, boxX, boxY, boxW, boxH, 6 * Math.min(ratio, vRatio));
    ctx.stroke();

    // Text
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    lines.forEach((line, i) => {
      const textY = boxY + padY + lineH * i + lineH / 2;

      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillText(`${line.label}: `, boxX + padX, textY);

      const labelW = ctx.measureText(`${line.label}: `).width;
      ctx.fillStyle = line.color;
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.fillText(line.value, boxX + padX + labelW, textY);

      if (line.extra) {
        const valueW = ctx.measureText(line.value + " ").width;
        ctx.fillStyle = adjustAlpha(line.color, 0.7);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillText(line.extra, boxX + padX + labelW + valueW, textY);
      }
    });
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

// ── Pane View ──

class PositionPaneView {
  constructor(source) {
    this._source = source;
    this._renderer = new PositionRenderer();
  }

  update() {
    const source = this._source;
    const series = source._series;
    const chart = source._chart;

    if (!series || !chart) return;

    const timeScale = chart.timeScale();

    // Convert time coords to screen X
    const toScreenX = (time) => {
      if (time == null) return null;
      let x = timeScale.timeToCoordinate(time);
      if (x == null || !isFinite(x)) {
        x = timeToCoordinateInterpolated(chart, series, time);
      }
      return x;
    };

    const entryY = series.priceToCoordinate(source._entryPrice);
    const tpY = source._tpPrice != null ? series.priceToCoordinate(source._tpPrice) : null;
    const slY = source._slPrice != null ? series.priceToCoordinate(source._slPrice) : null;

    const leftX = toScreenX(source._timeRange.start);
    const rightX = toScreenX(source._timeRange.end);

    // Read K-line colors from CSS variables on the chart container
    let upColor = "#22c55e";
    let downColor = "#ef4444";
    try {
      const chartEl = chart.chartElement?.() || document.querySelector(".chart-container");
      if (chartEl) {
        const styles = getComputedStyle(chartEl);
        const cssUp = styles.getPropertyValue("--candle-up").trim();
        const cssDown = styles.getPropertyValue("--candle-down").trim();
        if (cssUp) upColor = cssUp;
        if (cssDown) downColor = cssDown;
      }
    } catch { /* use defaults */ }

    // Get current price from the last data point of the series
    let currentPrice = null;
    try {
      // Try reading the last bar from the series data
      const lastBar = series.dataByIndex(Infinity, -1);
      if (lastBar && lastBar.close != null) {
        currentPrice = lastBar.close;
      } else if (lastBar && lastBar.value != null) {
        currentPrice = lastBar.value;
      }
    } catch { /* */ }

    this._renderer.update({
      entryY,
      tpY,
      slY,
      leftX,
      rightX,
      direction: source._direction,
      selected: source._selected,
      hovered: source._hovered,
      isPreview: source._isPreview,
      entryPrice: source._entryPrice,
      tpPrice: source._tpPrice,
      slPrice: source._slPrice,
      positionSize: source._positionSize,
      upColor,
      downColor,
      currentPrice,
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

export class PositionDrawingPrimitive {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {"long"|"short"} opts.direction
   * @param {number} opts.entryPrice
   * @param {number|null} opts.tpPrice
   * @param {number|null} opts.slPrice
   * @param {{start: number, end: number}} opts.timeRange - Unix timestamps
   * @param {number} opts.positionSize - position amount in base currency
   */
  constructor(opts) {
    this._id = opts.id;
    this._type = "position";
    this._direction = opts.direction || "long";
    this._entryPrice = opts.entryPrice;
    this._tpPrice = opts.tpPrice ?? null;
    this._slPrice = opts.slPrice ?? null;
    this._timeRange = opts.timeRange || { start: null, end: null };
    this._positionSize = opts.positionSize || 1000;
    this._selected = opts.selected || false;
    this._isPreview = opts.isPreview || false;
    this._hovered = opts.hovered || false;

    this._series = null;
    this._chart = null;
    this._paneView = new PositionPaneView(this);
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
  get direction() { return this._direction; }
  get entryPrice() { return this._entryPrice; }
  get tpPrice() { return this._tpPrice; }
  get slPrice() { return this._slPrice; }
  get timeRange() { return this._timeRange; }
  get positionSize() { return this._positionSize; }
  get selected() { return this._selected; }
  get dataPoints() {
    const points = [];
    if (this._timeRange.start != null) {
      points.push({ time: this._timeRange.start, price: this._entryPrice });
    }
    if (this._timeRange.end != null) {
      points.push({ time: this._timeRange.end, price: this._entryPrice });
    }
    return points;
  }

  setEntryPrice(price) {
    this._entryPrice = price;
    this._requestUpdate?.();
  }

  setTpPrice(price) {
    this._tpPrice = price;
    this._requestUpdate?.();
  }

  setSlPrice(price) {
    this._slPrice = price;
    this._requestUpdate?.();
  }

  setTimeRange(range) {
    this._timeRange = range;
    this._requestUpdate?.();
  }

  setPositionSize(size) {
    this._positionSize = size;
    this._requestUpdate?.();
  }

  setDirection(dir) {
    this._direction = dir;
    this._requestUpdate?.();
  }

  setSelected(v) {
    this._selected = v;
    this._requestUpdate?.();
  }

  setHovered(v) {
    this._hovered = v;
    this._requestUpdate?.();
  }

  setPreview(v) {
    this._isPreview = v;
    this._requestUpdate?.();
  }

  setDataPoints(points) {
    if (points.length >= 2) {
      this._timeRange = { start: points[0].time, end: points[1].time };
      this._entryPrice = points[0].price;
    }
    this._requestUpdate?.();
  }

  requestUpdate() {
    this._requestUpdate?.();
  }

  // ── Hit testing ──

  hitTest(x, y) {
    if (!this._series || !this._chart) return null;

    const timeScale = this._chart.timeScale();
    const series = this._series;

    const toScreenX = (time) => {
      if (time == null) return null;
      let sx = timeScale.timeToCoordinate(time);
      if (sx == null || !isFinite(sx)) {
        sx = timeToCoordinateInterpolated(this._chart, series, time);
      }
      return sx;
    };

    const leftX = toScreenX(this._timeRange.start);
    const rightX = toScreenX(this._timeRange.end);

    if (leftX == null || rightX == null) return null;

    const minX = Math.min(leftX, rightX);
    const maxX = Math.max(leftX, rightX);

    // Expand horizontal tolerance for edge detection
    if (x < minX - 20 || x > maxX + 20) return null;

    const entryY = series.priceToCoordinate(this._entryPrice);
    const tpY = this._tpPrice != null ? series.priceToCoordinate(this._tpPrice) : null;
    const slY = this._slPrice != null ? series.priceToCoordinate(this._slPrice) : null;

    if (entryY == null) return null;

    const HIT_RADIUS = 8;
    const EDGE_HIT = 10;

    // Determine vertical extent of the position box
    const allYs = [entryY];
    if (tpY != null) allYs.push(tpY);
    if (slY != null) allYs.push(slY);
    const boxTop = Math.min(...allYs);
    const boxBottom = Math.max(...allYs);

    // ── Left/Right edge hit (prioritize if selected) ──
    if (this._selected) {
      if (Math.abs(x - minX) <= EDGE_HIT && y >= boxTop - 10 && y <= boxBottom + 10) {
        return { zone: "left", pointIndex: -1 };
      }
      if (Math.abs(x - maxX) <= EDGE_HIT && y >= boxTop - 10 && y <= boxBottom + 10) {
        return { zone: "right", pointIndex: -1 };
      }
    }

    // Check TP line hit (for dragging)
    if (tpY != null && Math.abs(y - tpY) <= HIT_RADIUS && x >= minX - 5 && x <= maxX + 5) {
      return { zone: "tp", pointIndex: -1 };
    }

    // Check SL line hit (for dragging)
    if (slY != null && Math.abs(y - slY) <= HIT_RADIUS && x >= minX - 5 && x <= maxX + 5) {
      return { zone: "sl", pointIndex: -1 };
    }

    // Check entry line hit
    if (Math.abs(y - entryY) <= HIT_RADIUS && x >= minX - 5 && x <= maxX + 5) {
      return { zone: "entry", pointIndex: -1 };
    }

    // Check if inside the TP zone
    if (tpY != null) {
      const top = Math.min(entryY, tpY);
      const bottom = Math.max(entryY, tpY);
      if (y >= top && y <= bottom && x >= minX && x <= maxX) {
        return { zone: "body", pointIndex: -1 };
      }
    }

    // Check if inside the SL zone
    if (slY != null) {
      const top = Math.min(entryY, slY);
      const bottom = Math.max(entryY, slY);
      if (y >= top && y <= bottom && x >= minX && x <= maxX) {
        return { zone: "body", pointIndex: -1 };
      }
    }

    return null;
  }
}

export default PositionDrawingPrimitive;
