import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sandboxPluginAssetUrl } from "./pluginPlatformApi.js";
import {
  newSandboxInstanceId,
  nextSandboxBridgeGeneration,
  SandboxBridgeSession,
  type SandboxBridgeState,
  type SandboxHostSnapshot,
} from "./pluginSandboxBridge.js";
import type {
  PluginPlatformRuntime,
  PluginSandboxViewContribution,
} from "./pluginPlatformTypes.js";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";

function hostTheme(): "dark" | "light" {
  const declared = document.documentElement.dataset.theme;
  if (declared === "light" || declared === "dark") return declared;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function hostLocale(): string {
  const value = document.documentElement.lang || navigator.language || "en";
  return value.trim().slice(0, 64) || "en";
}

export default function SandboxPluginFrame({
  runtime,
  contribution,
}: {
  runtime: PluginPlatformRuntime;
  contribution: PluginSandboxViewContribution;
}) {
  const locale = useLocale();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const sessionRef = useRef<SandboxBridgeSession | null>(null);
  const loadCountRef = useRef(0);
  const [bridgeIdentity, setBridgeIdentity] = useState(() => ({
    generation: nextSandboxBridgeGeneration(contribution.id),
    instanceId: newSandboxInstanceId(),
  }));
  const [height, setHeight] = useState(360);
  const [state, setState] = useState<SandboxBridgeState>("created");
  const [failure, setFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const { generation, instanceId } = bridgeIdentity;
  const assetUrl = useMemo(
    () => sandboxPluginAssetUrl(
      contribution.pluginId,
      contribution.configuration.asset.bundleDigest,
      contribution.configuration.asset.entry,
    ),
    [contribution],
  );
  const snapshot = useMemo<SandboxHostSnapshot>(() => ({
    theme: hostTheme(),
    locale,
    market: runtime.view.marketIdentity,
  }), [locale, runtime.view.marketIdentity]);

  const connect = useCallback(() => {
    const target = iframeRef.current?.contentWindow;
    if (!target || failure) return;
    loadCountRef.current += 1;
    if (loadCountRef.current !== 1) {
      sessionRef.current?.dispose();
      setFailure("PLUGIN_SANDBOX_UNEXPECTED_NAVIGATION");
      return;
    }
    try {
      const session = new SandboxBridgeSession(
        {
          pluginId: contribution.pluginId,
          viewId: contribution.id,
          instanceId,
          generation,
        },
        snapshot,
        {
          onReady: () => {
            setAnnouncement(t("plugin.host.sandboxConnected", {}, locale));
            if (document.visibilityState === "hidden") sessionRef.current?.suspend();
          },
          onResize: (nextHeight) => setHeight(nextHeight),
          onAnnounce: (message) => setAnnouncement(message),
          onFailure: (code) => setFailure(code),
          onStateChange: setState,
        },
      );
      sessionRef.current = session;
      session.connect(target);
    } catch {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      setFailure("PLUGIN_SANDBOX_CONNECT_FAILED");
    }
  }, [contribution.id, contribution.pluginId, failure, generation, instanceId, locale, snapshot]);

  useEffect(() => {
    sessionRef.current?.updateSnapshot(snapshot);
  }, [snapshot]);

  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === "hidden") sessionRef.current?.suspend();
      else sessionRef.current?.resume();
    };
    const themeObserver = new MutationObserver(() => {
      sessionRef.current?.updateSnapshot({
        theme: hostTheme(),
        locale: hostLocale(),
        market: runtime.view.marketIdentity,
      });
    });
    document.addEventListener("visibilitychange", visibility);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "lang"] });
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      themeObserver.disconnect();
    };
  }, [runtime.view.marketIdentity]);

  useEffect(() => {
    let focusTimer: number | null = null;
    const publishFocus = () => {
      focusTimer = null;
      const iframe = iframeRef.current;
      sessionRef.current?.setFocused(iframe !== null && document.activeElement === iframe);
    };
    const publishFocusAfterBrowserUpdate = () => {
      if (focusTimer !== null) window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(publishFocus, 0);
    };
    window.addEventListener("blur", publishFocusAfterBrowserUpdate);
    window.addEventListener("focus", publishFocusAfterBrowserUpdate);
    document.addEventListener("focusin", publishFocusAfterBrowserUpdate);
    return () => {
      if (focusTimer !== null) window.clearTimeout(focusTimer);
      window.removeEventListener("blur", publishFocusAfterBrowserUpdate);
      window.removeEventListener("focus", publishFocusAfterBrowserUpdate);
      document.removeEventListener("focusin", publishFocusAfterBrowserUpdate);
    };
  }, [generation]);

  useEffect(() => () => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
  }, [generation]);

  const reload = () => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    loadCountRef.current = 0;
    setFailure(null);
    setState("created");
    setAnnouncement("");
    setHeight(360);
    setBridgeIdentity({
      generation: nextSandboxBridgeGeneration(contribution.id),
      instanceId: newSandboxInstanceId(),
    });
  };

  return (
    <div
      className="plugin-sandbox-host"
      data-plugin-sandbox-state={state}
      data-plugin-sandbox-generation={generation}
      data-plugin-sandbox-active={state === "ready" ? "true" : "false"}
    >
      <div className="plugin-sandbox-meta" aria-live="polite">
        <span>{t("plugin.host.sandboxOpaque", {}, locale)}</span>
        <span>{state}</span>
      </div>
      {failure ? (
        <div className="plugin-sandbox-failure" role="alert">
          <strong>{t("plugin.host.sandboxFailed", {}, locale)}</strong>
          <span>{failure}</span>
          <button type="button" onClick={reload}>{t("plugin.host.sandboxReload", {}, locale)}</button>
        </div>
      ) : (
        <iframe
          key={`${contribution.id}:${generation}`}
          ref={iframeRef}
          className="plugin-sandbox-frame"
          src={assetUrl}
          title={contribution.title}
          sandbox="allow-scripts"
          allow=""
          credentialless=""
          loading="eager"
          referrerPolicy="no-referrer"
          style={{ height }}
          onLoad={connect}
          onFocus={() => sessionRef.current?.setFocused(true)}
          onBlur={() => sessionRef.current?.setFocused(false)}
        />
      )}
      <span className="plugin-sandbox-announcement" aria-live="polite">{announcement}</span>
    </div>
  );
}
