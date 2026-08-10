# K 线回放交易所级双向持仓 Phase 9 结果

日期：2026-08-06  
分支：`codex/replay-hedge-exchange-parity`  
阶段基线：`056d9a2d feat(replay): harden hedge liquidation recovery`

## 1. 结论合同

Phase 9 的实现候选已经完成。公开交易所输入仍是 exact immutable archive：每个 FULL track 独立绑定规则、费率、mark/index、funding 和历史 L2；保险基金与 ADL 只使用 Phase 0 冻结的版本化确定性模拟 manifest，且明确标记为模拟，禁止运行时随机、无限余额或 proxy fallback。

本文件随候选实现提交。2026-08-10 的 owner 决策将阻塞式浏览器门禁改为不少于 60 分钟、100 次 lifecycle、1,000,000 projection events 的高密度稳定性运行；4 小时仅保留为非阻塞观察。checks、smoke 和稳定性证据仍必须绑定当前 clean HEAD；benchmark、真实来源和 rollback 只有在旧证据 HEAD 是当前 HEAD 的祖先、且 verifier 声明的阶段运行时输入零 diff 时才允许复用，复用来源和 diff 必须写入最终 manifest。

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

### 3.12 适配器恢复后的资金费审计时间域误序与修复

- `a4c67bc1888b44271eb8309960562b3fac46e734` 的 clean-HEAD 8 分钟诊断证明 3.11 的 Review 修复有效：第 4 个动作周期、source sequence `319` 时仅保存 98 个关键事件，anchor 为 `813,280 B`、总 artifact 为 `1,213,149 / 134,217,728 B`，actor 为健康 `PAUSED`、`task_done=false`、`runtime_failures=0`，SQLite transaction failures 为 0。该轮仍在第 4 次适配器驱逐后超时，但已不是存储预算或 actor 崩溃。
- 恢复前同一 Run 的 account auditor 为 `PASS`；驱逐后重建触发完整审计，空头资金费记录的结算前数量被误算为 `-0.003`，持久化权威值为 `-0.002`，服务端据此正确进入 `ACCOUNT_AUDIT_FAILED` / `FAILED_CLOSED`。历史盘口随后已恢复为 `AVAILABLE_EXACT / READY`，所以此前看到的 `HISTORICAL_BOOK_CAPABILITY_UNAVAILABLE` 只是恢复窗口内的前置 fail-closed 响应，不是最终根因。
- 根因是账户审计把两种不可直接比较的时钟混排：broker fill 的 `event_time_ms` 属于 Run 虚拟/公开时间，而 pinned funding 的 `actual_settlement_time_ms` 属于真实来源时间。`HIDE_ALL` Run 从较大归档中间启动时，后发生的虚拟成交数值可以小于先发生的实际资金费时间；第 5 笔后置成交因此被错误算入结算前仓位。修复后，普通 Run 统一按 append-only contract ledger sequence 重建成交与资金费先后关系，不再用实际时间和虚拟时间比较因果。
- Review Fork 会为子 Run 重新生成物理 ledger sequence，不能直接继承父 Run 的数字。Fork 现在把每笔成交费、资金费等复制 posting 的父 Run id 与父 ledger sequence 写进子账本的 hash-chained metadata；子审计验证父 posting 的 kind、reference type/id 与序号一致，再用该不可变父序号重建因果。父 posting 缺失或映射漂移会明确审计失败，不使用时间排序或近似兜底。
- 服务端合法的组合终态本来就包含 `portfolio.status=FAILED_CLOSED`，前端旧 parser 却只允许 `ACTIVE / LIQUIDATING / BANKRUPT`，使真实 fail-closed 被二次显示为 `replay.v3 response violates the contract`。严格类型和 parser 现显式接收 `FAILED_CLOSED`，仍拒绝任何未知状态；失败现场保存的 13 个 `/tracks` 响应已全部离线通过当前 parser，最终业务状态保持 `FAILED_CLOSED`，不会被吞成协议错误。
- 新增 HIDE_ALL 回归实际构造“后置 fill 的虚拟时间小于 funding 实际时间、但 ledger sequence 更大”的条件，并覆盖独立审计、服务重启和 Review Fork 子审计。定向结果为后端 `8 passed`、扩大恢复/Review/benchmark 集 `39 passed`、前端 replay `336 passed`、Ruff、TypeScript typecheck 与 `git diff --check` 全部通过。首次完整 replay 回归诚实暴露两个强平 Fork 子审计失败，补齐父因果序后最终完整回归为 `928 passed, 2323 deselected`；未删除审计、未改阈值、未启用降级。
- 本修复与本节记录产生新的候选 HEAD；`a4c67bc` 的诊断 artifacts 仅用于根因证据，不能进入最终 manifest。新 HEAD 必须先重新通过同参数 8 分钟恢复复测，再从头生成全部正式证据。

### 3.13 适配器恢复 8 分钟预检通过

- `f499fb54f039d53298aff0801a4397e75f54c088` 在 clean HEAD 上以 `--allow-short --duration-ms 480000 --cycles 4 --projection-events 10000 --sample-ms 60000` 完成恢复预检，运行 `480089 ms`，4/4 训练动作、4/4 archive lifecycle 和 10,000 projection events 全部完成；浏览器 source sequence 推进到 `415`，越过此前稳定失败的 `316 / 319 / 327`。
- 第 4 次适配器驱逐、重建和重连全部完成，最终仍同时持有 LONG/SHORT 两腿；账户连续性、blind-boundary、replay/backend/live 隔离、archive exact、heap/DOM/listener 等短时验收均通过。projection 吞吐为 `62111.801 events/s`，primary/late heap 增长为 `9,449,400 / 5,666,612 B`，report hash 为 `sha256:fc5bfa0118843c7c684f47c3f5685dd75f09e9a1c94fc9454d9ec86dd6d17ef0`。
- 该 artifact 位于仓库外，仅证明 3.11 与 3.12 的根因修复已跨过复现窗口。因为使用了 `--allow-short`，`hedge_exact_training_bound` 不构成正式 release acceptance；它不能替代 4 小时、100 次 lifecycle 和 1,000,000 projection events 的正式 soak，也不能进入最终 PASS manifest。
- 本节记录会形成新的候选 HEAD；正式数据源、checks、benchmark、smoke、4 小时 soak、rollback 与 manifest 必须全部在该新 clean HEAD 上从头生成。

### 3.14 正式 soak acceptance 严格布尔合同修复

- `157f95832ce3e8a22f539ce0afef2c598420e8b3` 的真实来源、全量 release checks（后端 `3251 passed`、前端 Node `2951 passed`）、formal benchmark、真实浏览器短 smoke 与完整构建 rollback 均通过。formal benchmark 的 8 轨 normal p95 为 `209.726 ms`，8 轨 liquidation p95/max 为 `639.483 ms`，冻结阈值未调整；这些结果只作为本轮发布工具诊断，不继承到下一 HEAD。
- 启动 4 小时 soak 前的严格类型审计发现，`hedge_exact_training_bound` 的 JavaScript `&&` 表达式在全部条件成立时返回最后一个 `simulationRef` 对象，而不是 boolean `true`。soak 自身使用 truthy 汇总，因而错误地生成顶层 `passed=true`；最终 Python verifier 使用 `value is True`，会正确拒绝该 artifact。旧 smoke 也存在同一问题，只是此前 4 小时失败使 manifest 从未走到该检查。
- exact-binding 判断现抽成可单测的 `isExactHedgeTrainingBound`，在不减少 public refs、simulation ref、fidelity、fallback、rows 或 cache 条件的前提下，对完整表达式显式布尔化。成功只能序列化为 JSON `true`，任一 required ref 缺失只能返回 `false`。
- 定向 soak 测试 `31 passed`；全部 replay Node scripts `41 passed`；Phase 10/18 Python release-script 集 `20 passed`；双 tsconfig typecheck、全量 ESLint 和 `git diff --check` 均通过。修复提交后先以 real-source 短 smoke 证明 artifact 每项严格等于 `true`，随后全部正式证据从新 clean HEAD 重跑。

