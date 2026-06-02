import crypto from "node:crypto";
import http from "node:http";

const port = Number.parseInt(process.env.PORT || "18000", 10);
const baseTime = Math.floor(Date.now() / 3600000) * 3600 - 239 * 3600;
const bars = Array.from({ length: 240 }, (_, index) => {
  const time = baseTime + index * 3600;
  const wave = Math.sin(index / 8) * 120 + Math.cos(index / 17) * 80;
  const open = 62400 + wave + index * 4;
  const close = open + Math.sin(index / 5) * 45;
  const high = Math.max(open, close) + 80 + Math.sin(index / 3) * 12;
  const low = Math.min(open, close) - 75 - Math.cos(index / 4) * 10;
  const volume = 320 + Math.round(Math.abs(Math.sin(index / 6)) * 180 + index * 0.8);
  return {
    time,
    open: round(open),
    high: round(high),
    low: round(low),
    close: round(close),
    volume,
  };
});

function round(value) {
  return Math.round(value * 100) / 100;
}

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function historyPayload(limit = bars.length) {
  const data = bars.slice(Math.max(0, bars.length - limit));
  return {
    source: "binance",
    data,
    start_ms: data[0].time * 1000,
    end_ms: data[data.length - 1].time * 1000,
    has_tail_gap: false,
  };
}

function smaData(sourceBars, period = 20) {
  return sourceBars.map((bar, index) => {
    const start = Math.max(0, index - period + 1);
    const window = sourceBars.slice(start, index + 1);
    const value = window.reduce((sum, item) => sum + item.close, 0) / window.length;
    return { time: bar.time, value: round(value) };
  });
}

function bollData(sourceBars, period = 20) {
  const middle = smaData(sourceBars, period);
  const upper = [];
  const lower = [];
  for (let index = 0; index < sourceBars.length; index += 1) {
    const start = Math.max(0, index - period + 1);
    const window = sourceBars.slice(start, index + 1);
    const avg = middle[index].value;
    const variance = window.reduce((sum, item) => sum + (item.close - avg) ** 2, 0) / window.length;
    const dev = Math.sqrt(variance);
    upper.push({ time: sourceBars[index].time, value: round(avg + 2 * dev) });
    lower.push({ time: sourceBars[index].time, value: round(avg - 2 * dev) });
  }
  return { upper, middle, lower };
}

function rsiData(sourceBars, period = 14) {
  let gain = 0;
  let loss = 0;
  return sourceBars.map((bar, index) => {
    if (index === 0) return { time: bar.time, value: 50 };
    const change = bar.close - sourceBars[index - 1].close;
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    const rs = loss === 0 ? 100 : gain / loss;
    return { time: bar.time, value: round(100 - 100 / (1 + rs)) };
  });
}

function detectIndicatorName(body) {
  const name = String(body.name || "").toUpperCase();
  const script = String(body.script || "").toUpperCase();
  if (name) return name;
  if (script.includes("__ENGINE__:BOLL")) return "BOLL";
  if (script.includes("__ENGINE__:RSI")) return "RSI";
  if (script.includes("__ENGINE__:VOL")) return "VOL";
  if (script.includes("__ENGINE__:MA")) return "MA";
  if (script.includes("BOLL")) return "BOLL";
  if (script.includes("RSI")) return "RSI";
  if (script.includes("VOLUME") || script.includes("VOL")) return "VOL";
  return "MA";
}

function indicatorPayload(body) {
  const sourceBars = Array.isArray(body.ohlcv) && body.ohlcv.length ? body.ohlcv : bars;
  const name = detectIndicatorName(body);
  if (name === "VOL" || name === "VOLUME") {
    return {
      ok: true,
      lines: [{
        id: "vol",
        name: "VOL",
        pane: "volume",
        type: "histogram",
        color: "#64748b",
        data: sourceBars.map((bar) => ({ time: bar.time, value: bar.volume })),
        colorData: sourceBars.map((bar) => ({
          time: bar.time,
          color: bar.close >= bar.open ? "rgba(34, 197, 94, 0.5)" : "rgba(239, 68, 68, 0.5)",
        })),
      }],
    };
  }
  if (name === "BOLL" || name === "BB") {
    const { upper, middle, lower } = bollData(sourceBars, body.params?.period || 20);
    return {
      ok: true,
      lines: [
        { id: "upper", name: "BOLL Upper", pane: "main", color: "#60a5fa", data: upper },
        { id: "middle", name: "BOLL Mid", pane: "main", color: "#94a3b8", data: middle },
        { id: "lower", name: "BOLL Lower", pane: "main", color: "#60a5fa", data: lower },
      ],
      fills: [{ plot1_id: "upper", plot2_id: "lower", color: "rgba(96, 165, 250, 0.16)", pane: "main" }],
    };
  }
  if (name === "RSI") {
    return {
      ok: true,
      lines: [{
        id: "rsi",
        name: "RSI",
        pane: "separate",
        color: "#a855f7",
        data: rsiData(sourceBars, body.params?.period || 14),
      }],
      hlines: [
        { id: "rsi-70", pane: "separate", price: 70, title: "70", color: "#ef4444", linestyle: "dashed" },
        { id: "rsi-30", pane: "separate", price: 30, title: "30", color: "#22c55e", linestyle: "dashed" },
      ],
    };
  }
  return {
    ok: true,
    lines: [{
      id: "ma",
      name: "MA",
      pane: "main",
      color: "#f59e0b",
      data: smaData(sourceBars, body.params?.period || 20),
    }],
  };
}

