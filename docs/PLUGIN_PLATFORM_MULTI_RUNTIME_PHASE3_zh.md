# CandleScope 多运行时插件平台 Phase 3 完成证据

## 1. 阶段结论

Phase 3 已实现 native-executable Runtime Provider，并用一个无第三方依赖的 Rust
reference plugin 验证 CandleScope 可以安装、复核和直接运行预编译原生产物。

本阶段实际交付的边界是：

- manifest schema v3 的 native-executable 可在显式打开总开关、Provider seam 和
  native 开关后完成 install、check、quick-repeat、fresh-process probe、activate、
  invoke、health、cancel、shutdown 与 rollback；
- Host 只启动 bundle inventory 中 manifest 声明的那一个 artifact；
- Windows trusted-local 使用原子 Job Object 管理，受限模式使用现有
  AppContainer runner 和内部 Job Object；
- 现有 schema v2/v3 Python 路径保持 Phase 2 语义；
- 多运行时总开关和 native 开关仍默认关闭；
- Java、Node、WASM Provider 仍不存在，不得因本阶段结果宣称它们已可运行。

## 2. 实施前背景审计

Phase 2 已经抽出了语言无关的 Runtime Provider API，但 Registry 只注册
PythonModuleProvider。Phase 3 开始前，仓库里与 native 相关的真实基础如下：

| 层 | 已有基础 | Phase 3 缺口 |
| --- | --- | --- |
| SDK manifest v3 | 严格 native artifact、OS、arch、args；拒绝 shell 和脚本 | 没有可执行 Provider |
| Bundle v3 | inventory 覆盖全部文件，runtime artifact 有角色、摘要、大小与平台 | 安装后没有二进制类型复核 |
| Activation registry v3 | 可表达 artifact、args、runtimeKind、runtimeId、artifactSha256 | Core 尚不能启动 native |
| Provider seam | probe 与 Core 共用 PreparedLaunch | 只有 Python Provider |
| Windows sandbox | AppContainer runner 已有 kill-on-close Job 与资源预算 | trusted-local 只有进程组，没有原子 Job |
| Supervisor | 已消费 executable、argv、cwd，无语言判断 | 尚无进程树策略字段 |

审计还确认本机工具链为 rustc 1.97.1 和 cargo 1.97.1，目标为
x86_64-pc-windows-msvc；Go 和独立 MSVC cl 不作为本阶段前提。

原有 Windows AppContainer runner 已能覆盖受限进程树，但 trusted-local 若先普通启动
再附加 Job，会留下极短的逃逸窗口。因此本阶段不能只在进程启动后补 Job，必须使用
CREATE_SUSPENDED、AssignProcessToJobObject 和 NtResumeProcess 的原子顺序。

## 3. 已执行计划

1. 冻结 Native Provider、artifact、功能开关和 Windows Job 合同；
2. 将 RuntimeInstallationRequest 扩展为语言无关 artifact inventory；
3. 实现 NativeExecutableProvider 1.0.0；
4. 将 installer、probe runner 和 Core 接入同一个 Native Provider；
5. 将 process tree、isolated search path 和 max process 传入通用 Host spec；
6. 实现 Windows 原子 Job Object controller；
7. 编写最小 Rust reference plugin 和冻结 transcript；
8. 验证 trusted-local、真实 AppContainer、包外访问和零残留；
9. 注入启动、invoke、hang、wire、stderr 和 child 故障；
10. 验证 native flag 关闭、degraded 展示和精确 Python rollback；
11. 建立 contract fixture、一键 gate、性能快照和本完成文档；
12. 跑完整插件、SDK、Rust、前端和静态回归；
13. 仅暂存 Phase 3 明确路径并独立提交。

## 4. 最终执行链

执行链保持 Provider 与 Host 分层：

    manifest v3 native runtime
      -> bundle v3 artifact inventory
      -> NativeExecutableProvider prepare/verify
      -> receipt schema 3 runtime binding
      -> activation exact artifact + digest
      -> PreparedLaunch
      -> EntrypointSupervisor
      -> trusted-local Job 或 AppContainer Job
      -> candlescope.plugin/2 over jsonl/1

Supervisor 和协议层仍不知道 Rust、Go、C 或 C++。它只消费经 Provider 验证的
executable、argv、working directory 和进程策略。

## 5. Native Provider 合同

### 5.1 RuntimeArtifact

backend/app/plugin_core_v2/runtime_providers/base.py 新增 RuntimeArtifact，字段为：

