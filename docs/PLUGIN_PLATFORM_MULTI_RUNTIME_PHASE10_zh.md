# CandleScope 多运行时插件平台 Phase 10 完成证据

## 1. 阶段结论

Phase 10 已把 Marketplace 从单一 Python-era release 扩展为按 OS/arch 独立签名、同时绑定
插件产物与 Host-managed runtime 的多运行时供应链。当前真实声明范围是 Windows x86_64：

- Java reference：`candlescope.ta4j-elliott` `0.1.1` / `0.1.2`；
- native reference：`candlescope.aho-corasick` `0.1.0`；
- 每个 `.cspkg` 有独立 Ed25519 签名、SHA-256、size、manifest/SBOM/license inventory；
- Java 同时绑定 Runtime Registry revision 5、Registry digest、Temurin JRE digest和许可证；
- fresh install、offline repeat、Java update、历史 rollback、native revocation quarantine、
  AppContainer 真实进程与零残留全部通过；
- Marketplace 与 telemetry 默认仍关闭，更新仍为人工 staged lifecycle。

这不是“允许 Marketplace 任意执行 GitHub 仓库”。Marketplace 只接受已经审核并预构建的
`.cspkg`；源码编译、系统 runtime fallback、未声明下载和跨平台假声明都会 fail closed。
本地可信插件仍由用户独立管理，不能被 Marketplace 静默接管或升级信任。

## 2. 实施前背景与决策

实施前的 Marketplace v1 已经具备根密钥固定、index 签名、publisher 签名、透明日志、HTTPS
origin、不可变 release、手动安装/更新、过期与撤销检查。这些边界保留不变，但 v1 仍有四个
多运行时缺口：

1. 一个 release 只有一个通用 artifact，无法按 `windows/linux/macos + x86_64/arm64` 独立签名；
2. release 没有绑定 entrypoint runtime kind、插件内 runtime artifact 与 Managed Runtime Registry；
3. catalog 不能分别表达 publisher verification、official maintenance、sandbox 和 permissions；
4. 缺少 rollout、verified offline artifact cache、corruption/revocation quarantine 和隐私受限遥测。

Phase 10 的选择是新增 `candlescope.marketplace-index/2`，而不是修改 v1 wire。v1 parser、catalog、
status 与安装语义继续兼容；只有 v2 index 才返回新增字段。

## 3. 已执行计划

1. 审计 Marketplace v1、Installer、Trust UX、Runtime Registry、AppContainer 与 Plugin Manager；
2. 冻结 index v2、publisher verification tier、multi-runtime release 与 signed artifact；
3. 增加 Host platform selection、minimum Host、rollout 与严格 review policy；
4. 把 manifest runtime entrypoint、bundle content、SBOM、license inventory 和 signed release 对齐；
5. 将 Java host runtime 绑定到 active Registry ancestry，并拒绝 rollback 后的 forward revision；
6. 实现 verified artifact cache、offline repeat、corruption/revocation quarantine receipt；
7. 实现默认关闭、仅本地聚合、无上传能力的 telemetry；
8. 在 Plugin Manager 分开展示发布者验证、官方维护、沙箱、权限与 rollout；
9. 构建可复现的 ta4j `0.1.1` / `0.1.2` 发布候选且保持 Phase 5 冻结产物不变；
10. 构建 Aho-Corasick native Marketplace wrapper，并补齐 SBOM application license；
11. 生成三段签名 index：初始发布、Java 更新、native 恶意 artifact 撤销；
12. 在空临时产品根执行真实 fresh/offline/update/rollback/revocation 生命周期；
13. 保存 machine-readable evidence、增加回归测试并更新执行文档。

## 4. Index v2 与签名边界

### 4.1 Release 与 platform artifact

一个 release 包含：

```text
pluginId + version + publisherId
  -> artifacts[os, arch, artifactId]
     -> file/url/sha256/size
     -> manifestSha256/sbomSha256/licenseInventorySha256
     -> runtimeBindings[]
     -> provenance
     -> reviewPolicy
     -> artifact Ed25519 signature
  -> minimumHostVersion
  -> rolloutStage
  -> officialMaintained
  -> permissions
  -> SHA256SUMS + digest
  -> release Ed25519 signature
  -> append-only transparency record
```

同一 release 的 platform tuple 必须排序且唯一；Host 只选择本机精确 `os/arch` artifact。没有唯一
匹配时不可下载，不允许退回另一个平台或 source build。

### 4.2 三层信任

- **root/index**：build-pinned Marketplace root 验证 canonical index；sequence、previous index digest、
  expiry 和 append-only release/revocation 均受保护；
- **publisher/release**：publisher key 分别签 artifact statement 和 release statement；
- **transparency**：所有 release 形成连续 log index + previous record hash chain。

真实 gate 使用只注入临时平台、明确标记为 non-production 的可复现 reference key。它没有加入
产品默认 root，不能用于部署 Marketplace；用途只是让 CI 可重复验证完整签名链。