### 3.15 长时 MarketTrack 轮询饥饿根因与修复

- `b9f0b73b1af7a8966438f6aa0afb3821b0accec3` 的真实来源、全量 release checks（后端 `3251 passed`、前端 Node `2952 passed`）、formal benchmark、真实浏览器短 smoke 与完整构建 rollback 均通过。formal benchmark 的 8 轨 normal p95 为 `288.649 ms`，8 轨 liquidation p95/max 为 `845.090 ms`，13 项检查全部为真；smoke 的 30 项 acceptance 均为严格 JSON boolean `true`。这些 PASS 只属于该 HEAD，不能继承到修复后的候选提交。
- 正式 soak 未使用 `--allow-short`，先以 `100266.71 events/s` 完成 1,000,000 projection events，随后在 `elapsedFromStartMs=7626443`（约 127.1 分钟）、第 40 个训练动作周期因 `Timed out waiting for training pause ack` fail closed。页面仍为 `PLAYING`、generation `80`、source sequence `1154`、revision `1234`，暂停按钮可用且无 command/console/page error；对应 actor 已为健康 `PAUSED`、revision `1234`、queue `0`、`runtime_failures=0`，SQLite `transaction_failures=0`。失败现场保存的 `/tracks` 200 响应也明确返回 `global_clock.state=PAUSED`、`reason=USER_PAUSE`、generation `80`、profile revision `158`。因此暂停命令和服务端状态机均已成功，失败边界是浏览器没有发布权威响应。
- 根因位于 MarketTrack 状态刷新：播放期间每 `250 ms` 无条件发起一次 `/tracks`，每个新请求都会使此前请求失去“最新请求”资格。随着 40 笔订单、40 笔成交和 3,884 条账本证据令响应解析耗时超过轮询周期，后续请求会在前一响应完成前持续启动，使所有已完成响应均被判为过期；暂停命令后的权威 refresh 也会被下一个后台 poll 抢占，形成确定性请求饥饿，而不是 HEDGE、强平、actor 或持久化故障。
- 修复引入 MarketTrack 请求门和统一执行器：后台 poll 只在无在途请求时启动；命令后的 authoritative refresh 可抢占并取消旧 poll；旧 transport 即使在取消后仍返回，也既不能发布旧 `PLAYING` 投影，也不能清除新命令请求的所有权；命令请求在途期间所有后台 poll 都直接跳过。权威 `PAUSED` 响应发布后，现有 React 状态自然停止轮询。`250 ms` 周期、控制确认超时、soak 时长、100 次 lifecycle、1,000,000 events 和全部 HEDGE acceptance 均未放宽，也没有灰度或降级分支。
- 新增可控 Promise 竞态回归，覆盖 poll 单飞、authoritative 抢占、取消后旧响应晚返回、旧请求 finish 不清除新请求、命令响应唯一发布和释放后恢复轮询。定向 workspace `23 passed`，完整 frontend replay `337 passed`，soak harness `31 passed`；双 tsconfig typecheck、定向 ESLint 与 `git diff --check` 全部通过。提交后先以高密度 40-cycle clean-HEAD 预检越过原增长边界，再从真实来源、全量 checks、benchmark、smoke、rollback、真实 4 小时 soak 到 manifest 全部重跑。

### 3.16 正式 4 小时堆门禁失败与证据补全

- `99afdda88ad4969416670b1265e5e57d898021e0` 先后通过真实来源、全量 release checks（后端 `3251 passed`、前端 Node `2953 passed`）、formal benchmark、真实浏览器短 smoke 和完整构建 rollback。formal benchmark 的 8 轨 normal p95 为 `399.743 ms`，8 轨 liquidation p95/max 为 `1298.559 ms`，13 项检查全部为真；smoke 的 30 项及 rollback 的 17 项 acceptance 均为严格布尔真。
- 正式 soak 未使用 `--allow-short`，运行 `14,599 s`，完成 1,000,000 projection events、100/100 训练动作、100/100 archive lifecycle、100/100 订单与成交、100/100 adapter recovery 和 reconnect。两小时、三小时以及第 100 轮均越过此前暂停响应饥饿边界；actor、持久化、恢复、shutdown、blind boundary、live 隔离、DOM、target 与 subscriber 门禁全部通过。
- 最终 30 项门禁只有 `primary_retained_heap_bounded` 和 `primary_late_heap_bounded` 为假；冻结上限仍为 `64 MiB / 32 MiB`，未放宽。该正式轮因此是 FAIL，未生成 soak PASS 或 release manifest。
- 旧失败结构只保存 acceptance map，却丢失验收前已经组装好的 `result`，导致失败 artifact 没有初始、半程与终态堆样本，无法判断固定预热成本和持续增长斜率。失败证据现额外保存 `partialResult`；它不改变采样、GC、阈值或 acceptance，只保证最终门禁拒绝时仍留下完整样本曲线。新增单测证明 acceptance failure 会保留堆摘要和 samples；soak harness `32 passed`、双 tsconfig typecheck 与 `git diff --check` 通过。
- 本证据增强提交后将以 clean HEAD 运行压缩复现，先读取真实初始/半程/终态曲线，再修复页面实际保留根因。完成根因修复后，真实来源、checks、benchmark、smoke、rollback 和正式 4 小时 soak 仍必须在最终新 HEAD 全部从头重跑；本节列出的 `99afdda8` PASS artifacts 不能继承。

### 3.17 CDP Network 保留根因与产品堆门禁隔离

- `327865ad5839687e22dcf15b5a484faec4cbf8e7` 的 clean-HEAD 高密度诊断完成 40/40 训练动作、40/40 archive lifecycle、40/40 lifecycle reload、40/40 订单成交和 40/40 adapter recovery/reconnect，运行 `2,610,123 ms`。30 项 acceptance 中 29 项为真，唯一失败仍是冻结 `32 MiB` 上限的 `primary_late_heap_bounded`；`primary_retained_heap_bounded` 在原 `64 MiB` 上限内，没有产品功能、actor、SQLite、恢复、盲审或隔离失败。
- 失败 artifact 的完整曲线显示：主页面 forced-GC `usedSize` 从 `10,195,924 B` 增至 `64,058,488 B`，原始增长 `53,862,564 B`；embedder heap 从 `4,513,136 B` 增至 `27,249,000 B`，但 backing storage 只从 `2,067,461 B` 增至 `2,232,686 B`，DOM element 始终为 `558`。压缩循环连续占满计划时段，只形成初始/终态两个常规 sample，因此旧 late 选择回落到初始 sample，严格拒绝该 run。
- 对同一个主 Run 的精确 CDP 堆快照进一步定位到调试器：约第 9 轮 `usedSize=21,211,432 B`、`blink::NetworkResourcesData::ResourceData=4,410`；第 20 轮增至 `35,181,940 B / 9,269`。页面 Resource Timing 始终被浏览器限制在 `250`，存活 WebSocket 为 `1`，DOM 不增长；相反 Performance `Nodes` 从 `1,641` 增至 `45,079`，与 Network inspector request metadata 同步。Chromium 的 [`NetworkResourcesData`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/inspector/network_resources_data.cc) 会为每个被调试请求创建 `ResourceData`，而 [`InspectorNetworkAgent::disable`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/inspector/inspector_network_agent.cc) 明确调用 `resources_data_->Clear()`；CDP [`Network.enable`](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-enable) 的 content buffer 上限不限制 request metadata 数量。故这条线性曲线属于 soak 自身持续 43 分钟启用 Network domain 的观测开销，不是产品 controller、WebSocket、响应集合或 DOM 泄漏。
- 修复没有从采样中删数据，也没有放宽 `64 MiB / 32 MiB`：持续 Network inspector 的原始 samples 仍完整保存为 `inspectorObservedHeap`，只用于诊断和盲审；产品泄漏门禁改用三处显式 `Network.disable -> resources clear -> forced GC` 检查点。初始值在 blind runtime 开始前取自主页面，终值在 blind runtime、结束报告和导出全部完成后取自主页面；半程值取最接近 `duration/2` 的全新 lifecycle reload 页面并在关闭前清空 inspector。半程页面没有继承主页面前半程的任何潜在产品泄漏，因此 `final primary - fresh half` 是比同页 late delta 更保守的上界，不会把真实泄漏洗掉；盲审从初始恢复 Network 后开始，到最终停用 Network 前结束，不产生审计空窗。
- soak 结果顶层 `passed` 现在与 acceptance 的严格布尔汇总一致，失败 partial result 不再出现 `passed=true` 的矛盾状态；非 replay 请求的 boundary-generation bookkeeping 也在 loading finish 时释放。定向 harness 新增 Network 暂停/恢复、最终保持禁用、半程选择/增长计算三组回归，`35 passed`；正式 `tsx` frontend 全量测试 `2957 passed`，双 tsconfig typecheck、定向 ESLint 与 `git diff --check` 通过。修复提交后的 clean HEAD 仍须先通过 40-cycle 压缩复验，再从真实来源、全量 checks、formal benchmark、真实浏览器 smoke、rollback、正式 4 小时 soak 到 release manifest 全部重跑；任何 `327865ad` artifact 都不能进入最终 manifest。

