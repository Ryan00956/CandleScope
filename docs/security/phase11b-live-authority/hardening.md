# Security Hardening Review: CandleScope Phase 11B Live Authority

## Evidence Basis

本设计绑定到 `e464c4f7add0e64b1139692ce0daaeef71fb2159` 的 16 个仓库证据文件。
我检查了授权、bundle 校验、能力租约、网络撤销、Paper 状态机、审计以及原生/
sandbox UI 边界，并在同一 revision 上重跑了 31 个聚焦测试。证据显示当前
Paper-only 边界是有意且有效的，但仓库里还没有一个能同时拥有 publisher 证明、
凭据、规范账户、实盘订单日志、对账和网络撤销的单一权威组件。

完整清单与摘要见 [context.md](context.md)。这些材料是架构决策时的冻结证据快照；
此后用户选择 Option 3，并只授权实现 WP-A/WP-B。当前运行时代码已增加 build-pinned
publisher evidence 与零网络 Broker foundation，但这不表示 Phase 11B 已整体交付，
更不表示任何实盘风险已经被解除。

## Constraints

我们保持 Windows 桌面基线、现有 `.cspkg`/sidecar/Grant Store/Capability Broker、
Paper 语义和 Host 原生 Plugin Manager。默认仍是零实盘权限；本阶段不开放提现、
转账、杠杆、保证金、做空、通用 secret 签名或任意认证网络。Phase 12 的社区
publisher 签名尚未完成，因此第一个实现切片只能考虑显式 build-pinned 的第一方
connector。

没有给出正式延迟或内存预算。本提案使用平衡型约束，并把本地 IPC、RSS、撤销延迟
和故障恢复列为实现前必须量化的门。

## Opportunity Portfolio

| Opportunity | Evidence | Options | Recommendation | Proposal |
| --- | --- | --- | --- | --- |
| 集中并隔离 Live authority | Phase 11B 退出门、manifest 身份缺口、摘要-only bundle、现有撤销原语、Paper unknown recovery、原生 UI 边界（E001–E008） | 1. 保持 Paper-only；2. 主进程内 Live Gateway；3. 独立 Live Transaction Broker | 在当前约束下选择 Option 3；若 Broker 隔离与持久对账无法证明，则退回 Option 1 | [完整提案](proposals/live-authority-boundary.md) |

## Recommendation Summary

三个选项都比“把 API key 交给插件 sidecar”更安全，但只有 Option 3 把最危险的能力
收敛到一个可审计、可撤销的边界：插件只产生规范化 `OrderIntent`；Host 控制面拥有
scope、风险和不可伪造的确认；独立 Broker 进程拥有 OS vault、规范账户、持久订单
journal、query-before-retry 对账、专用认证传输和 policy epoch。

我推荐 Option 3，不是因为多一个进程天然安全，而是因为它让“谁能接触明文、谁能
发出认证网络动作、谁能在 crash 后决定是否重试”有一个明确所有者。代价是新进程、
私有 IPC、打包和故障恢复复杂度。若我们无法用测试证明 secret 不越过 Broker、
kill/revoke 在下一次网络动作前生效，或 unknown 状态可以可靠对账，正确选择仍是
Option 1：继续 Paper-only。

Option 2 适合严格信任整个 Host 后端、只做一个第一方 venue 且交付时间压倒进程隔离
收益的场景；它不应被包装成与 Option 3 等价的隔离。

## Next Decisions

2026-07-23，用户已选择 **Option 3：独立 Live Transaction Broker**，并授权继续
WP-A/WP-B。实施计划见
[implementation/isolated-live-transaction-broker.md](implementation/isolated-live-transaction-broker.md)。

当前授权只覆盖“信任证明 + secret handle + Broker foundation、零网络动作”。WP-A
已独立提交为 `5d0128e`，WP-B 已完成技术验收并在独立阶段提交中。两个工作包分别
可回滚；`verified-publisher`、账户发现、认证网络、生产实盘 submit/cancel 和
自动化 Live session 都继续保持关闭。下一步 WP-C 不在当前授权范围内。

WP-A/WP-B 聚焦与受影响回归已通过。最终 backend 全量运行有两个既有路径失败：
Replay shutdown 超时在隔离复跑通过；未修改的 Windows AppContainer 子进程回收
零等待断言可稳定复现。后者保留为仓库级 residual gate，因此不把 backend 全量写成
绿灯，也不阻塞本阶段默认关闭、零网络的独立提交。
