# strategy-provider/1 协议

合同版本：`strategy-provider/1`

本协议是回测策略插件的公共面。它不修改 `candlescope.script-runtime/1`。

## 贡献点

`kind` 必须是 `strategy-provider/1`。插件只声明能力，不申请任意历史查询。

## 生命周期

`describe` → `prepare` → `warmup` → `step` / `onExecutionReport` → `snapshot` / `restore` → `close`

每个调用携带 `runId`、`generation`、`sequence`、`watermark`。响应必须回显 sequence。旧 generation 丢弃。

## 输出

只允许 `SIGNAL`、`TARGET_POSITION`、`ORDER_INTENT`。warmup 不得产生可成交输出。

## 可执行能力描述

`describe.capabilities` 除输入/输出/state/reproducibility/snapshot 能力外，必须明确：

- `signalClock`：策略何时允许形成决策，例如 `BAR_CLOSE`；
- `requiredFeatures`：每次调用必需的特征名，Host 缺少任一项即失败关闭；
- `warmupRequirement`：静态行数或由参数决定的 warmup 公式。

这些字段只描述 Provider 需要什么，不授权 Provider 拉取数据。改变 signal clock、required feature
语义或 warmup 算法时必须发布新的策略 revision；Host 不得用不兼容事件时钟调用 Provider。

`AGG_TRADE_EXECUTION` 中，Host 仍以 `roles=[BARS]` 调用声明 `BAR_CLOSE` 的 Provider；这些 bar
必须由本 Run 的同一 aggTrade snapshot 通过 `TRADE_DERIVED_COMPLETE_BUCKETS_V1` 产生，并以
独立 `signal_sequence` 调用。Provider 不接收每笔 aggTrade，也不得把形成中尾桶当成完整 bar。
执行时钟与 aggTrade cursor 属于 Host，不改变既有 BAR_CLOSE Provider revision 的指标语义。

## 失败关闭

未知字段、NaN、重复 key、乱序 sequence、watermark 回退、超时、崩溃、越权写 Host 状态，一律失败。无 snapshot 的 Provider 崩溃后只能整 Run 失败。
