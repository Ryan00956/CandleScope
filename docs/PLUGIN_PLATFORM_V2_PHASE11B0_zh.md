# CandleScope 通用插件平台 v2 — Phase 11B0 执行记录

- 日期：2026-07-23
- 分支：`codex/plugin-platform-v1`
- 状态：Live 安全架构设计完成；任何实盘 capability、凭据或网络动作仍未开放

## 1. 阶段结论

Phase 11B0 是 Phase 11B 的强制前置设计门，不是 Live opt-in 的实现。它把 Phase 11A
保留的六个问题——secret broker、publisher trust、live account canonicalization、
exchange idempotency/reconciliation、醒目确认 UI、网络 kill/revoke——收敛成一个
可审查的 Live authority 决策。

当前代码继续满足：

- `secrets.use`、`trade.submit`、`trade.cancel` 不可授予；
- `verified-publisher` 不存在，manifest 的 publisher 字符串不能提升为高风险身份；
- 当前 Manager 的 “Install signed .cspkg bundle” 只是既有文案，不是签名证据；在
  Phase 12 前必须纠正为 digest-verified local/first-party pinned 的真实状态；
- Paper Runtime、Paper 状态与 Paper kill switch 不变；
- 没有真实 credential、账户 endpoint、认证 header、submit/cancel 或订单查询；
- 没有把 Phase 9 `network.connect` 改造成认证交易通道。

## 2. 证据与产物

设计包位于
[`security/phase11b-live-authority/hardening.md`](security/phase11b-live-authority/hardening.md)：

```text
docs/security/phase11b-live-authority/
├── context.md
├── hardening.json
├── hardening.md
├── diagrams/
│   ├── live-authority-boundary-before.mmd
│   ├── live-authority-boundary-paper-only-gate-after.mmd
│   ├── live-authority-boundary-in-process-live-gateway-after.mmd
│   └── live-authority-boundary-isolated-live-transaction-broker-after.mmd
└── proposals/
    └── live-authority-boundary.md
```

证据集合绑定到 revision
`e464c4f7add0e64b1139692ce0daaeef71fb2159`、Git tree
`c824383f391e842d1ace2dadde5233c392f55ff6` 和 16 个原始 Git blob 的集合 SHA-256
`b025a166090f5ff5947f5ec97f0a102c22fa52c16ca0da9312e3e5765317db6d`。

## 3. 三个可选方案

### Option 1：保持 Paper-only

继续拒绝全部实盘权限，等待 Phase 12 publisher trust 和更完整的隔离基础设施。安全
风险最低，但不交付 Live。

### Option 2：主进程内 Live Gateway

在现有 Host Python 进程中加入 secret vault port、规范账户、订单 journal、专用认证
transport 与对账。它实现成本较低，但凭据、插件控制面、数据与交易权威仍共享同一
进程故障域。

### Option 3：独立 Live Transaction Broker

插件只向 Host 提交 `OrderIntent`；Host 原生控制面完成 scope、风险和确认；受限 Broker
进程独占凭据、签名、交易网络、规范账户、订单 journal 和 query-before-retry 对账。
grant revoke、plugin disable、publisher revoke 与 kill switch 通过同步 policy epoch
在下一次网络动作前生效。

当前推荐 Option 3。若独立 Broker 的 secret confinement、持久状态机、撤销竞态或恢复
无法通过真实故障测试，必须回退到 Option 1，而不是降级为隐式不安全的 Live 路径。

## 4. 推荐方案的关键合同

- public plugin SDK 永不返回 raw secret、Authorization header、签名结果或 OS vault handle；
- `secrets.use` 是 Host 内部消费的不可转授权限，不向插件 mint 通用 signer handle；
- publisher eligibility 来自 build-pinned release record 或未来 Phase 12 的签名证明，
  绝不来自 manifest display string 或全局 `trust_level`；
- Live account 只能由 Host 在认证只读查询后建立，绑定 venue、environment、
  venue account、credential version、connector digest 与 publisher proof；
- submit 前必须持久化 intent、风险决定、确认 receipt、policy epoch 和稳定
  venue client order ID；
- crash/timeout/unknown 先按稳定 ID 查询交易所，禁止盲目重发；
- kill/revoke 先阻止新动作并关闭 in-flight transport；未获交易所证明的结果保持
  `unknown`，不得宣称已取消；
- plugin disable 停止新 submit，但保留受信 connector 的 drain-only query/cancel
  能力直到订单终态；
- Live confirmation、持续 Live 标识和 kill switch 由 Host 原生 UI 拥有，sandbox iframe
  不得到 bridge 方法，也不能覆盖确认层；
- 认证交易 transport 与 Phase 9 通用 `network.connect` 分离，不允许 redirect、任意域名、
  任意签名或将认证响应原样返回插件。

## 5. 验证

本阶段没有功能代码变更。为确认设计基线仍然成立，执行：

```text
python -m pytest \
  tests/test_plugin_grants_v2.py \
  tests/test_plugin_capabilities_v2.py \
  tests/test_plugin_integration_gateway_v2.py \
  tests/test_plugin_paper_v2.py -q
```

结果：`31 passed in 23.76s`。

该结果只证明当前授权、租约撤销、网络撤销和 Paper 状态机基线，没有测试任何实盘
行为。`hardening.json`、Mermaid、相对路径、阶段状态与 Git diff 还需在提交前统一校验。

## 6. 下一门

下一步必须先选择 Option。选择后才创建
`security/phase11b-live-authority/implementation/<option-id>.md`，绑定最新 revision 并
列出有序工作包。

若选择推荐的 Option 3，第一个实现提交只允许包含：

- first-party release-lock publisher evidence；
- 不把 digest-only 工件显示为 signed 的 Host trust label；
- Broker 私有 IPC 与 policy epoch 空壳；
- OS vault 的 opaque credential handle；
- 负向测试与 secret byte scan；
- **零交易所网络、零账户同步、零 submit/cancel**。

只有这个基础提交验收后，才依次推进只读账户规范化、testnet 对账 shadow、原生确认、
testnet submit/cancel，最后才讨论 production Live。`verified-publisher` 仍依赖 Phase 12。

## 7. 回滚

本阶段是 docs-only：

- 没有数据库 migration；
- 没有 SDK/wire/schema 变更；
- 没有 registry、grant、runtime、frontend 或 package 代码变更；
- 回滚只需撤销本阶段文档提交。

回滚后 Phase 11A Paper-only 行为不变。
