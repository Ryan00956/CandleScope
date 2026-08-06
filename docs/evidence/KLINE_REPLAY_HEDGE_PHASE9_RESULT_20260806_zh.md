# K 线回放交易所级双向持仓 Phase 9 结果

日期：2026-08-06  
分支：`codex/replay-hedge-exchange-parity`  
阶段基线：`056d9a2d feat(replay): harden hedge liquidation recovery`

## 1. 结论合同

Phase 9 的实现候选已经完成。公开交易所输入仍是 exact immutable archive：每个 FULL track 独立绑定规则、费率、mark/index、funding 和历史 L2；保险基金与 ADL 只使用 Phase 0 冻结的版本化确定性模拟 manifest，且明确标记为模拟，禁止运行时随机、无限余额或 proxy fallback。

本文件随候选实现提交。根据 release 工具的 clean-HEAD 约束，正式 benchmark、浏览器 smoke、4 小时 soak、回滚和 release manifest 必须在该提交之后写到仓库外的 `<evidence-root>/<git-head>/`；只要候选 HEAD 后续发生代码或文档修改，全部正式证据作废并在新 HEAD 重跑。

## 2. 已实现内容

### 2.1 逐轨公开输入

- schema 升至 v19，新增逐轨 public binding、projection 和 applied-event receipt。
- ADD_TRACK、FULL upgrade、fork、rehydrate 与 auditor 都验证 symbol、dataset epoch、checksum、event chain、历史 L2 和 simulation symbol coverage。
- rule、mark/index、funding 只作用于事件所属 track；Run 级 simulation manifest 保持账户唯一。
- HEDGE draft 可以在选品前为空，但正式创建必须同时解析 exact public ref 与 simulation manifest ref；缺任一项即 fail closed。

### 2.2 多轨账户和强平

- 使用真实 ADD_TRACK 创建 1/2/4/8 个不同 symbol 的 FULL track，并在每轨同时持有 LONG 与 SHORT。
- liquidation order、broker fill 和跨轨 evidence fill 使用不同稳定身份，消除多轨 ID 冲突。
- CROSS breach 计入所有非 reduce-only 活跃挂单的 reserved margin。
- HEDGE 的 market source STEP 不在每条轨道尚未对齐的中间态重复扫描强平；所有轨道与 public events 到达同一全局屏障后执行唯一权威强平扫描。用户 PLACE/CLOSE/CANCEL/保护命令仍即时刷新关系化持仓、保证金和风险投影。
- 高精度 Decimal partial close 会把最新 unrealized PnL 回写 broker position，避免循环小数导致恢复审计差异。

### 2.3 浏览器与发布合同

- 默认 Run 为 HEDGE、Binance futures、BOOK_ASSISTED_REQUIRED、HISTORICAL_EXACT funding 和 DETERMINISTIC_SIMULATION account。
- 浏览器 fixture 生成 BTC/ETH 30 天 1m BAR、逐标的 exact L2/public archives 和覆盖双标的的 simulation manifest，无 fallback。
- soak 在浏览器内开双腿并验证切商品、切 1m/5m、刷新、强制断线重连前后的 server-authoritative portfolio hash 不变。
- 键盘可访问性门禁通过真实 Tab + Space 激活 activity-bar；定位使用稳定的 `data-rail-view="replay-paper"`，不依赖已经不存在的可见文案。
- 浏览器动作周期按 `data-replay-action="place-order"` + `data-side="BUY|SELL"` 直接选择开多/开空 CTA，不再模拟已移除的 BUY/SELL 方向切换按钮。
- 新增 22 项 HEDGE 最低验收矩阵及校验器；release manifest v3 纳入逐轨 HEDGE benchmark、浏览器 exact binding 和账户连续性。

### 2.4 盲测公开输入时间域

