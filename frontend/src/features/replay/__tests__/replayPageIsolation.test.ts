import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ReplayApiClient } from "../replayApi.js";
import { ReplayStreamController } from "../replayStreamController.js";
import type { ReplayStreamSocket } from "../replayStreamController.js";
import { ReplayRuntimeLifecycle } from "../useReplayRuntime.js";
import { enabledCapabilities, replaySessionResponse } from "./fixtures.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(testDirectory, "../../../..");

function source(path: string): string {
  return readFileSync(resolve(frontendRoot, path), "utf8");
}

async function settle(): Promise<void> {
  await new Promise<void>((done) => setImmediate(done));
  await new Promise<void>((done) => setImmediate(done));
}

class CapturedSocket implements ReplayStreamSocket {
  readonly OPEN = 1;
  readonly readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  send(): void {}
  close(): void {}
}

test("replay and live documents have independent, non-fallback composition roots", () => {
  const replayHtml = source("replay.html");
  const liveHtml = source("index.html");
  assert.match(replayHtml, /src="\/src\/replay-main\.tsx"/);
  assert.doesNotMatch(replayHtml, /src="\/src\/main\.tsx"/);
  assert.match(liveHtml, /src="\/src\/main\.tsx"/);
  assert.doesNotMatch(liveHtml, /replay-main/);
});

test("replay composition source has no live runtime value import", () => {
  const paths = [
    "src/replay-main.tsx",
    "src/features/replay/ReplayApp.tsx",
    "src/features/replay/ReplayPageShell.tsx",
    "src/features/replay/ReplayTrainingPageShell.tsx",
    "src/features/replay/components/ReplayRightMarketRail.tsx",
    "src/features/replay/useReplayHistoryRuntime.ts",
    "src/features/replay/useReplayRuntime.ts",
  ];
  const forbidden = [
    "useMarketDataRuntime",
    "useAdvancedMarketDataRuntime",
    "useOrderBookRuntime",
    "useWatchlistRuntime",
    "useWatchlistFullCacheRuntime",
    "useIndicatorRuntime",
    "useAlert",
    "/services/",
  ];
  for (const path of paths) {
    const content = source(path);
    for (const token of forbidden) {
      assert.doesNotMatch(content, new RegExp(token), `${relative(frontendRoot, resolve(frontendRoot, path))} imported ${token}`);
    }
  }
});

test("startup network boundary emits only replay HTTP and replay WebSocket URLs", async (context) => {
  const requests: string[] = [];
  const sockets: string[] = [];
  const fetcher: typeof fetch = async function (this: unknown, input) {
    assert.equal(this, undefined, "ReplayApiClient must call fetch without an instance receiver");
    const url = String(input);
    requests.push(url);
    const payload = url.endsWith("/capabilities") ? enabledCapabilities() : replaySessionResponse();
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const api = new ReplayApiClient({ fetcher });
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api,
    streamFactory: (options) => new ReplayStreamController({
      ...options,
      baseUrl: "ws://replay.test",
      socketFactory: (url) => {
        sockets.push(url);
        return new CapturedSocket();
      },
    }),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  assert.deepEqual(requests, [
    "/api/v1/replay/capabilities",
    "/api/v1/replay/sessions/session-0001",
  ]);
  assert.equal(sockets.length, 1);
  assert.match(sockets[0] ?? "", /^ws:\/\/replay\.test\/api\/v1\/stream\/replay\//);
  for (const url of [...requests, ...sockets]) {
    assert.doesNotMatch(url, /(?:klines|market|order.?book|liquidation|watchlist|indicator)/i);
  }
});
