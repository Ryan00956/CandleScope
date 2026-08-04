# CandleScope Marketplace 多运行时发布清单

> 本清单用于把一个已经通过本地 Adapter 验证的插件推进到 Marketplace。它不是“从 GitHub
> 仓库直接安装”的快捷方式；Marketplace 只分发已经审核、预构建、签名且可追溯的 `.cspkg`。

## 1. 发布角色与不可混用的信任

发布前明确三类角色：

| 角色 | 负责内容 | 不得做的事 |
| --- | --- | --- |
| 上游项目 | 算法库或运行时依赖 | 不自动成为 CandleScope publisher |
| Adapter publisher | 固定上游版本、构建 Adapter、签 release | 不持有 Marketplace root key |
| Marketplace operator | 审核、签 index、rollout、撤销 | 不把 Marketplace 信任升级为 `trusted-local` |

所有生产 key 必须在独立的发布环境管理。仓库里的 reference key 只用于可复现 CI 门禁，明确是
non-production，不能加入产品默认 trust root。

## 2. 进入发布流程前

逐项确认：

- [ ] 已有 schema v3 manifest，plugin id、version、entrypoint、runtime kind、runtime id 一致；
- [ ] 上游使用不可变 tag 和完整 40 位 commit；tag、commit、下载 URL 已记录；
- [ ] 所有直接和传递依赖的版本、大小、SHA-256、许可证均已冻结；
- [ ] Adapter 只调用审核过的公共 API，没有复制上游核心实现；
- [ ] 已生成 CycloneDX SBOM、canonical license inventory、provenance 和 build receipt；
- [ ] 已有可离线复现的构建指令及其文档摘要；
- [ ] 发布产物只包含目标 OS/arch 的预构建文件；
- [ ] 没有 post-install source build、system runtime fallback 或未声明下载；
- [ ] 权限是贡献点所需的最小集合，账户、secret、交易和 live authority 独立审批；
- [ ] 本地 `trusted-local` 验证不会被描述为 Marketplace sandbox 验证。

固定 review policy：

```json
{
  "distribution": "prebuilt-only",
  "sourceBuild": false,
  "systemRuntimeFallback": false,
  "undeclaredDownloads": false
}
```

任意值不满足时停止发布；不得以 warning 方式继续。

## 3. 可复现构建门禁

1. 在两个全新的隔离 publisher staging 目录执行同一构建；
2. 只使用锁文件中允许的编译器、SDK、runtime 和依赖 cache；
3. 固定时间戳、文件顺序、archive metadata 和文本编码；
4. 分别产出 runtime artifact、manifest、SBOM、license、provenance、receipt 和 `.cspkg`；
5. 比较两次 runtime artifact 与 `.cspkg` 的 bytes；
6. 运行 manifest probe 和完整 control transcript，验证返回 descriptor 的 id/version/runtime；
7. 从全新进程启动候选包，运行 conformance、业务 corpus 与清理检查。

接受条件：两次 artifact 和 bundle 均 byte-identical；descriptor、manifest、receipt 与签名 statement
中的身份和摘要完全相等。任何 mismatch 都是发布阻断项。

## 4. Runtime 与平台绑定

每个 release artifact 必须唯一绑定：

- `os`、`arch`、runtime kind、runtime id；
- artifact path、size、SHA-256；
- Host-managed runtime 时的 Registry revision、artifact digest、license；
- plugin-bundled runtime 时的 bundle content digest；
- manifest entrypoint 与实际 bundle content。

同一 release 的 platform tuple 必须排序且唯一。Host 只选择本机精确匹配，找不到唯一匹配时
fail closed；不允许选择别的平台、调用系统 PATH 或改为源码编译。

当前 GA 只声明 Windows 11 x86_64。Linux、macOS、arm64 需要各自独立的安装、沙箱、进程清理、
故障注入和 soak 证据。

## 5. 签名链与 index v2

按顺序完成：

1. publisher key 签 artifact statement；
2. publisher key 签 release statement；
3. release 写入 append-only transparency record；
4. Marketplace root 签 canonical index；
5. 验证 index `sequence` 单调增加、`previousIndexDigest` 连续；
6. 验证 log index 和 previous record hash 连续；
7. 验证 index 未过期，release/revocation 只追加不改写；
8. 用 build-pinned root 在全新 Host 上重新验证整个链。