### 3.18 计划重载取消完整性查询的代理 500

- `a54b83d7210272a19f594cd445c04d1fd1d99d40` 的高密度复验完成 40/40 训练动作、archive lifecycle、lifecycle reload、订单成交与适配器恢复/重连，但最终主页面网络门禁发现同一 Run 的 `equity`、`rules`、`integrity` 三个 500，因此正确写入失败 artifact，未把功能轮次完成误报为 PASS。Vite 在同一时刻记录这三个 URL 的 `socket hang up`；服务随后继续完成剩余轮次，每轮 backend health 均通过，未出现 actor、SQLite 或进程退出故障。
- 三个端点与 `current-drawing`、终态 `report` 同属 `useReplayIntegrityRuntime.refresh()` 的单个 `Promise.all`。产品/周期切换会安排一次 50 ms 延迟刷新，HEDGE 浏览器连续性测试旧流程在验证服务器账户摘要后立即执行 `Page.reload`；如果本批刷新尚未结束，旧 document 被导航撤销，开发代理会把仍在途的 upstream 请求记录为 500。失败三项正是当时尚未结束的批内请求，属于测试计划重载与自身请求并发，而不是允许忽略的 API 业务错误。
- 状态栏现公开只读 `data-replay-integrity-operation`；主页面连续性重载与每个临时 lifecycle 页面都先等待 50 ms 调度窗口过去，并要求完整性 operation 空闲、时间披露策略和结果标签已经由整批响应填充，再触发计划重载。临时 lifecycle capture 同时新增 replay API `>=400` 硬断言；主页面最终 500 门禁保持原样，没有添加状态码白名单、取消时间窗豁免或代理特判。
- 增量验证为 soak harness `35 passed`、frontend 全量 `2957 passed`、双 tsconfig typecheck、定向 ESLint 与 `git diff --check` 通过。修复提交后必须从 clean HEAD 重新运行真实浏览器短测和 40-cycle 压缩门禁；只有两级 API 失败断言、原 `64 MiB / 32 MiB` 产品堆阈值以及其余 acceptance 全部通过，才进入正式 4 小时证据链。

### 3.19 Inspector 隔离后的剩余主页面留存

- `390cb2973a8e2c277d8d65999a63b5b7ae200fdd` 的 clean-HEAD 高密度复验完成 40/40 训练动作、archive lifecycle、lifecycle reload、订单成交与适配器恢复/重连；40 个临时页的 replay API failure 均为 0，主页面也没有 4xx/5xx。30 项 acceptance 中 29 项为真，唯一失败为冻结 `32 MiB` 的 `primary_late_heap_bounded`，证明 3.18 的代理 500 已修复，但 release 仍保持拒绝。
- Network inspector 暂停后的清洁主页面从 `7,923,872 B` 增至 `66,548,564 B`，primary/late 增长分别为 `58,624,692 / 62,484,984 B`；连续 inspector 的终态为 `66,282,740 B`，与清洁终态同量级。因此 3.17 的 `NetworkResourcesData` 只能解释 heap snapshot 中的一类伴随保留，不能作为全部 `Runtime.getHeapUsage` 增长的最终根因。`Performance.Nodes` 从 `1,393` 增至 `45,505`、listener 从 `449` 增至 `3,952`，而可见 DOM 终态只有 `736` elements，仍存在需要对象持有链确认的长生命周期页面留存。
- 40 个 fresh lifecycle 页在 forced GC 后均稳定于约 `4–8 MiB`，没有随轮次增长；这排除了 archive 数据量或单次页面固有体积，但 fresh 页与经历 40 次恢复的主页面不是同一生命周期，不能拿较小 fresh heap 直接把主页面失败改判为通过。阈值、采样次数和 acceptance 均保持不变。
- harness 新增仅限 `--allow-short` 的 `--heap-snapshot-out`：在最终 Network inspector 停用与 forced GC 后、Chrome 清理前流式写出主页面 `.heapsnapshot`；正式命令显式拒绝该参数。下一轮诊断将按 retained object/持有链定位真实产品或浏览器生命周期根因，修复后重新跑 40-cycle，而不是放宽 `32 MiB`。

### 3.20 挂起绘图 RAF 与冻结回放栏 transition 根因修复

- `722ae0866298c2e8855abbd578a24bee0333a036` 的 10-cycle 主页面 heap snapshot 显示旧图表和旧回放右栏不是不可解释的 V8 固定成本，而是可重复的 detached 子树。绕开 WeakMap 弱边后，最短强引用链为 `Global handles -> current Window -> HTMLDocument -> ScriptedAnimationController -> pending V8FrameRequestCallback -> drawing scheduler closure -> old chart adapter -> ChartApi -> ChartWidget`。`drawingSceneRuntime.suspend()` 原先会清空 binding、worker 和 plan，却没有取消 scheduler 已登记的 RAF；后台/无头 Chromium 的帧回调可能长期不执行，从而把每一轮已经卸载的图表完整保留。
- scheduler 现在提供可复用的 `suspend()`：清空待处理 reason、推进 generation、取消已登记 frame handle 并解除引用，但不永久 dispose scheduler，后续 runtime 重新激活仍可正常调度。单测同时证明“挂起会取消旧 frame”和“挂起后可重新激活”。作为外围防线，图表 pane 的 ResizeObserver 生命周期也拒绝 cleanup 后的晚到 frame；没有修改渲染节拍、soak 采样或内存门槛。
- 第二条强引用链为 `Global handles -> current Window -> HTMLDocument -> DocumentTimeline -> CSSTransition -> old active replay rail button -> detached replay rail -> replay-paper-trading`。回放页面的生命周期重载发生在后台/无头时间线中，旧右栏的短 transition 可能冻结并保留整棵子树。CSS 现在只对 `[data-runtime-source="replay"]` 下的 market activity item 禁用 transition；实时行情页面的 transition 保持不变，也没有增加运行时旗标、灰度或 fallback。
- 三个同口径 5-cycle clean-HEAD heap snapshot 给出因果对照：`a4267196` 修复前 snapshot `40,241,164 B`，`ChartWidget=9`、detached chart pane `=8`、detached paper trading `=7`、全部 detached node `=2,725`；`1980869b` 取消绘图 RAF 后降至 `31,413,145 B / 2 / 1 / 7 / 2,253`；`f7cee596` 再清除回放栏 transition 后降至 `30,550,588 B / 2 / 1 / 0 / 150`。这两次下降分别对应两条持有链，而不是更换统计口径。
- 增量验证中绘图 scheduler 定向测试 `57 passed`，完整 frontend 分别为 `2960 passed` 和 `2961 passed`；双 tsconfig typecheck、定向 ESLint 与 `git diff --check` 通过。`f7cee596fafab7e9fca73af5910fa8703dedb891` 的 clean-HEAD 40-cycle 压缩复验随后运行 `1,822,766 ms`，完成 40/40 训练动作、archive lifecycle、lifecycle reload、订单成交与适配器恢复/重连，并以 `72,737.324 events/s` 完成 1,000,000 projection events；primary/late heap 增长为 `7,554,876 / 8,620,156 B`，盲审通过，30 项 acceptance 全部为真，报告 hash 为 `sha256:ed0c2bc6aeb8fa4554ac2419d01ff89e48b5cb2a4c2068ce16ffc4bddc6d6973`。
- `64 MiB / 32 MiB` 堆门槛、40 次压缩生命周期、100 次正式生命周期、1,000,000 projection events 和其余发布条件均未放宽。该 PASS 只完成进入正式证据链前的高密度内存门禁；本节文档提交会产生新 HEAD，因此真实来源、全量 checks、formal benchmark、真实浏览器 smoke、rollback、正式 4 小时 soak 和 release manifest 仍须在新 clean HEAD 从头重跑，不能继承 `f7cee596` artifact。

