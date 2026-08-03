# CandleScope Node.js / TypeScript reference plugin

这是多运行时插件平台 Phase 7 的离线参考实现。源代码使用 TypeScript，发布制品是
预编译的 ESM 模块图：`runtime/main.mjs` 加固定摘要的 `runtime/sdk.mjs`。CandleScope
安装、probe、启动和更新过程中都不会调用 npm、npx、corepack 或 TypeScript 编译器。

Host 使用签名 Registry 中固定的 Node.js 24.19.0 LTS，并添加 Permission Model、
`--no-addons`、`--no-global-search-paths`、AppContainer 和 Job Object。首版拒绝 CJS、
动态 import、bare package resolution、loader hook、child process 和 worker 声明。

`source-maps/main.mjs.map` 是可选调试制品；构建脚本会把其中的本机绝对路径清除，
Provider 只允许它从 `content/source-maps` 读取。

作者构建可以使用仓库锁定的 TypeScript，但 Release bundle 本身完全离线可运行。
