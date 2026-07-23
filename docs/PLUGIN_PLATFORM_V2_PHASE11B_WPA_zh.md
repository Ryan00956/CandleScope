# CandleScope 通用插件平台 v2 — Phase 11B WP-A 执行记录

- 日期：2026-07-23
- 分支：`codex/plugin-platform-v1`
- 方案：Option 3 — 独立 Live Transaction Broker
- 工作包：WP-A — Trust evidence
- 状态：技术验收完成；Live、凭据与认证网络仍关闭

## 1. 本工作包交付了什么

WP-A 新增内部 `PublisherEvidence` 合同和严格的 first-party Live release lock：

- evidence 精确绑定 plugin ID、connector ID、publisher、version、bundle SHA-256、
  manifest SHA-256、release-record SHA-256 与整份 lock SHA-256；
- `publisherIdentity` 来自 Host build 内置 release record，不再把 manifest 的 display
  publisher 字符串当作实盘身份；
- 只有 `first-party-pinned`、active activation、已验证 bundle 和 release record
  全字段一致时才会签发 evidence；
- local/untrusted、未知 connector、disabled activation、伪造 evidence 和任一 digest/
  identity mismatch 均 fail closed；
- strict JSON loader 拒绝重复键、未知字段、错误 schema、非规范 digest、重复 connector、
  非标准数值和超过 64 KiB 的 lock。

生产 lock
`backend/app/plugin_live_v2/first-party-live-connectors-v1.json` 当前是合法空集合。
这不是占位成功：它意味着本 Host build **没有任何可获得 Live 资格的 connector**。
第一个真实记录只能在后续选定 venue、固定 release artifact 并完成独立复核后加入。

## 2. Trust label 修正

Plugin Manager 原来的 “Install signed .cspkg bundle” 没有 publisher signature 证据。
WP-A 将它改为 “Install digest-verified local .cspkg bundle”，并增加前端回归测试，避免
以后再次把内容摘要校验误标成 publisher 签名。

这不会降低 installer 已有的完整性验证；它只是让用户看到的信任声明与实际证据一致。
Phase 12 的 `verified-publisher` 仍未实现。

## 3. 未开放的能力

本提交没有新增或开放：

- raw secret、OS vault、credential handle；
- Broker 进程或 Broker IPC；
- 账户发现、账户绑定、认证 header、签名或交易所 transport；
- `secrets.use`、`network.connect` 的认证变体；
- `trade.submit`、`trade.cancel`；
- testnet 或 production Live mode。

现有 Grant Store 许可集合、Capability Broker、Paper Runtime、SDK manifest/wire schema
均未修改。

## 4. 验证证据

执行的聚焦和相关回归：

```text
python -m pytest tests/test_plugin_live_trust_v2.py -q
python -m pytest \
  tests/test_plugin_installer_v2.py \
  tests/test_plugin_core_v2.py \
  tests/test_plugin_paper_core_v2.py -q
python -m ruff check app/plugin_live_v2 tests/test_plugin_live_trust_v2.py
npm test
npm run typecheck
npm run lint
git diff --check
```

结果：

- WP-A trust：20 passed；
- installer/core/Paper：19 passed；
- frontend：2353 passed；
- Ruff、TypeScript typecheck、ESLint 与 diff hygiene：通过。

frontend test 输出过一次已占用的测试 WebSocket 端口警告，但测试 runner 最终为
exit code 0、零失败；它不是 WP-A 运行时端口，也没有影响 trust 结论。

## 5. 回滚

WP-A 是 additive 且没有数据 migration：

1. 确认 WP-B feature 关闭且不存在 credential handle；
2. 回退本工作包提交；
3. Plugin Manager 文案会回到旧状态，但普通 `.cspkg` 安装和 Paper 数据不变。

生产 lock 当前为空，因此回滚不涉及 connector、账户、vault 或订单状态。

## 6. 下一门

下一步是 WP-B Broker foundation：

- 独立 worker 与私有 inherited pipe；
- 固定协议版本、session 与 policy epoch；
- opaque credential handle；
- fake vault 与 Windows DPAPI-protected vault；
- 健康、受控停止/重启、replay/crash/secret-canary 测试；
- 协议和实现 **零 network/account/order/sign 方法**。

WP-B 必须独立提交、默认关闭。通过 WP-B 也不会自动开始 WP-C；账户发现、认证网络和
交易动作仍需新的工作包和明确授权。
