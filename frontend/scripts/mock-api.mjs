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
const MARKET_CHANNELS = [
  "mark_price",
  "index_price",
  "funding_rate",
  "open_interest",
  "basis",
];
const MARKET_IDENTITY = {
  exchange: "binance",
  market_type: "futures",
  symbol: "BTCUSDT",
};

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

function periodToMilliseconds(period) {
  const match = String(period || "5m").match(/^(\d+)([mhd])$/i);
  if (!match) return 5 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
  return amount * multiplier;
}

function marketStreamKey(channel, overrides = {}, params = {}) {
  return {
    exchange: String(overrides.exchange || MARKET_IDENTITY.exchange).toLowerCase(),
    market_type: String(overrides.market_type || MARKET_IDENTITY.market_type).toLowerCase(),
    symbol: String(overrides.symbol || MARKET_IDENTITY.symbol).toUpperCase(),
    channel,
    params,
  };
}

function marketTopic(key) {
  return `${key.exchange}:${key.market_type}:${key.symbol}@${key.channel}`;
}

function advancedMarketValues({ update = false } = {}) {
  const markPrice = round(bars.at(-1).close + (update ? 9.75 : 8.5));
  const indexPrice = round(bars.at(-1).close - (update ? 13.5 : 14.25));
  const basis = round(markPrice - indexPrice);
  const basisRate = basis / indexPrice;
  return {
    markPrice,
    indexPrice,
    fundingRate: update ? 0.000137 : 0.000126,
    openInterest: update ? 18_742.5 : 18_700.25,
    basis,
    basisRate,
    basisBps: basisRate * 10_000,
  };
}

function marketDataForChannel(channel, { update = false, eventTimeMs } = {}) {
  const values = advancedMarketValues({ update });
  if (channel === "mark_price") return { mark_price: values.markPrice };
  if (channel === "index_price") return { index_price: values.indexPrice };
  if (channel === "funding_rate") {
    return {
      funding_rate: values.fundingRate,
      mark_price: values.markPrice,
      next_funding_time_ms: Math.ceil(eventTimeMs / 28_800_000) * 28_800_000,
      is_final: false,
      sample_kind: "preview",
    };
  }
  if (channel === "open_interest") {
    return {
      open_interest: values.openInterest,
      open_interest_value: round(values.openInterest * values.markPrice),
      is_final: false,
      sample_kind: "provisional",
    };
  }
  return {
    mark_price: values.markPrice,
    index_price: values.indexPrice,
    basis: values.basis,
    basis_rate: values.basisRate,
    basis_bps: values.basisBps,
  };
}

function marketStateRecord(channel, {
  identity = MARKET_IDENTITY,
  eventTimeMs = bars.at(-1).time * 1000,
  revision = 1,
  update = false,
} = {}) {
  const key = marketStreamKey(channel, identity);
  return {
    key,
    topic: marketTopic(key),
    channel,
    event_time_ms: eventTimeMs,
    received_at_ms: eventTimeMs + (update ? 250 : 100),
    source: "mock",
    sequence: eventTimeMs,
    revision,
    data: marketDataForChannel(channel, { update, eventTimeMs }),
  };
}

function marketSnapshotPayload(channels = MARKET_CHANNELS) {
  const eventTimeMs = bars.at(-1).time * 1000;
  return {
    type: "market.snapshot",
    as_of_ms: eventTimeMs + 100,
    data: channels.map((channel, index) => marketStateRecord(channel, {
      eventTimeMs,
      revision: index + 1,
    })),
    missing: [],
  };
}

function marketHistoryRecord(channel, eventTimeMs, index, period = "") {
  const key = marketStreamKey(
    channel,
    MARKET_IDENTITY,
    period ? { period } : {},
  );
  const markPrice = round(62_400 + Math.sin(index / 5) * 160 + index * 3.5);
  const data = channel === "funding_rate"
    ? {
        funding_rate: Math.round((Math.sin(index / 3) * 0.00012 + 0.00002) * 1e8) / 1e8,
        funding_time_ms: eventTimeMs,
        mark_price: markPrice,
        is_final: true,
        sample_kind: "settlement",
      }
    : {
        open_interest: round(16_500 + index * 11 + Math.sin(index / 7) * 220),
        open_interest_value: round((16_500 + index * 11) * markPrice),
        is_final: true,
        sample_kind: "final",
      };
  return {
    key,
    topic: marketTopic(key),
    channel,
    event_time_ms: eventTimeMs,
    received_at_ms: eventTimeMs + 100,
    source: "http_backfill",
    sequence: eventTimeMs,
    data,
  };
}

