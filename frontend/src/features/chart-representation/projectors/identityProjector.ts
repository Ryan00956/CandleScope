import {
  sourceOhlc,
  whitespaceDisplayRow,
  withProjectionMetadata,
} from "./projectorData.js";
import type {
  DisplayRow,
  Projector,
  SourceBar,
} from "../chartRepresentationTypes.js";

export class IdentityProjector implements Projector {
  readonly id: "identity";
  readonly oneToOne: true;

  constructor() {
    this.id = "identity";
    this.oneToOne = true;
  }

  projectRow(row: SourceBar): DisplayRow | null {
    if (row?.time == null) return null;
    if (!sourceOhlc(row) && row?.__whitespace) {
      return whitespaceDisplayRow(row, this.id);
    }
    return withProjectionMetadata(row, this.id);
  }

  project(rows: readonly SourceBar[] = []): DisplayRow[] {
    const output: DisplayRow[] = [];
    for (const row of rows || []) {
      const point = this.projectRow(row);
      if (point) output.push(point);
    }
    return output;
  }
}
