import {
  sourceOhlc,
  whitespaceDisplayRow,
  withProjectionMetadata,
} from "./projectorData.js";

export class IdentityProjector {
  constructor() {
    this.id = "identity";
    this.oneToOne = true;
  }

  projectRow(row) {
    if (row?.time == null) return null;
    if (!sourceOhlc(row) && row?.__whitespace) {
      return whitespaceDisplayRow(row, this.id);
    }
    return withProjectionMetadata(row, this.id);
  }

  project(rows = []) {
    const output = [];
    for (const row of rows || []) {
      const point = this.projectRow(row);
      if (point) output.push(point);
    }
    return output;
  }
}
