import {
  toEpochSeconds,
  type EpochSeconds,
} from "../features/market-data/marketDataTypes.js";

/**
 * Builds a deliberately partial dependency for a test that exercises only a
 * small structural slice of a larger browser or third-party interface.
 *
 * Keep the assertion centralized here so individual tests still have to name
 * the production contract and cannot spread ad-hoc casts through fixtures.
 */
export function partialMock<T extends object>(value: Partial<T>): T {
  return value as T;
}

/** Bridges a deliberately narrow structural fake across a third-party interface boundary. */
export function structuralMock<T extends object>(value: object): T {
  return value as T;
}

/** Marks a deliberately malformed value used to verify a defensive parser. */
export function malformedFixture<T>(value: unknown): T {
  return value as T;
}

export function mustBeDefined<T>(
  value: T | null | undefined,
  message = "Expected test value to be defined",
): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

export function epochSeconds(value: number): EpochSeconds {
  return mustBeDefined(toEpochSeconds(value), `Invalid epoch seconds fixture: ${value}`);
}
