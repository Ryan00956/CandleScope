# CandleScope Rust native reference plugin

这是多运行时插件平台 Phase 3 的最小、无第三方依赖参考实现。它直接实现
`candlescope.plugin/2` + `jsonl/1` 控制面，用于证明 Rust/Go/C/C++ 一类单文件
native artifact 无需 Python 套娃即可由 Runtime Provider 安装、探测、监督和回滚。

本项目不是通用 Rust SDK。它只覆盖 reference transcript 所需的
handshake、describe、activate、invoke、healthCheck、cancel、deactivate 和 shutdown，
并提供只用于 Host 故障门禁的 `--mode` 参数。生产接入仍应使用后续正式 SDK 或薄适配层。

离线构建：

```powershell
cargo build --release --locked --manifest-path .\Cargo.toml
```

插件日志只能写 stderr；stdout 永远保留给 JSONL 协议。
