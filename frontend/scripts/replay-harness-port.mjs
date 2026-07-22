import net from "node:net";
import process from "node:process";

export const HARNESS_PORT_MIN = 16_000;
export const HARNESS_PORT_MAX = 29_999;

const HARNESS_PORT_COUNT = HARNESS_PORT_MAX - HARNESS_PORT_MIN + 1;
let nextHarnessPort =
  HARNESS_PORT_MIN + ((process.pid * 97) % HARNESS_PORT_COUNT);

function probeHarnessPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(!error));
    });
  });
}

export async function freeHarnessPort() {
  for (let attempt = 0; attempt < HARNESS_PORT_COUNT; attempt += 1) {
    const port = nextHarnessPort;
    nextHarnessPort =
      port >= HARNESS_PORT_MAX ? HARNESS_PORT_MIN : port + 1;
    if (await probeHarnessPort(port)) return port;
  }
  throw new Error(
    `No free replay harness port in ${HARNESS_PORT_MIN}-${HARNESS_PORT_MAX}`,
  );
}
