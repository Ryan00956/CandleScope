import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildAlertEventStreamUrl,
  recordAlertDispatchReceipt,
} from "../../features/alerts/alertsClient.js";
import {
  ALERT_RULE_STATE_CHANGED_EVENT,
  deliverAlertNotification,
} from "../../features/alerts/alertDeliveryClient.js";
import {
  parseAlertNotificationMessage,
} from "../../features/alerts/alertTypes.js";
import type { AlertNotificationMessage } from "../../features/alerts/alertTypes.js";

interface AlertToast {
  id: string;
  notification: AlertNotificationMessage;
  deliveryError?: string;
}

export interface AlertNotificationCenterProps {
  onOpenAlerts(): void;
}

const TOAST_LIFETIME_MS = 15_000;
const MAX_TOASTS = 5;

export default function AlertNotificationCenter({ onOpenAlerts }: AlertNotificationCenterProps) {
  const [toasts, setToasts] = useState<AlertToast[]>([]);
  const seenDispatchesRef = useRef(new Set<string>());
  const seenEventsRef = useRef(new Set<string>());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const publishToast = useCallback((notification: AlertNotificationMessage) => {
    const toast: AlertToast = { id: notification.dispatchId, notification };
    setToasts((current) => [...current.filter((item) => item.id !== toast.id), toast].slice(-MAX_TOASTS));
    window.setTimeout(() => dismiss(toast.id), TOAST_LIFETIME_MS);
  }, [dismiss]);

  const publishDeliveryError = useCallback((notification: AlertNotificationMessage, detail: string) => {
    const toast: AlertToast = {
      id: `delivery-error-${notification.dispatchId}`,
      notification,
      deliveryError: detail,
    };
    setToasts((current) => [...current, toast].slice(-MAX_TOASTS));
    window.setTimeout(() => dismiss(toast.id), TOAST_LIFETIME_MS);
  }, [dismiss]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const source = new EventSource(buildAlertEventStreamUrl());
    const handleNotification = (event: MessageEvent<string>) => {
      void (async () => {
        let notification: AlertNotificationMessage;
        try {
          const value: unknown = JSON.parse(event.data);
          notification = parseAlertNotificationMessage(value);
        } catch (error: unknown) {
          console.error("Invalid alert notification payload", error);
          return;
        }
        if (seenDispatchesRef.current.has(notification.dispatchId)) return;
        seenDispatchesRef.current.add(notification.dispatchId);
        if (seenDispatchesRef.current.size > 512) {
          seenDispatchesRef.current = new Set([notification.dispatchId]);
        }
        if (!seenEventsRef.current.has(notification.eventId)) {
          seenEventsRef.current.add(notification.eventId);
          if (seenEventsRef.current.size > 512) {
            seenEventsRef.current = new Set([notification.eventId]);
          }
          window.dispatchEvent(new CustomEvent(ALERT_RULE_STATE_CHANGED_EVENT, {
            detail: {
              eventId: notification.eventId,
              ruleId: notification.ruleId,
            },
          }));
        }

        const receipt = await deliverAlertNotification(notification, publishToast, onOpenAlerts);
        if (receipt.status !== "delivered" && notification.action.type !== "in_app") {
          publishDeliveryError(notification, receipt.detail);
        }
        try {
          await recordAlertDispatchReceipt(
            notification.eventId,
            notification.dispatchId,
            receipt.status,
            receipt.detail,
          );
        } catch (error: unknown) {
          console.warn("Failed to record alert delivery receipt", error);
        }
      })();
    };
    source.addEventListener("alert.notification", handleNotification as EventListener);
    return () => {
      source.removeEventListener("alert.notification", handleNotification as EventListener);
      source.close();
    };
  }, [onOpenAlerts, publishDeliveryError, publishToast]);

  if (toasts.length === 0) return null;
  return (
    <div className="alert-toast-stack" role="region" aria-live="polite" aria-label="警报通知">
      {toasts.map((toast) => {
        const { notification } = toast;
        const symbol = notification.target.symbol || "--";
        return (
          <div className={`alert-toast ${toast.deliveryError ? "is-error" : ""}`} key={toast.id}>
            <button className="alert-toast-main" type="button" onClick={onOpenAlerts}>
              <span className="alert-toast-kicker">{toast.deliveryError ? "通知投递失败" : `警报 · ${symbol}`}</span>
              <strong>{notification.message || `${symbol} 命中规则`}</strong>
              {toast.deliveryError && <small>{toast.deliveryError}</small>}
            </button>
            <button className="alert-toast-close" type="button" onClick={() => dismiss(toast.id)} aria-label="关闭通知">×</button>
          </div>
        );
      })}
    </div>
  );
}
