# CandleScope 通用插件平台 v2 — Phase 11B WP-B 执行记录

> 本文保留 WP-B 提交时点的历史边界与测试数字。用户随后已授权并完成 WP-C
> 认证只读账户绑定；当前状态与新门禁见
> [`PLUGIN_PLATFORM_V2_PHASE11B_WPC_zh.md`](PLUGIN_PLATFORM_V2_PHASE11B_WPC_zh.md)。

- 日期：2026-07-23
- 分支：`codex/plugin-platform-v1`
- 方案：Option 3 — 独立 Live Transaction Broker
- 工作包：WP-B — Broker foundation
- 状态：技术验收完成、默认关闭；账户、认证网络与订单动作仍不存在

## 1. 阶段结论

WP-B 已把 credential custody 的最小基础从普通插件 sidecar 和 Host 公共 RPC 中分离：

- `LiveBrokerController` 仅在
  `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENABLED=1` 时启动；
- Core composition 还要求全局平台是 `first-party-pinned`，否则启动前 fail closed；
- worker 由 Host 以 `python -I -u` 启动，只注入固定的 Host backend 与 pinned SDK
  source 路径，不读取环境 `PYTHONPATH`；
- 通道只有父进程创建并继承的 stdin/stdout pipe，没有监听 socket、named pipe、
  HTTP endpoint 或插件可连接地址；
- worker 目录持有独占锁，避免两个 Broker 同时修改 policy/vault metadata；
- stdout 只承载有界 strict JSON 协议，stderr 只允许脱敏错误码且有 16 KiB 硬上限。

production feature 默认 false，production first-party Live release lock 仍为空。代码落地
后没有任何 connector 能创建真实 credential handle。

## 2. 私有协议与撤销

协议版本固定为 `candlescope.live-broker-foundation/1`。每个请求必须同时匹配：

- private session nonce；
- 从 1 开始严格递增的 sequence；
- 当前持久化 policy epoch；
- 固定 method allowlist 和逐方法 exact params。

唯一允许的方法是：

```text
foundation.bootstrap
foundation.health
policy.advance
credential.put
credential.describe
credential.revoke
foundation.shutdown
```

协议中没有 network、HTTP、account、query、sign、trade、order、submit 或 cancel 方法。
静态 AST 门同时禁止 WP-B package 导入 socket/HTTP/交易 client。

`policy.advance` 必须恰好加一。Broker 先原子持久化新 epoch、清空全部 active handle 并
登记待删除密文，再清理 vault；因此即使删除阶段 crash，旧 handle 也已经不可用。
stale/future epoch、重放 sequence 或错误 session 都被拒绝，session/sequence 违规会
终止当前 worker。

## 3. Opaque credential 与 vault

Host 只得到 `cred_<random>` opaque reference 和非敏感 metadata。持久状态只保存
handle SHA-256，不保存 raw handle；插件 API、SDK、catalog 和 UI 都没有这个类型。

vault port 有两个实现：

- `WindowsDpapiCredentialVault`：使用 current-user DPAPI +
  broker-specific optional entropy，密文原子写入 Broker 私有目录；读取使用可擦除
  `bytearray`，离开 context 后 best-effort 清零；
- `FakeCredentialVault`：只在 controller 显式
  `allow_test_backend=True` 时可启动，进程退出即擦除。

credential put 顺序是“先写 DPAPI/fake vault，再原子登记 handle”；登记失败就删除
vault record。revoke/epoch advance 则相反，先让 handle 在 durable state 中失效，再
清理密文。启动时会清除 orphan ciphertext，并移除没有 vault record 的失效 metadata。

Python 与操作系统不能保证进程内存从不进入管理员 crash dump；本阶段证明的是 secret
不进入插件、公开 RPC、响应、argv、环境、stderr、状态 JSON 或明文磁盘文件。Windows
用户账户完全失陷仍在既定威胁边界之外。

## 4. Host 集成与 Paper 隔离

`CorePluginPlatform` 新增默认 false 的 Broker foundation flag。false 时：

- 不启动进程；
- 不创建 pipe；
- 不创建 `live-broker-v1` 目录或 vault；
- 不创建 credential handle。

Broker 启动失败会阻止该显式启用的 Core start，不会回退到主进程明文 secret 或普通
`network.connect`。Broker crash 后请求 fail closed；显式 restart 建立新 session，
DPAPI backend 可重开已登记密文，fake backend 会清除已丢失的 handle。

故障测试在 Broker 被 kill 前后比较了真实 `PluginPaperRuntime.status()`，Paper 状态
不变，并在 Broker 重启后继续独立可用。现有 Paper DTO、ledger、risk、kill switch
和数据文件没有迁移。

## 5. 安全与功能验证

执行：