function marketHistoryPayload(url) {
  const channel = String(url.searchParams.get("channel") || "").toLowerCase();
  const period = url.searchParams.get("period") || "";
  const limit = Math.max(1, Number(url.searchParams.get("limit")) || 500);
  const startMs = Number(url.searchParams.get("start_ms"));
  const endMs = Number(url.searchParams.get("end_ms"));
  const latestMs = bars.at(-1).time * 1000;
  const stepMs = channel === "funding_rate" ? 28_800_000 : periodToMilliseconds(period);
  const availableCount = channel === "funding_rate" ? 30 : 240;
  const earliestMs = latestMs - (availableCount - 1) * stepMs;
  let data = Array.from({ length: availableCount }, (_, index) => (
    marketHistoryRecord(channel, earliestMs + index * stepMs, index, period)
  ));
  if (Number.isFinite(startMs) && startMs > 0) {
    data = data.filter((record) => record.event_time_ms >= startMs);
  }
  if (Number.isFinite(endMs) && endMs > 0) {
    data = data.filter((record) => record.event_time_ms <= endMs);
  }
  data = data.slice(Math.max(0, data.length - limit));
  const responseKey = marketStreamKey(channel, MARKET_IDENTITY, period ? { period } : {});
  return {
    type: "market.history",
    key: responseKey,
    count: data.length,
    data,
    fallback: false,
    has_more: data.length >= limit,
    coverage: {
      earliest_ms: data[0]?.event_time_ms ?? null,
      latest_ms: data.at(-1)?.event_time_ms ?? null,
      complete: data.length < limit,
    },
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

function advancedChannelCapability(channel, overrides = {}) {
  return {
    channel,
    market_types: ["futures"],
    realtime: true,
    history: false,
    realtime_transports: ["websocket"],
    history_transports: [],
    delivery: "latest",
    snapshot: true,
    delta: false,
    sequence: null,
    checksum: null,
    resync: null,
    params: {},
    update_intervals_ms: [1000, 3000],
    available_fields: [channel],
    unavailable_fields: [],
    derived_fields: [],
    connection_model: "shared_multiplex",
    limits: {},
    known_limitations: [],
    ...overrides,
  };
}

function exchangePayload() {
  return {
    count: 1,
    exchanges: [{
      exchange: "binance",
      id: "binance",
      name: "Binance",
      label: "Binance",
      plugin_api_version: "1.0",
      capability_schema_version: 2,
      markets: [
        { market_type: "spot", product_type: "spot", label: "Spot" },
        { market_type: "futures", product_type: "perpetual", label: "USD-M Futures" },
      ],
      channels: [
        advancedChannelCapability("mark_price", {
          available_fields: ["mark_price"],
          derived_fields: ["basis", "basis_rate", "basis_bps"],
        }),
        advancedChannelCapability("index_price", {
          available_fields: ["index_price"],
        }),
        advancedChannelCapability("funding_rate", {
          history: true,
          history_transports: ["rest_history"],
          available_fields: ["funding_rate"],
          limits: { "history.max_limit": 1000 },
        }),
        advancedChannelCapability("open_interest", {
          history: true,
          realtime_transports: ["rest_poll"],
          history_transports: ["rest_history"],
          params: { period: ["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"] },
          update_intervals_ms: [5000],
          available_fields: ["open_interest"],
          connection_model: "polling_only",
          limits: { "history.max_limit": 500 },
        }),
      ],
      native_intervals: ["1m", "5m", "15m", "1h", "4h", "1d"],
      supports_multi_symbol_ticker: false,
      supports_symbol_search: true,
      protocol_features: [],
      limits: {},
      known_limitations: [],
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
  if (path.includes("/capabilities")) return json(res, exchangePayload().exchanges[0]);
  if (path === "/api/v1/settings/cache-limits") return json(res, { max_days: 30, per_interval: { "1h": 30 } });
  if (path === "/api/v1/subscriptions/" || path === "/api/v1/subscriptions") return json(res, []);
  if (path === "/api/v1/subscriptions/prices") return json(res, {});
  if (path === "/api/v1/symbols/exchange-info") return json(res, { symbols: [{ symbol: "BTCUSDT" }] });
  if (path === "/api/v1/market/snapshot") {
    const requestedChannels = url.searchParams.getAll("channel")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase())
      .filter((value) => MARKET_CHANNELS.includes(value));
    return json(res, marketSnapshotPayload(requestedChannels.length ? requestedChannels : MARKET_CHANNELS));
  }
  if (path === "/api/v1/market/history") {
    const channel = String(url.searchParams.get("channel") || "").toLowerCase();
    if (!["funding_rate", "open_interest"].includes(channel)) {
      return json(res, { detail: `Unsupported history channel: ${channel || "missing"}` }, 422);
    }
    if (channel === "open_interest" && !url.searchParams.get("period")) {
      return json(res, { detail: "open-interest history requires period" }, 422);
    }
    return json(res, marketHistoryPayload(url));
  }
  if (path === "/api/v1/klines/" || path === "/api/v1/klines") return json(res, historyPayload(Number(url.searchParams.get("limit")) || 500));
  if (path === "/api/v1/klines/latest") return json(res, historyPayload(Number(url.searchParams.get("limit")) || 5));
  if (path === "/api/v1/klines/history" || path === "/api/v1/klines/range" || path === "/api/v1/klines/history/before") {
    return json(res, historyPayload());
  }
  if (path === "/api/v1/klines/resolve") return json(res, { interval: url.searchParams.get("interval") || "1h", seconds: 3600 });
  if (path === "/api/v1/indicators/presets") return json(res, []);
  if (path.startsWith("/api/v1/indicators/presets/")) {
    const id = path.split("/").pop();
    const engineName = id.toUpperCase();
    return json(res, {
      id,
      name: engineName,
      engineName,
      script: `# __ENGINE__:${engineName}`,
      params: {},
      visible: true,
    });
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
  const isMarketStream = req.url.startsWith("/api/v1/stream/market");
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
  socket.write(wsFrame(isMarketStream
    ? { type: "connected", protocol: "market.v1", max_subscriptions: 64 }
    : { type: "connected" }));
  if (!isIndicatorStream && !isMarketStream) {
    socket.write(wsFrame({ type: "stream_status", interval: "1h", status: "live" }));
  }
  let seq = 0;
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    if (!isIndicatorStream && !isMarketStream) return;
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
      if (isMarketStream) {
        const requestId = typeof message.request_id === "string" ? message.request_id : undefined;
        const streams = Array.isArray(message.streams)
          ? message.streams
              .filter((stream) => MARKET_CHANNELS.includes(String(stream?.channel || "").toLowerCase()))
              .map((stream) => marketStreamKey(
                String(stream.channel).toLowerCase(),
                {
                  exchange: stream.exchange,
                  market_type: stream.market_type || stream.marketType,
                  symbol: stream.symbol,
                },
              ))
          : [];
        if (message.action === "unsubscribe") {
          socket.write(wsFrame({ type: "unsubscribed", request_id: requestId, streams }));
          continue;
        }
        if (message.action !== "subscribe" || streams.length === 0) continue;
        const eventTimeMs = bars.at(-1).time * 1000;
        socket.write(wsFrame({
          type: "subscribed",
          request_id: requestId,
          streams,
        }));
        socket.write(wsFrame({
          type: "snapshot",
          request_id: requestId,
          data: streams.map((stream, index) => marketStateRecord(stream.channel, {
            identity: stream,
            eventTimeMs,
            revision: index + 1,
          })),
          missing: [],
        }));
        socket.write(wsFrame({
          type: "update",
          protocol: "market.v1",
          data: streams.map((stream, index) => marketStateRecord(stream.channel, {
            identity: stream,
            eventTimeMs: eventTimeMs + 1_000,
            revision: index + 2,
            update: true,
          })),
        }));
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
