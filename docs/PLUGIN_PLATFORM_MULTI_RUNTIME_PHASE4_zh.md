# CandleScope 多运行时插件平台 Phase 4 完成证据

## 1. 阶段结论

Phase 4 已交付 Managed Runtime Registry：CandleScope Host 现在可以在显式开启功能后，
按签名清单下载、验证、缓存、探针和审计 Java、Node 或 WASM 运行时。本阶段用固定的
Eclipse Temurin JRE 21.0.12+8 完成了真实 Windows x86_64 退出门。

本阶段实际完成的边界是：

- Registry 是 build-pinned Ed25519 公钥验证的 strict canonical JSON；
- runtime 必须精确匹配 runtime id、kind、OS 和 arch；
- archive、vendor checksum、metadata、SBOM、signature 与许可证 inventory 都有签名摘要和大小；
- 首次下载进入 staging，验证后原子发布到 content-addressed cache；
- 每次使用都运行新的子进程做版本 probe；
- quick repeat 与离线 cache hit 不访问网络；
- payload、archive、evidence 或 receipt 损坏都会被隔离并按可恢复边界处理；
- Registry revision 可显式导入、撤销、回滚和跨签名 key 轮换；
- activation 与 installation 在使用 Host-managed runtime 时升级为 schema 4，并绑定
  registry revision、registry digest、runtime digest 和 probe digest；
- runtime cache 的引用同时扫描当前 activation 与 rollback history；
- developer-local 可以双重确认后显式登记系统 runtime，但会永久标记为不可复现；
- Plugin Manager 可以显示 Registry、缓存、来源、许可证、大小、验证状态与每个入口的
  runtime supply；
- Registry 总开关和网络更新开关仍默认关闭，且没有自动 Registry 拉取；
- Java JAR Provider、Java SDK 和 ta4j 插件仍属于 Phase 5，本阶段不能宣称任意 JAR 已可运行。

## 2. 实施前背景审计

Phase 3 已能直接运行 bundle 内声明的 native executable，但 Java、Node 和 WASM 需要
Host 提供外部语言 runtime。实施前仓库里的真实缺口如下：

| 层 | 已有基础 | Phase 4 缺口 |
| --- | --- | --- |
| manifest v3 | runtimeKind、runtimeId、artifact 已严格表达 | runtimeId 没有可验证的供应来源 |
| Runtime Provider API | 可返回 executable、artifact 与 launch 参数 | 没有语言 runtime provenance |
| installer receipt 3 | 可绑定 Provider policy identity | 不能绑定 Registry 和 JRE digest |
| activation registry 3 | 可绑定插件 artifact | 不能区分插件 artifact 与 Host runtime |
| Marketplace | 已有签名与原子 cache 模式 | 不能直接复用为语言 runtime Registry |
| Plugin Manager | 可显示入口生命周期 | 看不到 JRE/Node/WASM 来源和可复现性 |

审计还确认：

- `backend/app/plugin_runtime/registry.py` 是运行中插件进程 Registry，不是供应链 Registry，
  不能混用；
- 直接使用本机 `PATH` 上的 Java 会让 activation 不可复现；
- 只验证压缩包 SHA-256 不够，还必须验证解压后的文件数、总量、许可证目录和 fresh-process
  probe；
- runtime archive 不能跟着单个 plugin rollback 删除，因为不同插件和 rollback history
  可能共享同一份 JRE；
- build-pinned 私钥不能进入仓库，因此 roots schema 必须允许同一 registryId 下保留旧
  keyId 并加入新 keyId，才能安全轮换签名键。

## 3. 已执行计划

