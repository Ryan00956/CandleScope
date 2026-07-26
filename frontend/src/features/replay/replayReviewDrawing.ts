import {
  decodeDrawingDocumentRecord,
  encodeDrawingDocumentRecord,
} from "../drawings/persistence/drawingDocumentRepository.js";
import type {
  DrawingDocumentRecordV1,
} from "../drawings/persistence/drawingDocumentRepository.js";
import type { DrawingDocument } from "../drawings/core/drawingDocument.js";
import { replaySha256Hex } from "./replaySha256.js";

const DECIMAL_WRAPPER = "$replay_decimal_v1";

type CanonicalReviewJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalReviewJson[]
  | { readonly [key: string]: CanonicalReviewJson };

function encodeFiniteFloats(value: unknown): CanonicalReviewJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("drawing record contains a non-finite number");
    if (Number.isSafeInteger(value)) return value;
    return { [DECIMAL_WRAPPER]: value.toString() };
  }
  if (Array.isArray(value)) return value.map(encodeFiniteFloats);
  if (typeof value !== "object") {
    throw new TypeError("drawing record contains unsupported data");
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, encodeFiniteFloats(item)]),
  );
}

function decodeFiniteFloats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeFiniteFloats);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length === 1 && keys[0] === DECIMAL_WRAPPER) {
    const encoded = source[DECIMAL_WRAPPER];
    if (typeof encoded !== "string") throw new TypeError("drawing decimal wrapper is invalid");
    const decoded = Number(encoded);
    if (!Number.isFinite(decoded) || Number.isSafeInteger(decoded)) {
      throw new TypeError("drawing decimal wrapper is not canonical");
    }
    return decoded;
  }
  return Object.fromEntries(
    Object.entries(source).map(([key, item]) => [key, decodeFiniteFloats(item)]),
  );
}

function canonicalString(value: CanonicalReviewJson): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  return `{${entries.map(([key, item]) => (
    `${JSON.stringify(key)}:${canonicalString(item)}`
  )).join(",")}}`;
}

export async function replayReviewDocumentHash(
  document: Readonly<Record<string, unknown>>,
): Promise<`sha256:${string}`> {
  const canonical = canonicalString(document as CanonicalReviewJson);
  const bytes = new TextEncoder().encode(canonical);
  const subtle = globalThis.crypto?.subtle;
  let hex: string;
  if (subtle === undefined) {
    hex = replaySha256Hex(bytes);
  } else {
    try {
      const digest = await subtle.digest("SHA-256", bytes);
      hex = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    } catch {
      hex = replaySha256Hex(bytes);
    }
  }
  return `sha256:${hex}`;
}

export function replayReviewDrawingRecord(
  document: DrawingDocument,
  runId: string,
  updatedAt = Date.now(),
): Readonly<Record<string, unknown>> {
  const record = encodeDrawingDocumentRecord(document, updatedAt);
  if (record === null) throw new TypeError("drawing document failed canonical encoding");
  return encodeFiniteFloats({
    ...record,
    scopeKey: `replay-run:${runId}`,
  }) as Readonly<Record<string, unknown>>;
}

export function replayReviewDrawingDocument(
  value: Readonly<Record<string, unknown>>,
  reviewScopeKey: string,
): DrawingDocument {
  const decoded = decodeFiniteFloats(value);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("review drawing document is invalid");
  }
  const record = {
    ...(decoded as DrawingDocumentRecordV1),
    scopeKey: reviewScopeKey,
  };
  const document = decodeDrawingDocumentRecord(record, reviewScopeKey);
  if (document === null) throw new TypeError("review drawing document failed strict decoding");
  return document;
}
