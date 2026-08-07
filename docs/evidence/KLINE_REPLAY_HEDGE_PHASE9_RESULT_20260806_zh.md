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
- 报告 JSON 导出断言复用当前 `REPLAY_TRAINING_PROTOCOL="replay.v3"`，不再把已经退役的 wire protocol `replay.v2` 当成期望值；`replay.v2` 仅保留为产品/发布代际名称。
- 新增 22 项 HEDGE 最低验收矩阵及校验器；release manifest v3 纳入逐轨 HEDGE benchmark、浏览器 exact binding 和账户连续性。

### 2.4 完整构建回滚演练修复

- 回滚工具只给当前 backend 注入仓库内 bundled plugin SDK；历史基线的 `PYTHONPATH` 严格限制在 detached worktree，禁止借用当前 SDK 或当前 `app` 包。
- 当前 enabled 段使用默认 HEDGE、exact public/L2 archive 和单一 deterministic private simulation；disabled 段不构造 replay service、不打开 replay persistence；历史基线段不加载任何 replay-only source。
- 回滚流程跟随当前两阶段产品合同：先创建空 Run，再在 Run 内选品并绑定 exact refs；URL 使用 `?run=`，持久化身份使用 Run 的 `adapter_session_id`，训练 archive wire protocol 使用 `replay.v3`。
- 紧急停机后，正常构建的入口保持可见但不可点击，并显示后端 capability 不可用；Run API 以 `replay.v3` / `REPLAY_TRAINING_UNAVAILABLE` 失败，浏览器显示“无法打开回放”、零 canvas 且不新建 replay WebSocket。该运维停止态不是灰度发布，也不改变正常默认启用合同。
- cross-root 历史基线使用当前 QA 启动壳灌入最近已闭合的 live K 线，但显式跳过 replay archive seed；若误带 aggTrade、历史盘口或 HEDGE source 参数则直接拒绝，保证前回放基线不导入当前 `app.replay`。
- 候选诊断在 `249478decc2d0fc4b6e28e491a7aeca543ec6735` 完整通过：enabled Run 以 `shutdown_pause` 持久化，disabled restart 与旧构建都未改变 replay.db 字节摘要或 Phase 18 存储语义，旧 backend replay capability route 为 404。由于本结果文档提交会产生新 HEAD，该诊断不作为最终 release manifest 输入，正式 rollback 必须在最终 clean HEAD 重跑。

### 2.5 盲测公开输入时间域

- 真实浏览器 HIDE_ALL smoke 发现 `/tracks` 曾把 HEDGE 内部真实时间、模拟时间和含真实时间的原始 projection state 同时公开；严格前端解析器因此正确 fail closed。
- 内部 `replay.hedge-input-view.v1` 保持不变，继续承载真实时间、原始 state、component hash 和 auditor/checkpoint 证明，避免破坏既有审计链。
- API 边界改为 `replay.hedge-input-view.v2`：一次响应只能是 `PUBLIC` 或 `ACTUAL` 单一时间域；HIDE_ALL 等未揭示模式只返回 synthetic timeline，NONE 或已揭示模式才返回 actual timeline。
- 公开 projection 删除 `as_of_actual_time_ms`、`as_of_virtual_time_ms` 和原始 `state`，仅返回 `as_of_time_ms`、`state_hash`、`input_chain_hash` 与 `source_component_hash`；auditor 原始 differences 同样改为计数和逐项哈希，防止错误详情夹带真实时间。
- 后端同时验证 dataset origin、HEDGE binding range 与 actor virtual timeline 的偏移一致性；任一混合时间域、越界时间或缺失元数据均以 storage degraded fail closed。

### 2.6 终态报告交接与 actor 回收

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

### 3.6 回滚修复增量验证

