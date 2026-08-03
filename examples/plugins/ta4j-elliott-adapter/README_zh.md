# ta4j Elliott Wave 参考 Adapter

这是 CandleScope `java-jar` Provider 的首个参考插件。它把 Host 提供的逐时点
OHLCV 转成 ta4j `BarSeries`，调用固定在 ta4j 0.23.0 Release 的公开
`ElliottWaveAnalysisRunner`，再映射为 CandleScope 分析结果和 Host-owned
Render IR v2。

边界是刻意收紧的：Adapter 不下载行情、不读取 CandleScope 数据库、不复制
ta4j 算法，也不把当前 Python Elliott 插件自动替换掉。两者必须用相同冻结输入
并行评估，升级上游版本时也必须重新跑同一 corpus。

## 离线构建

先按 `supply-chain.lock.json` 准备 Temurin JDK 25.0.4+7 和四个 Maven JAR，
然后运行：

```powershell
python scripts/build_release.py `
  --jdk-home C:\path\to\jdk-25.0.4+7 `
  --dependency-cache C:\path\to\maven-cache
```

脚本不访问网络；它先验证每个依赖的大小和 SHA-256，再以固定时间戳、排序路径
和固定压缩级别生成 fat JAR。MIT、Apache-2.0、Commons Math 完整原始
LICENSE/NOTICE、SLF4J 原始 LICENSE、第三方 attribution 和 Adapter GPL 正文都随
JAR / bundle 分发；独立检查会逐字节核对这些法律文件。Phase 5 的 `0.1.0` 源码、JAR、
lock、golden corpus 和真实证据继续冻结不改。Phase 10 的发布者构建会在临时目录复制这份
已审核源码，只允许把唯一的 `ADAPTER_VERSION = "0.1.0"` 常量替换为显式稳定 SemVer，
再完整编译；缺失或出现多个版本戳都会 fail closed。因此它不会改写冻结基线，也不会产生
manifest、运行时 descriptor 与 Marketplace release 版本不一致的包。

`0.1.1` / `0.1.2` 候选均由冻结的 JDK 25、同一依赖和固定压缩规则构建；运行时只接受
Runtime Registry 管理、已通过 Windows AppContainer 门禁的 `temurin-26.0.2.10`。
Phase 10 的发布者侧命令如下（初始 `0.1.1` 只需替换版本参数）：

```powershell
python scripts/build_release.py `
  --jdk-home C:\path\to\jdk-25.0.4+7 `
  --dependency-cache C:\path\to\maven-cache `
  --candidate-version 0.1.2 `
  --output C:\publisher-staging\ta4j-elliott-adapter-0.1.2.jar `
  --report C:\publisher-staging\build-report-0.1.2.json
```

候选构建只能写到锁定 `runtime/` 之外；`evidence/build-report-0.1.1.json` 与
`evidence/build-report-0.1.2.json` 分别固定摘要
`sha256:1143e70ad368445b8e7eaec1c2f1fdc40ca7127bd453932f5c51fe03c6930c56` 和
`sha256:a8ba1e917f8fee9c2e5be10407ebcd97c3f0b4347a74b1a8251c830b86b122ab`。
它在发布者/CI 侧先构建并签名，Marketplace 用户机器只下载预构建 `.cspkg`，绝不执行
源码编译或系统 runtime fallback。Java Provider 默认由
`CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED=0` 关闭。

## 数据契约

命令输入含 `market` 与 `settings`。`market` 只描述 exchange、symbol、interval、
截止时间和数量；真正的 bars 通过 `market.bars.read` Host call 获取。响应包含：

* scenario id、degree、pattern、phase 和 direction；
* pivot 的 index、time、price；
* invalidation、targets 与上游置信度分量；
* warnings、输入/版本 provenance 和 Render IR v2。

所有 bars 都必须不晚于请求的 `asOf`，时间严格递增，间隔一致，数值有限且非负。
未收盘末柱会被明确标记，不会借用未来柱校准结果。
