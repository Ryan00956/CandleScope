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
JAR / bundle 分发；独立检查会逐字节核对这些法律文件。`0.1.1` 是只迁移运行时供应链、
不改变 Adapter JAR 的打包修订：编译仍由冻结的 JDK 25 完成，运行时只接受 Runtime Registry
管理、已通过 Windows AppContainer 门禁的 `temurin-26.0.2.10`。Java Provider 默认由
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
