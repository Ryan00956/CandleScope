# CandleScope Plugin SDK for Java

这是 Plugin Platform v2 的最小、零依赖 Java SDK。它故意只实现稳定的进程协议层，
不替插件管理依赖、不开放 Host 内部对象，也不允许插件把普通 stdout 当日志使用。

当前范围：

* 严格 UTF-8、JSONL 与 canonical JSON/SHA-256；
* 1 MiB 消息、32 层深度、10,000 容器项和 256 KiB 字符串上限；
* handshake、describe、activate、invoke/eventBatch、healthCheck、cancel、
  prepareUpgrade、deactivate、shutdown；
* generation、request id、并发上限和 Host call correlation；
* 原始 stdout 专用于协议，插件的 `System.out` 自动重定向到 stderr；
* graceful shutdown、取消与陈旧 Host response 拒绝。

SDK 主源码保持 Java 17 语法兼容。参考 ta4j 插件会随其固定的 ta4j 0.23.0
依赖用 `--release 25` 重新编译，并由固定 Temurin 25 JRE 执行。

## 离线自测

```powershell
python scripts/check.py `
  --jdk-home C:\path\to\jdk-25.0.4+7 `
  --python-transcript ..\candlescope-plugin-sdk\tests\fixtures\hello_command_transcript_v2.json
```

测试会以 `--release 17` 编译 SDK 与独立测试插件，验证 Python/Java transcript
逐帧 digest 一致，并覆盖 Unicode、数字、消息边界、generation、Host call 和取消。
