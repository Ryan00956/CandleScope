# CandleScope TypeScript / Node.js Plugin SDK

这是 Plugin Platform v2 的零运行时依赖 Node.js SDK。它实现
`candlescope.plugin/2` + `jsonl/1`，包括完整生命周期、严格有界 JSON、请求代际、
取消、`host.call` 关联和 stdout 协议隔离。

首个 Node Provider 只接受预构建的 ESM `.mjs` 模块图。插件安装、探测和运行时
都不会调用 npm、npx、corepack、TypeScript 编译器或 lifecycle script。作者可在
发布前使用任意构建工具，但提交给 CandleScope 的 bundle 必须已经包含全部相对 ESM
模块及固定摘要。

最小入口：

```ts
import {
  CandleScopePlugin,
  servePlugin,
  type InvokeRequest,
  type JsonObject,
  type RuntimeDescriptor,
} from "@candlescope/plugin-sdk-node";

class Plugin extends CandleScopePlugin {
  describe(): RuntimeDescriptor { /* 返回静态 descriptor */ }
  invoke(request: InvokeRequest): JsonObject { /* 返回 JSON object */ }
}

process.exitCode = await servePlugin(new Plugin());
```

日志请写 stderr。`servePlugin()` 会保留启动时的原始 stdout 作为协议输出，并将
后续 `console.log()` / `process.stdout.write()` 重定向到 stderr。
