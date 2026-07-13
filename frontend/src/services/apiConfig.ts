export type HttpApiBase = string;
export type WebSocketApiBase = string;

const DEFAULT_API_BASE: HttpApiBase = "/api/v1";

function normalizeApiBase(value: unknown): HttpApiBase {
  const base = String(value || DEFAULT_API_BASE).trim();
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export const API_BASE = normalizeApiBase(import.meta.env?.VITE_API_BASE);

export function httpBaseToWsBase(httpBase: HttpApiBase): WebSocketApiBase {
  if (httpBase.startsWith("https://")) return `wss://${httpBase.slice("https://".length)}`;
  if (httpBase.startsWith("http://")) return `ws://${httpBase.slice("http://".length)}`;
  if (httpBase.startsWith("/")) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${httpBase}`;
  }
  return httpBase;
}
