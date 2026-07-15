export type DrawingExportMaybePromise<T> = T | PromiseLike<T>;

export interface DrawingExportTarget {
  readonly scopeKey: string;
  readonly documentRevision: number;
}

export interface DrawingExportPersistenceReceipt<TPersistence> extends DrawingExportTarget {
  readonly persistence: TPersistence;
}

export interface DrawingExportSceneReceipt<TScene> extends DrawingExportTarget {
  readonly scene: TScene;
}

export interface DrawingExportBarrierReceipt<TPersistence, TScene, TPaint>
  extends DrawingExportTarget {
  readonly leaseId: number;
  readonly persistence: TPersistence;
  readonly scene: TScene;
  readonly paint: TPaint;
}

export interface DrawingExportBarrierStepContext {
  readonly leaseId: number;
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export type DrawingExportTerminalizeContext = DrawingExportBarrierStepContext;

export interface DrawingExportFlushContext extends DrawingExportBarrierStepContext {
  readonly target: DrawingExportTarget;
}

export interface DrawingExportPresentationContext<TPersistence, TScene>
  extends DrawingExportBarrierStepContext {
  readonly target: DrawingExportTarget;
  readonly persistence: TPersistence;
  readonly scene: TScene;
}

export interface DrawingExportExactSceneContext<TPersistence>
  extends DrawingExportBarrierStepContext {
  readonly target: DrawingExportTarget;
  readonly persistence: TPersistence;
}

export interface DrawingExportFrameContext<TPersistence, TPresentation, TScene>
  extends DrawingExportBarrierStepContext {
  readonly target: DrawingExportTarget;
  readonly persistence: TPersistence;
  readonly presentation: TPresentation;
  readonly scene: TScene;
}

export interface DrawingExportRevalidateContext<
  TPersistence,
  TPresentation,
  TScene,
  TPaint,
> extends DrawingExportBarrierStepContext {
  readonly target: DrawingExportTarget;
  readonly presentation: TPresentation;
  readonly receipt: DrawingExportBarrierReceipt<TPersistence, TScene, TPaint>;
}

export interface DrawingExportRestoreContext<
  TPersistence,
  TPresentation,
  TScene,
  TPaint,
> {
  readonly leaseId: number;
  readonly reason: "failure" | "lease";
  readonly cause: unknown | null;
  readonly target: DrawingExportTarget | null;
  readonly presentationAttempted: boolean;
  readonly presentationApplied: boolean;
  readonly presentation: TPresentation | null;
  readonly receipt: DrawingExportBarrierReceipt<TPersistence, TScene, TPaint> | null;
}

export interface DrawingExportBarrierDependencies<
  TPersistence,
  TPresentation,
  TScene,
  TPaint,
> {
  terminalizeInteraction(
    context: DrawingExportTerminalizeContext,
  ): DrawingExportMaybePromise<DrawingExportTarget>;
  flushTargetDocument(
    context: DrawingExportFlushContext,
  ): DrawingExportMaybePromise<DrawingExportPersistenceReceipt<TPersistence>>;
  awaitExactScene(
    context: DrawingExportExactSceneContext<TPersistence>,
  ): DrawingExportMaybePromise<DrawingExportSceneReceipt<TScene>>;
  applyAndClearPresentation(
    context: DrawingExportPresentationContext<TPersistence, TScene>,
  ): DrawingExportMaybePromise<TPresentation>;
  waitForNextFrame(
    context: DrawingExportFrameContext<TPersistence, TPresentation, TScene>,
  ): DrawingExportMaybePromise<TPaint>;
  revalidate(
    context: DrawingExportRevalidateContext<TPersistence, TPresentation, TScene, TPaint>,
  ): DrawingExportMaybePromise<boolean>;
  restorePresentation(
    context: DrawingExportRestoreContext<TPersistence, TPresentation, TScene, TPaint>,
  ): DrawingExportMaybePromise<void>;
}

export interface DrawingExportBarrierPrepareOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DrawingExportBarrierOptions {
  readonly defaultTimeoutMs?: number;
  readonly now?: () => number;
}

export interface DrawingExportBarrierLease<TPersistence, TScene, TPaint> {
  readonly leaseId: number;
  readonly receipt: DrawingExportBarrierReceipt<TPersistence, TScene, TPaint>;
  revalidate(): Promise<boolean>;
  restore(): Promise<void>;
}

export interface DrawingExportBarrierSnapshot {
  readonly locked: boolean;
  readonly leaseId: number | null;
}

export interface DrawingExportBarrier<TPersistence, TScene, TPaint> {
  prepare(
    options?: DrawingExportBarrierPrepareOptions,
  ): Promise<DrawingExportBarrierLease<TPersistence, TScene, TPaint>>;
  snapshot(): DrawingExportBarrierSnapshot;
}

export type DrawingExportBarrierErrorCode =
  | "aborted"
  | "busy"
  | "invalid-receipt"
  | "invalid-timeout"
  | "restore-failed"
  | "stale"
  | "timeout";

export class DrawingExportBarrierError extends Error {
  readonly code: DrawingExportBarrierErrorCode;