- relative_path；
- 安装目录内解析后的真实 path；
- role；
- sha256；
- size；
- operating_systems；
- architectures。

构造时即要求 artifact：

- 位于 installation 之内；
- 是真实普通文件；
- 不是 symlink；
- relative path 安全且大小写唯一；
- 摘要、大小和平台字段格式有效。

同一个 RuntimeInstallationRequest 可以承载 wheel 或普通 artifact。Python Provider
继续单独要求 wheel 与 distribution；Native Provider 则明确拒绝 Python package 输入。

### 5.2 安装后复核

NativeExecutableProvider 不运行 package manager，也不执行安装脚本。它对安装后的
content 再做一次：

1. role 必须是 native-executable；
2. artifact 必须支持当前 Host OS/arch；
3. 实际 SHA-256 和大小必须等于 bundle inventory；
4. 后缀和文件名不得是 shell、PowerShell、batch、Python、JavaScript 或 shell script；
5. Windows 必须是 .exe；
6. 二进制头必须是当前平台的 64 位 executable，而不是 DLL。

Windows PE 验证检查 MZ、PE signature、machine、executable bit、DLL bit 和 PE32+
optional header。Linux 检查 little-endian ELF64 type/machine；macOS 检查 thin
little-endian Mach-O 64 executable。Phase 3 没有宣称 fat Mach-O 或 32 位产物支持。

### 5.3 运行身份

receipt schema 3 记录：

- runtimeKind = native-executable；
- runtimeId = native-host；
- providerVersion = 1.0.0；
- runtimeIdentity = Host OS/arch、Provider version、二进制策略、进程树策略和搜索路径策略的
  canonical SHA-256。

artifact 自身的 SHA-256 由 bundle inventory、content record 和 activation
artifactSha256 独立绑定。这样 Provider policy identity 和具体可执行文件 identity 不会混为
一个字段。

## 6. 只启动声明产物

probe runner 和 Core 都从 bundle descriptor inventory 定位 manifest 声明的 artifact，
不接受系统 PATH、shell、解释器或同目录猜测作为入口。

Native Provider prepare_runtime 要求：

- executable 等于 installation/content 下 manifest 声明路径；
- working directory 是同一不可变 installation；
- executable 不是 symlink；
- 当前实际 digest 等于 activation artifactSha256；
- 二进制头仍通过当前 Host 检查。

PreparedLaunch 对 native 固定：

- executable 为声明 artifact；
- arguments 为 manifest 的字符串数组；
- manage_process_tree 为 true；
- isolated_search_path 为 true；
- max_processes 为 1。

trusted-local PATH 只包含 artifact 所在目录。AppContainer PATH 只包含 artifact 目录和
Windows System32，不继承开发机、Python、Node、Java 或用户 PATH，因此不存在未声明的
语言 runtime 或 DLL 搜索目录 fallback。

## 7. Windows 进程树与长路径

backend/app/plugin_host/windows_job.py 新增 WindowsJobController：

1. Host 使用 CREATE_SUSPENDED 创建 native root；
2. 创建匿名 Job Object；
3. 设置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE；
4. 设置 JOB_OBJECT_LIMIT_ACTIVE_PROCESS 和 ActiveProcessLimit = 1；
5. 打开 suspended process handle；
6. AssignProcessToJobObject；
7. NtResumeProcess；
8. Host stop、强制终止或 controller close 时终止整棵 Job。

若任一步失败，Host 会终止 suspended process 和 Job，不让未受控代码继续运行。

测试还暴露了 Windows 最终 installation 路径超过 MAX_PATH 时的真实问题：仅给 argv[0]
加扩展路径前缀仍会得到 WinError 206，因为 Python subprocess 会让 CreateProcessW
重新解析命令行中的 module name。Host 现在同时：

- 将长 executable/cwd 转换为 Windows extended-length path；
- 显式传 lpApplicationName，也就是 subprocess executable 参数。

真实长路径 final installation 已通过 fresh-process transcript 和第二次静态复核。

transport snapshot 新增 processTreeControl，管理和诊断层可以看到当前 session 是否处于
Job 或 sandbox 进程树控制下。

## 8. Rust reference plugin

examples/plugin-platform-native-rust 是一个独立 MIT Rust binary crate：

- 无 crates.io 依赖；
- Cargo.lock 提交；
- release 使用 locked、offline、LTO、panic abort；
- stdout 正常模式只输出 canonical JSONL protocol frame；
- 错误和日志只走 stderr；
- 自带严格 JSON parser，拒绝 duplicate key、非法 number、escape 和 trailing content。

