export const FOREGROUND_PRELOAD_QUIET_DWELL_MS = 30_000;

export interface ForegroundLease {
  readonly generation: number;
  readonly owner: string;
  release(): void;
}

export interface PreloadLease {
  readonly controller: AbortController;
  readonly generation: number;
  readonly owner: string;
}

type TimerHandle = unknown;

export interface ForegroundPreloadGateOptions {
  quietDwellMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
}

export interface ForegroundPreloadGateSnapshot {
  activeForeground: number;
  activePreloadOwner: string | null;
  blockedUntil: number;
  generation: number;
  waitMs: number;
}

/**
 * App-instance arbitration between user-visible market-data work and
 * speculative preloading.
 *
 * Foreground leases are reference counted. The first foreground entrant
 * synchronously aborts the single speculative lease, and preloading remains
 * blocked until every foreground owner has released plus one complete quiet
 * dwell. Lease identity fences stale releases from newer generations.
 */
export class ForegroundPreloadGate {
  private readonly quietDwellMs: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;
  private readonly foregroundOwners = new Map<symbol, string>();
  private readonly listeners = new Set<() => void>();
  private activePreload: (PreloadLease & { readonly token: symbol }) | null = null;
  private blockedUntil = 0;
  private generation = 0;
  private wakeTimer: TimerHandle | null = null;
  private disposed = false;

  constructor(options: number | ForegroundPreloadGateOptions = {}) {
    const normalized = typeof options === "number" ? { quietDwellMs: options } : options;
    this.quietDwellMs = Math.max(
      0,
      Number(normalized.quietDwellMs ?? FOREGROUND_PRELOAD_QUIET_DWELL_MS) || 0,
    );
    this.now = normalized.now || Date.now;
    this.schedule = normalized.schedule || ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = normalized.cancel || ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  enterForeground(owner = "foreground"): ForegroundLease {
    const token = Symbol(owner);
    if (this.disposed) {
      return { generation: this.generation, owner, release: () => {} };
    }
    this.foregroundOwners.set(token, owner);
    this.preemptForForeground(this.now());
    const leaseGeneration = this.generation;
    let released = false;
    return {
      generation: leaseGeneration,
      owner,
      release: () => {
        if (released) return;
        released = true;
        if (!this.foregroundOwners.delete(token) || this.disposed) return;
        if (this.foregroundOwners.size === 0) {
          this.extendQuietDwell(this.now());
        }
        this.notify();
      },
    };
  }

  acquireBusy(owner: string): ForegroundLease {
    return this.enterForeground(owner);
  }

  /** Marks instantaneous foreground activity before its transport lease starts. */
  yieldToForeground(now = this.now()): void {
    if (this.disposed) return;
    this.preemptForForeground(now);
  }

  waitMs(now = this.now()): number {
    if (this.disposed || this.foregroundOwners.size > 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.blockedUntil - now);
  }

  tryAcquirePreload(ownerOrNow: string | number = "preload", requestedNow?: number): PreloadLease | null {
    if (this.disposed || this.activePreload || this.foregroundOwners.size > 0) return null;
    const owner = typeof ownerOrNow === "string" ? ownerOrNow : "preload";
    const now = typeof ownerOrNow === "number" ? ownerOrNow : (requestedNow ?? this.now());
    if (this.waitMs(now) > 0) {
      this.scheduleWake();
      return null;
    }
    const token = Symbol(owner);
    const lease = {
      controller: new AbortController(),
      generation: this.generation,
      owner,
      token,
    };
    this.activePreload = lease;
    return lease;
  }

  isCurrent(lease: PreloadLease): boolean {
    return this.activePreload === lease
      && lease.generation === this.generation
      && !lease.controller.signal.aborted;
  }

  release(lease: PreloadLease): void {
    if (this.activePreload !== lease) return;
    this.activePreload = null;
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    this.scheduleWake();
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(now = this.now()): ForegroundPreloadGateSnapshot {
    return {
      activeForeground: this.foregroundOwners.size,
      activePreloadOwner: this.activePreload?.owner || null,
      blockedUntil: this.blockedUntil,
      generation: this.generation,
      waitMs: this.waitMs(now),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.foregroundOwners.clear();
    const activePreload = this.activePreload;
    this.activePreload = null;
    activePreload?.controller.abort();
    if (this.wakeTimer != null) this.cancel(this.wakeTimer);
    this.wakeTimer = null;
    this.listeners.clear();
  }

  private preemptForForeground(now: number): void {
    this.generation += 1;
    this.blockedUntil = Math.max(this.blockedUntil, now + this.quietDwellMs);
    const activePreload = this.activePreload;
    this.activePreload = null;
    activePreload?.controller.abort();
    this.scheduleWake();
    this.notify();
  }

  private extendQuietDwell(now: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, now + this.quietDwellMs);
    this.scheduleWake();
  }

  private scheduleWake(): void {
    if (this.disposed) return;
    if (this.wakeTimer != null) {
      this.cancel(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (this.foregroundOwners.size > 0 || this.activePreload) return;
    const delayMs = Math.max(0, this.blockedUntil - this.now());
    if (delayMs <= 0) return;
    this.wakeTimer = this.schedule(() => {
      this.wakeTimer = null;
      if (this.disposed || this.foregroundOwners.size > 0 || this.activePreload) return;
      const remaining = this.waitMs();
      if (remaining > 0) {
        this.scheduleWake();
        return;
      }
      this.notify();
    }, delayMs);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
