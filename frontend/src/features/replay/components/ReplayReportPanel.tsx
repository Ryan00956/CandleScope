import { downloadReplayReport } from "../replayReportExport.js";
import { formatReplayPublicTime, replayOwnsController } from "../replayUiModel.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";

export default function ReplayReportPanel({ runtime }: { readonly runtime: ReplayRuntime }) {
  if (runtime.store.state !== "ENDED") return null;
  const response = runtime.report;
  const config = runtime.store.sessionConfig;
  const ownsController = replayOwnsController(runtime.store, runtime.clientInstanceId);
  const exportInput = response && config && runtime.sessionId ? {
    sessionId: runtime.sessionId,
    config,
    response,
    commandTimeline: runtime.commandTimeline,
    journal: runtime.store.journal,
  } : null;
  return (
    <section className="replay-report-panel" data-replay-panel="report" aria-labelledby="replay-report-title">
      <div className="replay-report-heading">
        <div><span className="replay-mode-badge">ENDED</span><h2 id="replay-report-title">训练报告</h2></div>
        <div className="replay-report-actions">
          <button type="button" disabled={!exportInput} onClick={() => exportInput && downloadReplayReport(exportInput, "json")}>导出 JSON</button>
          <button type="button" disabled={!exportInput} onClick={() => exportInput && downloadReplayReport(exportInput, "csv")}>导出 CSV</button>
        </div>
      </div>
      {runtime.operation === "report" && <p role="status">正在固化并校验报告…</p>}
      {runtime.reportError && <div className="replay-command-error" role="alert">{runtime.reportError.code}: {runtime.reportError.message}</div>}
      {response && (
        <>
          <div className="replay-report-summary">
            <div><span>Final equity</span><strong>{response.report.final_equity}</strong></div>
            <div><span>Realized PnL</span><strong>{response.report.realized_pnl}</strong></div>
            <div><span>Fees</span><strong>{response.report.fees_paid}</strong></div>
            <div><span>Max drawdown</span><strong>{response.report.max_drawdown}</strong></div>
            <div><span>Trades</span><strong>{response.report.trade_count}</strong></div>
            <div><span>Win rate</span><strong>{response.report.win_rate}</strong></div>
            <div><span>Profit factor</span><strong>{response.report.profit_factor ?? "∞ / N.A."}</strong></div>
            <div><span>Ambiguous bars</span><strong>{response.report.ambiguous_bar_count}</strong></div>
          </div>
          <div className="replay-report-integrity">
            <span>{response.data_fidelity} · {response.execution_fidelity}</span>
            <code>report {response.report.report_hash}</code>
            <code>state {response.report.state_hash}</code>
            <code>ledger {response.report.ledger_tail_hash}</code>
          </div>
          {!response.revealed && (
            <div className="replay-reveal-panel">
              <strong>真实日期仍被隐藏</strong>
              <p>结束不会自动 reveal。显式揭示后，真实区间才会出现在本页与导出文件中。</p>
              <button
                type="button"
                data-replay-action="reveal-history"
                disabled={!ownsController || runtime.pendingCommand !== null || runtime.forkPending}
                title={ownsController ? "揭示真实训练区间" : "先获取 controller lease"}
                onClick={() => void runtime.actions.submitCommand("reveal_history", {}).then(() => runtime.actions.loadReport()).catch(() => undefined)}
              >揭示真实区间</button>
            </div>
          )}
          {response.revealed && response.actual_history && (
            <div className="replay-reveal-panel replay-revealed" data-replay-history-revealed="true">
              <strong>真实区间已揭示</strong>
              <span>{formatReplayPublicTime(response.actual_history.replay_start_ms, { blindMode: false, originMs: null })}</span>
              <span>→ {formatReplayPublicTime(response.actual_history.replay_end_open_ms, { blindMode: false, originMs: null })}</span>
            </div>
          )}
        </>
      )}
      <div className="replay-timeline-grid">
        <section><h3>Command timeline</h3>{runtime.commandTimeline.map((entry) => <div key={entry.command_id}><code>{entry.type}</code><span>{entry.status}</span></div>)}</section>
        <section><h3>Journal</h3>{runtime.store.journal.map((entry) => <div key={entry.entry_id}>{entry.text}</div>)}</section>
      </div>
      <div className="replay-report-footer">
        <button type="button" onClick={() => window.close()}>关闭此回放页</button>
        <a href="/" target="_blank" rel="noopener noreferrer">打开实时行情 ↗</a>
        <a href="/replay.html" target="_blank" rel="noopener noreferrer">新建回放 ↗</a>
      </div>
    </section>
  );
}
