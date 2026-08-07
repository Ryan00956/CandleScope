import http from "node:http";

export class Phase8Fault429Proxy {
  constructor({ host = "127.0.0.1", port = 0 } = {}) {
    this.host = host;
    this.port = port;
    this.server = null;
    this.counts = { requests: 0, connects: 0, responses429: 0 };
  }

  async start() {
    if (this.server) return this.diagnostics();
    const server = http.createServer((_request, response) => {
      this.counts.requests += 1;
      this.counts.responses429 += 1;
      response.writeHead(429, { "content-type": "text/plain", "retry-after": "1", connection: "close" });
      response.end("phase8 controlled proxy rate limit");
    });
    server.on("connect", (_request, socket) => {
      this.counts.connects += 1;
      this.counts.responses429 += 1;
      socket.end("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nConnection: close\r\n\r\n");
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, resolve);
    });
    this.server = server;
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : this.port;
    return this.diagnostics();
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  url() {
    if (!this.server || !this.port) throw new Error("Phase 8 fault proxy is not running");
    return `http://${this.host}:${this.port}`;
  }

  diagnostics() {
    return {
      running: Boolean(this.server),
      host: this.host,
      port: this.port,
      url: this.server ? this.url() : null,
      counts: { ...this.counts },
    };
  }
}
