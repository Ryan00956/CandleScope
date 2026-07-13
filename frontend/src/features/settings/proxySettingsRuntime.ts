import { useCallback, useEffect, useState } from "react";
import {
  fetchProxySettings,
  testProxyConnection,
  updateProxySettings,
} from "../../services/api";

export type ProxyMode = "system" | "custom" | "none";

export interface ProxyTestResult extends Record<string, unknown> {
  success?: boolean;
  message?: string;
}

export interface ProxySaveMessage {
  ok: boolean;
  text: string;
}

export interface ProxySettingsRuntime extends Record<string, unknown> {
  proxyMode: ProxyMode;
  customProxy: string;
  systemProxy: string;
  effectiveProxy: string;
  proxyLoading: boolean;
  proxyTestResult: ProxyTestResult | null;
  proxySaveMsg: ProxySaveMessage | null;
  handleProxyModeChange(mode: ProxyMode): void;
  handleCustomProxyChange(value: string): void;
  handleProxySave(): Promise<void>;
  handleProxyTest(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, fallback = ""): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function proxyModeField(record: Record<string, unknown>): ProxyMode {
  const value = record.mode;
  return value === "custom" || value === "none" || value === "system" ? value : "system";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function useProxySettingsRuntime({ isOpen }: { isOpen: boolean }): ProxySettingsRuntime {
  const [proxyMode, setProxyMode] = useState<ProxyMode>("system");
  const [customProxy, setCustomProxy] = useState("");
  const [systemProxy, setSystemProxy] = useState("");
  const [effectiveProxy, setEffectiveProxy] = useState("");
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | null>(null);
  const [proxySaveMsg, setProxySaveMsg] = useState<ProxySaveMessage | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setProxyTestResult(null);
    setProxySaveMsg(null);
    fetchProxySettings()
      .then((data) => {
        const record = isRecord(data) ? data : {};
        setProxyMode(proxyModeField(record));
        setCustomProxy(stringField(record, "custom_proxy"));
        setSystemProxy(stringField(record, "system_proxy"));
        setEffectiveProxy(stringField(record, "effective_proxy"));
      })
      .catch(() => {});
  }, [isOpen]);

  const handleProxyModeChange = useCallback((mode: ProxyMode) => {
    setProxyMode(mode);
    setProxyTestResult(null);
    setProxySaveMsg(null);
  }, []);

  const handleCustomProxyChange = useCallback((value: string) => {
    setCustomProxy(value);
    setProxySaveMsg(null);
  }, []);

  const handleProxySave = useCallback(async () => {
    setProxyLoading(true);
    setProxySaveMsg(null);
    try {
      const res = await updateProxySettings({ mode: proxyMode, custom_proxy: customProxy });
      const record = isRecord(res) ? res : {};
      setEffectiveProxy(stringField(record, "effective_proxy"));
      setProxySaveMsg({ ok: true, text: "代理设置已保存 ✓" });
    } catch (err: unknown) {
      setProxySaveMsg({ ok: false, text: `保存失败: ${errorMessage(err)}` });
    } finally {
      setProxyLoading(false);
    }
  }, [proxyMode, customProxy]);

  const handleProxyTest = useCallback(async () => {
    setProxyLoading(true);
    setProxyTestResult(null);
    try {
      const res = await testProxyConnection({ mode: proxyMode, custom_proxy: customProxy });
      setProxyTestResult(isRecord(res) ? res : {});
    } catch (err: unknown) {
      setProxyTestResult({ success: false, message: `请求失败: ${errorMessage(err)}` });
    } finally {
      setProxyLoading(false);
    }
  }, [proxyMode, customProxy]);

  return {
    proxyMode,
    customProxy,
    systemProxy,
    effectiveProxy,
    proxyLoading,
    proxyTestResult,
    proxySaveMsg,
    handleProxyModeChange,
    handleCustomProxyChange,
    handleProxySave,
    handleProxyTest,
  };
}