### 3.21 非隔离性能失败与 catalog epoch 重试证据

- `59378424f2ae8f707644c085d970cd7f56665b70` 的真实来源校验和全量 release checks 通过：官方 AGG_TRADE exact/nonempty/checksum 与真实 BAR 连续、只读、双标的 6 项全真；后端 `3251 passed`、前端 `2961 passed`。formal benchmark 随后在第一个 `core-v1` 组件 fail closed：BAR actor `3250.36 events/s` 低于冻结 `5000`，AGG_TRADE `741.27` 仍高于 `600`。同参数独立诊断没有挑选好结果，第二次 BAR 为 `2775.62`、AGG_TRADE 为 `619.86`，因此正式 `benchmark.json` 未生成。
- 同机最近两个 clean-HEAD PASS 基线的 BAR/AGG_TRADE 分别为 `7721.97 / 868.29` 和 `6997.28 / 1030.22 events/s`；从后一 PASS 到 `59378424` 没有 backend 或性能 baseline 文件变化。失败时三个 3 秒 CPU 采样均显示独立 24 小时 alerts soak、两个 MuMu VM 和 sing-box 持续占用多个核心。发布门禁没有停止或修改这些不属于本任务的进程，也没有提高优先级、固定亲和性、降低样本或放宽 `5000 / 600`；该机器状态不能产生可信的正式性能 PASS。
- 同一 HEAD 的真实浏览器 smoke 完成全部产品动作后发现一次 `/api/v1/replay/runs/<id>/markets` 409，并按“任何 replay API >=400”旧断言拒绝。旧失败 artifact 只保存 URL/status，未保存该响应 body，因此不能事后声称它一定是哪个 error code。代码合同同时明确：归档准备可能推进 catalog epoch，客户端只允许 `CATALOG_EPOCH_MISMATCH` 刷新并重试一次；无分类 409、重复冲突或未成功重试都必须失败。
- harness 现按 CDP requestId 关联 method、URL、status 与 response body，并为初始 market POST 保存一个独立有界 transition 集。新 `replay.api-concurrency-contract.v1` 仅接受 `POST /runs/<id>/markets -> 409 CATALOG_EPOCH_MISMATCH -> 同 URL POST 201`，每个 URL 最多一次；body 缺失、`TRAINING_RUN_BUSY` 等其他 409、第二次 epoch 冲突、没有后续 201 以及任何其他 4xx/5xx 均继续 fail closed。acceptance 新增严格布尔 `replay_api_concurrency_bounded`，不是状态码白名单或网络失败豁免。
- 分类器与真实 capture 回归 `41 passed`；完整 frontend 架构、插件边界、双 typecheck、lint、`2966 passed` 和 production build 全部通过。修复提交 `f4c47cbd44d2a7a2197a6a99496cc8846e3c0fd7` 的真实 smoke 随后以 31 项 acceptance 全真通过，本轮 catalog epoch conflict 为 `0`，证明无错误时不会制造合成重试证据；完整构建 rollback 的 17 项 acceptance 也全真，旧 backend replay route 为 404，禁用重启与旧构建保持 replay.db 和 Phase 18 存储语义。
- `f4c47cbd` 的 smoke/rollback 只验证修复和命令就绪；本节文档提交再次生成新 HEAD。最终来源、全量 checks、完整 benchmark、smoke、rollback、正式 4 小时 soak 和 manifest 必须全部绑定新 clean HEAD，性能环境仍须先恢复到可重复状态。

### 3.22 命令 200 响应身份绑定与 100 周期复现闭环

- `917c6de2827309ecd4d4d7b2eaeb537a50e288a9` 的正式 4 小时运行在 `training-action-cycle` 第 70 周期拒绝，错误为等待 training speed ack 超时，页面保持 `controlPending=set_speed`。失败 capture 中本次请求为 `control-746ef4d8-6fd4-427c-8d45-16e14720a726`、`set_speed(BASE_BAR, 10000)`；对应命令路由的 HTTP 200 body 却携带旧 `control-404ebcaf-8eeb-43ca-998e-9d1137e900f8`，全局时钟仍为 `PAUSED / rate=1 / USER_PAUSE`。这证明旧客户端把结构合法的 200 当作本次命令成功，却没有验证响应 `run_id/command_id` 是否绑定请求；它不证明错配由 Vite proxy、HTTP keep-alive 或浏览器缓存中的哪一层造成。
- 对共享 keep-alive Vite proxy 另做隔离 echo 压测：共触发 3,997 个后端请求，其中约半数主动 abort，逐一校验 2,000 个完成响应，结果为 `mismatches=0 / errors=0`。真实诊断浏览器另以 CDP side monitor 连续观察 55 秒，当前命令 request/response ID 全部匹配，且响应不是 disk cache 或 service worker。没有可重复的代理错配证据，因此本阶段没有猜测性修改 proxy/agent，也没有通过关闭连接复用掩盖问题。
- `fb42c8348744cba452ebbcc66ad944b17323afb7` 将客户端命令合同硬化为 fail closed：发送前要求 payload `run_id` 与 route 一致，收到成功响应后要求 response `run_id/command_id` 与请求精确一致；任一错配抛出 `REPLAY_V2_RESPONSE_IDENTITY_MISMATCH`。soak capture 不再只依赖通用 100 项 body tail，而是独立保留最多 2,000 条命令 request/response/body transition，并按 CDP requestId 关联；成功 2xx 的 route run、request run、response run 和 command ID 任一缺失或不一致都使 `replay_command_response_identity_exact=false`。
- 定向 soak/API 回归 `51 passed`，双 typecheck、定向 ESLint 和 `git diff --check` 通过；完整 frontend 架构、插件边界、双 typecheck、lint、`2970 passed` 与 production build 全部通过。工作树原 `node_modules` 是指向主工作树的 junction，主工作树依赖已漂移到 Monaco `0.56.0`，与本分支 lock 的 `0.55.1` 不符；确认 junction target 后只删除本工作树 junction 并执行 `npm ci`，没有修改主工作树 target 或 lock，随后以独立依赖完成上述全量验证。
- 同一 clean HEAD 的 `--allow-short` 高密度诊断完成 100/100 training action、100/100 下单/成交/重连、100/100 archive lifecycle 和 10,000 projection events，最后 archive lifecycle 在 `5,651,353 ms` 完成，越过旧 cycle 70 故障边界。32 项 acceptance 全真；712 个命令 request、712 个 response、712 个 response body 全部精确关联，identity violation 为 0；projection 为 `59,417.706 events/s`，primary/late heap 增长 `9,848,364 / 14,070,328 B`，盲审通过，报告 hash 为 `sha256:3be9640476b9b9b50b4e1e9426a615f9ac3df2bdb8e91a4aa5c2290f5651c179`。
- 该运行使用 `--allow-short --duration-ms 10000 --projection-events 10000`，只关闭第 70 周期确定性复现和命令身份证据缺口，不是正式 4 小时发布证据。本文提交会再次产生新 HEAD；真实来源、全量 checks、formal benchmark、真实浏览器 smoke、rollback、正式 4 小时/100 周期/1,000,000 events soak 和 release manifest 仍须从新 clean HEAD 全部重跑，不能继承本节 artifact。

