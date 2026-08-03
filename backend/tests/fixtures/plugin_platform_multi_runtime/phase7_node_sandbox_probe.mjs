/* SPDX-License-Identifier: GPL-3.0-only */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const [secretPath, sourcePath, installationWrite, privateWrite, portText] =
  process.argv.slice(2);

function canRead(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function canWrite(path) {
  try {
    writeFileSync(path, "sandbox-probe", "utf8");
    return true;
  } catch {
    return false;
  }
}

function childProcessDenied() {
  try {
    const result = spawnSync(process.execPath, ["--version"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return result.error?.code === "ERR_ACCESS_DENIED" || result.status === null;
  } catch (error) {
    return error?.code === "ERR_ACCESS_DENIED";
  }
}

function loopbackDenied(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (denied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(denied);
    };
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    socket.setTimeout(2_000, () => finish(true));
  });
}

const result = {
  childProcessDenied: childProcessDenied(),
  externalDenied: !canRead(secretPath),
  installationWrite: canWrite(installationWrite),
  loopbackDenied: await loopbackDenied(Number(portText)),
  privateWrite: canWrite(privateWrite),
  secretRead: canRead(secretPath),
  sourceRead: canRead(sourcePath),
};

process.stdout.write(`${JSON.stringify(result)}\n`);
