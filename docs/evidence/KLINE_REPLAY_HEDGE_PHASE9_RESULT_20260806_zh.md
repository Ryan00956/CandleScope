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
- archive lifecycle 保持产品的两阶段合同：`POST /runs` 只创建 product-independent 空 Run，exact HEDGE public/simulation refs 仅在后续 `/markets` 选品请求绑定；禁止把选品 refs 反向塞回 setup。
- 结束训练不会擅自打开复盘 drawer；浏览器验收按真实产品交互，在确认 `ENDED` 后使用稳定的 `data-replay-action="toggle-integrity"` 打开“复盘与完整性”，再等待固化报告和导出按钮。验收脚本不再把隐藏 drawer 误报为报告持久化失败。
- 新增 22 项 HEDGE 最低验收矩阵及校验器；release manifest v3 纳入逐轨 HEDGE benchmark、浏览器 exact binding 和账户连续性。

### 2.4 盲测公开输入时间域

- 真实浏览器 HIDE_ALL smoke 发现 `/tracks` 曾把 HEDGE 内部真实时间、模拟时间和含真实时间的原始 projection state 同时公开；严格前端解析器因此正确 fail closed。
- 内部 `replay.hedge-input-view.v1` 保持不变，继续承载真实时间、原始 state、component hash 和 auditor/checkpoint 证明，避免破坏既有审计链。
- API 边界改为 `replay.hedge-input-view.v2`：一次响应只能是 `PUBLIC` 或 `ACTUAL` 单一时间域；HIDE_ALL 等未揭示模式只返回 synthetic timeline，NONE 或已揭示模式才返回 actual timeline。
- 公开 projection 删除 `as_of_actual_time_ms`、`as_of_virtual_time_ms` 和原始 `state`，仅返回 `as_of_time_ms`、`state_hash`、`input_chain_hash` 与 `source_component_hash`；auditor 原始 differences 同样改为计数和逐项哈希，防止错误详情夹带真实时间。
- 后端同时验证 dataset origin、HEDGE binding range 与 actor virtual timeline 的偏移一致性；任一混合时间域、越界时间或缺失元数据均以 storage degraded fail closed。

### 2.5 终态报告交接与 actor 回收

- 真实浏览器诊断在完成 HEDGE 动作周期和 archive lifecycle 后，发现 reaper 回收 `ENDED` actor 时会重复提交一份 `shutdown` checkpoint；大状态写入超过 5 秒后，已持久化的终态 actor 被错误改成 `ERROR`，报告页随即收到 `INVALID_STATE_TRANSITION`。
- `END_SESSION` 和数据耗尽的终态现在都在原命令/源事件原子提交中持久化 checkpoint，并把终态 checkpoint 记入 actor ring；只有提交成功后才对调用方确认 `ENDED`。
- 对已经 `ENDED` 的 actor，shutdown 明确是纯资源屏障：关闭投影批次和 actor task，但不再调用 flush、checkpoint 或 `shutdown` mutation 持久化钩子。活跃的 `PLAYING/PAUSED` actor 仍保持原有 shutdown pause 与持久化合同。
- actor 回归测试用会主动失败的 flush/checkpoint 钩子证明终态回收不触碰外部持久化；service 回归测试用会拒绝 `shutdown` mutation 的真实 SQLite service 证明容量回收、报告恢复和 5 秒 handoff grace 均正常，且 `reaper_failures=0`。
- WebSocket 建立后不再长期占用 service 的请求 lease，但 actor 的 subscriber token 本身就是活跃页面所有权。reaper 现在在候选筛选和最终 claim 两处都拒绝回收仍有 subscriber 的 actor；断线/关闭触发 unsubscribe 后，终态 actor 才重新满足容量与 TTL 回收条件，避免报告页在 HTTP + WebSocket 交接中反复 recovery/eviction。
- 完整性 drawer 的 1 秒终态报告轮询改为逐 Run single-flight：同一 Run 的慢请求共享同一 Promise，不再通过递增 generation 互相作废；不同 Run 仍可并行，旧 Run 响应继续受 generation 和 `run_id` 双重隔离。真实失败证据中后端连续返回 6 份一致的 `ended=true`、`account_audit=PASS` 报告，修复后前端不再因轮询频率高于五接口组合延迟而永久丢弃报告。
- HEDGE 独立输入审计的内部 `replay.hedge-input-audit.v1` 保留 actual/virtual 游标和完整重建 snapshot；公开 account-audit/report 只返回 `replay.hedge-input-audit-summary.v1` 的状态、proof、difference hashes 与 snapshot hash。前端严格要求 summary，明确拒绝夹带原始 snapshot 或 `as_of_actual_time_ms` 的响应。

## 3. 候选提交前验证

### 3.1 后端

- `PYTHONPATH=packages/candlescope-plugin-sdk/src python -m pytest -q backend/tests -k replay`：`916 passed, 2322 deselected`。
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

### 3.4 终态回收修复增量验证

- actor 定向 shutdown 合同：`3 passed`。
- service 终态回收/报告 handoff：`2 passed`。
- WebSocket stream 生命周期：`13 passed`。
- 完整 actor、service、stream 与全部 HEDGE 文件：`159 passed`。
- 前端 replay：`336 passed`；refresh gate 包含同 Run 合并、跨 Run 不阻塞和失败后可重试三类合同。
- Ruff：通过。

### 3.5 冻结性能门槛

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