- 真实浏览器 HIDE_ALL smoke 发现 `/tracks` 曾把 HEDGE 内部真实时间、模拟时间和含真实时间的原始 projection state 同时公开；严格前端解析器因此正确 fail closed。
- 内部 `replay.hedge-input-view.v1` 保持不变，继续承载真实时间、原始 state、component hash 和 auditor/checkpoint 证明，避免破坏既有审计链。
- API 边界改为 `replay.hedge-input-view.v2`：一次响应只能是 `PUBLIC` 或 `ACTUAL` 单一时间域；HIDE_ALL 等未揭示模式只返回 synthetic timeline，NONE 或已揭示模式才返回 actual timeline。
- 公开 projection 删除 `as_of_actual_time_ms`、`as_of_virtual_time_ms` 和原始 `state`，仅返回 `as_of_time_ms`、`state_hash`、`input_chain_hash` 与 `source_component_hash`；auditor 原始 differences 同样改为计数和逐项哈希，防止错误详情夹带真实时间。
- 后端同时验证 dataset origin、HEDGE binding range 与 actor virtual timeline 的偏移一致性；任一混合时间域、越界时间或缺失元数据均以 storage degraded fail closed。

## 3. 候选提交前验证

### 3.1 后端

- `python -m pytest -q backend/tests -k replay`：`911 passed, 2322 deselected`。
- Phase 5/6/8、真实多轨、Phase 9 和 benchmark 定向集均通过。
- `python -m ruff check <changed-python-files>`：通过。
- `python -m compileall -q backend/app/replay backend/scripts`：通过。

### 3.2 前端

- `npm --prefix frontend run check`：通过。
- Node：`2936 passed, 0 failed`。
- architecture、plugin architecture、typecheck、ESLint 和 production build：通过。
- build 仅保留既有 chunk-size warning，不构成失败。

### 3.3 盲测时间域修复增量验证

- 后端 HEDGE 全部阶段用例：`86 passed`。
- Phase 9 定向用例：`10 passed`，包含 HIDE_ALL/PUBLIC 与 NONE/ACTUAL 双矩阵，并验证公开 JSON 不包含内部真实时间字段或原始 state。
- 前端 replay 集：`334 passed, 0 failed`；新增 PUBLIC/ACTUAL 正例以及实际时间字段、原始 state、混合时间域反例。
- replay-soak 脚本回归集：`26 passed, 0 failed`，覆盖稳定 rail identity、CDP 超时、盲测泄漏、重连与正式 HEDGE plan。
- Ruff、TypeScript typecheck、ESLint 与 `git diff --check`：通过。

### 3.3 冻结性能门槛

真实 ReplayService + SQLite/WAL + Decimal + immutable archive + 双腿持仓：

| FULL tracks | normal p95/max | liquidation p50/p95/max | 结论 |
| ---: | ---: | ---: | --- |
| 1 | 94.922 / 94.922 ms | 179.206 / 195.243 / 195.243 ms | PASS |
| 2 | 128.566 / 128.566 ms | 295.880 / 317.585 / 317.585 ms | PASS |
| 4 | 196.887 / 196.887 ms | 489.987 / 536.743 / 536.743 ms | PASS |
| 8 | 357.662 / 357.662 ms | 927.611 / 1374.952 / 1374.952 ms | PASS |

冻结上限保持不变：normal p95 `500 ms`；liquidation p95 `2000 ms`、max `5000 ms`。

## 4. clean-HEAD 正式判定

候选提交后依次执行并绑定同一 HEAD：

1. 全量 backend/frontend release checks；
2. formal benchmark（含 1/2/4/8 HEDGE）；
3. 真实 BAR 与官方 AGG_TRADE source validation；
4. 真实浏览器短 smoke；
5. 不少于 4 小时、100 次 archive lifecycle、1,000,000 projection events 的正式 soak；
6. 完整构建 rollback drill；
7. 22 项 HEDGE matrix、默认启用静态审计和最终 release manifest。

只有外部 `release-manifest.json` 为 PASS 且工作树仍为同一 clean HEAD，Phase 9 才算完成。任何失败先修复并形成新候选提交，再从第 1 项重跑；不继承旧证据。
