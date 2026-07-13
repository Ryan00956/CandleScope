export class IndicatorPayloadError extends TypeError {
  path: string;

  constructor(path: string, message: string) {
    super(`Invalid indicator payload at ${path}: ${message}`);
    this.name = "IndicatorPayloadError";
    this.path = path;
  }
}

export function isIndicatorRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectIndicatorRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isIndicatorRecord(value)) throw new IndicatorPayloadError(path, "expected an object");
  return value;
}

export function expectIndicatorArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new IndicatorPayloadError(path, "expected an array");
  return value;
}

export function expectIndicatorString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new IndicatorPayloadError(path, "expected a string");
  return value;
}

export function expectIndicatorNonEmptyString(value: unknown, path: string): string {
  const parsed = expectIndicatorString(value, path);
  if (!parsed.trim()) throw new IndicatorPayloadError(path, "expected a non-empty string");
  return parsed;
}

export function expectIndicatorBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new IndicatorPayloadError(path, "expected a boolean");
  return value;
}

export function expectIndicatorFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new IndicatorPayloadError(path, "expected a finite number");
  }
  return value;
}

export function expectIndicatorPositiveInteger(value: unknown, path: string): number {
  const parsed = expectIndicatorFiniteNumber(value, path);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new IndicatorPayloadError(path, "expected a positive integer");
  }
  return parsed;
}

export function optionalIndicatorString(value: unknown, path: string): string | undefined {
  return value === undefined || value === null ? undefined : expectIndicatorString(value, path);
}

export function optionalIndicatorFiniteNumber(value: unknown, path: string): number | undefined {
  return value === undefined || value === null ? undefined : expectIndicatorFiniteNumber(value, path);
}

export function indicatorStringArray(value: unknown, path: string): string[] {
  return expectIndicatorArray(value, path).map((item, index) => (
    expectIndicatorString(item, `${path}[${index}]`)
  ));
}
