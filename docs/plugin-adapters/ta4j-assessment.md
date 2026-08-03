# ta4j 0.23.0 CandleScope 接入评估

> 状态：`PHASE0_SOURCE_FROZEN`
>
> 评估日期：2026-08-03
>
> 本文件只冻结上游身份、接入边界和后续验收项；Phase 0 没有下载 Maven
> 发行物、构建 Adapter、安装 JRE 或宣称 Java 插件已经可运行。

## 1. 结论

ta4j 属于“有稳定 Java 公共 API 的纯库”，适合通过 `java-jar` Runtime Provider 和薄
Adapter 接入。CandleScope 不应重写其 Elliott Wave 核心，也不应让现有 Python 插件用
`subprocess` 套娃启动 JVM。

首个 Adapter 的建议边界是：

- Host 提供 point-in-time OHLCV；
- Adapter 转换为 ta4j `BarSeries`；
- Adapter 调用 `ElliottWaveAnalysisRunner`；
- Adapter 将结果转换为 CandleScope 版本化结果与 Render IR；
- ta4j 和 Adapter 都不直接访问 CandleScope DB、交易所网络、账户、密钥或交易接口。

当前评估允许进入 Plugin Platform multi-runtime Phase 5 的实现准备，但还不满足打包、
Marketplace 或替换现有 Elliott 插件的条件。

## 2. 固定上游身份

| 字段 | 冻结值 | Phase 0 证据 |
| --- | --- | --- |
| Repository | `https://github.com/ta4j/ta4j` | 上游 GitHub 仓库 |
| Stable tag | `0.23.0` | `git ls-remote` 在 2026-08-03 重新验证 |
| Annotated tag object | `0f3a703b651864953c78f2e7f1b91a30778b0625` | `refs/tags/0.23.0` |
| Peeled commit | `896d7138a9d1818fe6725b89b433ba7860b8f654` | `refs/tags/0.23.0^{}` |
| Release date | `2026-07-13` | tag 中的 `CHANGELOG.md` |
| Project version | `0.23.0` | tag 中的 `pom.xml` |
| Java baseline | `25` | `maven.compiler.release` |
| Maven wrapper | `3.9.16` | tag 中的 `README.md` |
| Upstream license | MIT | `pom.xml`、`license-header.txt`、`README.md` |
| Proposed public API | `org.ta4j.core.indicators.elliott.ElliottWaveAnalysisRunner` | tag 中的 public final class |

上游链接：

