const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const MAX_ENTRIES = 64;
const MAX_BARS = 256;
const MAX_PAYLOAD_BYTES = 512 * 1024;

function clone(value) {
  return structuredClone(value);
}

function validBar(row) {
  return row && typeof row === "object" && !Array.isArray(row)
    && Number.isSafeInteger(row.time) && row.time >= 0
    && [row.open, row.high, row.low, row.close, row.volume]
      .every((value) => Number.isFinite(value));
}

function validatePayload(raw) {
  if (!raw || typeof raw !== "object" || !KEY_PATTERN.test(raw.key || "")) {
    throw new TypeError("Series snapshot key is invalid");
  }
  if (!Array.isArray(raw.rows) || raw.rows.length < 1 || raw.rows.length > MAX_BARS) {
    throw new RangeError(`Series snapshot must contain 1..${MAX_BARS} bars`);
  }
  if (!raw.rows.every(validBar)) throw new TypeError("Series snapshot contains an invalid bar");
  for (let index = 1; index < raw.rows.length; index += 1) {
    if (raw.rows[index].time <= raw.rows[index - 1].time) {
      throw new TypeError("Series snapshot times must be strictly ascending");
    }
  }
  const serialized = JSON.stringify({ key: raw.key, rows: raw.rows });
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`Series snapshot exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return JSON.parse(serialized);
}

export class SeriesSnapshotHub {
  constructor() {
    this.entries = new Map();
    this.counts = { publishes: 0, reads: 0, hits: 0, misses: 0, evictions: 0, rejects: 0 };
  }

  publish(raw) {
    let payload;
    try {
      payload = validatePayload(raw);
    } catch (error) {
      this.counts.rejects += 1;
      throw error;
    }
    this.entries.delete(payload.key);
    this.entries.set(payload.key, payload.rows);
    while (this.entries.size > MAX_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value);
      this.counts.evictions += 1;
    }
    this.counts.publishes += 1;
    return { ok: true, key: payload.key, bars: payload.rows.length };
  }

  read(rawKey) {
    this.counts.reads += 1;
    if (typeof rawKey !== "string" || !KEY_PATTERN.test(rawKey)) {
      this.counts.rejects += 1;
      return { ok: false, code: "SERIES_SNAPSHOT_KEY_INVALID", rows: [] };
    }
    const rows = this.entries.get(rawKey);
    if (!rows) {
      this.counts.misses += 1;
      return { ok: true, hit: false, rows: [] };
    }
    this.entries.delete(rawKey);
    this.entries.set(rawKey, rows);
    this.counts.hits += 1;
    return { ok: true, hit: true, rows: clone(rows) };
  }

  diagnostics() {
    return {
      schemaVersion: "candlescope.series-snapshot-hub/1",
      limits: { maxEntries: MAX_ENTRIES, maxBars: MAX_BARS, maxPayloadBytes: MAX_PAYLOAD_BYTES },
      entries: this.entries.size,
      bars: [...this.entries.values()].reduce((sum, rows) => sum + rows.length, 0),
      counts: { ...this.counts },
    };
  }
}
