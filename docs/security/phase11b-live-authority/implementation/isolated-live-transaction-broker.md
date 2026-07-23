# Implementation Plan: Isolated Live Transaction Broker

## Selected Design And Constraints

2026-07-23 已选择 Option 3：独立 Live Transaction Broker。初始授权为 WP-A/WP-B，
随后用户明确授权继续 WP-C：

- WP-A 建立 build-pinned first-party `PublisherEvidence`，精确绑定 plugin、
  connector、publisher、version、bundle SHA-256 与 manifest SHA-256。
- WP-B 建立 Host-owned 独立进程、私有继承 pipe、版本化协议、policy epoch、
  opaque credential handle、Windows vault port、测试 vault 和健康/重启语义。
- WP-B 协议不包含网络、账户、签名、query、submit 或 cancel 方法；Broker 进程不做
  DNS、socket、HTTP 或交易所调用。
- WP-C 只增加 build-pinned OKX Demo Spot read-only account binding、两个固定认证
  GET 和 discover/describe/rebind；不增加订单 query、journal、submit 或 cancel。
- `trade.submit`、`trade.cancel`、`network.connect` 和 Phase 12
  `verified-publisher` 继续不可用。
- 插件进程和插件 UI 永远看不到凭据明文、vault handle、认证 header、签名材料或
  Broker 私有 IPC。
- Paper runtime、Paper 协议、Paper 数据与回滚路径保持独立。

实施状态：WP-A 已独立提交为 `5d0128e`，WP-B 为 `8aba4e9`；WP-C 技术验收完成，
等待本阶段独立提交。验收记录分别见
`docs/PLUGIN_PLATFORM_V2_PHASE11B_WPA_zh.md`、
`docs/PLUGIN_PLATFORM_V2_PHASE11B_WPB_zh.md` 与
`docs/PLUGIN_PLATFORM_V2_PHASE11B_WPC_zh.md`。WP-D 尚未授权。

生产默认值保持关闭。没有匹配的内置 release lock 记录、Windows vault 不可用、协议
握手失败、policy epoch 不一致或 Broker 退出时，结果都是 fail closed，而不是退回
主进程明文 secret 或普通 plugin network gateway。

## Source Revision And Drift Check

- 证据 revision：
  `e464c4f7add0e64b1139692ce0daaeef71fb2159`
- 证据集合 SHA-256：
  `b025a166090f5ff5947f5ec97f0a102c22fa52c16ca0da9312e3e5765317db6d`
- 实施计划 revision：
  `d26418e5d45e1e35dc80e8ae307c265ec9a1a3ca`
- drift 复核：`git diff --name-status e464c4f..d26418e` 只有 Phase 11B0 的
  10 个文档；`backend/`、`frontend/`、`packages/` 均无漂移。

因此 E001–E008 的运行时诊断仍适用。实现期间若这些证据文件出现并行修改，先重新
比对涉及的不变量；不能确认兼容时停止对应工作包，不以测试通过替代 drift 解释。

## Affected Components

WP-A 预计新增 `backend/app/plugin_live_v2/trust.py` 和一个产品内置、默认无可用
connector 的 Live release lock；它只消费 installer 已验证的 activation/bundle
字段，不修改公开 SDK manifest。`PluginPlatformSurfaces.tsx` 中把 digest-only
artifact 称为 signed 的文案会同步纠正。

WP-B 预计在同一内部包中新增：

- 严格 request/response 协议和固定 method allowlist；
- Host-side controller/client 与独立 worker；
- `CredentialVault` port、测试 fake vault、Windows DPAPI-protected store；
- policy epoch 持久状态、opaque handle 元数据和脱敏错误；
- 默认关闭的 composition-root 接线与仅暴露健康状态的内部诊断。

WP-C 在同一 Broker 包中增加 operation-specific OKX Demo read-only connector、
canonical account state、credential rebind、schema v2 migration 和受测 v2→v1
downgrade 工具；公开 SDK、Grant Store 和 management API 不变。

现有 Grant Store、Capability Broker、integration network gateway 与 Paper Runtime
不增加 Live permission，也不获得 credential use 权限。

## Ordered Work Packages

1. **WP-A — Trust evidence**
   - 冻结 `PublisherEvidence` 与 first-party release lock schema。
   - 严格解析 lock，拒绝重复键、未知字段、非规范 digest 和重复 identity。
   - 从已验证 bundle/activation 构造候选并逐字段匹配；任一不一致均失败。
   - 生产 lock 初始不声明真实 Live connector，因此默认没有对象可获 Live 资格。
   - 修正安装 UI 的 “signed” 误标。
   - 跑聚焦测试、相关 installer/core/frontend tests，独立提交。
