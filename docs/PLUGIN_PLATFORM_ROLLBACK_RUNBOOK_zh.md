# CandleScope 多运行时插件回滚 Runbook

> 回滚目标是先停止新增风险，再恢复已验证能力，同时保留安装、签名链、receipt、审计和用户数据。
> 本手册不授权删除整个插件目录、数据库、cache、Grant Store 或用户行情。

## 1. 严重级别与选择

| 级别 | 例子 | 首选动作 |
| --- | --- | --- |
| S1 单插件故障 | 一个版本 crash/hang/错误输出 | 停用 activation，回到上一 immutable release |
| S2 单运行时故障 | Java/Node/WASM runtime 或 Registry artifact 异常 | 关闭该 runtime flag，其他 kind 保持 |
| S3 分发故障 | Marketplace index/release/cache/revocation 异常 | 关闭 Marketplace/network update，冻结 index |
| S4 平台级风险 | Supervisor/沙箱/权限边界疑似失效 | 关闭全部 12 个新开关，验证 v2 Python/v1 |

发现恶意 artifact、签名私钥泄露、沙箱逃逸或 live authority 越权时，直接按 S4 处理，并追加
release/runtime revocation。不要为了“先复现”继续激活可疑代码。

## 2. 操作前记录

回滚前先记录，不修改用户数据：

1. 时间、Host commit/version、OS/arch；
2. plugin id/version、bundle/artifact SHA-256；
3. runtime kind/id、Registry revision/ancestry；
4. activation generation、trust mode、grants、sandbox policy；
5. active process/Supervisor/profile 数和 PID；
6. install/activation/audit/quarantine receipt 摘要；
7. 稳定错误码、最小复现和是否涉及账户/交易；
8. 当前 12 个 feature flag 的值。

原始 artifact、lock、SBOM、license、provenance、index 和 receipt 保持只读。证据边界见
`PLUGIN_PLATFORM_DIAGNOSTICS_BOUNDARIES_zh.md`。

## 3. S1：回滚单一插件 release

按状态机操作：

1. 阻止该 activation 的新 invoke；
2. 由 Host 发送 cancel/stop，等待有界 deadline；
3. 将当前 release 从 active 降为 staged/disabled；
4. 确认进程、Supervisor、Job Object/AppContainer profile 零残留；
5. 选择上一份已安装的 immutable release；不要覆盖当前 payload；
6. 重新核验旧 bundle、runtime、SBOM、license、provenance 和 receipt；
7. 显式重新确认旧 release 的权限，禁止从新版静默继承；
8. begin activation -> reconcile -> health observation；
9. 用冻结 semantic probe 验证后才恢复 active；
10. 保存 rollback receipt，并记录 `from/to` version 和 generation。

若旧 release 也失败，保持 disabled，升级到 S2/S3；不得临时调用未固定系统 runtime。

## 4. S2：关闭单一 runtime

只关闭受影响 runtime，重启 Host 后验证其他 kind：

```powershell
$env:CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_RUNTIME_NODE_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_RUNTIME_WASM_ENABLED = "0"
```

实际操作时只设置需要关闭的一项，不要机械地全部执行。被关闭 runtime 的 activation 应显示
`runtime disabled` 并保持 staged/disabled，不得自动改用另一个 executable/JRE/Node/Wasmtime。

Runtime Registry artifact 有问题时：

1. 禁止 network update；
2. 停止所有绑定该 runtime/revision 的 activation；
3. 回滚到 Registry ancestry 中上一份已签名 revision；
4. 验证来自未来 revision 的 binding 被拒绝；
5. 必要时追加 runtime revocation；
6. 离线重新验证旧 runtime archive/digest/license；
7. 逐 plugin reconcile 和 observation。

## 5. S3：关闭 Marketplace 或更新

```powershell
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_MARKETPLACE_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_MARKETPLACE_TELEMETRY_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_NETWORK_UPDATES_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED = "0"
```

然后：

1. 冻结当前 signed index、sequence、previous digest 和 transparency head；
2. 停止新的 download/prepare/update，不删除已安装 release；
3. 对恶意/损坏 release 追加 signed revocation；
4. enforcement 停用 activation，把对应 cache payload 移入 quarantine；
5. 写 quarantine receipt，阻止同一 release 再次 prepare；
6. verified cache 中其他未撤销 release 仍可离线核验；
7. 本地 `trusted-local` 插件不受 Marketplace revocation 静默接管或删除；
8. v1 Marketplace/API compatibility 仍按既有合同验证。

