import {
  projectedOhlc,
  projectionMetadata,
  sourceOhlc,
  whitespaceDisplayRow,
} from "./projectorData.js";

export class HeikinAshiProjector {
  constructor() {
    this.id = "heikin-ashi";
    this.oneToOne = true;
  }

  projectRow(row, { previousDisplayRow = null } = {}) {
    if (row?.time == null) return null;
    const raw = sourceOhlc(row);
    if (!raw) return whitespaceDisplayRow(row, this.id, { synthetic: true });

    const previous = projectedOhlc(previousDisplayRow);
    const close = (raw.open + raw.high + raw.low + raw.close) / 4;
    const open = previous
      ? (previous.open + previous.close) / 2
      : (raw.open + raw.close) / 2;
    const point = {
      time: row.time,
      open,
      high: Math.max(raw.high, open, close),
      low: Math.min(raw.low, open, close),
      close,
      customValues: projectionMetadata(row, this.id, { synthetic: true }),
    };
    if (Object.prototype.hasOwnProperty.call(row, "volume")) point.volume = row.volume;
    return point;
  }

  resolvePreviousDisplayRow(rows = []) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (projectedOhlc(rows[index])) return rows[index];
    }
    return null;
  }

  project(rows = [], { previousDisplayRow = null } = {}) {
    const output = [];
    let previous = previousDisplayRow;
    for (const row of rows || []) {
      const point = this.projectRow(row, { previousDisplayRow: previous });
      if (!point) continue;
      output.push(point);
      if (projectedOhlc(point)) previous = point;
    }
    return output;
  }
}
