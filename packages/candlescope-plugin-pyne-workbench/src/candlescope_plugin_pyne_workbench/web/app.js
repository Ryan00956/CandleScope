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
  const messages = {
    "zh-CN": {
      title: "Pyne 工作台",
      statusWaiting: "等待 CandleScope 连接",
      statusRejected: "连接协议已拒绝",
      statusConnected: "已连接 · 命令从插件面板运行",
      statusDisposed: "已关闭",
      howTo: "怎么用",
      stepOpenChart: "打开支持范围内的实时主图。",
      stepRunCommand: "在插件命令中运行“在当前图表运行 Pyne”。",
      stepDebug: "需要逐根调试时，先启动会话，再推送或预览 K 线。",
      boundaryTitle: "当前边界",
      boundaryBody: "脚本和数据只走 Host 能力调用。图形会转换为受限的 Render IR v2；不能无损映射的 candle、table 和 linefill 仍保留在原生 Pyne 结果摘要中。",
      mainChart: "主图",
      theme: "主题",
    },
    en: {
      title: "Pyne Workbench",
      statusWaiting: "Waiting for CandleScope",
      statusRejected: "Connection protocol rejected",
      statusConnected: "Connected · run commands from the plugin panel",
      statusDisposed: "Closed",
      howTo: "How to use",
      stepOpenChart: "Open a supported live main chart.",
      stepRunCommand: "Run “Run Pyne on current chart” from plugin commands.",
      stepDebug: "For bar-by-bar debugging, start a session, then push or preview bars.",
      boundaryTitle: "Current boundaries",
      boundaryBody: "Scripts and data only use Host capability calls. Graphics are converted to the bounded Render IR v2; candle, table, and linefill output that cannot be mapped losslessly remains in the native Pyne result summary.",
      mainChart: "Main chart",
      theme: "Theme",
    },
  };
  let locale = "zh-CN";

  const normalizeLocale = (value) => {
    if (typeof value !== "string") return "zh-CN";
    const normalized = value.toLowerCase();
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    return "zh-CN";
  };
  const translate = (key) => messages[locale][key] ?? key;
  const applyLocale = (value) => {
    locale = normalizeLocale(value);
    document.documentElement.lang = locale;
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = translate(element.dataset.i18n);
    });
  };
  const setStatus = (key) => {
    status.dataset.i18n = key;
    status.textContent = translate(key);
  };

  const apply = (payload) => {
    applyLocale(payload.locale);
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
        channel.close(); channel = null; setStatus("statusRejected"); return;
      }
      inbound = next.sequence;
      apply(next.payload);
      setStatus(next.payload.state === "disposed" ? "statusDisposed" : "statusConnected");
    };
    channel.start();
    apply(message.payload);
    setStatus("statusConnected");
    send("sandbox.ready", { capabilities: [], documentTitle: document.title });
  }, { once: true });
})();
