import http from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const PAGES = ["", "index.html", "replay.html", "local.html", "backtest.html", "strategy.html"];
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".wasm": "application/wasm" };

export function isTrustedAppUrl(value, appUrl) {
  try {
    const target = new URL(value);
    const base = new URL(appUrl);
    return ["http:", "https:"].includes(base.protocol)
      && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
      && target.origin === base.origin && !target.username && !target.password
      && PAGES.some((page) => target.pathname === new URL(page || "./", base).pathname);
  } catch { return false; }
}

export async function startDesktopAssetServer(directory, { port = 18079 } = {}) {
  const root = await realpath(directory);
  let origin;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(origin).host || !["GET", "HEAD"].includes(request.method)) {
        response.writeHead(403).end();
        return;
      }
      const pathname = decodeURIComponent(new URL(request.url, origin).pathname);
      if (pathname.includes("\\") || pathname.includes("\0")) throw new Error("invalid asset path");
      const filename = await realpath(path.join(root, pathname === "/" ? "index.html" : pathname));
      const relative = path.relative(root, filename);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !(await stat(filename)).isFile()) {
        response.writeHead(403).end();
        return;
      }
      const data = await readFile(filename);
      response.writeHead(200, {
        "Content-Type": MIME[path.extname(filename)] || "application/octet-stream",
        "Content-Length": data.length,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { appUrl: `${origin}/`, close: () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }) };
}
