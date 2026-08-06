function canonicalValue(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${path} must contain only safe integer JSON numbers`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalValue(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (entries.some(([, item]) => item === undefined)) {
      throw new TypeError(`${path} cannot contain undefined values`);
    }
    return `{${entries.map(([key, item]) => (
      `${JSON.stringify(key)}:${canonicalValue(item, `${path}.${key}`)}`
    )).join(",")}}`;
  }
  throw new TypeError(`${path} contains unsupported ${typeof value}`);
}

export function canonicalReplayJson(value: unknown): string {
  return canonicalValue(value, "$");
}

export async function canonicalReplaySha256(value: unknown): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(canonicalReplayJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}