1. 冻结 Registry roots、Registry schema、签名、canonical JSON 和错误码；
2. 固定一个有真实上游证据和许可证 inventory 的 Windows JRE；
3. 实现 HTTPS-only、无 ambient proxy、有限重定向和大小受限的下载器；
4. 实现 registry、archive、evidence、extracted cache 的内容寻址存储；
5. 实现安全 ZIP/TAR 解压、完整 inventory、许可证和 fresh-process probe；
6. 实现 quick repeat、offline hit、损坏 quarantine 与恢复；
7. 实现 revision chain、撤销、回滚和跨 key revision rotation；
8. 扩展 Provider、installation receipt 和 activation registry 的 runtimeSupply；
9. 实现当前 activation 与 rollback history 的共享引用计数和可恢复清理；
10. 实现 developer-local 系统 runtime 的显式登记与复核；
11. 提供 JSON-only 管理 CLI 和 Plugin Manager 展示；
12. 建立小型签名 runtime 测试夹具、故障注入和固定 Phase 4 contract；
13. 在干净目录下载真实 Temurin JRE，验证 first/repeat/offline/corruption；
14. 跑 Phase 0～4、后端、SDK、前端、lint、类型和架构回归；
15. 固化机器证据、回滚说明并独立提交 Phase 4。

## 4. 最终执行链

执行链为：

    build-pinned roots
      -> signed canonical Registry revision
      -> exact runtime id/kind/os/arch resolve
      -> HTTPS download staging
      -> signed size + SHA-256 verification
      -> safe archive extraction
      -> full file and legal inventory
      -> fresh-process version probe
      -> atomic read-only content-addressed cache
      -> RuntimeSupplyBinding
      -> installation receipt schema 4
      -> activation registry schema 4
      -> future Java/Node/WASM Provider

Marketplace 或插件包只能声明一个 runtimeId。它不能提交下载 URL、覆盖摘要、请求源码编译，
也不能要求 Host 猜测系统 runtime。

## 5. 签名 Registry 合同

### 5.1 Roots

`official-runtime-registry-roots.json` 固定：

- registryId；
- Ed25519 keyId；
- 32-byte public key；
- 此 key 可以签名的 HTTPS origins；
- enabled 状态。

roots 按 `(registryId, keyId)` 排序且唯一。同一个 registryId 可以同时拥有旧、新两个
build-pinned key；Registry document 的 signature.keyId 决定使用哪一个 key 和哪一组
source origins。这样旧 revision 仍可验证，新 revision 可以由新发布密钥签名。

私钥不进入源码、构建产物或用户缓存。本阶段 bootstrap key 的私钥没有随仓库保存；未来
官方 revision 必须随新的 CandleScope Release 加入新公钥，同时保留仍需验证历史 revision
的旧公钥，再由新 key 签署连续 revision。

### 5.2 Registry document

Registry schema 1 要求：

- canonical UTF-8 JSON，最多允许一个结尾换行；
- schemaVersion、registry、runtimes、revocations、signature 精确字段；
- revision 1 的 previousRegistrySha256 必须为 null；
- 后续 revision 必须比 active revision 大 1，并精确引用 active digest；
- automaticNetworkUpdates 必须为 false；
- runtime key `(id, kind, os, arch)` 排序且唯一；
- revocation 按 artifact digest 排序且唯一；
- Ed25519 signature 覆盖除 signature 外的完整 canonical body。

Registry 中每个 runtime 固定 URL、SHA-256、大小、archive format、strip prefix、executable、
解压文件数和总量、许可证、evidence、probe 与 upstream identity。URL 必须属于该签名 key
批准的 HTTPS origin。

### 5.3 Revision、撤销与回滚

`activate_registry` 只接受显式提供的本地 document，不自动访问网络。它要求：

1. 签名 key 被当前 build roots 信任；
2. revision 连续；
3. previous digest 精确；
4. Registry ID 不变；
5. 新 document 原子进入 content-addressed registry store；
6. active state 原子切换并把旧 digest 加入 history。

`rollback_registry` 只能退到最后一个已接受且签名链匹配的 revision。artifact revocation 是
单调状态：回滚 Registry 不会解除已经接受的撤销，避免通过回滚重新启用已撤回 JRE。

## 6. 固定 Temurin 参考运行时

本阶段固定 [Eclipse Temurin 21.0.12+8 Release](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12%2B8)
的 Windows x64 JRE：

| 字段 | 固定值 |
| --- | --- |
| runtimeId | `temurin-21.0.12.8` |
| kind | `java` |
| version | `21.0.12+8-LTS` |
| OS / arch | `windows` / `x86_64` |
| archive | ZIP，root `jdk-21.0.12+8-jre` |
| SHA-256 | `b8aa18fef5edb69bee8618f99677d66d0873d22cb40d974c15ac9ffcdecf73ba` |
| archive size | 48,993,215 bytes |
| extracted inventory | 315 files / 151,523,285 bytes |
| executable | `bin/java.exe` |
| probe | `bin/java.exe -version`，15 秒上限 |
| license | `GPL-2.0 WITH Classpath-exception-2.0` |
| legal inventory | 179 files / 228,708 bytes |

