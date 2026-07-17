import type { DrawingExportLifecycleTransaction } from "./drawingExportLifecycle.js";

const CONTROLLED_DRILL_ID = "series-rebuild-before-export";
const CONTROLLED_HANDLE_NAME = "__CANDLESCOPE_CONTROLLED_ROLLBACK_DRILL__";
const CONTROLLED_CHECKPOINT_TIMEOUT_MS = 31_000;

interface ControlledRollbackSnapshot {
  readonly runId: string;
  readonly authorityTokenSha256: string;
  readonly authorityAccepted: true;
  readonly tokenRemoved: true;
  readonly drillId: typeof CONTROLLED_DRILL_ID;
  readonly variant: null;
  readonly documentInstanceId: string;
  readonly faultId: string;
  readonly sequence: number;
}

interface ControlledCheckpointReceipt {
  readonly accepted: true;
  readonly checkpointId: string;
  readonly paused: boolean;
  readonly runId: string;
  readonly authorityTokenSha256: string;
  readonly documentInstanceId: string;
  readonly faultId: string;
  readonly sequence: number;
  readonly transactionId: string;
  readonly leaseId: number;
}

interface ControlledRollbackHandle {
  snapshot(): unknown;
  awaitSeriesRebuildExportCapture(input: Readonly<{
    transactionId: string;
    leaseId: number;
    scopeKey: string;
    documentRevision: number;
    surfaceGeneration: number | null;
    hideDrawings: boolean;
    signal: AbortSignal;
  }>): Promise<unknown>;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactAuthority(value: unknown): ControlledRollbackSnapshot | null {
  const snapshot = objectValue(value);
  if (!snapshot
    || snapshot.authorityAccepted !== true
    || snapshot.tokenRemoved !== true
    || snapshot.drillId !== CONTROLLED_DRILL_ID
    || snapshot.variant !== null
    || typeof snapshot.runId !== "string"
    || !snapshot.runId
    || typeof snapshot.authorityTokenSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(snapshot.authorityTokenSha256)
    || typeof snapshot.documentInstanceId !== "string"
    || !snapshot.documentInstanceId
    || typeof snapshot.faultId !== "string"
    || !/^[a-f0-9-]{36}$/.test(snapshot.faultId)
    || !Number.isSafeInteger(snapshot.sequence)
    || Number(snapshot.sequence) <= 0) return null;
  return snapshot as unknown as ControlledRollbackSnapshot;
}

function controlledHandle(): Readonly<{
  handle: ControlledRollbackHandle;
  authority: ControlledRollbackSnapshot;
}> | null {
  if (typeof window === "undefined") return null;
  let handle: ControlledRollbackHandle | null = null;
  let authority: ControlledRollbackSnapshot | null = null;
  try {
    const candidate = (window as unknown as Record<string, unknown>)[CONTROLLED_HANDLE_NAME];
    handle = objectValue(candidate) as unknown as ControlledRollbackHandle | null;
    if (!handle || typeof handle.snapshot !== "function") return null;
    authority = exactAuthority(handle.snapshot());
  } catch {
    return null;
  }
  if (!authority) return null;
  if (typeof handle.awaitSeriesRebuildExportCapture !== "function") {
    throw new Error("Controlled series-rebuild export checkpoint is unavailable");
  }
  return Object.freeze({ handle, authority });
}

function awaitControlledCheckpoint(
  pending: PromiseLike<unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
      signal.removeEventListener("abort", abort);
      if (error !== null) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new DOMException(
      "Controlled series-rebuild export checkpoint was aborted",
      "AbortError",
    ));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    timeoutId = globalThis.setTimeout(() => finish(new Error(
      "Controlled series-rebuild export checkpoint timed out",
    )), CONTROLLED_CHECKPOINT_TIMEOUT_MS);
    Promise.resolve(pending).then(
      (value) => finish(null, value),
      (error: unknown) => finish(error instanceof Error
        ? error
        : new Error("Controlled series-rebuild export checkpoint failed", { cause: error })),
    );
  });
}

/**
 * The production export path owns the lease and every revalidation decision.
 * This authority-bound hook can only pause between a completed prepare and the
 * first source-pixel capture; it never receives or mutates the lease itself.
 */
export async function awaitControlledSeriesRebuildExportCapture(
  transaction: DrawingExportLifecycleTransaction,
  signal: AbortSignal,
): Promise<ControlledCheckpointReceipt | null> {
  const controlled = controlledHandle();
  if (!controlled) return null;
  if (signal.aborted) {
    throw new DOMException(
      "Controlled series-rebuild export checkpoint was aborted",
      "AbortError",
    );
  }
  const pending = controlled.handle.awaitSeriesRebuildExportCapture(Object.freeze({
    transactionId: transaction.transactionId,
    leaseId: transaction.leaseId,
    scopeKey: transaction.scopeKey,
    documentRevision: transaction.documentRevision,
    surfaceGeneration: transaction.surfaceGeneration,
    hideDrawings: transaction.hideDrawings,
    signal,
  }));
  const value = await awaitControlledCheckpoint(pending, signal);
  const receipt = objectValue(value);
  const authority = controlled.authority;
  if (!receipt
    || receipt.accepted !== true
    || typeof receipt.checkpointId !== "string"
    || !receipt.checkpointId
    || typeof receipt.paused !== "boolean"
    || receipt.runId !== authority.runId
    || receipt.authorityTokenSha256 !== authority.authorityTokenSha256
    || receipt.documentInstanceId !== authority.documentInstanceId
    || receipt.faultId !== authority.faultId
    || receipt.sequence !== authority.sequence
    || receipt.transactionId !== transaction.transactionId
    || receipt.leaseId !== transaction.leaseId) {
    throw new Error("Controlled series-rebuild export checkpoint receipt is invalid");
  }
  return receipt as unknown as ControlledCheckpointReceipt;
}
