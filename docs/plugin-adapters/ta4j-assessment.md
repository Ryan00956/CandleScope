# ta4j 0.23.0 CandleScope 接入评估与 Phase 5 验收

> 状态：`PHASE5_REFERENCE_IMPLEMENTED_DEFAULT_OFF`
>
> 初次评估 / 实现验收：2026-08-03
>
> 适用范围：Windows x86_64、CandleScope Plugin Platform v2、显式
> `local-trusted`、Host-managed Temurin JRE 25.0.4+7。

> Phase 6 运行时补充：上面的适用范围和本文后续 JRE 25 数据是 Phase 5 冻结历史。
> 当前插件包装版本 `0.1.1` 因 OpenJDK `JDK-8352728` 的 Windows AppContainer
> 兼容问题，已迁移到签名 Runtime Registry revision 3 的
> `temurin-26.0.2.10`；Adapter JAR `0.1.0`、ta4j 版本和 golden 语义未改变。
> 当前信任与沙箱证据见 `docs/PLUGIN_PLATFORM_MULTI_RUNTIME_PHASE6_zh.md`。

## 1. 最终判断

ta4j 是值得复用的成熟 Java 算法库，但它不是一个可以原样装入 CandleScope 的插件。它没有
CandleScope manifest、JSONL 生命周期、Host capability、point-in-time 数据契约、Render IR、
安装收据或进程清理协议。因此正确边界不是“重写 ta4j”或“直接运行 GitHub 仓库”，而是：

    CandleScope Host contract
      -> thin Java Adapter
      -> ta4j public Elliott API

Phase 5 已证明这条路径真实可行：固定 ta4j Release 和四个 Maven 产物，离线构建一个可重复
fat JAR，通过 `java-jar` Provider 在固定 JRE 中运行，并以 Host capability 读取 K 线。Adapter
没有复制 ta4j 的 Elliott 实现，也不访问网络或 CandleScope DB。

这并不证明现有 Python Elliott 插件“不如 ta4j”。五组相同逐时点输入显示两者的 scenario
词汇、pivot 和 invalidation 语义明显不同；非空样本的 pivot Jaccard 为 0。当前证据只支持
“并行保留和继续对照”，不支持自动替换、删除 Python 引擎或将任一输出视为交易优势。

## 2. 固定上游身份

| 字段 | 冻结值 |
| --- | --- |
| Repository | `https://github.com/ta4j/ta4j` |
| Stable Release / tag | `0.23.0` |
| Annotated tag object | `0f3a70324477e3bd7f0c943236a2bb6eeb897e29` |
| Peeled commit | `896d7138a9d1818fe6725b89b433ba7860b8f654` |
| Release date | `2026-07-13` |
| Java baseline | `25` |
| Upstream license | MIT |
| Public API | `org.ta4j.core.indicators.elliott.ElliottWaveAnalysisRunner` |

权威链接：

