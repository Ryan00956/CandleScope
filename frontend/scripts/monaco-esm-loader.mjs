import fs from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register(import.meta.url);

export async function load(url, context, nextLoad) {
  if (url.includes("/node_modules/monaco-editor/") && url.endsWith(".js")) {
    return {
      format: "module",
      source: fs.readFileSync(fileURLToPath(url), "utf8"),
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