必须实测并拒绝：root/index/release/artifact/SBOM/license/provenance 任一篡改、sequence rollback、
freeze/expiry、平台重复、未来 Registry revision、已撤销 runtime 和已撤销 release。

## 6. 安装生命周期门禁

在空产品根依次执行：

1. `prepare`：下载一次，校验签名、size、digest、bundle 和 runtime；
2. `apply`：原子写入 immutable installation，初始状态必须 disabled/staged；
3. `grant`：用户显式确认权限；
4. `activate`：先进入 observation，不直接宣称健康；
5. `reconcile`：启动真实 runtime 进程并完成 protocol handshake；
6. `observe`：运行语义 probe，才允许进入 active；
7. `stop`：进程、Supervisor、Job Object/AppContainer profile 全部收敛；
8. `offline repeat`：断开 fetcher，再次 prepare；只允许 verified cache hit；
9. `update`：旧版 active 到新版 staged，再重新授权和 observation；
10. `rollback`：回到历史 immutable release，权限不得从新版静默继承；
11. `revocation`：停用、quarantine cache payload、写 receipt、阻止再次 prepare；
12. 再检查本地 source/reference artifact 和用户数据没有被删除。

每一步都保存 machine-readable receipt。最终要求 residual process、Supervisor 和临时 sandbox profile
均为零。

## 7. 沙箱与攻击面门禁

Marketplace 插件必须在目标平台的真实沙箱中验证，而不只是 mock policy：

- Windows AppContainer SID 存在且进程确实以对应 token 启动；
- Job Object 限制进程树，参考插件 `activeProcessLimit=1`；
- 文件、网络、环境变量和子进程权限与 manifest/grant 一致；
- stdout 只含严格 JSONL；stderr 有界并脱敏；
- crash、hang、timeout、cancel、stale generation、restart storm 均 fail closed；
- Host stop 后无孤儿进程、句柄泄漏或 Supervisor 残留；
- 沙箱可用、publisher verified、official maintenance、permission scope 四项分别展示。

“发布者已验证”不等于“CandleScope 官方维护”，也不等于“无风险”。UI 和 release metadata 都不得
合并这些概念。

## 8. Rollout 与 telemetry

固定发布顺序：

```text
internal -> opted-in-local -> preview -> stable
```

- [ ] 每个 channel 的 minimum Host、平台和 runtime 条件已验证；
- [ ] 当前 channel 不会看到更晚 channel 的 release；
- [ ] update 是人工 staged lifecycle，不是后台静默激活；
- [ ] telemetry 默认关闭；
- [ ] 开启后只记录本地聚合健康字段，不含账户、secret、策略输入、私有 bars 或原始路径；
- [ ] telemetry 失败不会改变插件权限或阻断本地 rollback；
- [ ] preview 回退路径和 stable 紧急撤销负责人已明确。

## 9. GA 发布证据

stable 前至少具备：

- [ ] 全部 SDK 的干净构建、确定性 package、自测和 fresh install；
- [ ] unified conformance suite 全 runtime transcript；
- [ ] no-plugin、v1-only、v2-Python-only、multi-runtime 四类启动矩阵；
- [ ] 真实 headed UI 的 Marketplace 安装/激活及信任信息截图、trace、network 证据；
- [ ] crash、hang、cancel、network loss、disk full、cache corruption 故障注入；
- [ ] target Adapter point-in-time corpus、稳定输出摘要和性能预算；
- [ ] 五 runtime 同进程模型的连续 4 小时 soak，零错误、零重启、零残留；
- [ ] backend 全量回归、frontend check 和 production build；
- [ ] 发布支持矩阵、用户/作者/GitHub/诊断/回滚文档；
- [ ] GA 汇总证据由脚本读取子证据并 fail closed 生成。

对应 Phase 11 证据索引见 `PLUGIN_PLATFORM_MULTI_RUNTIME_PHASE11_zh.md`。

## 10. 撤销与回滚准备

在 stable 前演练：

1. 撤销单一 release/artifact；
2. 撤销 runtime 或回滚 Runtime Registry revision；
3. 关闭单一 runtime flag；
4. 关闭 Marketplace 和 Registry network update；
5. 所有 12 个多运行时/分发开关设为 `0`；
6. 重启并证明 v2 Python 与 v1 frozen wire 不变；
7. 证明安装包、Grant Store、audit、quarantine receipt 和用户数据仍可取证。

完整操作见 `PLUGIN_PLATFORM_ROLLBACK_RUNBOOK_zh.md`。
