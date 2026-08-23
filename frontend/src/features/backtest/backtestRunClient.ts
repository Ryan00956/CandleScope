import type { BacktestApiClient } from "./backtestApi.js";
import type { BacktestRunRecord } from "./backtestTypes.js";

export const BACKTEST_TERMINAL_STATES = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

const terminalStates = new Set<string>(BACKTEST_TERMINAL_STATES);

export function isBacktestTerminalState(state: string): boolean {
  return terminalStates.has(state);
}

function abortError(): Error {
  const error = new Error("backtest Run polling aborted");
  error.name = "AbortError";
  return error;
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : abortError();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

export function waitForBacktestPoll(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollBacktestRunToTerminal(options: {
  api: Pick<BacktestApiClient, "getRun">;
  runId: string;
  signal?: AbortSignal;
  intervalMs?: number;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  onUpdate?: (run: BacktestRunRecord) => void;
}): Promise<BacktestRunRecord> {
  const intervalMs = Math.max(0, options.intervalMs ?? 1_000);
  const wait = options.wait ?? waitForBacktestPoll;
  while (true) {
    throwIfAborted(options.signal);
    const run = await options.api.getRun(options.runId, options.signal);
    throwIfAborted(options.signal);
    options.onUpdate?.(run);
    if (isBacktestTerminalState(run.state)) return run;
    await wait(intervalMs, options.signal);
  }
}