插件身份为 candlescope.native-reference 0.1.0，贡献为 hello command。它实现：

- handshake；
- describe；
- activate；
- invoke；
- healthCheck；
- cancel；
- deactivate；
- shutdown。

冻结 transcript 包含 10 个响应，摘要为：

    sha256:a3da7d49d645be03a6d33962c0a6c5f6664c4398fda5c260ddea47bb92e003d5

除 handshake 和 describe 中的插件身份外，其余 8 个响应摘要与 Python SDK hello
conformance fixture 完全一致。

reference 另提供故障模式：

- crash-start、crash-invoke；
- hang-start、hang-invoke；
- invalid-utf8；
- stdout-pollution；
- stderr-flood；
- spawn-child；
- sandbox-probe。

sandbox-probe 会尝试读取包外文件并启动包外 executable，再把布尔结果通过正常 invoke
返回；真实 AppContainer gate 中两项均为 false。

## 9. trusted-local 与受限模式

### 9.1 trusted-local

trusted-local 直接启动声明 PE，不套 AppContainer，但仍受 Host Job 管理：

- root 在进入插件代码前已属于 Job；
- ActiveProcessLimit = 1；
- isolated PATH；
- stderr 上限、message 上限、超时和协议校验保持；
- Supervisor stop 与 Host stop 后 PID 均已退出；
- spawn-child 模式不能留下 child。

这给本地自部署用户提供接近普通本地应用的兼容性，但没有放弃可诊断生命周期和回滚。

### 9.2 Windows AppContainer

真实 AppContainer gate 证明：

- target 处于 AppContainer SID；
- inner Job ActiveProcessLimit = 1；
- target command 第一个参数精确等于 activation artifact；
- PATH 只有 artifact directory 与 System32；
- 包外 secret file 无法读取；
- 包外 native reference executable 无法启动；
- invoke 与 health 正常；
- Host stop 后 wrapper、target 和 Supervisor 均为零残留。

受限 native 不需要 pinned Python，也不会创建 site-packages 或语言 runtime substitution。

## 10. 开关、状态与回滚

开关矩阵：

| manifest/runtime | multi-runtime | Provider seam | native flag | 结果 |
| --- | ---: | ---: | ---: | --- |
| v2 Python | 0/1 | 1 | 0/1 | Python Provider，Phase 2 行为 |
| v2 Python | 0/1 | 0 | 0/1 | Phase 2 legacy Python rollback path |
| v3 native | 0 | 0/1 | 0/1 | PLUGIN_MULTI_RUNTIME_FEATURE_DISABLED |
| v3 native | 1 | 0 | 0/1 | PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE |
| v3 native | 1 | 1 | 0 | PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE |
| v3 native | 1 | 1 | 1 | Native Provider |
| v3 Java/Node/WASM | 1 | 1 | 0/1 | PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE |

生产默认仍是：

    CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED=0
    CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED=1
    CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED=0

关闭 native flag 后，已安装且 active 的 native activation 不会被改写：

- catalog 平台状态为 degraded；
- activation 仍显示 active/enabled；
- available 为 false；
- unavailableReason 为 PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE；
- contribution 和 runtime entrypoint 不发布；
- Plugin Manager 中没有 Supervisor；
- 不会猜测 Python module、系统 executable 或其他 artifact。

精确回滚门实际先安装同一插件 ID 的 Python 0.0.9，再安装 native 0.1.0，关闭 native flag
后调用 installer.rollback。结果恢复到原 Python installation 和 module，artifact 为 null，
并在 native flag 关闭时真实 invoke 成功。这是历史 activation 回滚，不是 native 自动
fallback。

## 11. 故障与诊断

冻结故障映射：

| 故障 | Host 结果 |
| --- | --- |
| crash-start / crash-invoke | PLUGIN_PLATFORM_EXITED |
| hang-start / hang-invoke | PLUGIN_PLATFORM_TIMEOUT |
| invalid UTF-8 | PLUGIN_PLATFORM_RESPONSE_INVALID_JSON |
| stdout 日志污染 | PLUGIN_PLATFORM_RESPONSE_INVALID_JSON |
| stderr 洪泛 | PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED |
| artifact OS/arch 错误 | PLUGIN_RUNTIME_PROVIDER_PLATFORM_MISMATCH |
| native flag 关闭 | PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE |
| artifact 篡改 | check 在执行代码前失败 |