  constructor(
    code: DrawingExportBarrierErrorCode,
    message: string,
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super(message, options);
    this.name = "DrawingExportBarrierError";
    this.code = code;
  }
}

const DEFAULT_EXPORT_BARRIER_TIMEOUT_MS = 5_000;

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function normalizedTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new DrawingExportBarrierError(
      "invalid-timeout",
      "Drawing export barrier timeout must be a finite positive number",
    );
  }
  return timeout;
}

function validTarget(value: unknown): value is DrawingExportTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Partial<DrawingExportTarget>;
  return typeof target.scopeKey === "string"
    && target.scopeKey.length > 0
    && Number.isSafeInteger(target.documentRevision)
    && Number(target.documentRevision) >= 0;
}

function matchingTarget(
  expected: DrawingExportTarget,
  candidate: DrawingExportTarget,
): boolean {
  return expected.scopeKey === candidate.scopeKey
    && expected.documentRevision === candidate.documentRevision;
}

function invalidReceipt(message: string): DrawingExportBarrierError {
  return new DrawingExportBarrierError("invalid-receipt", message);
}

function nextLeaseId(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

/**
 * Coordinates the export-only drawing boundary without owning any drawing,
 * persistence, scene, or presentation implementation. The returned lease
 * deliberately retains the single-instance lock until its idempotent restore
 * method finishes, so two captures can never share temporary presentation
 * state.
 */
export function createDrawingExportBarrier<
  TPersistence,
  TPresentation,
  TScene,
  TPaint,
>(
  dependencies: DrawingExportBarrierDependencies<
    TPersistence,
    TPresentation,
    TScene,
    TPaint
  >,
  options: DrawingExportBarrierOptions = {},
): DrawingExportBarrier<TPersistence, TScene, TPaint> {
  const now = options.now ?? defaultNow;
  const defaultTimeoutMs = normalizedTimeout(
    options.defaultTimeoutMs,
    DEFAULT_EXPORT_BARRIER_TIMEOUT_MS,
  );
  let activeToken: symbol | null = null;
  let activeLeaseId: number | null = null;
  let leaseSequence = 0;

  const snapshot = (): DrawingExportBarrierSnapshot => Object.freeze({
    locked: activeToken !== null,
    leaseId: activeLeaseId,
  });

  const prepare = async (
    prepareOptions: DrawingExportBarrierPrepareOptions = {},
  ): Promise<DrawingExportBarrierLease<TPersistence, TScene, TPaint>> => {
    if (activeToken !== null) {
      throw new DrawingExportBarrierError(
        "busy",
        "A drawing export barrier lease is already active",
      );
    }
    const timeoutMs = normalizedTimeout(prepareOptions.timeoutMs, defaultTimeoutMs);

    leaseSequence = nextLeaseId(leaseSequence);
    const leaseId = leaseSequence;
    const token = Symbol(`drawing-export-${leaseId}`);
    activeToken = token;
    activeLeaseId = leaseId;

    const abortController = new AbortController();
    const deadline = now() + timeoutMs;
    let currentStage = "terminalize interaction";
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | null = null;
    let target: DrawingExportTarget | null = null;
    let persistence: TPersistence | null = null;
    let presentation: TPresentation | null = null;
    let presentationAttempted = false;
    let presentationApplied = false;
    let finalReceipt: DrawingExportBarrierReceipt<TPersistence, TScene, TPaint> | null = null;

    const abortWith = (error: DrawingExportBarrierError): void => {
      if (!abortController.signal.aborted) abortController.abort(error);
    };

    const externalAbort = (): void => {
      abortWith(new DrawingExportBarrierError(
        "aborted",
        `Drawing export barrier was aborted during ${currentStage}`,
        { cause: prepareOptions.signal?.reason },
      ));
    };

    const disposeControl = (): void => {
      if (timeoutHandle !== null) {
        globalThis.clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      prepareOptions.signal?.removeEventListener("abort", externalAbort);
    };

    const timeoutError = (stage: string): DrawingExportBarrierError => (
      new DrawingExportBarrierError(
        "timeout",
        `Drawing export barrier timed out during ${stage}`,
      )
    );

    const cancellationError = (stage: string): DrawingExportBarrierError => {
      const reason: unknown = abortController.signal.reason;
      if (reason instanceof DrawingExportBarrierError) return reason;
      return new DrawingExportBarrierError(
        "aborted",
        `Drawing export barrier was aborted during ${stage}`,
        { cause: reason },
      );
    };

    const ensureCurrent = (stage: string): void => {
      if (activeToken !== token) {
        throw new DrawingExportBarrierError(
          "stale",
          `Drawing export barrier lost ownership during ${stage}`,
        );
      }
      if (abortController.signal.aborted) throw cancellationError(stage);
      if (now() >= deadline) {
        const error = timeoutError(stage);
        abortWith(error);
        throw error;
      }
    };

    const runStep = async <TResult>(
      stage: string,
      callback: () => DrawingExportMaybePromise<TResult>,
    ): Promise<TResult> => {
      currentStage = stage;
      ensureCurrent(stage);
      const operation = Promise.resolve().then(callback);
      const cancellation = new Promise<never>((_resolve, reject) => {
        const rejectCancelled = (): void => reject(cancellationError(stage));
        if (abortController.signal.aborted) {
          rejectCancelled();
          return;
        }
        abortController.signal.addEventListener("abort", rejectCancelled, { once: true });
        operation.finally(() => {
          abortController.signal.removeEventListener("abort", rejectCancelled);
        }).catch(() => {
          // The caller observes the original operation rejection through race.
        });
      });
      const result = await Promise.race([operation, cancellation]);
      ensureCurrent(stage);
      return result;
    };

    const releaseOwnedToken = (): void => {
      if (activeToken !== token) return;
      activeToken = null;
      activeLeaseId = null;
    };

    const restoreOwnedPresentation = async (
      reason: "failure" | "lease",
      cause: unknown | null,
      receipt: DrawingExportBarrierReceipt<TPersistence, TScene, TPaint> | null,
    ): Promise<void> => {
      if (activeToken !== token) return;
      try {
        await dependencies.restorePresentation(Object.freeze({
          leaseId,
          reason,
          cause,
          target,
          presentationAttempted,
          presentationApplied,
          presentation,
          receipt,
        }));
      } finally {
        releaseOwnedToken();
      }
    };

    if (prepareOptions.signal?.aborted) externalAbort();
    else prepareOptions.signal?.addEventListener("abort", externalAbort, { once: true });
    timeoutHandle = globalThis.setTimeout(() => {
      abortWith(timeoutError(currentStage));
    }, timeoutMs);

    try {
      const context = (): DrawingExportBarrierStepContext => Object.freeze({
        leaseId,
        signal: abortController.signal,
        deadline,
      });

      const terminalTarget = await runStep("terminalize interaction", () => (
        dependencies.terminalizeInteraction(context())
      ));
      if (!validTarget(terminalTarget)) {
        throw invalidReceipt("Terminal interaction did not return a valid export target");
      }
      target = Object.freeze({ ...terminalTarget });

      const persisted = await runStep("flush target document", () => (
        dependencies.flushTargetDocument(Object.freeze({
          ...context(),
          target: target as DrawingExportTarget,
        }))
      ));
      if (!validTarget(persisted) || !matchingTarget(target, persisted)) {
        throw invalidReceipt("Persistence flush did not cover the exact export target");
      }
      persistence = persisted.persistence;

      const exactScene = await runStep("await exact scene", () => (
        dependencies.awaitExactScene(Object.freeze({
          ...context(),
          target: target as DrawingExportTarget,
          persistence: persistence as TPersistence,
        }))
      ));
      if (!validTarget(exactScene) || !matchingTarget(target, exactScene)) {
        throw invalidReceipt("Exact scene did not cover the exact export target");
      }

      presentationAttempted = true;
      presentation = await runStep("apply and clear presentation", () => (
        dependencies.applyAndClearPresentation(Object.freeze({
          ...context(),
          target: target as DrawingExportTarget,
          persistence: persistence as TPersistence,
          scene: exactScene.scene,
        }))
      ));
      presentationApplied = true;

      const paint = await runStep("wait for animation frame", () => (
        dependencies.waitForNextFrame(Object.freeze({
          ...context(),
          target: target as DrawingExportTarget,
          persistence: persistence as TPersistence,
          presentation: presentation as TPresentation,
          scene: exactScene.scene,
        }))
      ));

      finalReceipt = Object.freeze({
        leaseId,
        scopeKey: target.scopeKey,
        documentRevision: target.documentRevision,
        persistence: persistence as TPersistence,
        scene: exactScene.scene,
        paint,
      });
      const current = await runStep("revalidate export target", () => (
        dependencies.revalidate(Object.freeze({
          ...context(),
          target: target as DrawingExportTarget,
          presentation: presentation as TPresentation,
          receipt: finalReceipt as DrawingExportBarrierReceipt<TPersistence, TScene, TPaint>,
        }))
      ));
      if (current !== true) {
        throw invalidReceipt("Drawing export target became stale before capture");
      }
      ensureCurrent("return export lease");
      disposeControl();

      let restorePromise: Promise<void> | null = null;
      const lease: DrawingExportBarrierLease<TPersistence, TScene, TPaint> = Object.freeze({
        leaseId,
        receipt: finalReceipt,
        async revalidate(): Promise<boolean> {
          if (activeToken !== token) return false;
          const current = await dependencies.revalidate(Object.freeze({
            leaseId,
            signal: abortController.signal,
            deadline,
            target: target as DrawingExportTarget,
            presentation: presentation as TPresentation,
            receipt: finalReceipt as DrawingExportBarrierReceipt<TPersistence, TScene, TPaint>,
          }));
          return activeToken === token && current === true;
        },
        restore(): Promise<void> {
          if (!restorePromise) {
            restorePromise = restoreOwnedPresentation("lease", null, finalReceipt);
          }
          return restorePromise;
        },
      });
      return lease;
    } catch (error) {
      disposeControl();
      if (!abortController.signal.aborted) abortController.abort(error);
      try {
        await restoreOwnedPresentation("failure", error, finalReceipt);
      } catch (restoreError) {
        throw new DrawingExportBarrierError(
          "restore-failed",
          "Drawing export barrier failed and could not restore presentation state",
          { cause: new AggregateError([error, restoreError]) },
        );
      }
      throw error;
    }
  };

  return Object.freeze({ prepare, snapshot });
}