### 3.23 用户决策：墙钟性能改为必测量非阻断观测

- `2d64c9a74ebf1831aa3135d0114d1aa6d36009d1` 的真实来源校验 6 项全真；正式 release checks 后端完成 `3250 passed`，唯一失败为 HEDGE Phase 9 单样本 benchmark：8 FULL normal `626.917 ms` 超过旧 `500 ms`，8 FULL liquidation `2221.873 ms` 超过旧 `2000 ms`，其余 1/2/4 轨、矩阵、账户/输入审计、SQLite 与 RSS 均通过。同期 5 秒采样显示 alerts 24h soak、sing-box 和两个 MuMu VM 合计持续占用约 3–4 个 CPU 核，因此旧墙钟门槛无法产生隔离、可重复的发布判定。
- 用户于 2026-08-08 明确要求“跳过性能要求门槛”。该决策解释为删除所有 replay 正式 benchmark 的墙钟延迟/吞吐 PASS/FAIL 比较，而不是跳过 benchmark：BAR/AGG_TRADE throughput、segment GC/inventory、account-history step、HEDGE normal/liquidation 的真实数值仍必须由同 HEAD 正式 workload 生成并写入 artifact，policy 固定为 `MEASURE_ONLY_NON_BLOCKING`。
- RSS/heap、late-half、queue/page、storage inventory、SQLite、审计、reference equivalence、1/2/4/8 矩阵、4 小时 soak 与 rollback 仍为硬门禁；没有新增环境变量、CLI opt-out、灰度、默认关闭或 fallback。历史 artifact 的 500/2,000/5,000 ms 与 5,000/600 events/s 只保留为历史测量参考，不再决定当前 release acceptance。

### 3.24 正式 4 小时命令响应丢失与双协议恢复证据

- `1cf1e66c75d1cf53d8e8b9b212e736747e87bfe8` 的正式真实来源、全量 checks、formal benchmark、真实浏览器 smoke 和 rollback 均通过。正式 soak 实际运行 `14,555.6 s`，完成 100/100 训练动作、archive lifecycle、lifecycle reload 与适配器恢复/重连，并以 `96,189.92 events/s` 完成 1,000,000 projection events；墙钟数值只记录，不参与 PASS/FAIL。
- 该轮在所有周期完成后的网络审计阶段正确拒绝，没有生成 PASS artifact。唯一 replay API 失败为 `POST /api/v1/replay/runs/session/ee334a7d6e6746019c974bd751f9110f/commands -> 500`，响应体缺失。Vite 同一请求记录 `http proxy error` 与 `socket hang up`；backend 没有结构化 500、Traceback 或进程退出，并在此后继续约 14 分钟完成剩余周期。故现有证据只支持“代理到上游的命令确认响应丢失”，不支持把它伪装成业务成功或直接忽略。
- 产品运行时原本已经采用 fail-closed 命令恢复：不确定响应会冻结后续 mutation，请求新的 WebSocket 原子快照，再以原始持久化 envelope 和同一 `command_id` 自动对账；后端按 canonical command ID 幂等返回已提交结果或只执行一次。缺口在 soak capture 只匹配 `replay.v3 /runs/{run_id}/commands`，没有捕获 `replay.v1 /runs/session/{session_id}/commands`，所以最终审计看得到无 body 的 500，却无法证明随后同命令对账成功。
- soak 现同时捕获两种命令路由及 request/response/body/loading-failed 记录。`replay.command-transport-recovery.v1` 只接受：首次为已实际捕获但无可解析 body 的 5xx 或 Network loading failure；后续只有一次 byte-identical method/URL/body 重试；请求 `command_id` 不变；成功响应的 protocol、Run/session、`command_id` 和 v1 `expected_revision + 1` 与路由及请求完全一致。正式 4 小时内最多接受 1 个这样的完整恢复链；第二次传输丢失、第二次 retry、修改 revision/payload、缺 retry、非 2xx、身份错配或任何结构化 5xx 都硬失败。
- `replay.api-concurrency-contract.v2` 将已证明的单次 exactly-once 恢复与 catalog epoch 冲突分别记录，不把它们降格为状态码白名单；`replayCommandResponseIdentityContract` 仍逐条保留首次失败和成功对账。最终网络审计在 assertion 前写入 `phaseDiagnostics`，以后即使拒绝也会保存恢复链、最近命令及 failed request，而不是只留下一个 requestId。
- 定向 harness `48 passed`，覆盖 v1 实际捕获、无 body 500 成功对账、Network loading failure、修改 canonical envelope、结构化 persistence 503、超过一次恢复和 v3 stale-200 身份错配。该修复提交会生成新 HEAD；旧 `1cf1e66c` 的来源、checks、benchmark、smoke、rollback 和失败 soak 都只能作为根因证据，正式 Phase 9 必须在新 clean HEAD 从头重跑。

### 3.25 正式长稳只读状态断流与有界 GET 恢复

- `1f1e06bfcb0c7186830376892fff2a4e8b716877` 的真实来源校验、全量 release checks、formal benchmark、真实浏览器 smoke 和 rollback 均通过：后端 `3253 passed`、前端 `2975 passed`；benchmark 在 `MEASURE_ONLY_NON_BLOCKING` 下保留了全部 core/fast-forward/1/2/4/8 HEDGE 墙钟测量，reference equivalence、账户/输入审计、SQLite、storage inventory 和 RSS 硬门禁全真；smoke 33 项及 rollback 17 项 acceptance 全真。
- 同一 HEAD 的正式 4 小时 soak 没有被误报为 PASS：运行到约 `4,487.9 s`、第 30 个 training action cycle 时，页面等待重连后的命令就绪超时。失败 artifact 显示 session 已经重新连接并由本页持有 controller，服务端 state 为 `PAUSED`，source sequence/revision 持续有效；此前 250 个命令 request/response/body 全部身份一致、没有命令传输恢复或运行时异常。真正失败的是 `GET /api/v1/replay/runs/session/<session_id>/tracks -> 500`，正文不可解析；Vite 同 URL 记录 `http proxy error` 和 `read ECONNRESET`。客户端把一次只读状态断流直接转成 `replay.v3 response is not valid JSON`，清空 tracks/bars 并永久禁用命令控件。该证据证明 actor/controller 已恢复而幂等读取没有恢复，不是性能门槛，也不能由用户的墙钟豁免覆盖。
- `ReplayV2ApiClient` 现在只对 GET 做最多一次内建重试：首次 fetch 传输失败、response body 读取中断，或无可解析 JSON 的 5xx 才允许重发；解析成功的结构化 4xx/5xx、成功 2xx 的非法 JSON、第二次失败以及所有 POST/DELETE/命令写入仍立即 fail closed。没有环境变量、灰度、默认关闭、退回旧 projection 或无限 retry。
- soak 新增 `replay.read-transport-recovery.v1`：按 CDP requestId 保存失败 GET、HTTP status、loading-failed、response body、请求序号和唯一同 URL retry；只有无结构化正文的 5xx/网络断流加一个可解析 2xx 才能闭环。已见 4xx 后的正文中断仍拒绝。`replay.api-concurrency-contract.v3` 对命令与只读恢复合并计数，整场正式运行总计最多 1 次；新增 `replay_read_transport_recovery_bounded` 与综合 `replay_transport_recovery_bounded` acceptance，第二次恢复或任何无证明链仍硬失败。
- 定向 harness `54 passed`，前端 API `13 passed`，覆盖实际 capture、bodyless 500、fetch/loading failure、2xx body 中断、结构化 503、非法成功 JSON、缺失 retry、已见 4xx 的中断、命令不自动重试和命令/读恢复合计超过一次。该修复提交将生成新 HEAD；`1f1e06bf` 的通过项和失败 soak 只保留为根因证据，正式 Phase 9 的来源、checks、benchmark、smoke、rollback、4 小时 soak 与 manifest 必须在新 clean HEAD 全部重跑。