- replay rollback/soak Node 定向集：`33 passed, 0 failed`。
- Run-centric replay API 契约与 smoke fixture 定向集：`42 passed`。
- ESLint 与 `git diff --check`：通过。
- 完整构建候选诊断：通过；历史基线 `c9a1ddbfe316c68c91787b69c783baeeb0670a9f` 的 replay route 为 404，live K 线与设置保持健康，replay.db SHA-256 为 `20b7631626b10c259de44e788a064ce532078a23b6db296b5ccf20a97faff5b7` 且三阶段一致。

### 3.7 clean-HEAD 首轮全量失败处置

- `0208a7463bb57d2b00a91a7ff867c1ccb62aafe4` 首轮 backend 全量结果为 `3240 passed, 2 failed`，发布脚本按合同停止，未继续前端，也未生成 PASS artifact。
- 确定性失败来自 Phase 10 静态门禁仍搜索已退役的 `queryReplayV2Archive`；现已改为搜索 `queryReplayTrainingArchive` 和 `REPLAY_TRAINING_PROTOCOL = "replay.v3"`，使产品代际与训练 wire 协议不再混淆。
- Windows sandbox CPU quota 用例成功终止目标进程，但在受载全量中记录 `8171 ms`，超过冻结的 `8000 ms` 上限 `171 ms`。空闲串行重跑三次均通过（约 `7.78 / 6.40 / 6.65 s`），因此不放宽安全时限；最终全量仍须在新 clean HEAD 重跑并自然通过。
- 由于本修复和记录都会生成新 HEAD，`0208a746` 的真实来源 PASS 也只保留为失败轮诊断，不进入最终 manifest。

### 3.8 formal benchmark 首轮失败处置

- `d1e8d60c6ecf49adb41af094d24dcba25d87df07` 的真实来源校验、全量 release checks（backend `3242 passed`、frontend Node `2950 passed` 及 architecture/typecheck/lint/build）、完整构建 rollback 和真实浏览器短 smoke 均通过；formal benchmark 依次完成 core、multi-track、segments、fast-forward 与 historical-book 后，在 account-history 组件 fail closed，未进入 HEDGE 组件，也未生成顶层 `benchmark.json` 或 manifest。
- 第一处确定性错误是账户历史与 period-summary 基准仍发送已退役的训练 wire `replay.v2`。两个脚本现统一复用 `REPLAY_V2_PROTOCOL`，实际值为 `replay.v3`；旧账户历史容量负载明确声明 `position_mode=ONE_WAY`，继续只验证私有账户历史归档能力，不把它伪装成 HEDGE。HEDGE 仍由独立 `hedge-exchange-parity-v3` 基准按默认 `DETERMINISTIC_SIMULATION`、exact public inputs 和双腿强平合同验证。
- 第二处是账户归档夹具仅提交事务但未真正关闭源 SQLite connection，导致 Windows 临时目录回收报共享冲突。夹具改为 transaction context 与 `closing()` 双层生命周期，并用创建后立即 `unlink()` 的 Windows 回归用例锁定。
- 协议修复后，新的 BAR 不可变分页合同继续拒绝无 source revision 的旧内存仓库。容量基准现使用 `ImmutableReplayHistoryFake` 生成内容哈希修订并绑定 selection，不跳过 dataset commitment。
- 资金费实际已经写入 `replay_training_funding_settlement` 与权威合约账本，但展示投影自当前 schema 起有意返回空的 `portfolio.ledger.entries`，旧基准因此误报未结算。验收改为同时检查权威 `portfolio.funding_cashflow` 非零和持久化 settlement 行数不少于 track 数；未删除资金费门禁。
- 修复后定向集 `15 passed`，Ruff 通过；基线一致的 Python `3.13.9`、1/2/4/8 FULL、每轨持仓、20 次迭代实跑全部 PASS。8 轨 normal p95 `191.464 ms`，低于冻结 `500 ms` 上限；所有 case 的 auditor、账本对账、资金费累计、持久化结算、SQLite quick/foreign-key checks 均通过。
- 本节提交会再次生成新 HEAD，因此 `d1e8d60c` 的全部 PASS/FAIL artifacts 只作为诊断记录，不能进入最终 manifest；新 HEAD 仍须从真实来源、全量 checks、rollback、smoke、formal benchmark 到 4 小时 soak 全部重跑。