## 5. Runtime、SBOM、许可证与 provenance 绑定

每个 runtime binding 必须同时匹配 manifest entrypoint 与 bundle content：

| runtime kind | supply source | 额外绑定 |
| --- | --- | --- |
| `python-module` | `host-python` | wheel/content digest |
| `native-executable` | `plugin-bundled` | executable path + digest |
| `java-jar` | `host-managed` | Registry id/revision/digest + JRE digest/license |
| `node-module` | `host-managed` | Registry 绑定；Phase 10 未新增平台声明 |
| `wasm-component` | `host-managed` | Registry 绑定；Phase 10 未新增平台声明 |

Java binding 只有在指定 Registry revision 位于当前 active Registry ancestry 时有效。Registry 回滚
后，来自未来 revision 的 Marketplace binding 会被拒绝；全局 runtime revocation 同样优先于缓存。

SBOM 门禁验证：

- `metadata.component` 的 name/version/license 精确匹配 release；
- 每个 component 的规范化 name/version/license 与 signed dependencies 完全相等；
- bundled wheel 必须被 dependency inventory 覆盖；
- plugin、dependencies、runtime licenses 的 canonical inventory digest 必须相等。

provenance 固定 HTTPS repository、完整 40 位 commit、build receipt URL/digest、rebuild instruction
URL/digest 和 `reproducibleBuilds=true`。review policy 只允许：

```json
{
  "distribution": "prebuilt-only",
  "sourceBuild": false,
  "systemRuntimeFallback": false,
  "undeclaredDownloads": false
}
```

## 6. ta4j 版本一致性修复

第一轮真实门禁正确拒绝了旧参考组合：plugin manifest 已是 `0.1.1`，但冻结 JAR descriptor 仍返回
`0.1.0`。随后又发现旧 control transcript 的响应摘要也包含 `0.1.0` 身份。处理方式不是放宽
descriptor 或 transcript 校验，而是：

1. 保留 Phase 5 的 `0.1.0` source/JAR/lock/golden/evidence 逐字节不变；
2. 发布者构建在临时目录复制已审核源码，只替换唯一版本常量；
3. 以固定 JDK 25、四个固定 Maven artifact 和确定性 JAR writer完整编译 `0.1.1` / `0.1.2`；
4. 实际启动每个候选 JAR，重放 8 帧 control transcript；
5. 将该版本 response/transcript digest 写回临时 manifest 与 bundle；
6. 两次隔离 publisher build 与 `.cspkg` build 必须 byte-identical。

不可变源码检查点为 `07f6659d915081c2639f59ee82a87c32c9eccf36`。候选 JAR 只在发布者侧
构建；Marketplace 安装阶段只接收预构建 `.cspkg`。

## 7. 安装、更新、回滚与撤销状态机

### 7.1 Fresh 与 offline repeat

每个 reference release 先从本地 HTTPS-equivalent fetcher 获取一次已签名 bytes，再关闭 fetcher
重复 `prepare`。第二次必须命中 content-addressed cache、重新校验 size/digest/bundle/release，且
不得发起下载。三份 artifact 共发生 3 次唯一下载，没有隐藏依赖下载。

Java 首次安装从固定的五份 Temurin evidence 准备 JRE；随后 `offline=True` quick repeat 必须只用
已验证 cache。native executable 不读取系统 PATH runtime。

### 7.2 Update 与 rollback

index sequence 2 追加 ta4j `0.1.2`，不会替换或删除旧 release。更新保持：

```text
prepare -> verify/cache -> apply disabled -> explicit permission grant
-> begin activation -> reconcile -> health observation -> active
```

历史 rollback 实际执行两步：`0.1.2 active -> 0.1.2 staged -> 0.1.1 staged`。旧 release 的授权
identity 不会从新 release 静默继承，因此用户/管理 API 重新确认原权限后才恢复 `0.1.1 active`。
这项 `reauthorizationRequired=true` 被写入证据。

### 7.3 Revocation 与 quarantine

index sequence 3 追加 Aho artifact 的 `MALICIOUS_RELEASE` 撤销。enforcement 会：

- disable 当前 native activation 并停止 AppContainer 进程；
- 把 Marketplace cache payload 移入 quarantine，写独立 receipt；
- 把 candidate 标记为 `quarantined`；
- 阻止再次 prepare；
- 保留 immutable installation 与用户本地 source/reference artifact，不把 Marketplace 撤销扩大为
  本地文件删除。

## 8. Rollout、telemetry 与 UI

rollout 顺序固定为：

```text
internal -> opted-in-local -> preview -> stable
```

Host channel 只能看到不早于自身 channel 的 release，并在下载前检查 minimum Host 与 platform。
更新仍是 `automatic=false`。

telemetry 默认关闭且没有 upload implementation。用户显式启用后也只保存本地聚合计数：
runtime kind、有限 operation enum、有限 outcome enum 和 count；schema 明确禁止 plugin/user identifier、
策略输入、账户、plugin private data。

