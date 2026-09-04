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
    ja: {
      title: "Pyne ワークベンチ",
      statusWaiting: "CandleScope の接続を待っています",
      statusRejected: "接続プロトコルが拒否されました",
      statusConnected: "接続済み · プラグインパネルからコマンドを実行",
      statusDisposed: "閉じました",
      howTo: "使い方",
      stepOpenChart: "対応範囲のリアルタイム主チャートを開きます。",
      stepRunCommand: "プラグインコマンドから「現在のチャートで Pyne を実行」を実行します。",
      stepDebug: "1本ずつデバッグする場合は、先にセッションを開始し、ローソク足を送信またはプレビューします。",
      boundaryTitle: "現在の境界",
      boundaryBody: "スクリプトとデータは Host 能力呼び出しのみを使います。グラフィックは制限付き Render IR v2 に変換され、損失なく写せない candle、table、linefill はネイティブ Pyne 結果の要約に残ります。",
      mainChart: "主チャート",
      theme: "テーマ",
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
    es: {
      title: "Banco de trabajo Pyne",
      statusWaiting: "Esperando a CandleScope",
      statusRejected: "Protocolo de conexión rechazado",
      statusConnected: "Conectado · ejecute comandos desde el panel de complementos",
      statusDisposed: "Cerrado",
      howTo: "Cómo usarlo",
      stepOpenChart: "Abra un gráfico principal en vivo compatible.",
      stepRunCommand: "Ejecute “Ejecutar Pyne en el gráfico actual” desde los comandos del complemento.",
      stepDebug: "Para depurar vela a vela, inicie una sesión y luego envíe o previsualice barras.",
      boundaryTitle: "Límites actuales",
      boundaryBody: "Los scripts y los datos solo usan llamadas de capacidad del Host. Los gráficos se convierten al Render IR v2 limitado; la salida candle, table y linefill que no se puede mapear sin pérdidas permanece en el resumen nativo de resultados Pyne.",
      mainChart: "Gráfico principal",
      theme: "Tema",
    },
    fr: {
      title: "Atelier Pyne",
      statusWaiting: "En attente de la connexion CandleScope",
      statusRejected: "Protocole de connexion rejeté",
      statusConnected: "Connecté · exécutez les commandes depuis le panneau du plugin",
      statusDisposed: "Fermé",
      howTo: "Mode d’emploi",
      stepOpenChart: "Ouvrez un graphique principal en direct pris en charge.",
      stepRunCommand: "Exécutez « Exécuter Pyne sur le graphique actuel » depuis les commandes du plugin.",
      stepDebug: "Pour un débogage barre par barre, démarrez une session, puis poussez ou prévisualisez des barres.",
      boundaryTitle: "Limites actuelles",
      boundaryBody: "Les scripts et les données n’utilisent que les appels de capacité de l’hôte. Les graphiques sont convertis vers le Render IR v2 borné ; les sorties candle, table et linefill qui ne peuvent pas être mappées sans perte restent dans le résumé natif Pyne.",
      mainChart: "Graphique principal",
      theme: "Thème",
    },
  };
  let locale = "zh-CN";

  const normalizeLocale = (value) => {
    if (typeof value !== "string") return "zh-CN";
    let candidate;
    try {
      candidate = new Intl.Locale(value.trim()).baseName.toLowerCase();
    } catch {
      return "en";
    }
    const supported = Object.keys(messages);
    while (candidate) {
      const exact = supported.find((id) => id.toLowerCase() === candidate);
      if (exact) return exact;
      const separator = candidate.lastIndexOf("-");
      candidate = separator < 0 ? "" : candidate.slice(0, separator);
    }
    // Plugin-owned resources fall back to their English defaults.
    return "en";
  };
  const translate = (key) => messages[locale][key] ?? messages.en[key] ?? key;
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