### 3.26 高密度复验发现主动取消分类缺口

- `5eba1e9be6b23be86ebbc2866d44a262bae18a05` 的 35-cycle 真实浏览器高密度复验实际完成 35/35 lifecycle、10,000 projection events（`51,124.74 events/s`）并越过旧第 30 周期故障边界；293 个命令 request/response/body 身份全真。运行在最终网络审计保持 FAIL，没有生成 PASS artifact。
- 唯一拒绝原因不是新的代理断流，而是 GET 恢复 capture 把 5 个生命周期主动取消误归为网络恢复：每条 CDP 记录均为 `canceled=true / net::ERR_ABORTED`，其中一条已收到 200 后正文因页面生命周期结束而取消；客户端 AbortError 分支不会自动 retry，后续同 URL 请求属于新生命周期，但旧 capture 设置 pending 并把它误配为 retry。该错误造成四条 `READ_TRANSPORT_RECOVERY_RETRY_EXCEEDED` 和一条虚假恢复，证明恢复分类器不能只看 `loadingFailed`。
- capture 现在仅把同时满足 `canceled=true` 且 `errorText=net::ERR_ABORTED` 的 replay GET 记入独立 `ignoredAborts` 审计，不设置 pending、不消耗一次传输恢复预算，也不与后续请求配对；任一其他 canceled/error 组合仍进入严格恢复合同。若主动取消发生在已开始的真实 retry 上，会终止 pending 并令原始恢复链因 retry 未成功而硬失败，不能借 abort 隐藏第二次错误。
- 定向 harness 增至 `57 passed`，前端 API 增至 `14 passed`；新增真实 CDP capture 顺序、AbortError 不重试、`canceled=true + ERR_CONNECTION_RESET` 反例及真实 retry 被 abort 时仍硬失败的闭环。该修复会产生又一个新 HEAD；`5eba1e9b` 的 35-cycle 结果只作根因证据，修复后的高密度复验和 Phase 9 正式全链仍须重跑。

### 3.27 正式 smoke 发现 Windows Chrome 启动器交接缺口

- `3da45a5085c0223af06a32d36b88a27843d3f2f8` 的新 35-cycle 高密度复验已通过：35/35 training、35/35 archive lifecycle、293/293/293 命令身份一致、命令与 GET 恢复均为 0，5 个 `canceled=true / net::ERR_ABORTED` 仅审计，全部 acceptance 为真。来源验证、`3253` 个 backend tests、`2990` 个 frontend tests 和完整 benchmark 也通过；benchmark 明确为 `MEASURE_ONLY_NON_BLOCKING`，100 万事件优化/参考路径的 cursor、state、component、report hash 完全一致。
- 随后的正式 smoke 在 Chrome readiness 阶段保持 FAIL。Windows 上 launcher PID 以 exit `0` 完成交接，但其真实 browser 子进程继续运行且稍后正常开放 `/json/version`；旧 harness 立即把 launcher exit 当作浏览器死亡，cleanup 又因只处理已退出 launcher PID 而遗漏真实 browser，最终由被占用的 `CrashpadMetrics-active.pma` 二次暴露资源泄漏。失败 artifact 与唯一临时 profile/PID 证据均已保留，残留浏览器已精确终止。
- harness 现在只为 Chrome 的显式 Windows 路径允许 `launcher exit 0` 交接；非零退出以及 backend/vite 的任何提前退出仍 fail closed。Chrome readiness 后立即建立 browser-level CDP 控制连接，收尾发送 `Browser.close`，再执行原 PID fallback，并要求 `/json/version` 在有界时间内确实不可用后才删除临时目录。WebSocket 可能先于 `Browser.close` acknowledgement 断开，但只有端点消失证明才能接受；端点存活仍硬失败。
- 该修复将产生新 HEAD。`3da45a50` 已通过的高密度、来源、checks、benchmark 只作根因和历史测量证据；新 HEAD 必须重新执行 Phase 9 正式全链，不能继承旧 HEAD 的 PASS。

### 3.28 新 HEAD 全量 checks 捕获 50ms 测试时钟竞争

- Windows lifecycle 修复的新 clean HEAD 已通过专用真实 browser smoke：1/1 training、1/1 archive lifecycle、21/21/21 命令身份一致、0 API/传输恢复异常；真实 browser 经 `Browser.close` 后无活进程，新临时 profile 自动删除。随后正式来源验证再次通过。
- 正式 backend 全量 checks 的唯一失败为 `test_binance_418_opens_exchange_ip_circuit_across_buckets`：3252 个其余测试通过；第一次 futures inspect 得到 `circuit_open`，宿主在线程调度后第二次 spot inspect 已越过测试写死的 50ms `Retry-After`，得到 circuit 恢复后的 `budget`。`3da45a50..d7b502a2` 的 backend diff 为空，同一测试独立连续运行 30 次均通过，证明不是产品 circuit 语义回归，而是以调度抖动量级充当观察窗的测试脆弱性。
- 该测试不等待恢复，只验证同一 418 在两个 Binance bucket 上立即可见；观察窗现从 50ms 改为 5s，并明确记录其目的仅是隔离宿主调度。生产 `RateLimitManager`、默认 cooldown、真实 `Retry-After` 解析与恢复语义均未修改；其他专门验证短 cooldown/恢复的测试仍保留原工作量。修复后的新 clean HEAD 仍须从正式来源、全量 checks 起重跑全部 Phase 9 证据。

### 3.29 replay.v3 快速时钟命令 ACK 悬挂与同 ID 对账

