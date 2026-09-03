import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SidecarSupervisor, SidecarStartupError } from "./sidecar-supervisor.mjs";

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

test("supervisor starts exactly one child, waits for health, logs, and reclaims it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "candlescope-sidecar-"));
  const port = await freePort();
  const source = [
    "const http=require('node:http');",
    `const s=http.createServer((q,r)=>{r.statusCode=200;r.end(JSON.stringify({desktop_instance_id:process.env.CANDLESCOPE_DESKTOP_INSTANCE_ID}))});`,
    `s.listen(${port},'127.0.0.1',()=>console.log('ready'));`,
    "process.on('SIGTERM',()=>s.close(()=>process.exit(0)));",
  ].join("");
  const supervisor = new SidecarSupervisor({
    command: process.execPath,
    args: ["-e", source],
    cwd: root,
    env: {},
    healthUrl: `http://127.0.0.1:${port}/health`,
    healthTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000,
    logPath: path.join(root, "sidecar.log"),
  });
  const first = await supervisor.start();
  const second = await supervisor.start();
  assert.equal(first.pid, second.pid);
  assert.equal(first.running, true);
  await supervisor.stop();
  assert.equal(supervisor.diagnostics().running, false);
  assert.match(await readFile(path.join(root, "sidecar.log"), "utf8"), /ready/);
});

test("startup failure is fail closed and leaves no running child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "candlescope-sidecar-fail-"));
  const port = await freePort();
  const supervisor = new SidecarSupervisor({
    command: process.execPath,
    args: ["-e", "process.exit(23)"],
    cwd: root,
    env: {},
    healthUrl: `http://127.0.0.1:${port}/health`,
    healthTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    logPath: path.join(root, "sidecar.log"),
  });
  await assert.rejects(() => supervisor.start(), SidecarStartupError);
  assert.equal(supervisor.diagnostics().running, false);
});

test("an existing healthy listener cannot impersonate the launched child", async () => {
  const server = http.createServer((_request, response) => response.end(JSON.stringify({ desktop_instance_id: "old-instance" })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const root = await mkdtemp(path.join(os.tmpdir(), "candlescope-stale-sidecar-"));
  const supervisor = new SidecarSupervisor({
    command: process.execPath, args: ["-e", `setTimeout(() => require('node:http').createServer().listen(${port}, '127.0.0.1'), 100)`],
    cwd: root, env: {}, healthUrl: `http://127.0.0.1:${port}/health`, healthTimeoutMs: 1000,
    shutdownTimeoutMs: 100, logPath: path.join(root, "child.log"),
  });
  try {
    await assert.rejects(supervisor.start(), SidecarStartupError);
    assert.equal(supervisor.diagnostics().readyMs, null);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    await supervisor.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});
