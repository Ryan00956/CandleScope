import { useCallback, useEffect, useState } from 'react';
import {
    fetchProxySettings,
    testProxyConnection,
    updateProxySettings,
} from '../../services/api';

export function useProxySettingsRuntime({ isOpen }) {
    const [proxyMode, setProxyMode] = useState('system');
    const [customProxy, setCustomProxy] = useState('');
    const [systemProxy, setSystemProxy] = useState('');
    const [effectiveProxy, setEffectiveProxy] = useState('');
    const [proxyLoading, setProxyLoading] = useState(false);
    const [proxyTestResult, setProxyTestResult] = useState(null);
    const [proxySaveMsg, setProxySaveMsg] = useState(null);

    useEffect(() => {
        if (!isOpen) return;
        setProxyTestResult(null);
        setProxySaveMsg(null);
        fetchProxySettings()
            .then((data) => {
                setProxyMode(data.mode || 'system');
                setCustomProxy(data.custom_proxy || '');
                setSystemProxy(data.system_proxy || '');
                setEffectiveProxy(data.effective_proxy || '');
            })
            .catch(() => { /* ignore — backend may not be up */ });
    }, [isOpen]);

    const handleProxyModeChange = useCallback((mode) => {
        setProxyMode(mode);
        setProxyTestResult(null);
        setProxySaveMsg(null);
    }, []);

    const handleCustomProxyChange = useCallback((value) => {
        setCustomProxy(value);
        setProxySaveMsg(null);
    }, []);

    const handleProxySave = useCallback(async () => {
        setProxyLoading(true);
        setProxySaveMsg(null);
        try {
            const res = await updateProxySettings({ mode: proxyMode, custom_proxy: customProxy });
            setEffectiveProxy(res.effective_proxy || '');
            setProxySaveMsg({ ok: true, text: '代理设置已保存 ✓' });
        } catch (err) {
            setProxySaveMsg({ ok: false, text: `保存失败: ${err.message}` });
        } finally {
            setProxyLoading(false);
        }
    }, [proxyMode, customProxy]);

    const handleProxyTest = useCallback(async () => {
        setProxyLoading(true);
        setProxyTestResult(null);
        try {
            const res = await testProxyConnection({ mode: proxyMode, custom_proxy: customProxy });
            setProxyTestResult(res);
        } catch (err) {
            setProxyTestResult({ success: false, message: `请求失败: ${err.message}` });
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
