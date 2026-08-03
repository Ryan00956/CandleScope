# CandleScope Rust/WASM SDK

这是 CandleScope `wasm-component` 首版 SDK。它只依赖 Rust 标准库，目标固定为
`wasm32-wasip2`，通过 stdin/stdout 上的 `candlescope.plugin/2` + `jsonl/1` 与 Host 通信。

- Rust：`1.97.1`
- Component/WASI：`wasm32-wasip2`、`wasi:cli/run`
- 单条消息：最多 1 MiB
- JSON：拒绝重复键、越界深度、超大容器和非安全整数 generation
- stdout：仅协议帧；日志必须写 stderr
- 不声明网络、目录、环境变量或子进程能力

SDK 不启动包管理器、不下载依赖，也不把 WASI 权限升级为本地应用权限。