供应链 evidence 精确包含：

- vendor checksum；
- vendor metadata JSON；
- Windows x64 SBOM；
- vendor PGP signature。

四个文件都有独立 URL、SHA-256、大小和文件名。许可证使用
[OpenJDK GPLv2 + Classpath Exception](https://openjdk.org/legal/gplv2+ce.html)，并额外固定
NOTICE、ADDITIONAL_LICENSE_INFO、ASSEMBLY_EXCEPTION 和 LICENSE 四个关键文件的摘要与
大小。这里只审计并保存上游 PGP signature；CandleScope 的信任决定仍来自自己的 Ed25519
Registry signature 与固定摘要，不把未配置的本机 PGP keyring 当作隐式信任来源。

## 7. 下载、解压与 cache

### 7.1 网络边界

默认 fetcher：

- 只接受没有用户名密码的 HTTPS URL；
- `trust_env=False`，不继承环境代理；
- 不自动跟随重定向，Host 自己最多处理 6 跳并逐跳复核 HTTPS；
- Content-Length 和实际流量都受 signed size 上限；
- 下载写入唯一 `.part` 文件并 fsync；
- digest 或 size 不符时不发布目标文件；
- transport、HTTP status、redirect、I/O 和磁盘满返回稳定错误码。

### 7.2 存储布局

独立 runtime root 下的布局为：

    registry-state.json
    registries/<registry-sha256>.json
    archives/<archive-sha256>.zip
    evidence/<evidence-sha256>/<file-name>
    cache/<runtime-id>/<archive-sha256>/
      payload/...
      runtime-receipt.json
    staging/*.part
    quarantine/<component>/...
    retired/<runtime-id>/...
    system-runtimes.json

plugin installation 与 managed runtime cache 完全分离。

### 7.3 安全解压

ZIP/TAR 解压会拒绝：

- 绝对路径、`..`、反斜杠或非 canonical member；
- strip prefix 外的成员；
- symlink、hardlink、special file；
- 大小写碰撞与重复目标；
- 超过 signed file count 或 extracted size；
- 实际文件数或总量与 Registry 不相等。

解压后重新遍历全部普通文件，计算 path、SHA-256、size inventory。legal directory 的文件数
和总量必须精确，关键 license files 必须逐个摘要匹配。

### 7.4 Fresh-process probe

probe 总是通过 argument array 和 `shell=False` 启动。环境只保留有限系统变量；PATH 只包含
runtime 自己的 bin 和 Windows System32，JAVA_HOME 指向当前 payload。

首次安装会在 staging payload 运行一次 probe，原子发布后再运行一次；两次 probe digest
必须相等。quick repeat 和 offline hit 也会重新启动进程，而不是信任旧 probe receipt。

## 8. Quick repeat、离线与损坏恢复

### 8.1 Quick repeat

若 receipt、payload inventory、Registry provenance、probe receipt、archive 和全部 evidence
仍有效：

- 不下载；
- 不解压；
- 只做完整 cache 验证和 fresh-process probe；
- 返回 quickRepeat=true。

### 8.2 离线

- cache、archive、evidence 完整：允许运行且网络调用为 0；
- extracted cache 缺失但 archive/evidence 完整：允许从本地归档恢复；
- archive 缺失：`PLUGIN_RUNTIME_REGISTRY_OFFLINE_CACHE_MISS`；
- evidence 缺失：`PLUGIN_RUNTIME_REGISTRY_OFFLINE_EVIDENCE_MISS`；
- 不查 PATH，不回退到系统 Java，不编译源码。

### 8.3 损坏

| 损坏组件 | 行为 |
| --- | --- |
| payload / receipt | 整个 extracted cache 移入 quarantine，再从已验证归档恢复 |
| archive | archive 移入 quarantine；在线重新下载，恢复后复用有效 payload |
| evidence | 单个 evidence 移入 quarantine；在线重新下载，恢复后复用有效 payload |
| Registry state | fail closed，不猜测 active revision |
| system executable | 摘要变化即拒绝，不自动重新登记 |

quarantine 写入独立 reason receipt。清理未引用 runtime 时不会直接删除，而是移动到 retired，
因此可恢复；verified archive 始终保留。

## 9. RuntimeSupplyBinding 与 schema 4

`RuntimeSupplyBinding` 把插件 artifact 和语言 runtime provenance 分开。Host-managed 绑定包含：

- source = host-managed；
- runtimeId、runtimeKind、version；
- 绝对 executable；
- runtime archive SHA-256 和大小；
- fresh probe SHA-256；
- verificationStatus = verified；
- reproducible = true；
- registryId、revision、registry SHA-256；
- source URL 与 SPDX license。

显式 system 绑定包含相同的基础身份，但：

- source = system；
- verificationStatus = probed；
- reproducible = false；
- licenseSpdx = NOASSERTION；
- 不允许伪造 registry 字段。

installation receipt 只有在 Provider binding 带 runtimeSupply 时才使用 schema 4；旧 Python 和
native 路径继续使用 schema 3。activation record 与 activation registry 同样只在存在
runtimeSupply 时升级 schema 4。读取仍兼容 schema 2/3，旧响应和默认关闭路径不漂移。

## 10. 共享引用与清理

引用计数会严格读取：

- 当前 activation registry；
- installer history 下所有 bounded strict JSON receipt。

每个引用按 source file、pluginId、activationId、runtimeId、artifact digest 去重。只要当前
插件或任一 rollback history 仍绑定该 digest，cleanup 就返回
`PLUGIN_RUNTIME_REGISTRY_RUNTIME_REFERENCED` 和精确 referenceCount。

测试用两个插件共享一个 runtime，并把其中一个放入 rollback history；计数为 2，清理被
拒绝，另一个插件仍可离线 quick repeat。只有使用空当前 registry 和空 history 时，cache 才
移动到 retired，archive 继续保留。

## 11. Developer-local 系统 runtime

系统 runtime 从来不是自动 fallback。登记必须同时满足：

- Registry 功能已显式开启；
- developerLocal=true；
- confirmNonreproducible=true；
- runtime id 和 kind 有效；
- executable 是绝对路径下的真实普通文件且不是 symlink；
- 用户提供的 probe args 和 expected version regex 成功；
- Host 记录 executable SHA-256、大小、probe receipt 和登记时间。

每次解析 system runtime 都重新验证文件摘要并重新运行 probe。相同 runtimeId/kind 若指向
不同 executable，必须走未来明确 replacement 流程，不能静默覆盖。
本机注册文件还会严格验证探针参数边界、正则边界、canonical UTC 登记时间、argv、输出上限
及探针 receipt 摘要；任何损坏统一返回 `PLUGIN_RUNTIME_REGISTRY_SYSTEM_STATE_INVALID`，不会
带着半可信状态继续解析或执行。

## 12. 管理 CLI

入口为 `backend/scripts/candlescope_runtime_registry.py`，所有成功输出和错误均为 JSON。
示例 PowerShell：

```powershell
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'CandleScope\plugin-platform-v2\managed-runtimes-v1'

python backend/scripts/candlescope_runtime_registry.py `
  --root $runtimeRoot status

python backend/scripts/candlescope_runtime_registry.py `
  --root $runtimeRoot ensure temurin-21.0.12.8 java

python backend/scripts/candlescope_runtime_registry.py `
  --root $runtimeRoot ensure temurin-21.0.12.8 java --offline

python backend/scripts/candlescope_runtime_registry.py `
  --root $runtimeRoot import-registry .\reviewed-runtime-registry-v2.json

python backend/scripts/candlescope_runtime_registry.py `
  --root $runtimeRoot rollback-registry
```

显式登记开发机 Java：

```powershell
python backend/scripts/candlescope_runtime_registry.py `
  --root $runtimeRoot add-system-runtime local-java-21 java 21-local `
  'D:\java\jdk-21\bin\java.exe' `
  --probe-arg=-version `
  --expected-pattern 'version "21\.' `
  --developer-local `
  --confirm-nonreproducible
```

`cleanup` 还接受 activation registry 与 history directory 参数，用于阻止误删仍可回滚的
runtime。

## 13. Plugin Manager

后端 catalog 只在 Runtime Registry 显式开启时增加 `runtimeRegistry`。默认关闭时完全省略该
字段，冻结的旧 catalog 响应不变。

Plugin Manager 新增：

- active registry id、revision 和“自动网络更新已关闭”；
- 当前平台 runtime id、kind、version、OS/arch、大小、许可证和摘要短码；
- cached / missing / corrupt / revoked 状态；
- referenceCount；
- developer-local system runtime 的绝对路径和不可复现提示；
- 每个插件入口的 runtime id、version、source、verificationStatus 和 reproducible 状态。

前端 parser 对这些对象使用 exact-field 验证；自动更新为 true、host-managed 却标记不可复现、
或带未知 update URL 的响应都会 fail closed。

## 14. 开关与回滚

| 开关 | 默认 | 作用 |
| --- | ---: | --- |
| `CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_ENABLED` | 0 | 创建、解析和使用 Managed Runtime Registry |
| `CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_NETWORK_UPDATES_ENABLED` | 0 | 只作为未来显式网络更新能力门；当前没有自动拉取实现 |
| `CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED` | 0 | Phase 1 总开关，仍控制非 Python manifest |
| `CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED` | 0 | Phase 3 native Provider，不受本阶段放宽 |

回滚顺序：

1. 停用未来 Java/Node/WASM Provider 开关；
2. 将 Runtime Registry enabled 设为 0；
3. 若已导入新 Registry，执行显式 rollback-registry；
4. 保留 verified archive、evidence 与 cache；
5. 不清理仍被 activation 或 history 引用的 digest；
6. schema 4 activation 仍可读取，不自动降级或改写为 schema 3。

## 15. 故障矩阵

专项门禁覆盖：

| 场景 | 稳定结果 |
| --- | --- |
| 离线 cache miss | `PLUGIN_RUNTIME_REGISTRY_OFFLINE_CACHE_MISS` |
| 下载中断 | `PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_FAILED`，无残留 `.part` |
| digest 错误 | `PLUGIN_RUNTIME_REGISTRY_ARTIFACT_MISMATCH` |
| size 错误 | `PLUGIN_RUNTIME_REGISTRY_ARTIFACT_MISMATCH`，details 区分实际大小 |
| 非法 ZIP | `PLUGIN_RUNTIME_REGISTRY_EXTRACT_FAILED` |
| 磁盘不足 | `PLUGIN_RUNTIME_REGISTRY_DISK_FULL` |
| 签名篡改 | `PLUGIN_RUNTIME_REGISTRY_SIGNATURE_INVALID` |
| revision 不连续 | `PLUGIN_RUNTIME_REGISTRY_CHAIN_INVALID` |
| runtime 被撤销 | `PLUGIN_RUNTIME_REGISTRY_RUNTIME_REVOKED` |
| runtime 仍被引用 | `PLUGIN_RUNTIME_REGISTRY_RUNTIME_REFERENCED` |
| system 未双重确认 | `PLUGIN_RUNTIME_REGISTRY_SYSTEM_CONFIRMATION_REQUIRED` |
| system executable 改变 | `PLUGIN_RUNTIME_REGISTRY_SYSTEM_RUNTIME_CHANGED` |

## 16. 测试与机器证据

### 16.1 Phase 4 专项

```text
backend/tests/test_plugin_platform_multi_runtime_phase4.py
backend/tests/test_plugin_platform_multi_runtime_phase4_gate.py
23 passed
```

覆盖签名、canonical JSON、flags、first/repeat/offline、全部故障、payload/archive/evidence/
receipt corruption、跨平台不安全归档路径、revision、revocation、rollback、跨 key rotation、
schema 3/4、共享引用、system runtime、Core catalog、CLI 和无 fallback/source build。

### 16.2 真实 JRE gate

机器证据：
`docs/perf-baselines/plugin-platform-v2/multi-runtime-phase4-2026-08-03-windows-amd64.json`

最终采样：

| 项目 | 结果 |
| --- | ---: |
| 干净目录首次下载、解压、双 probe | 22,519.927 ms |
| quick repeat | 469.685 ms |
| 完全断网 cache hit | 463.279 ms |
| 破坏 java.exe 后离线恢复 | 2,772.610 ms |
| 首次下载文件 | 5 |
| 离线网络调用 | 0 |
| 恢复 quarantine entries | 1 |
| 最终状态 | verified |

probe 输出精确为 Temurin 21.0.12+8-LTS；315 个文件、151,523,285 bytes、179 个 legal
files 与 4 个关键许可证摘要全部通过。

复现命令：

```powershell
$env:PYTHONPATH = 'backend;packages\candlescope-plugin-sdk\src'
backend\.venv\Scripts\python.exe `
  backend\scripts\plugin_platform_multi_runtime_phase4.py `
  --run-gate --real-jre `
  --output docs\perf-baselines\plugin-platform-v2\multi-runtime-phase4-2026-08-03-windows-amd64.json
```

### 16.3 回归

- Phase 4 专项：23/23；
- 后端干净全量（产品默认 Replay 关闭，Phase 2/3 性能 gate 独立进程）：2,977/2,978，
  唯一慢样本为既有 Windows CPU quota 8,094 ms 对 8,000 ms；隔离原阈值复跑 1/1，
  4.60 秒通过；
- Phase 2 gate 独立进程：4/4；
- Phase 3 gate 独立进程：4/4；
- 因此后端 2,986 个收集项均有通过证据；
- SDK：98/98，Ruff 通过；
- 前端：2,893/2,893，ESLint、typecheck、Plugin Platform architecture check 通过；
- Phase 4 Python 文件：Ruff check 与 format check 通过。

全后端若直接继承仓库本机 `backend/.env`，会打开 Replay 并要求未提交的本地 archive；测试
证据显式覆盖 `REPLAY_ENABLED=0`、`REPLAY_AGG_TRADE_ENABLED=0` 和
`RAW_AGG_TRADE_ARCHIVE_ENABLED=0`，与产品冻结默认一致。Phase 2/3 两个 Windows memory
gate 使用各自局部 ctypes Structure；在同一超大全量 pytest 进程中可能被别的测试设置的
psapi argtypes 污染，因此按原设计在独立 Python 进程验证，未修改阈值。

## 17. Phase 4 退出门

- [x] 至少一个固定 JRE 在干净目录安装并通过 fresh-process probe；
- [x] archive、checksum、metadata、SBOM、signature、license 和 notices 齐全；
- [x] quick repeat 不下载；
- [x] 完全断网 cache hit 为 0 次网络调用；
- [x] payload 损坏可 quarantine 并仅用本地归档恢复；
- [x] download interruption、digest、size、extract 和 disk full fail closed；
- [x] Registry revision 可验证、撤销、回滚和跨 key 轮换；
- [x] 两个插件共享 runtime，rollback history 阻止误删；
- [x] activation 和 installation 收据绑定 Registry 与 runtime digest；
- [x] developer-local system runtime 必须显式双重确认并标记不可复现；
- [x] Plugin Manager 展示 runtime provenance；
- [x] 不存在自动源码编译、PATH 搜索或系统 runtime fallback；
- [x] Registry 与网络更新开关默认关闭；
- [x] 原 schema 2/3、Python 和 native 行为保持回归通过。

## 18. 明确未交付

Phase 4 只交付 runtime 供应链，不交付具体语言 Provider：

- Java JAR launch、Java SDK、ta4j reference plugin：Phase 5；
- Node module Provider：Phase 6；
- WASM Component Provider：Phase 7；
- GitHub adapter、自动构建模板与 Marketplace 生态：Phase 8～10；
- Registry 自动联网检查：当前没有实现，即使网络更新 flag 为 true 也不会自动拉取；
- macOS/Linux Temurin、Node、Wasmtime 固定资产：在对应 Provider 阶段按同一 schema 新增；
- system runtime replacement：当前 fail closed，未来需显式审核工作流；
- 真实发布密钥托管、离线签名 ceremony 和 CI Release 注入：属于后续发布工程，不得把私钥
  放入仓库来简化本阶段。
