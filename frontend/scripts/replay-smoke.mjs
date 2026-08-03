import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const v2Entrypoint = path.join(scriptDirectory, "replay-soak.mjs");

// This historical filename is intentionally a v2-only forwarding entrypoint.
// replay-soak owns the fixture runtime flags --live-window and
// --disable-gap-maintenance; no v1 product can be selected here.
const result = spawnSync(process.execPath, [
  v2Entrypoint,
  "--allow-short",
  "--duration-ms",
  "10000",
  "--cycles",
  "1",
  "--projection-events",
  "10000",
  "--sample-ms",
  "5000",
  ...process.argv.slice(2),
], {
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