function exchangePayload() {
  return {
    exchanges: [{
      exchange: "binance",
      id: "binance",
      name: "Binance",
      label: "Binance",
      markets: [{ market_type: "spot", label: "Spot" }],
      native_intervals: ["1m", "5m", "15m", "1h", "4h", "1d"],
      ws_connection_model: "multiplex",
      default_history_days_by_interval: { "1h": 30 },
    }],
  };
}

function route(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  if (req.method === "OPTIONS") return json(res, {});
  if (path === "/api/v1/exchanges/" || path === "/api/v1/exchanges") return json(res, exchangePayload());
  if (path.includes("/capabilities")) return json(res, { ok: true, ws_connection_model: "multiplex" });
  if (path === "/api/v1/settings/cache-limits") return json(res, { max_days: 30, per_interval: { "1h": 30 } });
  if (path === "/api/v1/subscriptions/" || path === "/api/v1/subscriptions") return json(res, []);
  if (path === "/api/v1/subscriptions/prices") return json(res, {});
  if (path === "/api/v1/symbols/exchange-info") return json(res, { symbols: [{ symbol: "BTCUSDT" }] });
  if (path === "/api/v1/klines/" || path === "/api/v1/klines") return json(res, historyPayload(Number(url.searchParams.get("limit")) || 500));
  if (path === "/api/v1/klines/latest") return json(res, historyPayload(Number(url.searchParams.get("limit")) || 5));
  if (path === "/api/v1/klines/history" || path === "/api/v1/klines/range" || path === "/api/v1/klines/history/before") {
    return json(res, historyPayload());
  }
  if (path === "/api/v1/klines/resolve") return json(res, { interval: url.searchParams.get("interval") || "1h", seconds: 3600 });
  if (path === "/api/v1/indicators/presets") return json(res, []);
  if (path.startsWith("/api/v1/indicators/presets/")) {
    const id = path.split("/").pop();
    return json(res, { id, name: id.toUpperCase(), script: `# __ENGINE__:${id.toUpperCase()}`, params: {}, visible: true });
  }
  if (path === "/api/v1/indicators/compute" && req.method === "POST") {
    return readBody(req).then((body) => json(res, indicatorPayload(body)));
  }
  return json(res, { ok: true }, 200);
}

function wsFrame(payload) {
  const data = Buffer.from(JSON.stringify(payload));
  if (data.length < 126) {
    return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  }
  if (data.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([header, data]);
}

function decodeClientFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) break;
    const payload = Buffer.from(buffer.subarray(offset + headerLength + maskLength, offset + frameLength));
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({ opcode, text: payload.toString("utf8") });
    offset += frameLength;
  }
  return { frames, rest: buffer.subarray(offset) };
}

const server = http.createServer(route);

server.on("upgrade", (req, socket) => {
  if (!req.url.startsWith("/api/v1/stream/")) {
    socket.destroy();
    return;
  }
  const isIndicatorStream = req.url.startsWith("/api/v1/stream/indicators");
  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  socket.write(wsFrame({ type: "connected" }));
  if (!isIndicatorStream) {
    socket.write(wsFrame({ type: "stream_status", interval: "1h", status: "live" }));
  }
  let seq = 0;
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    if (!isIndicatorStream) return;
    const decoded = decodeClientFrames(Buffer.concat([pending, chunk]));
    pending = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode === 8) {
        socket.end();
        return;
      }
      if (frame.opcode !== 1) continue;
      let message = null;
      try {
        message = JSON.parse(frame.text);
      } catch {
        continue;
      }
      if (message.action !== "subscribe" || !message.clientId) continue;
      const payload = indicatorPayload({
        name: message.name,
        script: message.script,
        params: message.params,
        ohlcv: bars.slice(-Math.min(message.historyLimit || bars.length, bars.length)),
      });
      socket.write(wsFrame({
        ...payload,
        type: "indicator.snapshot",
        clientId: message.clientId,
        seq: ++seq,
      }));
    }
  });
  socket.on("error", () => {});
});

server.listen(port, "127.0.0.1", () => {
  console.log(`CandleScope mock API listening on http://127.0.0.1:${port}`);
});