- `6727970112505ead0c035f6bdb0b32b336d691ee` 的正式来源、全量 checks、formal benchmark、真实 smoke 和 rollback 全部通过；benchmark 继续以 `MEASURE_ONLY_NON_BLOCKING` 记录 BAR `2796.73 events/s`、AGG_TRADE `757.37 events/s` 与 100 万事件 optimized/reference 等价结果，没有墙钟发布阈值。正式 4 小时 soak 在约 `12,723 s`、第 88 个训练动作硬失败，属于命令正确性而非已豁免性能。
- 失败请求是 `set_speed(BASE_BAR, 600)`，request `command_id=control-7a900b68-fbb1-4f29-9368-f22b41d97e9a`。CDP 已捕获 POST 和完整 canonical body，但直到 120 秒动作截止仍没有 response、response body 或 loading-failed；页面保持 `PAUSED / rate=1 / controlPending=set_speed`，全部控件禁用。后端进程、WebSocket、SQLite 与 actor 均健康，当前 adapter queue 为 0、runtime/persistence failure 为 0；这只能证明 ACK 链悬挂，不能把命令猜测为成功或失败。
- `replay.v1` 基础运行时已有未知结果后的同 ID 对账，`replay.v3` Run API 却只发送一次无内部截止的 POST，因此代理既不返回也不报错时会永久冻结交易界面。Run API 现在对 acquire/takeover/release/play/pause/set_speed 六类快速时钟控制设置固定 30 秒 ACK 截止；截止会终止该 HTTP 尝试，并且只有 transport error 或无结构化正文的 5xx 才允许一次 method/URL/body 字节完全相同、`command_id` 不变的重交。后端 canonical command journal 返回已提交结果或执行一次，成功响应仍必须精确匹配 Run/command 身份。
- 结构化 4xx/5xx、成功但非法或身份错配的响应、调用方 Abort、第二次传输失败以及第二次 retry 均继续 fail closed。长 advance/scan/end 不套用快速 ACK 截止，避免把合法长任务误判为传输丢失；它们仍可在真实 transport error 后按同一 canonical command 最多对账一次。没有环境变量、灰度、默认关闭、fallback 或性能阈值改动。
- 定向 API 回归覆盖 bodyless 5xx exact retry、悬挂 set_speed 的 timer abort、结构化 controller conflict、外部 Abort、身份错配以及第二次失败的有界拒绝；双 typecheck 与 lint 通过。修复形成新 clean HEAD 后先运行真实浏览器高密度周期，再从零重建 Phase 9 全部正式 artifacts；`67279701` 的 PASS 项和失败 soak 只保留为根因证据。

### 3.30 有持仓播放批次长期占用 Run 锁与控制活性修复

- `b09ab3a6932d5dc0313fd53f89ab95d8ecea9d42` 已从零完成正式来源、全量 checks、formal benchmark、真实 smoke 和 rollback。来源包含 BTC/ETH 各 4,000 根连续真实 BAR 以及 Binance 官方 BTCUSDT futures `2020-01-01` 的 71,359 条 aggTrades；后端 `3253 passed`、前端 `2996 passed`。7/7 benchmark 组件和 14 项硬检查全真，性能 policy 保持 `MEASURE_ONLY_NON_BLOCKING`；smoke 33 项及 rollback 17 项 acceptance 全真。
- 同一 HEAD 的正式 4 小时 soak 在 `elapsed=8,964,348 ms`、第 62 个 training action cycle fail closed，错误为等待 training speed ACK 超时。失败时页面 source sequence `3301`、revision `3425`，权威 global clock 已是 `PAUSED / BASE_BAR / rate=1`，两条 HEDGE 腿仍同时存在，`controlPending` 已清空；最后一个 `set_speed(BASE_BAR, 120)` canonical 命令的首次请求和唯一同 ID 对账请求都以 `status=0 / net::ERR_ABORTED` 结束。后端 queue 为 0，runtime、persistence、reaper、recovery 与 SQLite transaction failure 均为 0，已接受 adapter 命令的最大 ACK 仅 `672 ms`。失败 artifact 保存为仓库外 `replay-v2-soak.json.failed.json`，未生成 PASS manifest。
- 根因是 `_run_ordered_playback` 在 `TrainingRunActor.serialized()` 内完成整个 `_advance_full_tracks_to` 目标。PAUSE 会先调用 `signal_ordered_stop()`，因此页面和权威 clock 可先变为 PAUSED，但 HTTP command 仍要排队等待同一 Run 锁；SET_SPEED 也必须先取得该锁。旧调度按 wall-time 累积最多 64 个离散单位，并可能在一次锁区间内逐 BAR 结算全部单位。原终态批次另允许有普通 position 时最多 32 根，但 HEDGE pinned mark/funding 等依赖会禁用该优化而走普通参考路径，所以只把 32 改小不能关闭真实失败入口。
- 播放调度现对每轮权威 track/snapshot 复用 fast-forward path dependency 判定；只要出现 `OPEN_ORDER` 或 `OPEN_POSITION`，无论终态优化是否可用、是否还有 funding/mark/book 依赖，单次锁区间的播放目标都限制为 1 个 BAR。每根完成持久化 global checkpoint 后退出 Run 锁，Python fair lock 允许已排队 PAUSE/SET_SPEED 获得确认；停止信号仍只在完整提交屏障检查，不会产生半根成交、半次强平或跳过保险/ADL。空账户仍使用原 64/大块终态路径，手动长任务合同未修改。
- 新回归在真实 HEDGE deterministic-simulation Run 中同时建立 LONG/SHORT 两腿，强制 `discrete_playback_units=64`，并在首根适配器推进尚持锁时排队 PAUSE；结果只发生一次 adapter advance，`final_state_max_events=None` 的普通参考路径只消费 1 根，source sequence 精确 `+1`，PAUSE 在释放首根后 1 秒内返回。原空账户 64 根终态批处理和 TOUCH_OR_TAPE_V2 活跃仓位禁用优化测试继续通过；完整 Phase 9 HEDGE 与 Phase 13 播放调度定向集为 `18 passed`。
- 本修复属于控制命令正确性/活性硬门禁，不恢复任何墙钟性能 PASS/FAIL。没有新增环境变量、灰度、默认关闭、fallback 或交易语义近似；该提交产生新 HEAD 后必须先做不少于 70 个周期的高密度真实浏览器复验越过旧第 62 周期，再从真实来源、全量 checks、7 组件 benchmark、smoke、rollback、正式 4 小时 soak 到 release manifest 全部重跑。

### 3.31 Windows AppContainer CPU 配额测试的任意墙钟门槛

- 锁修复候选 `13c3f1c73af416a89e902b2f0eef41ab6b6a359e` 的 70-cycle 高密度真实浏览器预检运行 `3,049,493 ms`，完成 70/70 training action、70/70 archive lifecycle、70/70 下单/成交/重连；最终仍同时持有 LONG/SHORT 两腿。573/573/573 条命令 request/response/body 身份精确，0 identity violation、0 命令/读取恢复，15 次生命周期主动 abort 正确隔离；35 项 acceptance 全真，报告 hash 为 `sha256:8049fb779f7cf219d10bde59d886c5cb8fa7d294e8ae4af92b9681d04a452593`。该轮已越过旧第 62 周期，证明 3.30 的控制活性修复闭环。
- 同一 HEAD 的正式真实来源 validation 随后通过；正式 release checks 后端唯一失败为 `test_cpu_time_quota_terminates_only_the_sandbox_process`，其余 `3253 passed`。Windows JobObject 的 1 秒 per-process CPU 配额实际已终止恶意探针：launcher status 为 `status=exited`、`violation=null`、非零 exit；只是宿主墙钟 `8328 ms` 超过测试自 2026-07-22 起写死的 `8000 ms`。若由 10 秒 wall monitor 终止，status 必须为 `violated / violation=wall-time`，与现场不符。
- 该测试独立连续运行 5 次全部通过，保留 basetemp 的另一次现场为 `elapsedMillis=3578`、`exitCode=3221225540 (0xC0000044)`、`status=exited`、`violation=null`。本机 Windows SDK `ntstatus.h` 明确定义 `0xC0000044` 为 `STATUS_QUOTA_EXCEEDED`。因此原 `< 8000 ms` 既不是配额身份，也会随宿主 CPU 调度漂移；它与用户已取消的墙钟性能发布门槛同类。
- 回归现精确断言 `violation is None` 和 `exitCode == STATUS_QUOTA_EXCEEDED`，比“任意非零且小于 8 秒”更严格地区分 OS CPU quota、probe 自行退出和 launcher wall-time violation。生产 `JOB_OBJECT_LIMIT_PROCESS_TIME`、CPU hard cap、AppContainer profile、1 秒 CPU time、10 秒 wall time、Job-only termination 与 status schema 均未修改，没有降低插件隔离安全性。
- 该测试与记录会形成新 HEAD；`13c3f1c7` 的 70-cycle PASS、来源 PASS 和 checks FAIL 仅保留为根因证据。新 clean HEAD 必须重新完成 70-cycle 复验及 Phase 9 正式来源、全量 checks、benchmark、smoke、rollback、4 小时 soak 和 manifest，不能继承旧 artifact。

