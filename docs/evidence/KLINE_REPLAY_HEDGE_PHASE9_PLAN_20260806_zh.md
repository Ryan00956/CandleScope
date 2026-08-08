# K 线回放交易所级双向持仓 Phase 9 执行计划

日期：2026-08-06  
分支：`codex/replay-hedge-exchange-parity`  
基线：`056d9a2d feat(replay): harden hedge liquidation recovery`

## 1. 阶段目标

本阶段完成交易所级 HEDGE 回放的性能、长稳、故障恢复与发布级验收。所有结果必须来自真实 `ReplayService`、SQLite/WAL、`Decimal`、不可变 archive、历史 L2 和浏览器；不得用空仓、纯函数或直接复制数据库行替代。

用户已明确接受：交易所私有历史输入不可获得时，使用 Phase 0 冻结并可审计的确定性模拟输入。该近似只适用于保险基金与 ADL 私有输入，不允许把公开 mark、funding、规则、费率或 L2 降级为代理值。

## 2. 背景审计

### 2.1 可直接复用的基础设施

- `backend/scripts/benchmark_replay_v2_release.py`：真实 ReplayService/SQLite/Decimal 发布基准骨架。
- `backend/scripts/benchmark_replay_account_history.py`：1/2/4/8 FULL positioned track 矩阵和历史账户推进测量骨架。
- `backend/scripts/run_replay_v2_release_checks.py` 与 `verify_replay_v2_release.py`：clean HEAD、外部 manifest、结果摘要与校验入口。
- `frontend/scripts/replay-soak.mjs`：真实浏览器生命周期、投影事件计数与资源采样；现有正式参数已要求至少 4 小时、100 次生命周期、1,000,000 projection events。
- `frontend/scripts/replay-v2-rollback-drill.mjs`：完整构建回滚演练骨架。

### 2.2 必须先修复的产品缺口

当前 HEDGE public 输入是 Run 级单标的绑定：

- `replay_hedge_input_binding` 只有 `run_id` 主键；
- public projection/applied receipt 只有 `(run_id, source_kind)` 游标；
- funding 始终选择第一个 FULL track；
- mark projection 把第一个标的的 mark 应用到所有 FULL tracks；
- ADD_TRACK 只验证历史 L2，不绑定该标的的 public rule/mark/funding archive；
- 现有多轨强平测试通过直接复制 SQLite 行构造第二轨，不能证明真实 ADD_TRACK、输入绑定、全局时钟或恢复路径。

因此，直接运行 1/2/4/8 性能矩阵会产生无效证据。本阶段先新增逐轨 public 输入绑定、projection、applied receipt 与审计；simulation manifest 仍是账户级单一输入，并必须显式覆盖全部加入的 symbol。每个新增 HEDGE FULL track 必须携带精确 immutable public ref，并与该轨历史 L2 ref 一致；缺失或不匹配一律 fail closed。

### 2.3 当前工具缺口

- 现有 release benchmark 未创建真实多标的 HEDGE 双腿持仓，也未分开普通 mark wave 与 liquidation wave。
- 现有 soak 覆盖 replay.v2 通用 BAR 生命周期，但没有强制 HEDGE 双腿、强平、保险基金/ADL 审计。
- 现有 release manifest 未包含执行文档要求的 22 项最低验收矩阵、HEDGE auditor、无灰度/无 fallback 静态审计和逐轨 HEDGE 性能结果。

## 3. 实施顺序

1. **逐轨输入合同与 schema**
   - 新增 schema revision 和逐轨 immutable public binding/projection/applied receipt。
   - 主轨也写入逐轨表；旧 Run 级 primary-public + simulation 记录继续作为兼容投影和 archive/fork 证明。
   - 为 public runtime event 增加真实 `track_id`，固定全局排序为 `time → phase → stable track → source sequence`。

2. **真实 ADD_TRACK 绑定**
   - HEDGE FULL ADD_TRACK 显式要求 `hedge_public_history_ref`。
   - 在 reserve 前验证 public archive、simulation symbol coverage 和逐轨 historical L2 ref；reserve 后原子写入逐轨初始 rule/mark/projection。
   - NONE/SUMMARY 不得承载可交易 HEDGE 双腿；升级到 FULL 时同样必须已有精确逐轨绑定，否则 fail closed。

3. **逐轨结算、风险与审计**
   - RULE/MARK/FUNDING 只作用于事件所属 track；fee policy 保持账户级并校验多 public archive 同步一致。
   - mark projection、funding 幂等键、fork/review、rehydrate、archive pin 和 auditor 覆盖所有逐轨输入。
   - 用真实 ADD_TRACK 构建至少两个不同 symbol 的双腿、规则、mark、funding 和强平顺序测试。

4. **Phase 9 benchmark 与 fault gates**
   - 新增 HEDGE 发布基准：1/2/4/8 FULL positioned tracks，分别运行 normal mark wave 与 liquidation wave。
   - 普通 wave 与强平 wave 单独报告 p50/p95/max；墙钟数值为必填观测，
     不参与发布 PASS/FAIL。
   - 不增加 skip flag，不减少 1/2/4/8 轨或正式样本；RSS、存储、队列、
     审计和确定性仍按资源/正确性门禁判定。
   - 覆盖 archive 篡改、SQLite busy/WAL、进程恢复、审计链断裂和 rollback。

5. **长稳与浏览器**
   - 扩展真实浏览器 soak，使正式模式明确创建默认 HEDGE Run、双腿持仓并观察 liquidation/audit 状态。
   - 正式执行不少于 4 小时、100 次生命周期、1,000,000 projection events。
   - 对 RSS、SQLite DB/WAL、archive cache、浏览器 heap/DOM/listener 采样，拒绝单调泄漏。

6. **完整验证与 release manifest**
   - 全量 backend replay、frontend replay、architecture、typecheck、lint、build、Ruff、compile、diff check。
   - 在最终 clean HEAD 上重跑 benchmark、soak、22 项矩阵、fault injection、auditor 与 rollback drill。
   - 生成外部 release manifest；manifest 中每项证据绑定同一 Git HEAD 和文件 SHA-256。

## 4. 不可放宽的停止条件

- 任一新增 symbol 缺 exact public archive、simulation coverage 或 historical L2：停止该 Run，不能复用主轨输入。
- 普通 wave 或 liquidation wave 数值必须原样报告；不得因较慢而删除样本，
  也不得因较快而把窄样本宣称为生产容量保证。
- 4 小时 soak 未达到真实时长/生命周期/事件数三项下限：不得用推算结果代替。
- 审计、恢复、rollback 或 clean HEAD 绑定失败：不得生成 PASS release manifest。

## 5. 完成定义

逐轨 HEDGE 输入语义正确，1/2/4/8 真实多标的双腿场景完成墙钟测量并通过正确性/资源门禁，4 小时 soak 与资源泄漏门禁通过，22 项最低验收矩阵与全量测试通过，并在 clean HEAD 上生成可独立验证的 release manifest 和 rollback 证据后，Phase 9 才可提交完成。