- [ta4j 0.23.0 Release](https://github.com/ta4j/ta4j/releases/tag/0.23.0)
- [ta4j 0.23.0 parent POM](https://github.com/ta4j/ta4j/blob/0.23.0/pom.xml)
- [ElliottWaveAnalysisRunner 0.23.0](https://github.com/ta4j/ta4j/blob/0.23.0/ta4j-core/src/main/java/org/ta4j/core/indicators/elliott/ElliottWaveAnalysisRunner.java)
- [Maven Central ta4j-core 0.23.0](https://repo.maven.apache.org/maven2/org/ta4j/ta4j-core/0.23.0/)

Adapter 只接受 tag 中实际存在的 `ORTHODOX_CLASSICAL` 等 profile。GitHub 默认分支后来出现、
但 0.23.0 不存在的 `INTRADAY_LIVE` 会被拒绝，避免把默认分支文档误当稳定 Release API。

## 3. 固定发行物与依赖

`supply-chain.lock.json` 是这一参考实现的制品事实源：

| 制品 | 版本 | 大小 | SHA-256 | 许可证 |
| --- | ---: | ---: | --- | --- |
| ta4j-core | 0.23.0 | 1,823,748 | `5cd1765cd309f7f99a458d7078fa65e1bec9db2fd51fb2a82496e3b033d26169` | MIT |
| slf4j-api | 2.0.18 | 69,982 | `44508fd1576500688c790b190acdd16fec4f8c79a3e0b900afd70503cf055f55` | MIT |
| commons-math3 | 3.6.1 | 2,213,560 | `1e56d7b058d28b65abd256b8458e3885b674c1d588fa43cd7d1cbb9c7ef2b308` | Apache-2.0 |
| gson | 2.14.0 | 313,604 | `2cbd119bf1961c28788310963dc80ba65f58cdeec1dd139c8bdb1240faa2c36f` | Apache-2.0 |
| Adapter fat JAR | 0.1.0 | 4,435,729 | `19c60a36d178d9e9340c4133ed0d60f4d80e4c19c3e17e01aaca6231bdcd6060` | GPL-3.0-only + 完整上游 licenses/notices |

编译器固定为 Temurin JDK 25.0.4+7：

- archive size：141,164,204 bytes；
- SHA-256：`7caab7db43bf4b94a2e6252c699e70d90084f9aa7c943cd3414761fd540937ae`；
- 构建脚本不联网，不运行 Maven/Gradle，也不从系统 classpath 猜依赖；
- 所有依赖先校验大小与 SHA-256；
- ZIP 路径排序、时间戳、权限和压缩级别固定；
- 两个干净构建得到完全相同 JAR。

运行时固定为 [Temurin 25.0.4+7](https://github.com/adoptium/temurin25-binaries/releases/tag/jdk-25.0.4%2B7)
Windows x64 JRE：

- runtime id：`temurin-25.0.4.7`；
- archive size：58,474,646 bytes；
- SHA-256：`5b0d58f043f762fa3ee6cc12b6774b59b245cafdcb357e45ce61f822aa9a56cb`；
- extracted inventory：320 files / 187,841,444 bytes；
- legal inventory：183 files / 231,846 bytes；
- vendor checksum、metadata、SBOM、signature 各自固定摘要和大小；
- Runtime Registry revision 2 由新 key 签名并连续引用 revision 1，可显式回滚。

仓库同时保存 CycloneDX SBOM、`THIRD_PARTY_NOTICES.txt`、build report 和 semantic
transcript。JAR/bundle 含完整 Apache-2.0、MIT、GPL 和 attribution；构建器还把锁定
Commons Math/SLF4J JAR 中的原始 LICENSE/NOTICE 原样保留在独立路径，独立检查逐字节验证
全部 8 项。Marketplace 发布签名仍属于 Phase 10，不能把本地参考制品宣传为 Marketplace
已审计发行版。

## 4. 项目与运行边界

| 评估项 | 已实现结论 |
| --- | --- |
| 项目类型 | Java library；通过 Adapter 变成 CandleScope command plugin |
| runtime kind | `java-jar` |
| transport | `candlescope.plugin/2` over strict `jsonl/1` |
| contribution | `command/1`：`analyze-ta4j-elliott` |
| Host capability | `market.bars.read` |
| numeric implementation | ta4j `DecimalNum` |
| UI 输出 | Host-owned `candlescope.render/2` |
| 网络 / DB | Adapter 均不直接访问 |
| 子进程 | 只允许主 JVM，`maxProcesses=1` |
| runtime | 只接受 Host-managed exact JRE；无 PATH/system fallback |
| trust | 当前仅 `local-trusted`；Phase 6 前不宣称 Marketplace sandbox |
| 账户、密钥、交易 | 未声明且不可获得 |

Adapter 主入口和映射代码共 632 行（含严格输入校验、输出投影与 Render IR），没有
`org.ta4j.*` 实现类副本。核心分析仍直接调用：

```java
ElliottWaveAnalysisResult result = ElliottWaveAnalysisRunner.builder()
    .degree(settings.degree())
    .logicProfile(settings.logicProfile())
    .minConfidence(settings.minConfidence())
    .maxScenarios(settings.maxScenarios())
    .scenarioSwingWindow(settings.scenarioSwingWindow())
    .build()
    .analyze(series);
```

因此 CandleScope 维护的是协议和数据映射，不是另一个 Elliott 算法 fork。

## 5. 输入与 point-in-time 契约

命令输入只描述要读取的数据和分析设置：

```json
{
  "market": {
    "context": {"mode": "live", "exchange": "binance", "marketType": "spot"},
    "series": {"symbol": "BTCUSDT", "interval": "1h"},
    "limit": 120
  },
  "settings": {
    "degree": "MINUTE",
    "logicProfile": "ORTHODOX_CLASSICAL",
    "higherDegrees": 0,
    "lowerDegrees": 0,
    "minConfidence": 0.0,
    "maxScenarios": 5,
    "scenarioSwingWindow": 0
  }
}
```

Adapter 不接受调用者直接夹带 bars。它以 activation 中的 opaque capability handle 发起
`market.bars.read` Host call，Host 返回 `candlescope.market-bars-page/1`：

- `context`、`series` 必须与请求完全一致；
- 时间使用 epoch seconds，严格递增；
- interval 转成 ta4j bar period；
- OHLCV 接受有界 JSON number/string decimal，再进入 `DecimalNum`；
- `high/low/open/close` 关系必须有效；
- 只有最后一根允许 `is_closed=false`，并生成明确 warning；
- 最多 5,000 根，5,001 根 fail closed；
- coverage、sourceQuality 和 pagination 原样进入 input provenance；
- 输出 pivot index 必须小于当时可见 bar count；
- Adapter 不下载示例数据，也不读取本地数据库。

独立测试覆盖空页、非终结末柱、重复时间拒绝、精确小数、时间戳上界、5,000 根上限和
超限拒绝。相同输入运行两次必须得到相同 canonical digest。

## 6. 输出契约

输出固定为 `candlescope.elliott-wave-analysis/1`，包含：

- Adapter 0.1.0、ta4j 0.23.0、tag、commit、Maven artifact digest；
- `DecimalNum` 数值类型；
- input coverage、source quality、pagination、bar count 和 last visible time；
- 版本化 settings 与 canonical settings digest；
- ranked scenarios；
- degree、pattern、phase、direction；
- pivot index/time/price；
- invalidation、Fibonacci targets 和上游 confidence 分量；
- 空数据、短历史、non-final、coverage 和 ta4j note warnings；
- `candlescope.render/2` polyline/marker/text 等 Host-owned Render IR；
- point-in-time、Host-owned data、无 direct network/DB、未复制上游算法的 provenance。

Adapter 只在上游公开结果有对应语义时输出 confidence/target，不根据未来行情补写历史结果，
也不把 Java exception 或本机路径放进普通产品结果。

## 7. Java SDK 与 Provider 适配结论

Java SDK 是零第三方依赖的协议层，主源码保持 Java 17 语法兼容；ta4j Adapter 因上游要求
使用 `--release 25`。SDK 已覆盖：

- strict UTF-8 JSON、duplicate-key/Unicode/non-finite/safe-integer 检查；
- 1 MiB message、32 depth、10,000 container items、256 KiB string；
- handshake、describe、activate、invoke/eventBatch、healthCheck、cancel、
  prepareUpgrade、deactivate、shutdown；
- request id、generation、Host call correlation 和陈旧 response 拒绝；
- 原始 stdout 专用于 JSONL，插件 `System.out` 被重定向到 stderr；
- graceful shutdown、pending 取消和 health pending 观测；
- 与 Python SDK 冻结 transcript 的逐帧 digest 完全一致。

`java-jar` Provider 已覆盖：

- Java 开关默认关闭；
- JAR inventory、大小写重复、路径、symlink/executable/encryption、压缩比和大小边界；
- descriptor 与 JAR Manifest 的 Main-Class 双重一致；
- 主类存在、class magic 和最高 class major/JRE 兼容；
- JAR digest 与 bundle immutable inventory 一致；
- JVM 参数只允许有界 `Xms/Xmx` 和批准 GC；
- Host 固定 encoding/headless/locale/OOM policy；
- runtime 只能从签名 Registry 精确解析；
- `shell=false`、隔离搜索路径、Windows process tree 和 `maxProcesses=1`；
- 安装、检查和运行时都重新验证，不信任旧 receipt。

## 8. Golden corpus 与 Python 对照

ta4j golden corpus 固定五组输入：空数据、120/240 根趋势震荡、180 根 impulse profile、
120 根 non-final 末柱。整体 cases digest 为：

`sha256:1c5119a4f990e0c246cff94e23e7b1569e39d4ccdfdac522425531ee7299e17b`

Python 对照固定本地 sibling worktree commit：

`bd2846d4a1d9f83ba965d91b1a6e22340fc22a61`

稳定对照 digest 为：

`sha256:04fa67c73ad3dfedb1c788d7d4fc56d79f1e90ccf08837d386a9251e9c49904c`

对照只比较同一时点可见的输入；elapsed time 不进入 stable digest。结果显示：

- 两边都没有 future pivot；
- 空数据均无 candidate/scenario；
- 其他样本的 pivot 语义不一致，不能按名称直接等价；
- Python 在部分样本没有 candidate，ta4j 仍返回 5 个 scenario；
- pattern 命名、invalidation 和置信度来源不同；
- 当前 `migrationDecision=not-approved`、`automaticReplacement=false`、
  `hindsightCalibration=false`。

要判断哪个引擎对产品更有价值，仍需 Phase 11 使用真实市场、决策时点标签、失败样本和稳定性
门槛，而不是用代码量、图形数量或回看后的走势挑赢家。

## 9. 真实运行验收

Windows x86_64 真实门禁完成：

| 项目 | 结果 |
| --- | --- |
| Java SDK 独立自测 | PASS |
| Adapter 独立 golden/boundary 自测 | PASS |
| 干净离线 JAR 构建 | 两次 byte-identical |
| JRE 首次获取 | 5 个固定文件 |
| quick repeat / offline | 均命中，不联网 |
| fresh install / check | active，fresh-process transcript digest 匹配 |
| update / rollback | 回到精确初始 bundle digest |
| Core cold invoke | 291.717 ms（本机证据，不作为通用 SLA） |
| 100 次 hot invoke | median 62.160 ms，p95 96.953 ms |
| 相同结果 digest | 100 次一致 |
| 取消 | 阻塞中的 Host market read 被取消，pending=0 |
| Host stop | 0 residual `java.exe`，0 supervisor |
| Java flag off | contribution unavailable，0 supervisor，无 fallback |
| Registry rollback | revision 2 -> 1 后 Java 25 精确不可用，再恢复 revision 2 |

故障矩阵：

| 故障 | Host 稳定诊断 |
| --- | --- |
| JVM crash | `PLUGIN_PLATFORM_EXITED` |
| startup hang | `PLUGIN_PLATFORM_TIMEOUT` |
| real heap OOM | `PLUGIN_PLATFORM_RESPONSE_INVALID_JSON` |
| stderr flood | `PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED` |

Temurin 25 Windows 的 `ExitOnOutOfMemoryError` 横幅会出现在 stdout，因此 Host 在 EOF 之前
按“协议 stdout 被污染”关闭进程。这仍是 fail closed 的准确观测；不能伪写成普通 EOF。

机器证据保存在
`docs/perf-baselines/plugin-platform-v2/multi-runtime-phase5-2026-08-03-windows-amd64.json`。

## 10. Plugin Manager 可见性

Java activation 的 catalog 入口现在明确投影：

- `runtimeKind=java-jar`；
- `runtimeId=temurin-25.0.4.7`；
- Adapter JAR SHA-256；
- `trustLevel=local-trusted`；
- JRE version、archive digest、size、license；
- Registry id/revision/digest；
- `verificationStatus=verified`、`reproducible=true`；
- Adoptium upstream source URL。

Phase 6 会把 trust mode 和权限选择做成更完整的产品 UX；Phase 5 的 catalog 已足够让 Manager
不把 Java、插件 JAR 和 JRE 来源混成一个黑箱。

## 11. 开关、回滚与未完成边界

默认状态：

```text
CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED=0
CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED=0
CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_ENABLED=0
CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED=0
```

回滚顺序：

1. 停用 `candlescope.ta4j-elliott` activation；
2. 将 `CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED` 设为 `0`；
3. 如需供应链回退，显式把 Runtime Registry revision 2 回滚到 revision 1；
4. 保留 content-addressed JRE/JAR 和 rollback history，不删除仍被引用的制品；
5. Python v2 插件和 v1 compatibility 不受影响。

仍未宣称完成：

- Windows Java AppContainer/sandbox attack matrix（Phase 6）；
- Linux/macOS/arm64 支持；
- 任意 GitHub URL 自动构建；
- Maven/Gradle 安装脚本执行；
- Marketplace publisher signing/revocation（Phase 10）；
- ta4j 成为默认 Elliott 引擎（需要单独产品迁移门）；
- 实盘交易能力。

## 12. 升级规则

ta4j、JDK、JRE 或任一依赖升级必须独立评审，并同时更新：

1. tag object、peeled commit、Maven coordinates；
2. JAR/POM/JDK/JRE/evidence 的 size 与 SHA-256；
3. licenses、SBOM、third-party notices；
4. class major 与 runtime registry release；
5. 两次离线可重复构建；
6. Java SDK transcript；
7. Adapter golden corpus 和 5,000-bar boundary；
8. Python point-in-time 对照；
9. fresh install、update、rollback；
10. crash/OOM/hang/stderr 和 residual process gate。

任何一项漂移都必须 fail closed；不能跟随 GitHub 默认分支、系统 Java 或未固定 Maven cache
静默继续。
