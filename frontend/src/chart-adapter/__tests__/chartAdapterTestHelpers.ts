import type { Coordinate } from "lightweight-charts";

/** Builds a branded Lightweight Charts coordinate for adapter-boundary tests. */
export function chartCoordinate(value: number): Coordinate {
  return value as Coordinate;
}
