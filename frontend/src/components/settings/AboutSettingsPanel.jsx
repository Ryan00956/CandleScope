export default function AboutSettingsPanel() {
    return (
        <>
            <div className="st-group">
                <div className="st-about-header">
                    <div className="st-about-logo">📈</div>
                    <div className="st-about-name">CandleScope</div>
                    <div className="st-about-version">v0.2.0</div>
                    <div className="st-about-tagline">开源 K 线看盘・实时行情</div>
                </div>
            </div>

            <div className="st-group">
                <div className="st-group-title">技术栈</div>
                <div className="st-about-stack">
                    <div className="st-stack-item">
                        <span className="st-stack-label">前端</span>
                        <span className="st-stack-value">React + Lightweight Charts</span>
                    </div>
                    <div className="st-stack-item">
                        <span className="st-stack-label">后端</span>
                        <span className="st-stack-value">FastAPI + SQLite (WAL)</span>
                    </div>
                    <div className="st-stack-item">
                        <span className="st-stack-label">数据源</span>
                        <span className="st-stack-value">Binance REST + WebSocket</span>
                    </div>
                    <div className="st-stack-item">
                        <span className="st-stack-label">实时更新</span>
                        <span className="st-stack-value">WebSocket 双向通信</span>
                    </div>
                </div>
            </div>

            <div className="st-group">
                <div className="st-group-title">快捷键</div>
                <div className="st-about-stack">
                    <div className="st-stack-item">
                        <span className="st-stack-label">⚙️</span>
                        <span className="st-stack-value">设置面板</span>
                    </div>
                    <div className="st-stack-item">
                        <span className="st-stack-label">📊</span>
                        <span className="st-stack-value">指标面板</span>
                    </div>
                    <div className="st-stack-item">
                        <span className="st-stack-label">✎</span>
                        <span className="st-stack-value">管理自定义周期</span>
                    </div>
                </div>
            </div>
        </>
    );
}
