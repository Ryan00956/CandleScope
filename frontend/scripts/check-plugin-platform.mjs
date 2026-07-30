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
const sandboxHostPath = path.join(pluginRoot, "SandboxPluginFrame.tsx");
const hostSource = files
  .filter((file) => file !== sandboxHostPath)
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
for (const [label, pattern] of [
  ["dynamic import", /\bimport\s*\(/],
  ["raw HTML", /dangerouslySetInnerHTML/],
  ["eval", /\beval\s*\(/],
  ["Function constructor", /\bnew\s+Function\b/],
  ["browser persistence", /\b(?:localStorage|sessionStorage|indexedDB)\b/],
  ["plugin worker", /\bnew\s+(?:Shared)?Worker\b/],
]) {
  assert.doesNotMatch(hostSource, pattern, `host-owned Plugin Platform must not contain ${label}`);
}

const sandboxHost = fs.readFileSync(sandboxHostPath, "utf8");
assert.equal((sandboxHost.match(/<iframe\b/g) ?? []).length, 1, "SandboxPluginFrame must own the only plugin iframe");
assert.match(sandboxHost, /sandbox="allow-scripts"/, "sandbox iframe must use the opaque-origin allow-scripts profile");
assert.match(sandboxHost, /referrerPolicy="no-referrer"/);
assert.match(sandboxHost, /credentialless/);
assert.doesNotMatch(sandboxHost, /allow-same-origin|allow-popups|allow-forms|allow-top-navigation|allow-downloads|srcDoc/);
assert.doesNotMatch(hostSource, /<iframe\b/i, "plugin iframe creation is isolated to SandboxPluginFrame");

const appShell = fs.readFileSync(path.join(root, "src", "app", "AppShell.tsx"), "utf8");
assert.doesNotMatch(appShell, /candlescope\.market-scanner|hello-command|scheduled-notification/, "AppShell must not branch on plugin IDs");
assert.match(appShell, /PluginPlatformToolbar/);
assert.match(appShell, /PluginPlatformSurfaces/);
assert.match(appShell, /PluginPlatformStatus/);
assert.match(appShell, /PluginUiErrorBoundary/);

console.log(`Plugin Platform architecture check passed (${files.length} host files, one opaque-origin sandbox gateway).`);
