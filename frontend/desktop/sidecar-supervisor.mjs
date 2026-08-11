import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export class SidecarStartupError extends Error {
  constructor(message, diagnostics) {
    super(message);
    this.name = "SidecarStartupError";
    this.code = "SIDECAR_STARTUP_FAILED";
    this.diagnostics = diagnostics;
  }
}

async function waitForHealthy(url, child, timeoutMs, fetchImpl) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new SidecarStartupError(`Sidecar exited before it became healthy (${child.exitCode})`, {
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      });
    }
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return Date.now() - startedAt;
      lastError = new Error(`health endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new SidecarStartupError(`Sidecar health check timed out after ${timeoutMs} ms`, {
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

export class SidecarSupervisor {
  constructor(options) {
    this.options = {
      fetchImpl: globalThis.fetch,
      healthTimeoutMs: 60_000,
      shutdownTimeoutMs: 10_000,
      ...options,
    };
    this.child = null;
    this.logHandle = null;
    this.startPromise = null;
    this.startedAt = null;
    this.readyMs = null;
  }

  diagnostics() {
    return {
      pid: this.child?.pid ?? null,
      running: this.child !== null && this.child.exitCode === null,
      startedAt: this.startedAt,
      readyMs: this.readyMs,
      command: this.options.command,
      args: this.options.args,
      healthUrl: this.options.healthUrl,
      logPath: this.options.logPath,
    };
  }

  async start() {
    if (this.child && this.child.exitCode === null) return this.diagnostics();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async startOnce() {
    await mkdir(dirname(this.options.logPath), { recursive: true });
    this.logHandle = await open(this.options.logPath, "a");
    this.startedAt = new Date().toISOString();
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      windowsHide: true,
      detached: false,
      stdio: ["ignore", this.logHandle.fd, this.logHandle.fd],
    });
    this.child = child;
    try {
      this.readyMs = await waitForHealthy(
        this.options.healthUrl,
        child,
        this.options.healthTimeoutMs,
        this.options.fetchImpl,
      );
      return this.diagnostics();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, this.options.shutdownTimeoutMs)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (this.logHandle) await this.logHandle.close();
    this.logHandle = null;
  }
}
