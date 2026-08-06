const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_WORKSPACES = 64;
const MAX_WINDOWS = 4;
const MAX_CELLS = 64;
const MISSING = Symbol("missing");

export const WORKSPACE_BUS_SCHEMA = "candlescope.workspace-bus/1";

export class WorkspaceBusConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "WorkspaceBusConflictError";
    this.code = "WORKSPACE_REVISION_CONFLICT";
    this.details = details;
  }
}

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function snapshotRevisions(snapshot) {
  return Object.fromEntries(snapshot.workspaces.map((workspace) => [
    workspace.id,
    workspace.document.revision,
  ]));
}

export function validateWorkspaceSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Workspace snapshot must be an object");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new RangeError("Workspace snapshot exceeds the 4 MiB IPC limit");
  }
  if (!validId(value.activeWorkspaceId)) {
    throw new TypeError("Workspace snapshot activeWorkspaceId is invalid");
  }
  if (!Array.isArray(value.workspaces)
    || value.workspaces.length < 1
    || value.workspaces.length > MAX_WORKSPACES) {
    throw new RangeError("Workspace snapshot must contain 1 to 64 workspaces");
  }
  const workspaceIds = new Set();
  for (const workspace of value.workspaces) {
    if (!validId(workspace?.id) || workspaceIds.has(workspace.id)) {
      throw new TypeError("Workspace snapshot contains an invalid or duplicate workspace id");
    }
    workspaceIds.add(workspace.id);
    const document = workspace.document;
    if (document?.schemaVersion !== 6
      || !Number.isSafeInteger(document.revision)
      || document.revision < 0) {
      throw new TypeError(`Workspace ${workspace.id} document revision is invalid`);
    }
    const windows = document.windows;
    const cells = document.cells;
    if (!windows || typeof windows !== "object" || Array.isArray(windows)
      || Object.keys(windows).length < 1
      || Object.keys(windows).length > MAX_WINDOWS) {
      throw new RangeError(`Workspace ${workspace.id} must contain 1 to 4 windows`);
    }
    if (!cells || typeof cells !== "object" || Array.isArray(cells)
      || Object.keys(cells).length < 1
      || Object.keys(cells).length > MAX_CELLS) {
      throw new RangeError(`Workspace ${workspace.id} must contain 1 to 64 cells`);
    }
  }
  if (!workspaceIds.has(value.activeWorkspaceId)) {
    throw new TypeError("Workspace snapshot activeWorkspaceId is missing");
  }
  return structuredClone(value);
}

function validateExpectedRevisions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Workspace expectedRevisions must be a record");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_WORKSPACES) throw new RangeError("Too many expected revisions");
  for (const [workspaceId, revision] of entries) {
    if (!validId(workspaceId)
      || !Number.isSafeInteger(revision)
      || revision < -1) {
      throw new TypeError("Workspace expected revision is invalid");
    }
  }
  return Object.fromEntries(entries);
}

function validateLinkEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Workspace link event must be an object");
  }
  if (!validId(value.workspaceId)
    || !validId(value.sourceWindowId)
    || !validId(value.sourceCellId)
    || !["crosshair", "timeAnchor", "dateRange", "drawings"].includes(value.kind)) {
    throw new TypeError("Workspace link event identity is invalid");
  }
  const payload = structuredClone(value.payload);
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 16 * 1024) {
    throw new RangeError("Workspace link event exceeds 16 KiB");
  }
  return { ...structuredClone(value), payload };
}

function sameRevisions(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => (left[key] ?? -1) === (right[key] ?? -1));
}

function jsonEqual(left, right) {
  if (left === right) return true;
  if (left === MISSING || right === MISSING) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function plainObject(value) {
  return value !== MISSING && value !== null && typeof value === "object" && !Array.isArray(value);
}

function threeWayMerge(base, current, candidate, path = "$") {
  if (jsonEqual(candidate, base)) return current === MISSING ? MISSING : structuredClone(current);
  if (jsonEqual(current, base)) return candidate === MISSING ? MISSING : structuredClone(candidate);
  if (jsonEqual(current, candidate)) return current === MISSING ? MISSING : structuredClone(current);
  if (!plainObject(base) || !plainObject(current) || !plainObject(candidate)) {
    throw new WorkspaceBusConflictError(`WorkspaceBus three-way conflict at ${path}`, { path });
  }
  const merged = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(candidate)]);
  for (const key of keys) {
    const value = threeWayMerge(
      Object.hasOwn(base, key) ? base[key] : MISSING,
      Object.hasOwn(current, key) ? current[key] : MISSING,
      Object.hasOwn(candidate, key) ? candidate[key] : MISSING,
      `${path}.${key}`,
    );
    if (value !== MISSING) merged[key] = value;
  }
  return merged;
}