2. **WP-B — Broker foundation**
   - 冻结协议版本和零网络 method allowlist。
   - 以 stdin/stdout inherited pipe 启动独立 worker；secret 不进入 argv/env/stderr。
   - 先握手，再处理绑定当前 policy epoch 的请求；旧 epoch 和重放 request ID 拒绝。
   - 实现 opaque credential handle 的 put/describe/revoke，响应永不返回 secret。
   - 实现 fake vault 与 Windows DPAPI-protected vault，持久文件采用原子替换。
   - 实现默认关闭 controller、健康状态、受控 stop/restart 和 crash fail-closed。
   - 跑 secret canary、malformed IPC、replay、crash/Paper 隔离、Windows vault、
     性能与全量回归，独立提交。
3. **WP-C — Authenticated read-only account binding**
   - 固定 `okx / demo / spot` 和纯 `read_only` permission。
   - Broker 内只实现 account config/balance 两个签名 GET，不暴露通用 signer。
   - 规范化 account identity，只向 Host 返回 opaque account reference。
   - 实现 discover/describe/rebind、credential revoke 和 policy advance 语义。
   - feature 默认关闭；v1→v2 只在显式启用时迁移，并提供受测 v2→v1 降级工具。
   - 跑权限、DNS/TLS、secret/UID canary、DPAPI restart、全量回归，独立提交。

WP-D–WP-G 不在当前授权内，不创建 journal、订单 query、确认或资金动作。

## Compatibility And Migration

WP-A/WP-B/WP-C 都是 additive internal contracts。现有 `.cspkg` schema、公开 SDK、插件
RPC、activation registry 和 Paper 数据不迁移。旧安装继续按 digest-only 语义工作，
但不能因此获得 Live 资格。

Live release lock 与普通 activation registry 分开；只有 Host build 内置记录可参与
WP-A。未来 Phase 12 publisher signature 不能静默改写当前 evidence；它必须引入新
schema/version 和明确 migration。

Credential records 只属于 Broker 私有根目录。格式升级必须先验证全部记录并原子
切换；解析未知 schema 时拒绝启动 credential operations。关闭 WP-B 不删除 vault
数据；回滚保留密文，人工确认后才可清理。WP-C state v2 只能在停止 Broker、完成
备份并显式确认删除只读 account metadata 后，通过受测工具降为 WP-B 可读的 v1。

## Tactical Protections During Migration

- Grant Store 继续只选择性开放 `accounts.read` 与 `trade.simulate` 的 Paper 语义。
- integration gateway 继续拒绝认证 header/cookie，不能被 Broker foundation 复用为
  认证 transport。
- feature flag 默认 false；false 时不创建 Broker 进程、pipe、vault 目录或 handle。
- 只有通过 WP-A 的 exact evidence 才能调用 credential put；`local-trusted`、
  `untrusted`、manifest display publisher 和普通 digest receipt 都不足以授权。
- Broker method allowlist 以常量和架构测试双重锁定；只有 WP-C 专用模块可导入
  `http`/`socket`，其他网络 client 或任何 order/trade 方法都会使测试失败。
- stdout 仅承载严格有界协议；stderr 有界且不包含 request params。
- policy epoch 单调持久化；advance 后旧 handle/request 不能继续使用。
- Broker crash 不触发 Host 内 fallback，不改变 Paper 状态。

## Tests And Security Validation

WP-A：

- 正常 first-party fixture 生成确定性 evidence。
- bundle、manifest、version、publisher、plugin、connector、release record 任一篡改
  均在 credential/Broker 边界前拒绝。
- local/unsigned activation 即使摘要正确也不能获得 evidence。
- lock 的重复键、未知字段、重复记录、大小越界、非规范 SHA-256 全部拒绝。
- installer receipt 与 activation record 的既有一致性测试继续通过。
- 前端不再声称 digest-only artifact 已 signed。

WP-B：

- 协议拒绝重复 JSON key、未知字段、超限 frame、未知 method、错误版本、错误 session、
  stale/future epoch 与重放 request ID。
- secret canary 扫描 response、stderr、audit、argv、env、临时目录和非 vault 文件，
  明文字节出现次数必须为零。
- handle 只可 describe/revoke；不存在 reveal/use/sign/network/account/order 方法。
- advance epoch 后旧 request 和旧 handle 拒绝；revoke 幂等但不泄漏对象存在性。
- worker 被 kill 后请求 fail closed；controller 可健康重启；Paper runtime 仍可运行。
- feature false 时进程数、pipe、vault path 和 handle 数均为零。
- Windows 上验证 DPAPI round trip、错误 entropy/context、密文 at-rest 与重启读取；
  非 Windows 生产 backend 明确 unavailable，不回退 fake。
