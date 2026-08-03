# CandleScope Rust/WASM Reference

这是 Phase 8 的最小 `wasm-component` 参考插件：同一份 `main.wasm` 在 Windows 和
Linux 上由固定 Wasmtime 47.0.3 执行，入口为 `wasi:cli/run`，协议为
`candlescope.plugin/2` + `jsonl/1`。

构建固定使用 Rust 1.97.1、`wasm32-wasip2`、`--locked` 与离线依赖图。插件没有第三方
crate，不读取 Host 文件或环境，不获得网络和子进程能力。`sandboxProbe` 与 fault input
仅用于 Phase 8 的真实门禁；正常贡献只返回 canonical JSON 的问候与安全整数求和。

运行时 artifact 必须由 Host-managed Runtime Registry 提供，绝不回退到 PATH 上的
Wasmtime。
