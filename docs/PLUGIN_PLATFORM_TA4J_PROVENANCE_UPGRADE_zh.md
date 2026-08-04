# ta4j Adapter provenance 与升级指南

> 本文规定 `candlescope.ta4j-elliott` 如何冻结上游、如何验证当前版本，以及将来如何升级。
> 升级 ta4j、JDK/JRE、任一 Maven 依赖或 Adapter 都必须是独立、可回滚的变更。

## 1. 当前冻结基线

| 项目 | 当前值 |
| --- | --- |
| upstream repository | `https://github.com/ta4j/ta4j` |
| upstream release | `0.23.0` |
| upstream source | 固定 tag + `supply-chain.lock.json` 中完整 commit |
| public API | `org.ta4j.core.indicators.elliott.ElliottWaveAnalysisRunner` |
| reference Adapter | `0.1.0` |
| Marketplace candidates | `0.1.1`、`0.1.2` |
| compiler baseline | Temurin JDK `25.0.4+7` |
| local/SDK runtime | `temurin-25.0.4.7` |
| Marketplace AppContainer runtime | `temurin-26.0.2.10` |
| protocol | `candlescope.plugin/2` JSONL/1 |
| supported Host | Windows 11 x86_64 |

锁文件：`examples/plugins/ta4j-elliott-adapter/supply-chain.lock.json`。其中固定 ta4j-core、Gson、
SLF4J API、Commons Math、JDK/JRE 下载来源、大小、SHA-256 和许可证。不得用 Maven `LATEST`、动态
版本范围、本机缓存中的同名文件或系统 `java` 替代。

JDK 25 用于确定性编译与 Java SDK/reference 路径；Marketplace 包运行在已通过 Windows
AppContainer 门禁的 Temurin 26。两者职责不同，不能把 JRE 26 的沙箱结论泛化到任意 JRE，
也不能在 Host 上静默选择系统 Java。

## 2. Provenance 边界

CandleScope 复用的是固定 ta4j Release 的公共 Elliott API，不是直接运行 GitHub 仓库：

```text
CandleScope canonical OHLCV snapshot
  -> thin Java Adapter
  -> ta4j BarSeries / public Elliott API
  -> candlescope.plugin/2 result + Render IR
```

Adapter 不得：

- 复制或改写 `org.ta4j.*` 核心算法；
- 访问 CandleScope 数据库、账户、secret 或网络；
- 读取请求时点之后的 K 线；
- 用 Python 插件结果选择 ta4j scenario，或反向选择 Python 输出；
- 根据最终结算/事后标签校准当前时点输出；
- 把两套不同语义的 pattern 名称强行映射成“相同答案”。

当前对照只证明两套引擎在同一 point-in-time 输入上可并行、可复现运行。它不证明谁“更强”，
也不授权删除或替换现有 Python Elliott 插件。

## 3. 当前证据应同时保留

- assessment：`docs/plugin-adapters/ta4j-assessment.md`；
- lock：`examples/plugins/ta4j-elliott-adapter/supply-chain.lock.json`；
- SBOM：`examples/plugins/ta4j-elliott-adapter/sbom/cyclonedx.json`；
- deterministic build receipts：`examples/plugins/ta4j-elliott-adapter/evidence/build-report*.json`；
- golden corpus：`examples/plugins/ta4j-elliott-adapter/evidence/golden-corpus.json`；
- Python comparison：`examples/plugins/ta4j-elliott-adapter/evidence/python-comparison.json`；
- Phase 11 语义/性能证据：`docs/evidence/plugin-platform-multi-runtime-phase11-ta4j.json`；
- Marketplace release lifecycle：`docs/evidence/plugin-platform-multi-runtime-phase10-real.json`。

冻结证据必须可在离线 cache 中重放。SLF4J 未绑定 provider 时的有界诊断 stderr 是当前已知行为；
它不得出现在 stdout，也不得导致 protocol transcript 改写。若将来添加 logger provider，属于依赖和
行为变更，必须走完整升级流程。

## 4. 升级触发条件

升级可以由安全修复、JDK/JRE 生命周期、上游 bug 修复或明确的新公共 API 触发。仅有“上游发布了
新版本”不是自动升级理由。先写升级说明，包含：

1. 旧版与新版完整版本和 commit；
2. 触发原因、受影响能力和不升级风险；
3. 上游 release notes、许可证、构建系统和公开 API 变化；
4. 传递依赖及 CVE/许可证变化；
5. JDK 编译目标、JRE runtime 与 AppContainer 兼容性；
6. 数据语义、Render IR 和性能可能变化；
7. rollout、撤销和历史 rollback 方案。

