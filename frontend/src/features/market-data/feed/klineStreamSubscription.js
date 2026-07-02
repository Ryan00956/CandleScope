const SOCKET_OPEN = 1;

export class KlineStreamSubscription {
  constructor({
    api,
    series,
    intervals = [],
    socketFactory = (url) => new WebSocket(url),
    onOpen = () => {},
    onStreamStatus = () => {},
    onControlMessage = () => {},
    onBackfillCompleted = () => false,
    onKline = () => {},
    onError = () => {},
    onClose = () => {},
    onParseError = () => {},
  }) {
    this.api = api;
    this.series = series;
    this.desiredIntervals = Array.from(new Set(intervals));
    this.activeIntervals = new Set();
    this.callbacks = {
      onOpen,
      onStreamStatus,
      onControlMessage,
      onBackfillCompleted,
      onKline,
      onError,
      onClose,
      onParseError,
    };
    this.socket = socketFactory(api.getMultiStreamUrl(series.symbol, series.marketType, series.exchange));
    this.bindSocket();
  }

  bindSocket() {
    this.socket.onopen = () => {
      this.activeIntervals = new Set();
      this.syncSubscriptions();
      this.callbacks.onOpen(this);
    };
    this.socket.onmessage = (event) => this.handleMessage(event);
    this.socket.onerror = (event) => this.callbacks.onError(event, this);
    this.socket.onclose = (event) => this.callbacks.onClose(event, this);
  }

  readyState() {
    return this.socket?.readyState;
  }

  isOpen() {
    return this.readyState() === (this.socket?.OPEN ?? SOCKET_OPEN);
  }

  send(payload) {
    if (!this.isOpen()) return false;
    this.socket.send(payload);
    return true;
  }

  sendPing() {
    return this.send("ping");
  }

  updateIntervals(intervals = []) {
    this.desiredIntervals = Array.from(new Set(intervals));
    this.syncSubscriptions();
  }

  syncSubscriptions() {
    if (!this.isOpen()) return;

    const desired = new Set(this.desiredIntervals);
    const toSubscribe = this.desiredIntervals.filter((interval) => !this.activeIntervals.has(interval));
    const toUnsubscribe = Array.from(this.activeIntervals).filter((interval) => !desired.has(interval));

    if (toSubscribe.length > 0) {
      this.socket.send(JSON.stringify({
        action: "subscribe",
        intervals: toSubscribe,
      }));
      toSubscribe.forEach((interval) => this.activeIntervals.add(interval));
    }

    if (toUnsubscribe.length > 0) {
      this.socket.send(JSON.stringify({
        action: "unsubscribe",
        intervals: toUnsubscribe,
      }));
      toUnsubscribe.forEach((interval) => this.activeIntervals.delete(interval));
    }
  }

  handleMessage(event) {
    if (event.data === "pong") return;

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (error) {
      this.callbacks.onParseError(error, event, this);
      return;
    }

    if (msg.type === "stream_status") {
      this.callbacks.onStreamStatus(msg, this);
      return;
    }

    if (
      msg.type === "subscribed" ||
      msg.type === "connected" ||
      msg.type === "warning" ||
      msg.type === "error"
    ) {
      this.callbacks.onControlMessage(msg, this);
      return;
    }

    if (msg.type === "backfill_completed" && this.callbacks.onBackfillCompleted(msg, this)) {
      return;
    }

    if (msg.type === "kline" && msg.data) {
      this.callbacks.onKline({
        interval: msg.interval,
        tick: msg.data,
        message: msg,
      }, this);
    }
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      // Best effort close during teardown.
    }
  }
}
