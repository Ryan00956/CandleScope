import { useMemo, useState } from "react";
import { isBacktestEntryEnabled } from "./backtestFlags.js";
import type { BacktestReport } from "./backtestTypes.js";

export default function BacktestApp() {
  const enabled = useMemo(() => isBacktestEntryEnabled(), []);
  const [report] = useState<BacktestReport | null>(null);
  if (!enabled) {
    return (
      <main className="backtest-app">
        <h1>策略回测</h1>
        <p>前端入口已关闭。设置 VITE_BACKTEST_ENTRY_ENABLED=1 且后端 BACKTEST_ENABLED=1 后可用。</p>
      </main>
    );
  }
  return (
    <main className="backtest-app">
      <h1>策略回测研究</h1>
      <section className="backtest-credibility" aria-label="credibility">
        <strong>APPROXIMATE</strong>
        <p>BAR 回测不能解释 K 线内部顺序，也不能当作实盘建议。</p>
      </section>
      <section>
        <h2>新建 Run</h2>
        <p>选择策略修订、不可变数据和账户后验证，再启动后台任务。刷新页面不会取消 Run。</p>
      </section>
      <section>
        <h2>报告</h2>
        <p>标签：{report?.report_label ?? "APPROXIMATE"}</p>
      </section>
    </main>
  );
}
