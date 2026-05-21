import { useCallback, useEffect, useState } from 'react';
import { fetchSupportedExchanges } from '../../services/api';

export function useExchangeSettingsRuntime({ isOpen }) {
    const [supportedExchanges, setSupportedExchanges] = useState([]);
    const [exchangeListLoading, setExchangeListLoading] = useState(false);
    const [exchangeListError, setExchangeListError] = useState(null);

    const loadSupportedExchanges = useCallback(async () => {
        setExchangeListLoading(true);
        setExchangeListError(null);
        try {
            const data = await fetchSupportedExchanges();
            setSupportedExchanges(Array.isArray(data.exchanges) ? data.exchanges : []);
        } catch (err) {
            setExchangeListError(err.message || '交易所列表加载失败');
        } finally {
            setExchangeListLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        loadSupportedExchanges();
    }, [isOpen, loadSupportedExchanges]);

    return {
        supportedExchanges,
        exchangeListLoading,
        exchangeListError,
        loadSupportedExchanges,
    };
}
