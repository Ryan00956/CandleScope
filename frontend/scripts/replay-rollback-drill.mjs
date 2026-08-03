import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const v2Entrypoint = path.join(scriptDirectory, "replay-v2-rollback-drill.mjs");

// Keep the historical filename fail-closed on the sole supported product.
// The v2 drill itself checks the detached old commit without exposing a v1
// current-HEAD launcher.
const result = spawnSync(process.execPath, [v2Entrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
