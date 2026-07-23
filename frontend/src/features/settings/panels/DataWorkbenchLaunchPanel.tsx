export interface DataWorkbenchLaunchPanelProps {
  onOpen(): void;
}

export default function DataWorkbenchLaunchPanel({ onOpen }: DataWorkbenchLaunchPanelProps) {
  return (
    <section className="st-group">
      <div className="st-tool-card">
        <div className="st-tool-header">
          <span className="st-tool-icon">🧭</span>
          <div>
            <div className="st-tool-name">数据工作台 <span className="st-badge st-badge-db">真实数据 · 只读</span></div>
            <div className="st-tool-desc">查看 SQLite 文件快照、实际落库序列和已登记缺口。这里不会执行删除、补全或 VACUUM。</div>
          </div>
        </div>
        <div className="st-actions-row">
          <button className="st-btn st-btn-accent" onClick={onOpen} type="button">打开数据工作台</button>
        </div>
      </div>
    </section>
  );
}