function mergeShape(snapshot) {
  return {
    activeWorkspaceId: snapshot.activeWorkspaceId,
    workspaces: Object.fromEntries(snapshot.workspaces.map((record) => {
      const { updatedAt: _updatedAt, document, ...metadata } = record;
      const { revision: _revision, ...documentContent } = document;
      return [record.id, { ...metadata, document: documentContent }];
    })),
  };
}

function mergeWorkspaceSnapshots(base, current, candidate, now) {
  const mergedShape = threeWayMerge(
    mergeShape(base),
    mergeShape(current),
    mergeShape(candidate),
  );
  const currentById = new Map(current.workspaces.map((record) => [record.id, record]));
  const candidateById = new Map(candidate.workspaces.map((record) => [record.id, record]));
  const orderedIds = [
    ...current.workspaces.map((record) => record.id),
    ...candidate.workspaces.map((record) => record.id).filter((id) => !currentById.has(id)),
  ].filter((id) => mergedShape.workspaces[id]);
  const workspaces = orderedIds.map((id) => {
    const mergedRecord = mergedShape.workspaces[id];
    const currentRecord = currentById.get(id);
    const candidateRecord = candidateById.get(id);
    if (!currentRecord) {
      const revision = candidateRecord?.document.revision ?? 0;
      return { ...mergedRecord, updatedAt: candidateRecord?.updatedAt ?? now, document: { ...mergedRecord.document, revision } };
    }
    const currentShape = mergeShape({ activeWorkspaceId: id, workspaces: [currentRecord] }).workspaces[id];
    const changed = !jsonEqual(currentShape, mergedRecord);
    return {
      ...mergedRecord,
      updatedAt: changed
        ? Math.max(now, currentRecord.updatedAt, candidateRecord?.updatedAt ?? 0)
        : currentRecord.updatedAt,
      document: {
        ...mergedRecord.document,
        revision: changed ? currentRecord.document.revision + 1 : currentRecord.document.revision,
      },
    };
  });
  return validateWorkspaceSnapshot({ activeWorkspaceId: mergedShape.activeWorkspaceId, workspaces });
}

export class WorkspaceBusHub {
  constructor({
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    crosshairIntervalMs = 33,
  } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.crosshairIntervalMs = Math.max(16, Math.floor(crosshairIntervalMs));
    this.participants = new Map();
    this.snapshot = null;
    this.sequence = -1;
    this.writerWindowId = null;
    this.linkSequence = 0;
    this.lastCrosshairAt = new Map();
    this.pendingCrosshair = new Map();
    this.crosshairTimers = new Map();
    this.counts = {
      bootstrap: 0,
      commits: 0,
      conflicts: 0,
      linkPublished: 0,
      crosshairCoalesced: 0,
      rebases: 0,
      disconnects: 0,
    };
  }

  register(windowId, send) {
    if (!validId(windowId) || typeof send !== "function") {
      throw new TypeError("WorkspaceBus participant is invalid");
    }
    this.participants.set(windowId, {
      focused: false,
      healthyAt: this.now(),
      send,
      visible: true,
    });
    this.electWriter();
    return this.stateResult();
  }

  connect(windowId, candidateSnapshot = null) {
    if (!this.participants.has(windowId)) throw new Error(`WorkspaceBus window is not registered: ${windowId}`);
    if (this.snapshot === null && candidateSnapshot !== null && windowId === "main-window") {
      this.snapshot = validateWorkspaceSnapshot(candidateSnapshot);
      this.sequence = 0;
      this.counts.bootstrap += 1;
      this.broadcast("snapshot", { reason: "bootstrap" });
    }
    return this.stateResult();
  }

  commit(windowId, raw) {
    if (!this.participants.has(windowId)) throw new Error(`WorkspaceBus window is not registered: ${windowId}`);
    if (this.snapshot === null) throw new Error("WorkspaceBus is not bootstrapped");
    const expectedSequence = Number(raw?.expectedSequence);
    const expectedRevisions = validateExpectedRevisions(raw?.expectedRevisions);
    let candidate = validateWorkspaceSnapshot(raw?.snapshot);
    const actualRevisions = snapshotRevisions(this.snapshot);
    if (!Number.isSafeInteger(expectedSequence)
      || expectedSequence !== this.sequence
      || !sameRevisions(expectedRevisions, actualRevisions)) {
      try {
        const base = validateWorkspaceSnapshot(raw?.baseSnapshot);
        candidate = mergeWorkspaceSnapshots(base, this.snapshot, candidate, this.now());
        this.counts.rebases += 1;
      } catch (mergeError) {
        this.counts.conflicts += 1;
        throw new WorkspaceBusConflictError(
          `WorkspaceBus conflict: expected sequence ${expectedSequence}, actual ${this.sequence}`,
          {
            expectedSequence,
            actualSequence: this.sequence,
            expectedRevisions,
            actualRevisions,
            mergeConflict: mergeError?.details || String(mergeError?.message || mergeError),
          },
        );
      }
    }
    const candidateRevisions = snapshotRevisions(candidate);
    for (const [workspaceId, revision] of Object.entries(candidateRevisions)) {
      const previous = actualRevisions[workspaceId] ?? -1;
      if (previous >= 0 && revision < previous) {
        throw new WorkspaceBusConflictError(
          `Workspace ${workspaceId} revision regressed from ${previous} to ${revision}`,
          { workspaceId, expectedRevision: previous, actualRevision: revision },
        );
      }
    }
    const encodedCurrent = JSON.stringify(this.snapshot);
    const encodedCandidate = JSON.stringify(candidate);
    if (encodedCurrent === encodedCandidate) {
      return { ...this.stateResult(), idempotent: true };
    }
    this.snapshot = candidate;
    this.sequence += 1;
    this.counts.commits += 1;
    this.broadcast("snapshot", { reason: "commit", sourceWindowId: windowId });
    return { ...this.stateResult(), idempotent: false };
  }

