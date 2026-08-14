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

## 失败关闭

未知字段、NaN、重复 key、乱序 sequence、watermark 回退、超时、崩溃、越权写 Host 状态，一律失败。无 snapshot 的 Provider 崩溃后只能整 Run 失败。