### 3.9 formal benchmark 第二轮 Windows 清理失败处置

- `def46cf105047daf47c5e4001adca4e1ec8d49fd` 的真实来源、全量 checks（backend `3246 passed`、frontend Node `2950 tests`）、完整构建 rollback 与浏览器短 smoke 均通过。formal benchmark 的 core、multi-track、segments、fast-forward 和 historical-book 也先后通过；其中 BAR `5617.42 events/s`、AGG_TRADE `946.12 events/s`，fast-forward 优化路径 `279.591 s`、完整参考路径 `7043.801 s` 且状态完全等价。随后 account-history 的全部 case 已执行完，但 Windows 删除最后一个 `positioned-8.db` 时返回 `WinError 32`，编排器正确停止且未生成顶层 benchmark PASS。
- 第一轮已修复归档源 connection，但容量脚本自身的诊断查询仍使用 `with sqlite3.connect(database)`。Python SQLite connection context 只负责 commit/rollback，不负责关闭连接；删除之前手工 `connection.close()` 后，文件句柄在 `TemporaryDirectory` 退出时仍存活。
- 诊断 connection 现同样使用 `closing(sqlite3.connect(...))` 与 transaction context 双层生命周期。新增端到端回归用例实际运行 1/2/4/8 四个 case，并要求返回后临时根目录为空，不再只验证单个归档源文件可删除。
- Python `3.13.9` 正式参数复验（1/2/4/8 FULL、20 次迭代）全部 PASS，8 轨 p95 `171.033 ms`，低于冻结 `500 ms`；所有语义、资金费、审计、SQLite 检查通过，命令退出 `0` 且临时根目录 `remaining=0`。
- 本修复与记录再次产生新 HEAD，因此 `def46cf1` 的上述 PASS 和长耗时组件均只作诊断，不继承到最终 manifest；正式证据必须从头完整重跑。

### 3.10 4 小时 soak 首轮 actor ERROR 处置

- `1e07d801d7bc5f67ca33ec13ef9616ea3cb32ea5` 的真实来源、formal benchmark、全量 release checks、完整构建 rollback 与真实浏览器短 smoke 均通过；正式 4 小时 soak 未使用 `--allow-short`，完成 1,000,000 projection events 后在约 5 分钟、第 327 个源事件进入 `ERROR`，编排器正确终止且未生成 soak PASS 或 release manifest。
- 失败 artifact 已保留，但当时的 `phaseDiagnostics` 为 `null`。根因是 actor 启动后捕获 `BaseException` 时只切换 `ERROR` 并结束 task，未把异常类型和消息写入 diagnostics；soak 主采样断言也未在失败前抓取对应 session actor，导致 backend tail 被无关的离线 live websocket 重试噪声淹没。
- actor diagnostics 现累计 `runtime_failures` 并保留最后一次运行时异常的类型与截断消息；取消任务仍沿用独立取消路径，不伪计为业务运行错误。soak 在连接或状态断言失败前抓取对应 actor 与后端健康门禁，写入失败 artifact 的 `phaseDiagnostics`。
- 本提交只增强 fail-closed 证据，不把 `ERROR` 降级为通过，也不改变执行、HEDGE、强平或默认启用合同。提交后先以 clean HEAD 短时运行越过第 327 个源事件定位根因；完成根因修复后，所有正式证据仍须从最终 clean HEAD 重新生成。

### 3.11 Review artifact 二次增长根因与修复

