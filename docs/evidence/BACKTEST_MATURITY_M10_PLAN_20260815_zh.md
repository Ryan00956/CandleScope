# M10 可靠性、性能和发布验收执行计划（2026-08-15）

## 基线与阶段依赖

- 分支：`codex/backtest-foundation`；基线：M9 `eda10edebb0e3628746b00771546502a11659762`。
- 依赖门禁：M8 Study V2 `21acca58783c6139233373094fcd96e0e3da2160`、M9 策略研究工作台均已通过并独立提交；开始 M10 时工作树干净。
- 冻结契约：Host 拥有执行真相；Run/Revision/Dataset/Artifact 身份不可变；Decimal 权威记账；无前视；失败关闭；BAR 不伪装成交，aggTrade 不宣称 raw trade 或 queue exact；不得静默联网补数据；旧 Run、旧 checkpoint 和旧报告继续可读；所有生产和高精度 flags 默认关闭。
- 本阶段不做：M11 BOOK_ASSISTED、多市场组合、实盘启用、生产 flag 开启、merge、push、删除工作树，或与发布主路径无关的重构。

## 初始审计结论

- BAR 与双时钟已有周期 checkpoint/restore；aggTrade 路径只有进程内 checkpoint，尚未落入 repository，不能跨 worker 恢复。
- 当前失败收尾会删除 checkpoint，Provider timeout/crash 无法满足“保留最后安全 checkpoint 和审计”的合同。
- 完成封存已使用事务写 report/audit/Run 并删除 checkpoint；需要在封存前增加最后安全 checkpoint 和故障点，而不能削弱原子完成语义。
- 数据集引用已冻结 `dataset_id + data_epoch + snapshot_hash`；aggTrade 归档也有不可变身份检查，可用于替换、截断和 hash 漂移恢复拒绝测试。
- 现有 100 万 synthetic aggTrade benchmark 明确是非发布证据；M10 必须补公开产品路径和真实官方 aggTrade 归档证据。
- 定向检查未在本工作树或 replay 工作树发现既有 `BTCUSDT-aggTrades-2026-07-24/25.zip`；如需获取，将使用显式命令、官方来源、checksum/provenance receipt，绝不后台或隐式补数。

## 实施顺序

1. **Checkpoint V2 与三类 Run 恢复**：新增可版本识别且兼容读取 V1 的 checkpoint envelope；持久化 kernel/provider/planner、事件游标、信号聚合状态和不可变输入身份。BAR、双时钟、aggTrade 都在统一安全点保存，恢复时验证 generation、配置、策略、数据、账户、撮合与报告身份。
2. **故障注入与失败关闭**：增加仅测试可注入、生产默认不存在的 worker fault hook，在 decision 前、订单后、部分成交后、funding 后、报告封存前触发。事件后故障必须先原子保存安全 checkpoint；恢复不得重复 fill/funding，三类权威 hash 与不间断运行一致。
3. **Provider 恢复合同**：timeout/crash 保留最后安全 checkpoint 和结构化 audit；只有 snapshot-capable provider、允许的失败码、完整 checkpoint 与完全相同身份才能显式 resume。corrupt/stale/missing checkpoint、数据漂移、非恢复类失败一律拒绝，不静默从头运行或覆盖旧报告。
4. **故障矩阵验证**：覆盖五个注入点、BAR/双时钟/aggTrade、stale generation、checkpoint corruption、文件替换/截断/hash 改变、Provider timeout/crash、SQLite busy、磁盘写失败与 worker 中断。记录基线/恢复的 decision/fill/ledger/report hash 和审计序列。
5. **公开产品性能路径**：新增只使用公开 HTTP API、worker、service、repository、report/export 的 harness；运行 20 万 BAR（活动订单/成交/账本/checkpoint/report）、100 万及 200 万真实官方 aggTrade（RSI clock/实际持仓）、大量部分成交、64-trial Study V2、接近 16 MB 报告和分页 trace、4 并发 Run。首次受控候选结果冻结阈值，后续失败不放宽阈值；私有 `_enqueue/_match` 结果只保留 microbenchmark 标识。
6. **公开 soak 与浏览器生命周期**：扩展结构化 API smoke/soak receipt；在干净 SHA 上完成 1h 公开路径 soak。真实浏览器完成长权益曲线、长交易表、分页 trace、Run 切换、刷新恢复、控制台错误和资源趋势检查，并连续运行 4h 生命周期 soak。
7. **候选、review 与回滚**：独立的只读 diff/合同 review；在 detached worktree 对候选 commit 执行 exact revert，验证数据库/报告保留且默认关闭后 live/local/replay/plugin 基本健康。保留 worktree，不删除用户或演练工作树。
8. **发布证据与总回归**：运行后端相关全量测试、前端 typecheck/lint/full tests/build、公开 API smoke；生成 schema 校验的 release manifest，记录 clean SHA、flags、数据 hash、命令/退出码/时长、权威 hash、浏览器错误和 artifact hash；复核旧 schema/report/checkpoint 兼容、Git diff 和默认 flags。

