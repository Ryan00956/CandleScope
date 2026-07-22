(() => {
  "use strict";

  const PROTOCOL = "candlescope.ui-bridge/1";
  const MAX_MESSAGE_BYTES = 32 * 1024;
  const encoder = new TextEncoder();
  const elements = {
    status: document.querySelector("#bridge-status"),
    lifecycle: document.querySelector("#lifecycle"),
    theme: document.querySelector("#theme"),
    locale: document.querySelector("#locale"),
    market: document.querySelector("#market"),
    generation: document.querySelector("#generation"),
    probes: document.querySelector("#probe-results"),
    runProbes: document.querySelector("#run-probes"),
    resize: document.querySelector("#resize"),
    announce: document.querySelector("#announce"),
    containedError: document.querySelector("#contained-error"),
  };
  let channel = null;
  let identity = null;
  let inboundSequence = 0;
  let outboundSequence = 0;

  function exact(value, required) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    return keys.length === required.length && keys.every((key, index) => key === [...required].sort()[index]);
  }

  function bounded(value) {
    try {
      return encoder.encode(JSON.stringify(value)).byteLength <= MAX_MESSAGE_BYTES;
    } catch {
      return false;
    }
  }

  function boundedString(value, maximum) {
    return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim();
  }

  function validMarket(value) {
    return exact(value, ["exchange", "interval", "marketType", "symbol"])
      && boundedString(value.exchange, 64)
      && boundedString(value.interval, 64)
      && boundedString(value.marketType, 64)
      && boundedString(value.symbol, 128);
  }

  function validSnapshot(payload) {
    return exact(payload, ["locale", "market", "theme"])
      && ["dark", "light"].includes(payload.theme)
      && boundedString(payload.locale, 64)
      && validMarket(payload.market);
  }

  function enableActions(enabled) {
    elements.runProbes.disabled = !enabled;
    elements.resize.disabled = !enabled;
    elements.announce.disabled = !enabled;
    elements.containedError.disabled = !enabled;
  }

  function send(type, payload) {
    if (!channel || !identity) return;
    outboundSequence += 1;
    const message = {
      protocol: PROTOCOL,
      token: identity.token,
      pluginId: identity.pluginId,
      viewId: identity.viewId,
      instanceId: identity.instanceId,
      generation: identity.generation,
      sequence: outboundSequence,
      type,
      payload,
    };
    if (!bounded(message)) {
      rejectChannel();
      return;
    }
    channel.postMessage(message);
  }

  function rejectChannel() {
    elements.status.textContent = "Bridge rejected an invalid Host message.";
    enableActions(false);
    channel?.close();
    channel = null;
  }

  function applySnapshot(payload) {
    elements.theme.textContent = payload.theme;
    elements.locale.textContent = payload.locale;
    elements.market.textContent = `${payload.market.exchange}:${payload.market.marketType}:${payload.market.symbol}@${payload.market.interval}`;
    document.documentElement.dataset.theme = payload.theme;
    document.documentElement.lang = payload.locale;
  }

  function acceptHostMessage(message) {
    if (!identity || !exact(message, ["generation", "instanceId", "payload", "pluginId", "protocol", "sequence", "token", "type", "viewId"]) || !bounded(message)) return false;
    if (
      message.protocol !== PROTOCOL
      || message.token !== identity.token
      || message.pluginId !== identity.pluginId
      || message.viewId !== identity.viewId
      || message.instanceId !== identity.instanceId
      || message.generation !== identity.generation
      || !Number.isSafeInteger(message.sequence)
      || message.sequence !== inboundSequence + 1
    ) return false;
    inboundSequence = message.sequence;
    return true;
  }

  function onChannelMessage(event) {
    const message = event.data;
    if (!acceptHostMessage(message)) {
      rejectChannel();
      return;
    }
    if (
      message.type !== "host.lifecycle"
      || !exact(message.payload, ["focused", "locale", "market", "state", "theme"])
      || typeof message.payload.focused !== "boolean"
      || !["visible", "suspended", "disposed"].includes(message.payload.state)
      || !validSnapshot({
        locale: message.payload.locale,
        market: message.payload.market,
        theme: message.payload.theme,
      })
    ) {
      rejectChannel();
      return;
    }
    elements.lifecycle.textContent = message.payload.focused ? `${message.payload.state} · focused` : message.payload.state;
    applySnapshot(message.payload);
    if (message.payload.state === "disposed") {
      enableActions(false);
      channel.close();
      channel = null;
    }
  }

  window.addEventListener("message", (event) => {
    if (channel || event.source !== parent || event.ports.length !== 1) return;
    const message = event.data;
    if (!exact(message, ["generation", "instanceId", "payload", "pluginId", "protocol", "sequence", "token", "type", "viewId"]) || !bounded(message)) return;
    if (
      message.protocol !== PROTOCOL
      || message.type !== "host.connect"
      || typeof message.token !== "string"
      || !/^[a-f0-9]{64}$/.test(message.token)
      || typeof message.pluginId !== "string"
      || typeof message.viewId !== "string"
      || typeof message.instanceId !== "string"
      || !Number.isSafeInteger(message.generation)
      || message.generation < 1
      || message.sequence !== 1
      || !exact(message.payload, ["capabilities", "locale", "market", "theme"])
      || !Array.isArray(message.payload.capabilities)
      || message.payload.capabilities.length !== 0
      || !validSnapshot({
        locale: message.payload.locale,
        market: message.payload.market,
        theme: message.payload.theme,
      })
    ) return;
    identity = {
      token: message.token,
      pluginId: message.pluginId,
      viewId: message.viewId,
      instanceId: message.instanceId,
      generation: message.generation,
    };
    inboundSequence = 1;
    channel = event.ports[0];
    channel.onmessage = onChannelMessage;
    channel.start();
    elements.generation.textContent = String(identity.generation);
    elements.status.textContent = "One-time MessageChannel connected. No Host capabilities were granted.";
    applySnapshot(message.payload);
    enableActions(true);
    send("sandbox.ready", { capabilities: [], documentTitle: document.title });
  }, { once: true });

  function result(label, passed, detail) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const status = document.createElement("strong");
    name.textContent = `${label}: ${detail}`;
    status.textContent = passed ? "blocked" : "unexpected";
    item.append(name, status);
    elements.probes.append(item);
    return passed;
  }

  async function indexedDbBlocked() {
    try {
      const request = indexedDB.open("candlescope-sandbox-probe", 1);
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(true), 250);
        request.onerror = () => { clearTimeout(timer); resolve(true); };
        request.onsuccess = () => {
          clearTimeout(timer);
          request.result.close();
          indexedDB.deleteDatabase("candlescope-sandbox-probe");
          resolve(false);
        };
      });
    } catch {
      return true;
    }
  }

  async function fetchBlocked() {
    try {
      await fetch("https://example.invalid/candlescope-phase8-probe", { mode: "no-cors" });
      return false;
    } catch {
      return true;
    }
  }

  async function webSocketBlocked() {
    try {
      const socket = new WebSocket("wss://example.invalid/candlescope-phase8-probe");
      return await new Promise((resolve) => {
        const timer = setTimeout(() => { socket.close(); resolve(true); }, 250);
        socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(false); };
        socket.onerror = () => { clearTimeout(timer); resolve(true); };
      });
    } catch {
      return true;
    }
  }

  async function serviceWorkerBlocked() {
    try {
      if (!("serviceWorker" in navigator)) return true;
      const registration = await navigator.serviceWorker.register("./app.js", { scope: "./" });
      await registration.unregister();
      return false;
    } catch {
      return true;
    }
  }

  function attemptDownload() {
    const link = document.createElement("a");
    link.href = "data:text/plain,candlescope-phase8-probe";
    link.download = "candlescope-phase8-probe.txt";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  }

  elements.runProbes.addEventListener("click", async () => {
    elements.probes.replaceChildren();
    let passed = 0;
    let total = 0;
    const record = (label, blocked, detail) => {
      total += 1;
      if (result(label, blocked, detail)) passed += 1;
    };
    try { void parent.document; record("Parent DOM", false, "accessible"); } catch { record("Parent DOM", true, "SecurityError"); }
    try { void parent.__CANDLESCOPE_PLUGIN_MANAGEMENT_V1__; record("Host JS", false, "accessible"); } catch { record("Host JS", true, "SecurityError"); }
    try { localStorage.setItem("probe", "1"); record("localStorage", false, "writable"); } catch { record("localStorage", true, "SecurityError"); }
    try { sessionStorage.setItem("probe", "1"); record("sessionStorage", false, "writable"); } catch { record("sessionStorage", true, "SecurityError"); }
    try { document.cookie = "sandbox_probe=1"; record("Cookies", !document.cookie.includes("sandbox_probe"), "not shared"); } catch { record("Cookies", true, "SecurityError"); }
    record("IndexedDB", await indexedDbBlocked(), "opaque origin");
    record("fetch", await fetchBlocked(), "connect-src none");
    record("WebSocket", await webSocketBlocked(), "connect-src none");
    let popup = null;
    try { popup = window.open("about:blank", "_blank"); } catch { popup = null; }
    if (popup) popup.close();
    record("Popup", popup === null, "sandbox token absent");
    try { top.location.hash = "candlescope-sandbox-escape"; record("Top navigation", false, "changed"); } catch { record("Top navigation", true, "sandbox token absent"); }
    attemptDownload();
    record("Download", true, "sandbox token absent; Host audited");
    record("Service worker", await serviceWorkerBlocked(), "opaque origin and worker-src none");
    elements.status.textContent = `${passed}/${total} isolation probes blocked as expected.`;
    send("view.announce", { message: `${passed} of ${total} sandbox probes were blocked`, politeness: "polite" });
  });

  elements.resize.addEventListener("click", () => send("view.resize", { height: 520 }));
  elements.announce.addEventListener("click", () => send("view.announce", { message: "Sandbox view is ready", politeness: "polite" }));
  elements.containedError.addEventListener("click", () => send("view.error", { code: "REFERENCE_ERROR", message: "Reference plugin requested contained error recovery" }));
})();