### 3.32 Vite 上游连接池与 Uvicorn 空闲截止错配

- `52ed928b92fd76d034104b3787f85f6367981e9e` 已重新完成 70/70 高密度周期、正式真实来源、全量 checks 和 7/7 measure-only benchmark。正式短 smoke 的训练、命令身份与 projection 均完成，但最终网络审计正确拒绝两个同秒发生的无正文 500：`POST /order-capacity` 为 `socket hang up`，`POST /public-times` 为 `read ECONNRESET`。后端没有结构化 500、Traceback、进程退出或健康异常；同一 HEAD、同一真实数据库的立即诊断复跑完整通过，因此不能把失败归为确定性的 HEDGE 业务异常，也不能覆盖原失败 artifact。
- Vite 配置自 `83b5cb2c` 起为 `/api` 显式使用 `keepAlive=true` 的 Node Agent；Node 22 全局 Agent 同样默认 keep-alive。回放 fixture 使用 Uvicorn `0.34.0` 且未覆盖 `timeout_keep_alive=5`，代理不知道上游连接的权威空闲截止。在上游发送 FIN/RST 与代理分配空闲 socket 的竞态窗口，多个并发安全查询会分别得到 Vite 生成的无正文 500。
- 使用相同 Vite preview、真实 FastAPI/Uvicorn，先确认上游已就绪，再把空闲截止收紧到 1 秒并在 `940–1060 ms` 边界发起 30 轮、每轮 8 个并发请求。旧 `keepAlive=true` 配置的 240 次请求稳定复现 25 个 500，其中 8 个 `socket hang up`、17 个 `ECONNRESET`；后端无错误。该实验只缩短复现窗口，没有修改产品错误预算。
- 开发与 production-preview 代理现保留显式私有 Agent 和最多 32 条在途连接，但设为 `keepAlive=false`，使每个 API 请求使用新的上游连接；浏览器到 Vite 的连接策略不变。同一就绪检查、空闲截止和并发边界下再跑 240 次为 `240/240`、0 个代理错误。没有给 GET/POST 增加重试、没有接受第二次传输恢复、没有忽略 500，也没有修改后端、交易、强平或持久化语义。新增配置契约同时验证 dev/preview 都不使用 Node 全局 Agent、不启用上游池复用。
- 该修复会形成新 HEAD；`52ed928b` 的高密度、来源、checks、benchmark PASS 以及 smoke FAIL/诊断 PASS 全部只作根因证据。新 clean HEAD 必须重新完成 70-cycle 复验和 Phase 9 全链，原严格网络恢复预算、资源与 4 小时长稳门禁均不放宽。

### 3.33 60 分钟门禁捕获订单 advisory 请求放大

- `3b6c2b4c29352a2692212449e20da65f6c36ab40` 首次执行新的 60 分钟阻塞式稳定性门禁，实际运行 `3,840.4 s`，完成 1,000,000 projection events 并越过 90 个训练/归档生命周期；第 94 个训练动作在下单前等待 120 秒后失败。Edge、页面、后端、actor、SQLite、WebSocket 和 controller 在失败前均存活且无 runtime/persistence/reaper/recovery 错误，757 条已完成命令 request/response/body 身份精确，因此本轮不是清理软件关闭浏览器，也不是旧 4 小时墙钟问题。
- 失败动作的 SELL `POST /order-capacity` 已由 CDP 捕获完整 URL、游标和正文，但没有 response/body/loading-failed；随后 controller 仅因页面 120 秒未完成动作而过期。失败前页面约产生 24,000 个请求，尾部持续重复 capacity/preview/read 查询。根因是右栏 background capacity effect 以 revision/source-sequence/virtual-time 为 key，却用 0 ms timer 启动；高倍速游标每次发布都会发起 advisory POST。浏览器 abort 旧 fetch 不保证已进入 TrainingRunActor 的服务端计算立即停止，长期请求放大最终会让真正下单前的 exact capacity/preview 校验排队饥饿。
- background capacity 与 preview 现在统一使用 180 ms trailing scheduler，游标持续变化时只保留最新回调；开始 exact 下单校验时会取消 scheduler、终止在途 advisory，并在校验期间禁止重新调度。exact capacity/preview 共用一个 15 秒 AbortSignal，重复提交被禁用，卸载时所有 timer/controller 都释放。soak 同时观察页面错误提示，校验失败后立即返回具体原因，不再固定等待 120 秒。
- `f4361867c9da39fec7ee263c499653da5a6bcb35` 的首个 10-cycle 分钟级高压回归完成 10/10 training/archive lifecycle、93 条命令身份检查和全部产品动作，下单未再卡住；新增预算仍正确拒绝该轮，因为总 advisory 为 592（capacity/preview 各 296，预算 140）。失败尾部显示同一 revision/cursor/body 被多次主动取消后重发，证明仅靠时间 debounce 仍会受 `viewerState` 对象身份更新和 PAUSED 内重复 render 触发。第二层修复把后台 advisory 限定为可交易的 PAUSED 状态，以完整 semantic key 记忆已启动请求，同 key 在成功或业务失败后不再自动重复；只有在途请求被生命周期中止时才 forget 并允许重试。preview 还必须等待同 key capacity ready 后才启动，不再让两项昂贵计算并发争用 Run actor。
- 新增 `replay.order-advisory-request-contract.v1`，按生命周期给 capacity/preview POST 设置宽松但有限的总预算 `max(40, cycles * 12 + 20)`；历史请求风暴会在 smoke/高压/正式运行的最终网络审计中直接失败。`npm run stress:replay:orders` 用 10 次真实浏览器训练和 archive lifecycle 在分钟级验证该入口，正式 60 分钟门禁继续执行相同合同。纯 scheduler 回归证明 1,000 次游标 churn 只启动最后 1 次请求，合同回归证明 1,000 次 advisory 在 10-cycle 预算下被拒绝。
- 增量验证为 keyed scheduler `3 passed`、soak harness `63 passed`、replay 前端 `351 passed`、Phase 10 发布合同 `12 passed`，architecture、双 TypeScript、定向 ESLint、Node syntax 与 `git diff --check` 全部通过。第二层修复形成新 HEAD 后重新执行一次 10-cycle 分钟级高压回归；通过后只重跑当前 HEAD 必需的 checks、smoke、rollback 和一次 60 分钟门禁，benchmark/真实来源仅按祖先与阶段 pathspec 零 diff 审计复用，旧 4 小时观察不重跑。

## 4. clean-HEAD 正式判定

候选提交后依次执行并绑定同一 HEAD：

1. 全量 backend/frontend release checks；
2. formal benchmark（含 1/2/4/8 HEDGE）；
3. 真实 BAR 与官方 AGG_TRADE source validation；
4. 真实浏览器短 smoke；
5. 不少于 60 分钟、100 次 archive lifecycle、1,000,000 projection events 的高密度正式稳定性运行；
6. 完整构建 rollback drill；
7. 22 项 HEDGE matrix、默认启用静态审计和最终 release manifest。

只有外部 `release-manifest.json` 为 PASS 且工作树仍为同一 clean HEAD，Phase 9 才算完成。失败后只重跑受影响阶段：checks、smoke 和稳定性证据不跨 HEAD；benchmark、真实来源和 rollback 仅可通过 verifier 的祖先关系与阶段输入 pathspec 零 diff 审计后复用。4 小时观察不参与 PASS/FAIL，也不能被写成已通过的发布门禁。最终测试计数、来源摘要、性能分布、稳定性遥测、复用审计和回滚 acceptance map 以外部 manifest 及其绑定 artifacts 为唯一权威记录。
