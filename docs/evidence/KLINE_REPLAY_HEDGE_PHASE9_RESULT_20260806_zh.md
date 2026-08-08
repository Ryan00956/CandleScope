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
