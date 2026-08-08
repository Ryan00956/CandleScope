(() => {
  "use strict";
  const protocol = "candlescope.ui-bridge/1";
  let identity = null;
  let channel = null;
  let outbound = 0;
  let inbound = 1;
  const status = document.querySelector("#status");
  const market = document.querySelector("#market");
  const theme = document.querySelector("#theme");

  const apply = (payload) => {
    document.documentElement.dataset.theme = payload.theme;
    theme.textContent = payload.theme;
    market.textContent = `${payload.market.exchange}:${payload.market.marketType}:${payload.market.symbol}@${payload.market.interval}`;
  };
  const send = (type, payload) => {
    outbound += 1;
    channel.postMessage({ ...identity, protocol, sequence: outbound, type, payload });
  };
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (channel || event.source !== parent || event.ports.length !== 1 || message?.protocol !== protocol || message?.type !== "host.connect") return;
    identity = {
      token: message.token,
      pluginId: message.pluginId,
      viewId: message.viewId,
      instanceId: message.instanceId,
      generation: message.generation,
    };
    outbound = 0;
    inbound = message.sequence;
    channel = event.ports[0];
    channel.onmessage = (nextEvent) => {
      const next = nextEvent.data;
      if (next?.protocol !== protocol || next.sequence !== inbound + 1 || next.type !== "host.lifecycle") {
        channel.close(); channel = null; status.textContent = "连接协议已拒绝"; return;
      }
      inbound = next.sequence;
      apply(next.payload);
      status.textContent = next.payload.state === "disposed" ? "已关闭" : "已连接 · 命令从插件面板运行";
    };
    channel.start();
    apply(message.payload);
    status.textContent = "已连接 · 命令从插件面板运行";
    send("sandbox.ready", { capabilities: [], documentTitle: document.title });
  }, { once: true });
})();
