import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "src", "features", "plugins");
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !full.includes(`${path.sep}__tests__${path.sep}`)) files.push(full);
  }
}

walk(pluginRoot);
const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
for (const [label, pattern] of [
  ["dynamic import", /\bimport\s*\(/],
  ["plugin iframe", /<iframe\b/i],
  ["raw HTML", /dangerouslySetInnerHTML/],
  ["eval", /\beval\s*\(/],
  ["Function constructor", /\bnew\s+Function\b/],
  ["browser persistence", /\b(?:localStorage|sessionStorage|indexedDB)\b/],
  ["plugin worker", /\bnew\s+(?:Shared)?Worker\b/],
]) {
  assert.doesNotMatch(source, pattern, `declarative Plugin Platform must not contain ${label}`);
}

const appShell = fs.readFileSync(path.join(root, "src", "app", "AppShell.tsx"), "utf8");
assert.doesNotMatch(appShell, /candlescope\.market-scanner|hello-command|scheduled-notification/, "AppShell must not branch on plugin IDs");
assert.match(appShell, /PluginPlatformToolbar/);
assert.match(appShell, /PluginPlatformSurfaces/);
assert.match(appShell, /PluginPlatformStatus/);
assert.match(appShell, /PluginUiErrorBoundary/);

console.log(`Plugin Platform architecture check passed (${files.length} native files, no plugin code loader).`);