扩大 gate 还发现 stderr 洪泛的第二条并发路径：如果 drainer 已请求 Job kill，而 stdout
reader 先收到 EOF，旧代码可能把结果归类为普通 EXITED。ManagedSidecarProcess 现在提供
有界 stderr settle；reader 在 EOF 分类前等待 terminating drainer 发布 overflow。20 次
连续原生洪泛压力均稳定返回 PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED。

## 12. 测试与机器证据

已通过：

| 集合 | 结果 |
| --- | --- |
| Phase 3 专项 | 19 passed |
| Phase 3 contract 与一键 gate | 4 passed |
| Phase 3 专项加 gate 合并 | 23 passed，44.30s |
| Phase 0～2、Host 与 Windows sandbox 早期回归 | 76 passed |
| 全部 test_plugin*.py | 438 passed，4 个既有 FastAPI deprecation warnings，495.00s |
| SDK 全量 | 98 passed |
| Rust cargo test release locked offline | PASS |
| Rust cargo fmt | PASS |
| Python Ruff check 与 format check | PASS |
| Frontend check:plugins | PASS |
| Frontend typecheck | PASS |

完整插件回归显式设置 REPLAY_ENABLED=0，使用产品默认关闭值，避免开发机 backend/.env 的
replay 配置和外部 archive lock 污染插件结论。

机器可读证据：

- contract：
  backend/tests/fixtures/plugin_platform_multi_runtime/phase3_contract_v1.json；
- native transcript：
  backend/tests/fixtures/plugin_platform_multi_runtime/native_reference_transcript_v1.json；
- gate：
  backend/scripts/plugin_platform_multi_runtime_phase3.py --run-gate；
- 性能快照：
  docs/perf-baselines/plugin-platform-v2/multi-runtime-phase3-2026-08-03-windows-amd64.json。

## 13. 性能

Windows/AMD64，本次受控 gate：

| 指标 | Native | 冻结上限 | 判定 |
| --- | ---: | ---: | --- |
| first install | 1376.936 ms | Phase 0 9724.601 ms × 1.25 = 12155.751 ms | PASS |
| 冷启动中位数，3 次 | 13.517 ms | Phase 2 Python 156.890 ms 对照上限 188.268 ms | PASS |
| working set 中位数 | 3895296 B | Phase 2 Python 4231168 B 对照上限 12619776 B | PASS |
| trusted-local residual processes | 0 | 0 | PASS |
| AppContainer residual processes | 0 | 0 | PASS |

Rust cargo release 编译约 2.3 秒，只作工具链信息，不计入预编译 cspkg 的安装耗时。Phase 3
支持的是固定 Release artifact；静默源码编译不是安装 fallback。

## 14. Phase 3 退出门

- [x] NativeExecutableProvider 1.0.0 已注册在显式 native flag 后；
- [x] inventory、摘要、大小、OS、arch 和二进制类型安装后复核；
- [x] Host 只启动声明 artifact；
- [x] script、shell 和继承 DLL/runtime 搜索路径被拒绝；
- [x] Rust reference 完整 transcript 通过；
- [x] trusted-local 使用原子 Windows Job；
- [x] AppContainer 真实运行，包外读和 executable 启动均被拒绝；
- [x] 崩溃、卡死、输出污染、invalid UTF-8 和 stderr 洪泛可诊断；
- [x] disable、rollback、Supervisor stop 和 Host stop 无残留；
- [x] native flag 关闭显示 unavailable，且没有 executable fallback；
- [x] Python rollback 在 native flag 关闭时真实 invoke；
- [x] 安装、启动和内存在冻结预算内；
- [x] 完整插件、SDK、Rust 与前端回归无新增失败。

## 15. 明确未交付

Phase 3 没有实现：

- Java、JRE、Node 或 WASM Provider；
- Managed Runtime Registry、下载、签名、cache、撤销或引用计数；
- Go/C/C++ 专用 SDK；这些语言当前只能直接实现语言无关协议并提供预编译 artifact；
- GitHub URL importer、repository lock、release resolver 或 source build service；
- ta4j adapter、ta4j JAR 或 Java sidecar；
- Marketplace 对 native 的签名发布流程 UI；
- 系统 executable、shell、源码编译或同名文件自动 fallback；
- macOS/Linux 与 Windows 同等级的实机沙箱证据。

Phase 4 必须先实现 Managed Runtime Registry，再开始 Java、Node 和 WASM Provider。不得让
Java Provider 临时调用系统 java，也不得在用户安装插件时静默运行 Maven 或 Gradle。
