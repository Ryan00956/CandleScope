# Backtest Chart-first Phase 0 执行计划（2026-08-24）

## 身份与范围

- 基线：`f8a195e7844f1c8afaa073bea620588a863477e3`
- 分支：`codex/backtest-chart-first-ux`
- 隔离工作树：`H:\program\CandleScope-backtest-chart-first`
- 原工作树：`H:\program\CandleScope`，开始前已有 README、backtest frontend、i18n、CSS 与
  执行文档等用户改动；全部排除，不复制、不暂存、不提交。
- 本阶段只冻结合同、状态、边界、视觉稿和基线，不实现 Phase 1 及以后生产代码。
- 不 push、不 merge、不 deploy、不启用生产 flag。

## 实施顺序

1. 审计现有 BacktestRun/Study/TrainingRun、图表平台、runtime、flags、测试和历史 ADR。
2. 新增 ADR-BACKTEST-013，冻结普通/高级双层体验、能力共享/runtime 隔离、解释与比较合同、
   默认值和回滚边界。
3. 运行前端 architecture/i18n/typecheck/backtest 与后端相关回归，先记录零改动基线。
4. 使用 Codex 内置浏览器在同一 1440×900 视口捕获主图、replay 和旧 backtest 页面。
5. 记录默认生产 build、单图/四图 chart surface 与 data-ready、批量 K 线 WebSocket lease。
6. 在 `LOCAL_OFFLINE` 隔离后端中导入仓库 CSV fixture，经公开 HTTP API 完成 snapshot、Run、
   report、export hash smoke；不得调用私有撮合函数或联网补数据。
7. 用真实主图截图、真实 smoke Run 图表/成交/权益数据制作首次打开、完成、脚本错误、stale
   四个同视口视觉合同稿；明确标为非生产实现。
8. 建立需求到测试 ID 的追踪矩阵，更新执行文档状态，重跑 Phase 0 门禁。
9. 停在视觉/产品人工评审门禁。只有用户批准后才形成 Phase 0 单独提交；未批准不进入 Phase 1。

## 可重跑命令

### 前端合同与类型

```powershell
Set-Location H:\program\CandleScope-backtest-chart-first\frontend
npm run check:architecture
npm run check:i18n
npm run typecheck
npm run test:backtest
npm run build
```

`node_modules` 必须位于当前工作树或由 Vite `server.fs.allow` 明确允许。依赖目录放在其他工作树
时，字体请求会被 Vite 正确拒绝；不得把缺字体截图当作视觉证据。

### 后端相关回归

```powershell
Set-Location H:\program\CandleScope-backtest-chart-first\backend
$paths = @('tests/backtest_contract')
$paths += Get-ChildItem tests -Filter 'test_backtest*.py' | ForEach-Object FullName
$paths += @(
  'tests/test_strategy_provider_v1.py',
  'tests/test_trade_tape.py',
  'tests/test_pyne_strategy_provider.py',
  'tests/test_pine_strategy_adapter.py',
  'tests/test_external_model_adapters.py',
  'tests/test_contract_accounting.py'
)
D:\anaconda\python.exe -m pytest @paths -q
```

### 隔离公开 API smoke

后端进程使用独立目录与端口 18084；以下 flags 只存在于测试进程：

```powershell
$env:PYTHONPATH = @(
  'H:\program\CandleScope-backtest-chart-first\packages\candlescope-plugin-sdk\src',
  'H:\program\CandleScope-backtest-chart-first\packages\candlescope-backtest-sdk\src',
  'H:\program\CandleScope-backtest-chart-first\packages\candlescope-plugin-pyne\src'
) -join ';'
$env:CANDLESCOPE_RUNTIME_MODE = 'LOCAL_OFFLINE'
$env:CANDLE_DATA_DIR = 'H:\program\CandleScope-backtest-chart-first\output\phase0-backtest-runtime\data'
$env:CANDLESCOPE_LOCAL_DATA_DIR = 'H:\program\CandleScope-backtest-chart-first\output\phase0-backtest-runtime\local-data'
$env:BACKTEST_DB_PATH = 'H:\program\CandleScope-backtest-chart-first\output\phase0-backtest-runtime\backtest.db'
$env:BACKTEST_ENABLED = '1'
$env:BACKTEST_BAR_ENABLED = '1'
$env:BACKTEST_STUDY_ENABLED = '1'
D:\anaconda\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 18084
```

另一个终端导入仓库 fixture 并运行公开 API smoke：

```powershell
$uri = 'http://127.0.0.1:18084/api/v1/local/imports/csv?name=Phase0Smoke&symbol=BTCUSDT&interval=1m&timestamp_unit=ms&timezone=UTC&volume_required=true'
Invoke-RestMethod -Uri $uri -Method Post -InFile backend\tests\fixtures\local_mode_sample.csv -ContentType 'text/csv'
Set-Location frontend
$env:BACKTEST_BASE_URL = 'http://127.0.0.1:18084/api/v1/backtests'
npm run smoke:backtest
```

### 浏览器与租约

```powershell
$env:VITE_API_PROXY_TARGET = 'http://127.0.0.1:18080'
$env:VITE_DEV_PORT = '15224'
$env:VITE_BACKTEST_ENTRY_ENABLED = '1'
npm run dev -- --host 127.0.0.1
```

用同一浏览器/视口分别加载 `/`、`/replay.html`、`/backtest.html`。单/四图就绪条件必须同时
满足：逻辑 cell 数正确、每个 cell 恰有一个 `.tv-lightweight-charts`、每个 cell 的
`data-market-data-ready=true`。租约通过只读 `/debug/capacity` 记录；显式设置
`VITE_KLINE_BATCH_STREAM_ENABLED=1` 后，单图和四图都应只有一个物理 batch WebSocket，关闭
页面后 active connection 与 logical client/subscription 回到 0。

## 阻断规则

- 任一命令非零、截图未稳定、完成态数据不是公开 API Run、旧标记在 stale 态仍出现：Phase 0
  不得称为通过。
- 视觉稿只证明合同可评审，不证明 Phase 4 功能已实现。
- 人工视觉/产品评审未批准：不提交 Phase 0，不进入 Phase 1。