Plugin Manager v2 分别渲染：

- 发布者已验证；
- 官方维护或社区维护；
- 当前平台沙箱是否可用及 runtime kind；
- required/optional permission scope；
- rollout stage、minimum Host；
- quarantine alert 与 telemetry 本地/不上传说明。

这些标签互不推出：发布者已验证不等于官方维护，也不等于沙箱可用或零权限。

## 9. 真实门禁与机器证据

运行命令：

```powershell
$env:PYTHONPATH = "backend;packages/candlescope-plugin-sdk/src"
python backend/scripts/plugin_platform_multi_runtime_phase10.py `
  --run-real `
  --jdk-home C:\path\to\jdk-25.0.4+7 `
  --dependency-cache C:\path\to\fixed-maven-cache `
  --jre-evidence-directory C:\path\to\fixed-temurin-26-evidence `
  --output docs\evidence\plugin-platform-multi-runtime-phase10-real.json

# 只读取并校验已保存证据
python backend/scripts/plugin_platform_multi_runtime_phase10.py
```

机器证据：

- `docs/evidence/plugin-platform-multi-runtime-phase10-real.json`
- schema：`candlescope.plugin-platform-phase10-real/1`
- result：`pass`
- signed index sequence：`1 -> 2 -> 3`
- release count：`2 -> 3 -> 3`
- revocation count：`0 -> 0 -> 1`
- independent builds：`2`，全部 artifact digest 相等
- Marketplace download：3 个唯一 URL，各一次；offline repeat 不联网
- Runtime evidence download：5 份；JRE offline quick repeat 通过
- residual process / supervisor：`0 / 0`

稳定 reference artifact：

| plugin/version | runtime | `.cspkg` SHA-256 |
| --- | --- | --- |
| ta4j `0.1.1` | Java | `260d380ec50419c2fdde718205dcf3ed29bfd2637f4fea4f354da5a05c83f760` |
| ta4j `0.1.2` | Java | `1bf0ae92d534ca00ccd7ac719639082b05920de89becfff514bcb31b7192d4dd` |
| Aho `0.1.0` | native | `a4a931c5a179ba8a4e556323b0bff3ca5a82abd4140b8e0206be0afafefc579a` |

## 10. 测试范围

Phase 10 专用回归覆盖：

- index v2 schema/signature/transparency/platform uniqueness；
- artifact/release tamper、source build/system fallback/undeclared download 拒绝；
- minimum Host、rollout、publisher/official/sandbox/permissions 分离；
- Registry exact binding、active ancestry、rollback 后 forward revision 拒绝；
- verified cache reuse、corrupt cache quarantine、signed revocation quarantine；
- telemetry opt-in 与字段边界；
- v1 Marketplace wire/API compatibility；
- authority-backed effective grants 的 health observation；
- Phase 6 UI digest、Phase 7 upstream contract 与 Phase 8 upstream contract 逐级重新冻结，且三段
  真实门禁全部重跑；
- 当前 official Registry revision 5 下，Phase 7 historical rollback 精确执行
  `5 -> 4 -> 3 -> 4`，不会把“一次 rollback”误当成回到 pre-Node revision；
- frontend strict parser、未知字段拒绝与 SSR 信任标签。

最终结果：Phase 10 专项后端 `32 passed`；全量 63 个 `test_plugin*.py` 文件
`208 + 155 + 118 + 92 = 573 passed`；frontend parser `18 passed`、SSR `4 passed`，并通过
typecheck、Plugin Platform architecture、目标 ESLint 与 534-module production build；Python SDK
`98 passed`，Rust/WASM SDK与 Aho Adapter 各 `3 passed`，Ruff lint/format 与 cargo fmt 均通过。
Phase 6/7/8 的刷新真实门禁分别约 `80.2s / 174s / 64.1s`；Phase 10 完整真实门禁约
`104.7s`。Phase 11 会重新运行 backend、全部 SDK、frontend、浏览器、failure injection、soak 与
rollback matrix，不能把本阶段结果当 GA 结果。

## 11. 回滚与支持范围

关闭：

```powershell
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_MARKETPLACE_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_MARKETPLACE_TELEMETRY_ENABLED = "0"
```

可同时撤销 Marketplace release/artifact 或回滚 Runtime Registry revision。关闭不会删除本地可信
插件、已安装 payload、Grant Store、quarantine receipt 或用户数据；v1 Marketplace index 与 v2
Python 兼容路径仍由各自既有合同验证。

Phase 10 只声明 Windows x86_64 的 Java/native signed reference。没有声明 Linux/macOS/arm64
artifact，也没有把 Node/WASM 的既有本地验证自动升级为 Marketplace stable。生产签名私钥、远程
上传服务、自动更新和 GA 支持承诺不在本阶段范围；这些必须经过独立运维与 Phase 11 发布门禁。