- `7b859bcfd7286ed9f37048b1eef3b8b95f13bd5d` 的 clean-HEAD 8 分钟诊断跑完成 10,000 projection events，并在第 4 个训练动作周期稳定复现。失败时页面 source sequence 为 `316`、revision 为 `324`，全局时钟原因明确为 `REVIEW_ARTIFACT_BUDGET_EXCEEDED`；对应后端 actor 仍为健康 `PAUSED`、`task_done=false`、`runtime_failures=0`，纠正了首轮只能看到页面 `ERROR` 时对 actor 崩溃的假设。
- 当时 Review 已保存 395 个关键事件，artifact 为 `134,048,934 / 134,217,728 B`，contract ledger 为 833 条。Phase 4 要求的 HEDGE position/accounting/margin 每次权威变化会写零现金 hash-chained mutation receipt；旧 Review 一方面把任何 `ledger_count` 增长都当成新的关键事件，另一方面在每个事件的 `projection_json` 中再次复制从 T0 开始的完整 ledger prefix，最终形成事件泛滥和近似二次存储增长。
- 修复没有删除或合并 Phase 4 ledger，也没有提高 128 MiB artifact 或 8,192 critical-event 上限。持久化 Review frame 改为保存由 schema、精确 count 和 ledger tail hash 约束的不可变 ledger-prefix reference；Review、控制跳转、checkpoint 与 Fork 读取时从同一 append-only contract ledger 精确水化完整前缀，并使用水化后的原始 logical projection hash 重算 timeline event hash。reference/count/tail/prefix 或 event chain 任一篡改均以 `REVIEW_PROJECTION_CORRUPT` / `REVIEW_TIMELINE_CORRUPT` fail closed。
- `POSITION_MUTATION`、`POSITION_ACCOUNTING_MUTATION`、`MARGIN_MUTATION` 继续逐条进入同一 hash chain 和 auditor，但不再单独触发 Review 关键帧；真实现金 posting、fill、funding、liquidation、order/rule/view/drawing/marker、结构性持仓变化和最大回撤仍按原合同保留。HEDGE position identity 现分别计算 LONG/SHORT 的 quantity、entry 与 realized 状态，排除 mark-only 字段，避免旧 one-way descriptor 对嵌套双腿返回空对象。
- Phase 17 Review/Fork 与 Phase 4 HEDGE 会计扩大定向集为 `16 passed`；新增回归证明 compact row 可精确还原完整 ledger、选中 Review frame 可 Fork 且 child auditor PASS、零现金审计 receipt 不制造关键事件、双腿结构变化仍制造 `POSITION_STATE`，以及 ledger-prefix tamper 明确拒绝。该修复提交后仍须先越过原 8 分钟窗口，再从最终 clean HEAD 重跑全部正式证据。
- Phase 17/18、HEDGE Phase 0–9 与 22 项矩阵扩大集为 `109 passed`。首轮完整 replay 回归暴露内部 descriptor domain 与完整 projection domain 缺少同构字段，修正后相关集合 `17 passed`；内部 `critical_ledger_count` 在公开投影边界移除，未扩张前端协议。随后一次全量中的单样本 8 轨 normal wave 约 `512.964 ms`，超过冻结 `500 ms`，但相同正式脚本独立全项 PASS、同一单测连续 `12/12` PASS，未放宽阈值或 acceptance；最终原样完整 replay 回归为 `927 passed, 2323 deselected`。

## 4. clean-HEAD 正式判定

候选提交后依次执行并绑定同一 HEAD：

1. 全量 backend/frontend release checks；
2. formal benchmark（含 1/2/4/8 HEDGE）；
3. 真实 BAR 与官方 AGG_TRADE source validation；
4. 真实浏览器短 smoke；
5. 不少于 4 小时、100 次 archive lifecycle、1,000,000 projection events 的正式 soak；
6. 完整构建 rollback drill；
7. 22 项 HEDGE matrix、默认启用静态审计和最终 release manifest。

只有外部 `release-manifest.json` 为 PASS 且工作树仍为同一 clean HEAD，Phase 9 才算完成。任何失败先修复并形成新候选提交，再从第 1 项重跑；不继承旧证据。本文件不回填会改变 HEAD 的易变运行数值；最终测试计数、来源摘要、性能分布、4 小时遥测和回滚 acceptance map 以该 HEAD 外部 manifest 及其绑定 artifacts 为唯一权威记录。