## 干净 SHA 与提交策略

M10 的发布门禁要求证据绑定干净 SHA，而阶段证据又只能在验证后最终提交，因此本阶段使用两个边界清晰的本地提交，不把未验证状态标记为阶段完成：

1. 完成实现、focused tests 和短回归后，创建 **M10 candidate implementation commit**；此时 M10 仍为进行中。
2. 在该干净 candidate SHA 上运行真实性能、1h/4h soak、浏览器、故障恢复、review 和 exact revert；大体积运行产物保存在忽略的 `output/`，manifest 绑定 candidate SHA。
3. 所有强制门禁通过后，创建 **M10 evidence/completion commit**，只包含最终文档、schema/阈值和可追溯的小型 evidence。两个 commit 均可独立回滚；不 merge、不 push。

## 版本、兼容与回滚

- 新恢复语义使用 `BACKTEST_CHECKPOINT_V2`、`BACKTEST_RECOVERY_V1` 和显式 resume receipt；V1 checkpoint 只按原语义读取，绝不就地改写或冒充 V2。
- 如需数据库 schema 变更，只允许向后兼容的新增列/表/索引并提供受保护迁移与回滚；有 M10 专属业务数据时旧版本回滚必须先导出或拒绝。
- 新性能/发布证据使用版本化 manifest；阈值首次冻结后只可通过新的、显式版本身份修改。
- 立即关闭依靠既有默认 `0` flags；代码 exact revert 只作用于明确候选 commit，数据库、报告、checkpoint、日志和 evidence 保留。

## 风险与停止条件

- 主要风险：错误安全点导致重复成交/资金费；恢复时策略聚合窗口漂移；官方归档不足 200 万事件；soak 暴露资源泄漏；16 MB 报告被 API/UI 无界加载；回滚破坏旧数据库；环境争用导致性能波动。
- 控制：checkpoint 写后再故障、完整身份/hash 校验、真实官方数据 receipt、有界分页/导出、资源采样、干净 SHA 与固定环境 profile、保留所有失败证据。
- 停止条件：任一权威 hash 漂移、旧报告/checkpoint 不可读、corrupt checkpoint 被静默跳过、数据漂移仍恢复、Provider checkpoint 丢失、公开路径阈值/1h/4h/browser/revert/健康检查失败、默认 flag 非零、需要密钥/新权限/破坏性操作或 M11 扩展。停止时不得跳过 M10 或标记完成。

## M10 Definition of Done

- 文档 15.2、15.3、15.4、15.5 的强制项逐条有可复核 evidence；M11 明确为 `NOT_APPLICABLE_OPTIONAL_DEFAULT_OFF`。
- checkpoint/fault matrix、真实 aggTrade 性能、1h API soak、4h 浏览器/生命周期 soak、exact revert 与 rollback health 均在同一干净候选 SHA 上通过。
- release manifest schema 校验和 artifact hash 校验通过，所有生产 flags 仍默认 `0`。
- 两个 M10 本地 commit 形成后工作树无属于本阶段的遗留变更；不 merge、不 push、不删除工作树、不启用生产能力。