```text
python -m pytest \
  tests/test_plugin_live_broker_v2.py \
  tests/test_plugin_live_trust_v2.py -q

python -m pytest \
  tests/test_plugin_core_v2.py \
  tests/test_plugin_paper_core_v2.py \
  tests/test_plugin_host_v2.py \
  tests/test_plugin_capabilities_v2.py \
  tests/test_plugin_security_management_v2.py -q

python -m pytest tests -q
python -m pytest -q  # packages/candlescope-plugin-sdk
python -m ruff check \
  app/plugin_live_v2 \
  app/plugin_core_v2/runtime.py \
  app/plugin_core_v2/bootstrap.py \
  tests/test_plugin_live_broker_v2.py \
  scripts/plugin_live_broker_benchmark.py
```

结果：

- WP-A/WP-B 聚焦：34 passed；
- Core/Host/Capability/Paper/management：60 passed；
- backend 全量最终运行：2110 passed、2 failed，4 条既有 FastAPI `on_event`
  deprecation warning；
- SDK 全量：80 passed；
- Ruff：通过；
- WP-A 后的 frontend 全量：2353 passed，TypeScript typecheck 与 ESLint 通过；
  WP-B 没有 frontend/SDK contract 变更。

负向覆盖包括 local/untrusted publisher、identity/digest mismatch、重复 JSON key、
unknown method、错误 session、sequence replay、stale epoch、inactive handle、Broker
crash、错误 DPAPI entropy、feature-off 零副作用和 secret canary 扫描。

backend 全量的两个失败均位于本工作包未修改的既有路径：

- `test_blind_trade_service_never_exposes_archive_paths_or_actual_time` 在全量负载下
  发生一次 Replay shutdown 超时，隔离复跑通过；
- `test_stderr_overflow_kills_wrapper_and_its_appcontainer_job_tree` 的零等待
  `WaitForSingleObject(..., 0)` 断言失败，隔离复跑连续复现。相关
  `plugin_host/process.py`、Windows sandbox runner 与测试文件均未被 WP-B 修改。

因此 WP-A/WP-B 聚焦与所有受影响回归为绿，但仓库级 backend 全量门不声明为通过；
该 Windows 子进程回收时序问题作为真实 residual gate 保留，不能用历史绿灯覆盖。

## 6. Windows 性能与资源证据

采集命令：

```text
python scripts/plugin_live_broker_benchmark.py --starts 10 --requests 10000
```

环境：Windows 11 `10.0.26200`、CPython 3.12.7。结果：

| Metric | Measured | Budget |
| --- | ---: | ---: |
| worker cold start p95 | 315.748 ms | ≤ 500 ms |
| private health round trip p95 | 0.223 ms | ≤ 10 ms |
| private health round trip p99 | 0.319 ms | ≤ 25 ms |
| idle RSS | 34,205,696 bytes | ≤ 67,108,864 bytes |
| RSS after 10,000 requests | 34,213,888 bytes | ≤ 67,108,864 bytes |
| RSS growth | 8,192 bytes | ≤ 16,777,216 bytes |

机器可读 artifact：
[`perf-baselines/plugin-platform-v2/phase11b-wpb-2026-07-23-windows-amd64.json`](perf-baselines/plugin-platform-v2/phase11b-wpb-2026-07-23-windows-amd64.json)

SHA-256：
`01a9412d0dfb52a614692c0131d4344d4b52bed76febe1bf4ea067eef36b7225`

这是本机 fake-vault/health 基线，不是生产 SLO，也不测交易所延迟；它只证明 WP-B 的
额外本地 hop 和顺序协议在当前预算内，且 10,000 次请求没有线性 RSS 增长。

## 7. 未开放的能力

本工作包明确没有：

- 真实 API key、OAuth token 或交易所账户；
- account discovery/canonicalization；
- DNS、socket、HTTP、认证 header 或 connector transport；
- signature/use/reveal secret 方法；
- order journal、reconciliation、submit/cancel/query；
- `secrets.use`、`trade.submit`、`trade.cancel` grant；
- testnet 或 production Live UI/mode；
- Phase 12 `verified-publisher`。

“Broker ready”只表示本地 foundation 握手完成，不表示 Live ready。

## 8. 回滚

WP-B 与 WP-A 是独立提交。回滚 WP-B：

1. 保持或设置
   `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENABLED=0`；
2. 停止 worker；当前没有订单、账户或网络动作需要 drain；
3. 保留 `live-broker-v1` 下的 DPAPI ciphertext，除非用户明确选择清理；
4. 回退 WP-B 阶段提交。

普通插件、SDK、Paper 数据和 WP-A evidence 不受影响。若要继续回滚 WP-A，必须先确认
Broker 已关闭且没有 active handle。

## 9. 下一门

WP-C 尚未授权。开始前仍需明确：

- 第一个 build-pinned venue/testnet；
- canonical account identity 和 environment 语义；
- credential rotate/rebind；
- 只读认证 query 的专用 connector transport 与域名/TLS pin；
- Windows Credential Manager 与当前 DPAPI store 的最终产品选择。

WP-C 最多只允许 read-only account discovery，仍不能 submit/cancel。没有新的明确授权，
本分支停在 WP-A/WP-B 的零网络边界。