  publishLink(windowId, raw) {
    if (!this.participants.has(windowId)) throw new Error(`WorkspaceBus window is not registered: ${windowId}`);
    const event = validateLinkEvent(raw);
    if (event.sourceWindowId !== windowId) throw new TypeError("Workspace link source window mismatch");
    if (event.kind !== "crosshair") {
      this.deliverLink(event);
      return { ok: true, coalesced: false };
    }
    const key = `${event.workspaceId}\u0000${event.sourceWindowId}\u0000${event.sourceCellId}`;
    const elapsed = this.now() - (this.lastCrosshairAt.get(key) ?? Number.NEGATIVE_INFINITY);
    if (elapsed >= this.crosshairIntervalMs) {
      this.lastCrosshairAt.set(key, this.now());
      this.deliverLink(event);
      return { ok: true, coalesced: false };
    }
    this.pendingCrosshair.set(key, event);
    this.counts.crosshairCoalesced += 1;
    if (!this.crosshairTimers.has(key)) {
      const timer = this.setTimer(() => {
        this.crosshairTimers.delete(key);
        const pending = this.pendingCrosshair.get(key);
        this.pendingCrosshair.delete(key);
        if (!pending) return;
        this.lastCrosshairAt.set(key, this.now());
        this.deliverLink(pending);
      }, Math.max(0, this.crosshairIntervalMs - elapsed));
      this.crosshairTimers.set(key, timer);
    }
    return { ok: true, coalesced: true };
  }

  reportWindow(windowId, raw) {
    const participant = this.participants.get(windowId);
    if (!participant) return false;
    participant.focused = raw?.focused === true;
    participant.visible = raw?.visible !== false;
    participant.healthyAt = this.now();
    this.broadcast("health", { sourceWindowId: windowId });
    return true;
  }

  disconnect(windowId) {
    if (!this.participants.delete(windowId)) return false;
    this.counts.disconnects += 1;
    for (const key of [...this.pendingCrosshair.keys()]) {
      if (!key.includes(`\u0000${windowId}\u0000`)) continue;
      this.pendingCrosshair.delete(key);
      const timer = this.crosshairTimers.get(key);
      if (timer !== undefined) this.clearTimer(timer);
      this.crosshairTimers.delete(key);
    }
    this.electWriter();
    this.broadcast("health", { reason: "disconnect", sourceWindowId: windowId });
    return true;
  }

  diagnostics() {
    return {
      schemaVersion: WORKSPACE_BUS_SCHEMA,
      sequence: this.sequence,
      writerWindowId: this.writerWindowId,
      participantCount: this.participants.size,
      participants: [...this.participants].map(([windowId, state]) => ({
        windowId,
        focused: state.focused,
        visible: state.visible,
        healthyAt: state.healthyAt,
      })),
      hasSnapshot: this.snapshot !== null,
      revisions: this.snapshot ? snapshotRevisions(this.snapshot) : {},
      pendingCrosshair: this.pendingCrosshair.size,
      counts: { ...this.counts },
    };
  }

  stateResult() {
    return {
      ok: true,
      ready: this.snapshot !== null,
      schemaVersion: WORKSPACE_BUS_SCHEMA,
      sequence: this.sequence,
      writerWindowId: this.writerWindowId,
      revisions: this.snapshot ? snapshotRevisions(this.snapshot) : {},
      snapshot: this.snapshot ? structuredClone(this.snapshot) : null,
    };
  }

  electWriter() {
    const ids = [...this.participants.keys()].sort();
    this.writerWindowId = ids.includes("main-window") ? "main-window" : ids[0] ?? null;
  }

  broadcast(type, details = {}) {
    const message = {
      type,
      ...this.stateResult(),
      ...details,
    };
    for (const participant of this.participants.values()) participant.send(message);
  }

  deliverLink(event) {
    const message = {
      type: "link",
      event: {
        ...event,
        eventId: `link-${++this.linkSequence}`,
        emittedAt: this.now(),
      },
    };
    this.counts.linkPublished += 1;
    for (const [windowId, participant] of this.participants) {
      if (windowId !== event.sourceWindowId) participant.send(message);
    }
  }
}