- 架构测试扫描 WP-B 包，禁止 `socket`、HTTP client 和交易所 adapter 依赖。

WP-C：

- credential 和 OKX response 都使用 strict JSON、exact scope 与硬上限。
- 权限含 `trade`/`withdraw`、非固定 path/header 或私网 DNS 时 fail closed。
- duplicate account、cross-account rebind、revoked credential 和 stale account 拒绝。
- raw credential、`uid`、`mainUid` 不出现在 state、response 或非 vault 文件。
- feature off 不构造 connector、不迁移 state、不做 DNS/network。
- v1→v2 migration、显式 v2→v1 downgrade 和 Windows DPAPI restart 通过。

回归门包括相关 backend tests、完整 `backend/tests`、frontend typecheck/test/build、
SDK tests、`git diff --check`。WP-B 不需要浏览器或 testnet 来证明零网络 foundation，
但必须保留 Phase 11A 浏览器 smoke 和 Paper 回归。

## Performance And Resource Benchmarks

WP-B 在本机记录而不是预先声称以下预算已满足：

- worker 冷启动至握手 ready：p95 不高于 500 ms；
- 1,000 次无 secret 的 health/describe 本地 round trip：p95 不高于 10 ms，
  p99 不高于 25 ms；
- idle RSS 建议不高于 64 MiB；
- 连续 10,000 次受限请求后 pending/replay cache 有界，RSS 不持续线性增长；
- stop/revoke 到旧 epoch 被拒绝：本地下一请求立即生效。

若环境噪声使绝对预算不稳定，提交原始样本、机器/解释器信息与分位数；不得通过
移除 Broker hop、放宽 epoch 或启用网络来“优化”。

## Rollout And Rollback

1. 合并 WP-A 时仅增加 trust evidence；生产 lock 没有 Live connector，外部行为仍为
   Paper-only。
2. 合并 WP-B 时 feature 仍默认 false。开发 smoke 必须显式启用并使用 fixture
   evidence 与 fake/DPAPI vault；不使用真实 API key。
3. 启用失败、Broker crash 或 vault unavailable 时自动结果是 unavailable；不创建
   Live grant，也不走普通 plugin network。
4. 回滚 WP-B：关闭 flag、推进/封存 policy epoch、停止 worker、保留加密 vault；
   回退独立 WP-B 提交。
5. 回滚 WP-A：先确保 WP-B 已关闭且无 handle，再回退 WP-A 提交。普通插件安装和
   Paper 不受影响。
6. 回滚 WP-C：先关闭 account flag、停止 Broker、备份 state/vault，再用
   `downgrade_live_broker_state_v2_to_v1.py` 显式删除 account metadata 并写 v1；
   或保留 WP-C 代码但保持 flag=false。

WP-C 没有订单状态，因此回滚不需要 venue order cleanup；没有真实 Demo key smoke。

## Acceptance Criteria

- Option 3 选择、证据 revision、drift 与授权范围可追溯。
- WP-A、WP-B 与 WP-C 是独立、可单独回退的提交。
- 只有 exact build-pinned first-party release record 能产生 `PublisherEvidence`。
- local/unsigned/mismatched publisher 在任何 credential handle 创建前被拒绝。
- Broker 是独立进程且只有私有继承 IPC；协议版本和 policy epoch 强制执行。
- credential API 只返回 opaque reference/metadata，secret canary 不越过 vault 边界。
- WP-B 单独启用时零 network；WP-C 只允许两个固定认证 GET 和三个 account 方法。
- stale epoch/replay 失败，Broker crash 不影响 Paper。
- feature off 为零进程、零 pipe、零 vault 创建、零 handle。
- `trade.submit`、`trade.cancel`、order query 和 verified publisher 仍不可用。
- 聚焦、全量、frontend、SDK 和 diff hygiene 门通过，或明确记录真实 blocker。

## Open Decisions

- 第一个 connector 已选择 OKX Demo Spot read-only；production lock 继续为空。
- WP-C 继续使用 current-user DPAPI。是否迁移 Windows Credential Manager 是未来独立
  hardening，不阻塞默认关闭的只读绑定。
- Broker 继续使用 inherited pipe；是否迁移 ACL named pipe 是未来独立 hardening。
- WP-D 前选择 journal 存储和 crash-consistency 模型。
- WP-E 前冻结原生 intent-bound confirmation 与 audit export 合同。
- WP-F/WP-G 必须分别获得新的明确授权；测试通过不会自动打开 testnet 或 production。