- [0.23.0 tag](https://github.com/ta4j/ta4j/tree/0.23.0)
- [0.23.0 changelog](https://github.com/ta4j/ta4j/blob/0.23.0/CHANGELOG.md)
- [0.23.0 parent POM](https://github.com/ta4j/ta4j/blob/0.23.0/pom.xml)
- [ElliottWaveAnalysisRunner](https://github.com/ta4j/ta4j/blob/0.23.0/ta4j-core/src/main/java/org/ta4j/core/indicators/elliott/ElliottWaveAnalysisRunner.java)

不得将 GitHub `master` 或 snapshot 版本作为生产依赖。上游升级必须单独修改 tag、commit、
Maven 坐标、摘要、SBOM 和 golden corpus。

## 3. 项目分类

| 评估项 | 结论 |
| --- | --- |
| 项目类型 | Java library，不是 CandleScope 插件、CLI 或独立 daemon |
| 推荐 runtime kind | `java-jar` |
| 推荐 transport | Adapter 实现 `candlescope.plugin/2` over `jsonl/1` |
| Adapter 形态 | 一个包含 CandleScope Java SDK、Adapter 和固定依赖的可执行 JAR |
| Host contribution | 首版建议 `command/1`；后续可扩展 chart layer/settings |
| Host capabilities | `market.bars.read`，scope 绑定 exchange/market/symbol/interval/range |
| UI | 无直接 UI；只输出 Host-owned Render IR |
| 私有状态 | 首版不需要；若保存 profile，使用 Host settings/private storage |
| 网络 | ta4j/Adapter 分析路径不需要 direct network |
| 文件 | 分析路径不需要 direct file access |
| 账户、密钥、交易 | 明确禁止 |
| 子进程 | 不需要；`maxProcesses=1` |
| GPU/native dependency | 首版不需要 |
| 初始信任 | Phase 5 先 `trusted-local`；Marketplace 必须等待 Phase 6/10 |

## 4. 输入契约

Host 应提供一个有界、逐时点的 bars page：

```json
{
  "schemaVersion": "candlescope.market-bars-page/1",
  "exchange": "binance",
  "market": "spot",
  "symbol": "BTCUSDT",
  "interval": "1h",
  "bars": [
    {
      "openTimeMs": 0,
      "closeTimeMs": 0,
      "open": "0",
      "high": "0",
      "low": "0",
      "close": "0",
      "volume": "0",
      "final": true
    }
  ],
  "coverage": {
    "complete": true
  }
}
```

Adapter 映射必须冻结：

- `openTimeMs`、`closeTimeMs` 与 ta4j `Instant`/bar period 的关系；
- interval 与 `Duration`；
- OHLCV decimal 到 `DecimalNum` 或 `DoubleNum` 的明确选择；
- final/non-final bar 的处理；
- 缺口、重复时间、乱序、零成交量和空输入；
- maximum bars 与取消检查点；
- point-in-time：第 N 次运行不能看到 N 之后的数据。

首版禁止 Adapter 自行使用 ta4j example data source 下载 Coinbase/Yahoo 数据。那些 examples
可用于理解上游，但不能绕过 CandleScope 的市场数据真相与能力审计。

## 5. 输出契约

Phase 5 应新增并冻结 `candlescope.elliott-wave-analysis/1`，至少包含：

- Adapter 与 ta4j 版本/provenance；
- input coverage、bar count、last visible time；
- base degree 与 supporting degrees；
- ranked scenarios；
- scenario type、phase、confidence 与 confidence breakdown；
- pivot index/time/price；
- invalidation level；
- projection/target（只有上游结果存在时）；
- warnings、skipped degree 与 insufficient-history 原因；
- deterministic settings digest；
- Render IR layers。

输出不得：

- 把缺失 confidence 伪造成 0；
- 把上游 log 文本当稳定数据结构；
- 使用本机绝对路径；
- 暴露 Java exception stack trace 给普通 UI；
- 将最终行情结果写入对历史时点的判断。

## 6. 公共 API 与 Adapter 代码预算

冻结的首选调用面：

```java
ElliottWaveAnalysisRunner runner = ElliottWaveAnalysisRunner.builder()
    // Explicit, versioned settings are applied here.
    .build();

ElliottWaveAnalysisResult result = runner.analyze(series);
```

Adapter 只应包含：

1. JSONL/SDK 启动与生命周期；
2. Host bars/settings -> ta4j model；
3. ta4j result -> CandleScope result/Render IR；
4. 错误、取消、日志与 provenance；
5. 测试 fixtures。

业务映射目标约 300～500 行，不含生成模型、SDK 和测试。如果需要复制
`ElliottWaveAnalysisRunner`、scenario generator、swing detector 或 confidence model，
应停止并重新评估公共 API，而不是继续形成 fork。

## 7. 许可证与供应链

已确认 ta4j 源码声明 MIT，但这不等于可直接发布一个未知依赖集合的 fat JAR。
Phase 5/10 仍需完成：

- [ ] 从 Maven Central 固定 `org.ta4j:ta4j-core:0.23.0` 的真实 POM/JAR；
- [ ] 保存每个下载产物的 SHA-256、size 和来源 URL；
- [ ] 审计 `slf4j-api`、`commons-math3`、`gson` 等运行时传递依赖；
- [ ] 决定 thin JAR + bundle dependencies 或 deterministic shaded JAR；
- [ ] 生成 CycloneDX SBOM；
- [ ] 生成 `THIRD_PARTY_NOTICES.txt`；
- [ ] 保存可复现构建 receipt；
- [ ] 确认 CandleScope Java SDK/Adapter 自身许可证；
- [ ] 在 Marketplace 发布前完成签名与撤销记录。

Phase 0 只冻结 Git tag/commit，不冻结尚未下载验证的 Maven artifact digest。

## 8. 可重复性、性能与取消

待 Phase 5 真实验证：

- [ ] 同一 settings、Num implementation 和 bars 得到相同 canonical result；
- [ ] 冷启动、首次 analyze、热调用和 100 次重复调用；
- [ ] 1k、10k、100k bars 的时间与峰值内存；
- [ ] 空数据、短历史、异常 decimal、极端时间跨度；
- [ ] 取消能在有界时间内生效；
- [ ] JVM OOM、hang、crash、stderr flood 可被 Supervisor 诊断；
- [ ] Host stop/disable/rollback 后无残留 `java.exe`；
- [ ] 不启动额外进程或线程泄漏；
- [ ] `-Xmx` 与 Host resource profile 一致。

完整上游 Elliott calibration/replay 可能很慢，不能放入每次插件安装 probe。安装 probe
只验证协议和小型确定性语义；长 corpus 属于 CI/release gate。

## 9. Sandbox 与权限

Phase 5 首先只支持显式 `trusted-local`。进入 Marketplace 前必须证明：

- 固定 JRE 目录只读；
- bundle/JAR 只读，只有 plugin private/runtime 目录可写；
- direct network deny；
- bundle 外文件 deny；
- `maxProcesses=1`；
- Job Object 能清理整个 JVM；
- Host capabilities 仍按 handle、scope、generation 和 request context 校验；
- runtime/publisher 变化后旧 grant 不继承。

`trusted-local` 也不能自动获得账户、密钥或 Live authority。

## 10. Point-in-time 对照计划

ta4j Adapter 与现有 Python Elliott 插件先并行，不直接替换：

1. 冻结不同市场、周期、趋势、震荡与异常数据；
2. 对每个决策时点只提供当时已可见的 bars；
3. 分别保存两个插件的原始输出和 canonical digest；
4. 比较 pivot、scenario type、degree、invalidation、warning 和耗时；
5. 人工审查分歧，不以最终价格挑选“正确”算法；
6. 输出支持矩阵与失败样本；
7. 另立产品迁移门决定是否改变默认插件。

## 11. 当前未决项

| 未决项 | 所有者阶段 | 停止条件 |
| --- | ---: | --- |
| Maven JAR/依赖摘要 | 5 | 未固定则不得构建 Release bundle |
| Java SDK wire parity | 5 | 未通过统一 transcript 则不得调用 ta4j |
| Managed JRE | 4 | 缺少 pinned runtime 时不得系统 fallback |
| Result schema | 5 | 未冻结则不得宣称 Adapter 可替换现有插件 |
| Windows JVM sandbox | 6 | 未有真实负例则只能 trusted-local |
| Marketplace signing/SBOM | 10 | 未完成不得公开分发 |
| Python vs ta4j 对照 | 5/11 | 未完成不得删除或替换现有插件 |

## 12. Phase 0 结论

上游身份、公共入口、运行时要求、许可证声明与接入边界已冻结。下一次允许修改本文件的
情况只有：

- 上游 `0.23.0` 证据被证明错误；
- Phase 5 通过独立 PR 选择新的固定版本；
- 公共 API 在真实编译中与评估不符。

任何更新都必须保留旧值、变更原因、迁移与 rollback 说明。
