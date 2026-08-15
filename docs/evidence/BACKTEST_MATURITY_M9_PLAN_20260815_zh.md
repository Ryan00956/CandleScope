# M9 策略研究工作台执行计划（2026-08-15）

## 基线与依赖

- 分支：`codex/backtest-foundation`；基线：M8 `21acca58783c6139233373094fcd96e0e3da2160`。
- 依赖门禁：M1 标准策略语义与 M7 报告/指标 V2 已通过；M8 Study V2 已通过且工作树干净。
- 冻结契约：Host 拥有执行真相；Run/Revision/Artifact 身份不可变；Decimal 权威记账；无前视；失败关闭；不得把 BAR/aggTrade 标成 raw trade 或 queue exact；不得联网补数据；旧 Run/报告继续可读；生产和高精度 flags 默认关闭。
- 本阶段不做：M10 性能/soak/恢复发布总门禁、M11 任意扩展、任意 Python/TradingView Pine 兼容承诺、Run 内训练或覆盖外部模型。

## 实施顺序

1. **StrategyRevision V2 与 schema v4**：增加不可变 revision、编译 receipt、smoke receipt、分页 signal trace、研究桥 request；提供升级与可验证回滚脚本。Revision 绑定 source/artifact/dependency/runtime hash，归档只改变目录可见状态而不改内容。
2. **受限编译链**：支持内置模板、现有 Pine 安全子集及 Pyne 统一订单 DSL；静态诊断携带行列和可执行建议；编译后仅生成白名单 execution spec，隔离 worker 不接受任意代码。外部模型只接受冻结 artifact 引用。
3. **运行与 smoke 门禁**：一键小窗口 smoke 生成不可变 receipt；自定义 revision 的长 Run 必须匹配有效 smoke。隔离进程按冻结 execution spec 构造 Provider，旧内置 revision 行为不变。
4. **有界调试数据**：从主报告移除大型 trace，在 Run 完成事务中写入分页表；主报告仅保存 trace count/hash/schema。页面最多加载固定页大小，RSI pane 和标记详情只消费当前有界窗口。
5. **Run compare/clone**：以数据快照、账户、引擎、语义与精度身份计算兼容性；仅兼容 Run 直接叠加。返回参数、交易、成本、权益/回撤差异；decision hash 相同而 fill hash 不同时解释执行精度。Clone 只允许一次修改一个参数并产生新 Run 身份。
6. **回放研究桥**：独立默认关闭 flag；仅传递不可变数据引用、时间窗口和只读策略投影。Backtest 不共享/导入 replay 的账户、cursor、checkpoint 或 UI store；未揭盲前 API/UI 隐藏策略结果。
7. **UI 工作台**：普通路径使用 schema 表单完成创建/复制/归档、诊断/编译/smoke/Run；显示输入、clock、输出和明确不支持项；加入分页 trace、RSI pane、三类时间与成本解释、兼容性对比、单参数 clone 和研究桥入口。
8. **验证与证据**：focused M9、相关后端回归、前端 typecheck/lint/full tests/build；真实浏览器完成文档 10 步旅程并确认控制台零错误、刷新恢复和有界加载；检查旧报告、schema、默认 flags、diff；生成 manifest/hash/截图/日志。

## 版本与兼容策略

- 新身份：`STRATEGY_REVISION_V2`、`STRATEGY_COMPILE_RECEIPT_V2`、`STRATEGY_SMOKE_V1`、`SIGNAL_TRACE_V1`、`RUN_COMPARE_V2`、`REPLAY_RESEARCH_BRIDGE_V1`。实现审查发现对比合同必须显式携带回撤、交易和成本差异，因此未提交的 V1 原型被提升为 V2，未产生可观察的 V1 历史数据。
- schema 从 v3 升至 v4，仅新增表/索引；旧行与旧报告不重写。回滚脚本显式确认并先备份；任何 v4 专属表有业务数据都拒绝回滚，数据导出后才能重试。
- 所有语义/编译内容由 hash 参与新 Revision/Run 身份；绝不静默改变旧 Run。

## 风险、门禁与停止条件

- 风险：动态 revision 穿透隔离边界、trace 膨胀报告/内存、跨产品状态耦合、近似成交误标精确、旧数据库升级后不可回读。
- 控制：白名单 execution spec、事务写 trace、硬分页/点数上限、桥接 DTO 隔离、精度标签 fail-closed、升级/回滚 fixture。
- 停止：任何旧 Run 读取回归、身份可变、无前视失败、浏览器主旅程失败、控制台错误、默认 flag 开启、回放边界共享、或强制测试未通过，均不得提交 M9/进入 M10。
- 回滚：单独回滚 M9 commit；代码回滚前运行 v4→v3 脚本并保留 SQLite/manifest 备份。不得删除 M0～M8 数据。
