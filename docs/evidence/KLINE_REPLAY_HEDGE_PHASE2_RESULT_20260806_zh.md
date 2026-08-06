# K 线回放 HEDGE Phase 2 完成证据

日期：2026-08-06
基线：`1d205046`
范围：双向账户、逐腿 leverage、初始/维持保证金、CROSS/ISOLATED、order reservation、reduce-only 与 close capacity；不提前宣称 Phase 3 archive 或 Phase 5 强平状态机完整。

## 1. 完成结果

- broker model 升级到 HEDGE margin v4；`ReplayOrder` 持久化 effective leverage，LONG/SHORT position leg 持久化各自 active leverage，checkpoint、restart 与 fork 不丢失。
- 新增严格的 `set_position_leverage` 领域命令。非零腿不能借追加订单静默换杠杆；调杠杆会在 actor 内原子重算，存在目标腿 opening order 或降低后权益不足时明确拒绝。
- `InstrumentRule` 成为 initial margin、maintenance tier、quote-step 向上取整与 quantity-step 向下取整的统一 Decimal adapter。
- HEDGE 初始/维持保证金按腿独立计算后求和，不以净仓抵扣；等量 LONG/SHORT 的 net quantity 为零时仍是两条非零风险腿。
- CROSS available 按账户权益减逐腿初始保证金和所有 active opening reservation 重算；reduce-only reservation 为零，close capacity 只读取目标腿。
- HEDGE ISOLATED key 硬切为 `<track_id>:<LONG|SHORT>`。分配命令、hash-chained ledger、关系投影、margin bucket、capacity、自动释放、fork 和 UI 均携带 `position_side`，两腿钱包不共享。
- allocation 形成可审计 Review event；review fork 按逐腿 key 回放账本。仅被完整关闭且无同腿活动单的逐仓腿自动释放，不影响另一条腿。
- portfolio 从 cash ledger、active orders 和 HEDGE position-leg 关系独立重算 account notional、leverage、initial/maintenance margin、risk tier、reserved 与 available，并校验 position component hash 和 rule math；篡改关系数据 fail-closed。
- 右侧交易栏展示逐腿 active leverage，提供逐腿调杠杆与逐腿逐仓资金分配，不存在 feature flag、灰度或默认关闭路径。

## 2. 核心不变量验证

- 等量 LONG/SHORT 同时存在：净仓为零但账户不 flat，initial/maintenance margin 为两腿之和。
- opening reservation 使用目标腿 effective leverage；reduce-only 与合法 close 不占 opening margin，也不读取另一腿 capacity。
- LONG 调杠杆、分配或平仓不会改变 SHORT leverage、wallet、position relation 或 allocation。
- 低于已用初始保证金加活动订单 reservation 的逐仓扣减，以及导致全局 available 为负的 leverage mutation，均原子拒绝。
- restart 与 review fork 后逐腿 leverage、allocation、wallet、bucket 和 content hash 保持一致；手工破坏 position relation 后读取 portfolio 明确失败。

## 3. 验证记录

Phase 2 专项：

```powershell
$env:PYTHONPATH='backend;packages/candlescope-plugin-sdk/src'
python -m pytest backend/tests/test_replay_hedge_phase2_margin.py -q
```

结果：`3 passed in 0.64s`。

后端完整回放套件：

```powershell
$env:PYTHONPATH='backend;packages/candlescope-plugin-sdk/src'
$replayTests=(Get-ChildItem -LiteralPath 'backend/tests' -Filter 'test_replay*.py').FullName
python -m pytest @replayTests -q
```

结果：`808 passed, 4 warnings in 138.19s`。4 条均为既有 FastAPI `on_event` deprecation warning，无测试失败。

前端门禁：

```powershell
npm run typecheck
npm run test:replay
npm run lint
npm run build
```

结果：TypeScript 类型检查、ESLint 和 Vite production build 通过；replay 测试 `326/326` 通过。build 仅报告既有大 chunk 警告。

静态门禁：

```powershell
python -m ruff check <全部 Phase 2 修改的 Python 文件>
python -m compileall -q backend/app/replay
git diff --check
```

结果：全部通过。

## 4. 阶段边界

Phase 2 已完成双向账户和保证金内核，但当前 rule/funding/mark/fee 仍来自既有 run 输入和默认规则。Phase 3 必须把 public history 与确定性模拟输入物化为 pinned archive/manifest，并让 account-only event 进入同一虚拟时钟；Phase 4 才完成逐腿 funding/fee 审计，Phase 5 才完成部分强平、破产、保险基金和 ADL 的最终状态机。