关闭 GitHub assistant 不影响已经构建的 `.cspkg`；assessment 也从未授权 clone/build/run。

## 6. S4：关闭全部新多运行时能力

在启动 CandleScope 的同一 PowerShell 环境中设置：

```powershell
$env:CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_RUNTIME_NODE_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_RUNTIME_WASM_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_NETWORK_UPDATES_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_MULTI_RUNTIME_TRUST_UX_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_MARKETPLACE_ENABLED = "0"
$env:CANDLESCOPE_PLUGIN_MARKETPLACE_TELEMETRY_ENABLED = "0"
```

重启后必须验证：

- Provider registry 只包含 `python-module`；
- v2 Python 插件可启动、调用、停止；
- v1 frozen compatibility wire byte-for-byte 不变；
- no-plugin、v1-only、v2-Python-only 三种启动模式通过；
- native/Java/Node/WASM activation 不运行，也不 fallback；
- Marketplace、GitHub assessment 和 Registry network update 不发起网络；
- 所有已停止进程/Supervisor/profile 零残留；
- 安装、Grant Store、audit、quarantine receipt 和用户数据仍在。

这 12 项不包括既有 `CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED`；不要在没有单独产品授权时关闭整个
v2 平台或 live/paper flags。

## 7. 进程和沙箱清理

清理必须由 Host 的明确 ownership 信息驱动：

1. 从 Supervisor/activation receipt 解析精确 PID、generation、Job Object 和 AppContainer profile；
2. 先发送 protocol shutdown，再到 deadline 后终止 Host-owned Job；
3. 检查 process tree，而不是只看父 PID；
4. 只删除本次 activation 创建且已无进程使用的临时 profile；
5. 重查 listener、PID、Supervisor registry、Job/process count；
6. 保存 shutdown/cleanup receipt。

禁止按进程名批量结束 `java.exe`、`node.exe`、`python.exe`，禁止递归删除未解析的环境变量路径，
也禁止把整个用户目录或 workspace 当作清理目标。

## 8. Cache corruption、磁盘满和网络故障

### Cache corruption

1. 比较 expected/actual SHA-256；
2. 原子移入 quarantine，而不是覆盖；
3. 写 receipt；
4. 若存在 verified archive，则从 archive 恢复并重新验证所有 metadata；
5. 无 verified source 时保持失败，不在线源码构建。

### 磁盘满

1. 保持已安装 immutable release 不变；
2. 让 staging transaction 原子失败；
3. 清理时只处理本 transaction 精确登记的临时文件；
4. 不删除用户 K 线、数据库或全部 cache 来证明恢复。

### 网络故障

1. 关闭 fetcher/network update；
2. 只允许 verified cache hit；
3. cache miss 返回稳定错误；
4. 不降低 HTTPS、签名、摘要或 expiry 检查；
5. 网络恢复后先更新并验证 index，再人工继续 staged lifecycle。

## 9. 恢复和重新启用

只有根因、修复和证据都明确后才重新启用：

1. 在独立环境重现原问题；
2. 修复通过目标单测、conformance 和故障注入；
3. 两次确定性构建相同；
4. 在空产品根完成 fresh/offline/update/rollback；
5. 真实沙箱、headed UI、资源和零残留通过；
6. 运行全量 backend/frontend/SDK 回归；
7. 运行连续 4 小时五 runtime soak；
8. 先 internal，再 opted-in-local、preview、stable；
9. 一次只重新打开一个 flag，并在每一步记录验证；
10. 更新事件报告、support matrix 和 revocation 状态。

若无法证明问题已解决，保持相应 flag 关闭；不要以“暂未复现”作为恢复依据。

## 10. 回滚完成条件

- 风险入口已关闭，未发生自动 fallback；
- 目标旧 release 或 Python-only 基线已通过 semantic probe；
- v1/v2 compatibility 合同未改变；
- residual process、Supervisor、listener、临时 profile 为零；
- receipt/audit/artifact/quarantine 证据完整；
- 用户数据库、行情、Grant Store、安装和本地 source 未被删除；
- support owner、根因状态和重新启用条件已记录。