## 5. 独立升级步骤

### 5.1 只读评估

1. 用 `v3 assess-github` 固定新 tag/commit；评估阶段只读 metadata/archive，不 clone/build/run；
2. 审阅 LICENSE、NOTICE、release notes、POM/module graph 和目标公开 API；
3. 比较旧/新 dependency graph、最低 Java 版本和 binary compatibility；
4. 判断现有 thin Adapter 能否继续只用公共 API；
5. 记录是否需要新的权限、网络、文件或子进程；需要时停止并单独做威胁评审。

### 5.2 新锁文件和供应链

1. 在独立分支复制旧 lock 为候选，不覆盖已发布 lock；
2. 为每个 artifact 写入 canonical URL、version、size、SHA-256、license、purl；
3. 固定新 JDK/JRE archive 与 Runtime Registry revision；
4. 更新 SBOM、license inventory、provenance、rebuild instruction 和 build receipt；
5. 下载到全新 cache 后断网重建，证明没有 undeclared download；
6. 保留旧 cache 和旧 immutable release，不能就地覆盖。

### 5.3 构建和协议门禁

1. 在两个空 staging 目录用相同锁执行构建；
2. 比较 Adapter JAR 和 `.cspkg`，要求分别 byte-identical；
3. 用 `javac --release 17 -Xlint:all -Werror` 构建 Java SDK 基线；
4. 启动真实候选 JAR，重放 descriptor、health、invoke、cancel、shutdown transcript；
5. manifest、descriptor、release statement 的 plugin/Adapter/ta4j/runtime 版本必须一致；
6. stdout 必须只有 canonical JSONL；stderr 必须有界且脱敏；
7. fresh、offline repeat、update、rollback、revocation 全部通过。

### 5.4 Point-in-time 业务验证

候选版本必须重新运行当前五组冻结 corpus，并增加能覆盖新行为的样本：

- 空数据；
- 120/240 根趋势震荡；
- 180 根 impulse profile；
- 最后一根 non-final；
- 大样本性能输入。

每个 case 单独记录 input SHA、bar count、ta4j output SHA、scenario/pivot、warning、elapsed time；
检查所有 pivot/index/time 都不超出请求 snapshot，`futurePivotCount` 必须为 `0`。Python 插件以同一
输入独立运行，报告分歧但不把一方当 oracle，也不以事后行情选择胜者。

稳定输出摘要变化不是自动失败，但必须由 reviewer 解释为预期上游语义变化，并为回滚保存旧摘要。
未解释的变化、未来数据、非确定性或无法重放都是阻断项。

### 5.5 性能与资源门禁

在与基线相同的机器/电源模式下记录：

- JVM startup；
- cold invoke；
- hot p50/p95；
- 5,000 bars elapsed；
- 峰值 RSS、线程、句柄；
- crash/hang 后清理时间和零残留。

若超出当前 budget，不得只调高阈值；先定位 JDK、依赖、算法、日志或 Adapter 映射差异。必要时保持
旧版本 stable，让新版只进入 preview。

## 6. Marketplace 推进

1. 为候选版本创建新的 append-only release，不修改旧 record；
2. publisher 分别签 artifact/release statement；Marketplace root 签新 index；
3. 验证 Registry ancestry、Temurin artifact、SBOM/license/provenance 精确绑定；
4. 在空产品根完成 fresh、offline repeat、update、历史 rollback、revocation；
5. 使用真实 AppContainer 和 Job Object 验证 process limit 与零残留；
6. 按 `internal -> opted-in-local -> preview -> stable` 推进；
7. 每阶段只读观察错误码、启动、延迟、资源和 rollback 成功率；
8. stable 前完成连续 4 小时多插件 soak 与全量 GA gates。

完整发布项见 `PLUGIN_PLATFORM_MARKETPLACE_RELEASE_CHECKLIST_zh.md`。

## 7. 回滚

升级必须能独立回滚：

1. 停用候选 activation；
2. 将候选从 active 降为 staged；
3. 选择旧 immutable release；
4. 重新确认旧 release 的权限，禁止静默继承；
5. reconcile 和 health observation 后恢复 active；
6. 若供应链有风险，追加 signed revocation，把候选 cache payload 移入 quarantine；
7. 保留旧/新 lock、JAR、bundle、receipt、corpus 和日志供比较；
8. 必要时关闭 `CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED=0`，不影响 Python 与其他 runtime。

禁止为了回滚删除整个插件根、Grant Store、用户 K 线或旧证据。详细命令与验证见
`PLUGIN_PLATFORM_ROLLBACK_RUNBOOK_zh.md`。
