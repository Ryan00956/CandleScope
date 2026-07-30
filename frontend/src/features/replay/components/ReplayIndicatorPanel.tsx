import type { ReplayIndicatorRuntime } from "../useReplayIndicatorRuntime.js";

export interface ReplayIndicatorPanelProps {
  readonly runtime: ReplayIndicatorRuntime;
  onClose(): void;
}

export default function ReplayIndicatorPanel({
  runtime,
  onClose,
}: ReplayIndicatorPanelProps) {
  return (
    <aside
      className="replay-indicator-panel"
      aria-labelledby="replay-indicator-panel-title"
      data-replay-indicator-mode={runtime.status.mode}
    >
      <header>
        <div>
          <span className="training-hub-kicker">REVEALED PREFIX ONLY</span>
          <h2 id="replay-indicator-panel-title">回放指标</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭回放指标">×</button>
      </header>
      <p className="replay-indicator-panel-summary">
        {runtime.status.sourceBarCount} 根已揭示展示 K ·
        {" "}{runtime.status.activeIndicatorCount} 个已添加指标
      </p>
      {runtime.status.inheritedFromLiveWorkspace && (
        <p className="replay-indicator-panel-note">
          首次打开本 Run 时已复制实时页的本地指标视图；之后按 Run 独立保存。
        </p>
      )}
      <div className="replay-indicator-catalog">
        {runtime.catalog.map((item) => (
          <article key={item.id} data-indicator-added={item.added}>
            <div>
              <strong>{item.name}</strong>
              <span>{item.description} · {item.pane === "main" ? "主图" : "副图"}</span>
              <small data-indicator-available={item.available}>
                {item.availability}
              </small>
            </div>
            {item.added ? (
              <div className="replay-indicator-actions">
                {item.periodEditable && (
                  <label>
                    周期
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={item.period}
                      onChange={(event) => runtime.actions.updatePeriod(
                        item.id,
                        Number(event.target.value),
                      )}
                    />
                  </label>
                )}
                <button
                  type="button"
                  onClick={() => runtime.actions.toggleVisibility(item.id)}
                  aria-pressed={item.visible}
                >
                  {item.visible ? "隐藏" : "显示"}
                </button>
                <button type="button" onClick={() => runtime.actions.remove(item.id)}>
                  删除
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={!item.available}
                onClick={() => runtime.actions.add(item.id)}
              >
                添加
              </button>
            )}
          </article>
        ))}
      </div>
      {runtime.status.unsupportedLiveIndicators.length > 0 && (
        <section className="replay-indicator-unsupported" aria-label="未迁移指标">
          <strong>未迁移的实时指标</strong>
          <p>{runtime.status.unsupportedLiveIndicators.join("、")}</p>
          <small>自定义脚本与 hosted/range/security 指标尚无回放安全执行器，因此不会偷偷请求实时或未来窗口。</small>
        </section>
      )}
    </aside>
  );
}
