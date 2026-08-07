import type { AlertNotificationMessage } from "./alertTypes.js";

export const ALERT_RULE_STATE_CHANGED_EVENT = "candlescope:alert-rule-state-changed";
export const ALERT_PANEL_OPEN_REQUEST_EVENT = "candlescope:alert-panel-open-request";

export function requestAlertPanelOpen(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ALERT_PANEL_OPEN_REQUEST_EVENT));
}

export type AlertDeliveryReceiptStatus = "delivered" | "denied" | "unsupported" | "error";

export interface AlertDeliveryReceipt {
  status: AlertDeliveryReceiptStatus;
  detail: string;
}

let alertAudioContext: AudioContext | null = null;

function audioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as typeof window & { webkitAudioContext?: typeof AudioContext }).AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return candidate || null;
}

function getAlertAudioContext(): AudioContext | null {
  if (alertAudioContext) return alertAudioContext;
  const AudioContextCtor = audioContextConstructor();
  if (!AudioContextCtor) return null;
  alertAudioContext = new AudioContextCtor();
  return alertAudioContext;
}

export async function requestBrowserAlertPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (window.Notification.permission === "granted") return "granted";
  return window.Notification.requestPermission();
}

export async function primeAlertSound(): Promise<boolean> {
  const context = getAlertAudioContext();
  if (!context) return false;
  if (context.state === "suspended") await context.resume();
  return context.state === "running";
}

export async function deliverAlertNotification(
  notification: AlertNotificationMessage,
  publishToast: (notification: AlertNotificationMessage) => void,
  onOpenAlert?: () => void,
): Promise<AlertDeliveryReceipt> {
  const actionType = notification.action.type;
  if (actionType === "in_app") {
    publishToast(notification);
    return { status: "delivered", detail: "toast_rendered" };
  }
  if (actionType === "browser") {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return { status: "unsupported", detail: "notification_api_unavailable" };
    }
    if (window.Notification.permission !== "granted") {
      return { status: "denied", detail: `permission_${window.Notification.permission}` };
    }
    const symbol = notification.target.symbol || "CandleScope";
    const browserNotification = new window.Notification(`警报 · ${symbol}`, {
      body: notification.message,
      tag: notification.ruleId,
    });
    browserNotification.onclick = () => {
      window.focus();
      onOpenAlert?.();
      browserNotification.close();
    };
    return { status: "delivered", detail: "browser_notification_created" };
  }

  const context = getAlertAudioContext();
  if (!context) return { status: "unsupported", detail: "web_audio_unavailable" };
  if (context.state !== "running") return { status: "denied", detail: "audio_not_primed" };
  try {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.exponentialRampToValueAtTime(660, now + 0.22);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.25);
    return { status: "delivered", detail: "sound_played" };
  } catch (error: unknown) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
