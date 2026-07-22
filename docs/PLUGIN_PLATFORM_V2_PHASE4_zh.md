# CandleScope 通用插件平台 v2 — Phase 4 执行记录

> 状态：**实现与技术验收已完成，随本阶段独立提交交付**，2026-07-22。
>
> 父基线：`codex/plugin-platform-v1@eb7316b`（Phase 3）。
>
> 边界：本阶段交付权限、capability、审计和 Windows OS 隔离安全门；没有把 v2
> registry 或管理路由接入产品默认启动，没有开放真实网络代理、文件选择器、secrets、账户、
> 交易或 Marketplace，也没有建立签名 publisher identity。

## 1. 验收结论

Phase 4 把 Phase 3 的“可验证安装”推进为“默认无权限、授权可撤销、进程可隔离”的控制面：

- bundle/publisher/major/manifest 绑定的独立 Grant Store；
- required/optional、scope 差异、显式 grant/deny/revoke 和升级 staging；
- 仅驻留 Host 内存的 256-bit opaque capability handle；
- scope、用户动作、速率、调用次数、请求/响应字节和 trace 审计；
- Windows AppContainer、ACL、Job Object、私有 temp/data、direct network deny；
- Origin、CSRF、本地 session、loopback client/Host 共同保护的 management router；
- 文件、网络、fork、handle 伪造和资源耗尽的真实恶意探针。

Windows 原生攻击探针已经证明 direct file/network 和进程树隔离。但通用 v2 registry 仍未由
`app.main` 消费；manifest publisher 字符串也不是密码学身份。因此默认安装路径继续标记为
`local-trusted`，不能据此宣称 Marketplace 或任意社区 Python wheel 已安全开放。

## 2. 持久化边界

Phase 4 不把 grant 混入 activation registry：

```text
plugin-platform-v2/
├── platform-registry-v2.json          # 当前 activation；Phase 3 所有权
├── platform-grants-v2.json            # 当前 bundle-bound grant；Phase 4 所有权
├── platform-grants-v2.lock
├── audit-v2/
│   └── events/
│       └── <sequence>-<event-id>.json # append-only hash chain
├── installations/                     # immutable bundle/venv/receipt
├── history/                            # activation/rollback history
├── private/<plugin-id>/                # 将来的插件私有数据根
└── sandbox-runtime/                    # Host-owned launch config/status
```

Grant Store 只保存授权意图、requested/granted scope、decision、确认版本和身份摘要。raw secret、
raw capability handle 和账户凭据都不允许进入 scope、CLI/API 响应或 audit。审计事件逐文件不可变，
包含前一事件哈希；中间删除、插入、改写、重排或混入不支持的目录项都会在读取时失败。当前
没有外部 transparency anchor，因此不能把“仅删除链尾”宣称为可检测。

当前 publisher identity 明确为 `manifest:<publisher>`，只用于本地绑定和升级判断，不冒充签名
身份。`secrets.use`、`accounts.read`、`trade.*` 在签名 publisher 和交易阶段前一律不可 grant。

## 3. Permission 协商与升级

每个 manifest permission 必须来自 Host 的已知 permission catalog。Grant Store 对 scope 使用
偏序比较：

- object 只能减少字段或收窄子 scope；
- array grant 必须是 requested array 的子集；
- `maxHistoryBars`、`maxNotional`、`ratePerMinute` 等上限只能降低；
- 不可比较的变化按扩大处理，fail closed；
- `token`、`password`、`secret`、`apiKey`、`privateKey` 等敏感字段直接拒绝。

首次请求、新 permission、optional→required、scope 扩大/不可比较、publisher identity 或 major
变化都进入 `pending`。同 publisher identity 和 major 内，已 grant 的相同/收窄 scope，以及已
deny/revoke 的相同/收窄决策可以继承。所有 prompt 已显式处理、且 required scope 全量满足后，
`activationReady=true`。

安装器在 immutable installation 和 fresh-process probe 完成后，先计算并记录 permission diff，
再生成 activation：

- `activationReady=false` 时始终 `staged`，即使调用者传入 `--enable`；
- optional permission 也必须先 grant 或 deny，不能靠“忽略提示”自动激活；
- required permission 被 deny/revoke 或只得到部分 scope 时不能 enable；
- active 插件的 grant 失效后，registry 立即降为 `staged`；
- rollback 会重新绑定目标 bundle；若旧 grant 不能安全恢复，回滚版本也保持 `staged`。

Grant Store 和 activation registry 是两个原子文件。跨文件异常时选择安全优先：新 binding
可能先使旧 handle 失效，但不会让没有 grant 的新 activation 获得权限。

## 4. Capability 与 Broker

Host 只接受 `CapabilityHandleAuthority` 在 descriptor 校验后、activation generation 已确定时
mint 的 handle。每个 handle 使用 32-byte CSPRNG，wire 形式为 `caph_<opaque>`；Host 内存和
审计只索引 SHA-256 fingerprint。

lease 绑定以下全部维度：

```text
plugin + entrypoint + instance + generation
+ permission + granted scope + contribution IDs
+ bundle digest + publisher identity + confirmation version + TTL
```

伪造、过期、revoked、旧 generation、错误 contribution、scope/permission 被替换，或 Grant
Store confirmation version 已变化时，调用在 handler 前失败。deactivate、transport fatal、
stop 和 activation 失败都会撤销整个 instance 的 handle；在途 handler 若跨过撤销点，结果不
再回传插件。

`CapabilityBroker` 在真实 Host handler 前依次执行：method registration、permission binding、
当前用户动作、请求字节、scope、每分钟速率、每 activation 次数、返回 JSON 和响应字节检查。
允许和拒绝结果都带原 trace ID 写审计。Phase 4 没有注册 `network.connect` 或文件代理 handler，
所以“声明了 permission”不等于 Host API 已开放。

## 5. Windows OS 沙箱

### 5.1 启动路径

`SidecarProcessSpec(trust_level="untrusted")` 没有 `SandboxPolicy` 时在创建阶段直接失败。配置沙箱
后，Host 先启动可信 `windows_runner.py`，runner 再执行：

1. 创建/派生由 publisher identity、plugin ID、major 确定的 AppContainer profile；
2. installation 和显式 runtime roots 只授予 package SID `RX`；
3. 独立 private root 授予 `M`，`TEMP/TMP/HOME/APPDATA` 都指向该边界；
4. 创建 stdin/stdout/stderr pipe，只把三只 child handle 加入继承白名单；
5. 用无网络 capability 的 `SECURITY_CAPABILITIES` 挂起创建 child；
6. 在任何插件指令运行前把 child 加入已配置 Job Object，再恢复主线程；
7. wrapper 退出时 `KILL_ON_JOB_CLOSE` 回收整棵 Job 进程树。

没有使用会在本机触发 `0xC0000142` 的 child-process attribute；子进程数由 Job
`ActiveProcessLimit=1` 在恢复前生效，同样不存在先运行再收编的 race。

### 5.2 配额与网络

Job Object 同时设置 per-process/job memory、per-process CPU time、CPU hard cap、active process
和 kill-on-close。runner 监控 wall time，以及 private/profile 两个可写根的磁盘使用量；Host
按累计字节限制 stderr，JSONL transport 和 broker 分别限制 wire message 与 Host API payload。
任一超限只终止该 sidecar/wrapper，不终止主 Host。

AppContainer 不获得 internet/private-network capability，也没有 direct proxy fallback。真实探针
对外部 `1.1.1.1:53` 得到 `WSAEACCES`；对 Host 已打开的随机 localhost TCP listener 无法完成
连接，listener 没有 accept 到连接。网络代理将在后续阶段按域名、端口、TLS 和解析后 IP 策略
单独开放。

## 6. CLI 与 management router

显式 CLI 命令：

```powershell
python scripts\candlescope_plugin.py v2 --root C:\managed --json permissions
python scripts\candlescope_plugin.py v2 --root C:\managed --json permission-diff `
  C:\plugin.cspkg --sha256 sha256:<digest>
python scripts\candlescope_plugin.py v2 --root C:\managed --json grant `
  candlescope.example market.bars.read --scope-json '{"symbols":["BTCUSDT"]}'
python scripts\candlescope_plugin.py v2 --root C:\managed --json deny `
  candlescope.example notifications.show
python scripts\candlescope_plugin.py v2 --root C:\managed --json revoke `
  candlescope.example market.bars.read
```

`--scope-file` 只接受不超过 64 KiB 的 regular file；所有 scope 使用 strict JSON，重复 key、
非有限数、越权 scope 和敏感字段都失败。

`create_permission_management_router()` 提供同一组只读/变更操作，但默认不挂入 `app.main`。
嵌入方必须显式提供进程启动时生成的 ephemeral session/CSRF token 和精确 loopback Origin。
每个请求同时校验：

- TCP client 是 loopback；
- URL Host 是 `localhost` 或 loopback IP，拒绝 DNS rebinding Host；
- 没有 `Forwarded`/`X-Forwarded-*`/`X-Real-IP`；
- Origin 精确命中 allowlist；
- session header constant-time 匹配；
- mutation 另需 CSRF 和显式 user-action ID。

token 不在 HTTP 响应中返回。产品默认挂载和可信桌面 token handoff 留给 Phase 5 组合根。

## 7. 恶意探针与退出门

| 攻击/故障 | 实证结果 |
| --- | --- |
| 用户 secret、仓库源码读取 | AppContainer `CreateFileW` 拒绝 |
| installation 写入 | ACL 拒绝；private data 写入成功 |
| 外网与真实开放 localhost listener | direct socket 无法连接 |
| fork/任意 child | Job active-process limit 拒绝 |
| wrapper 被 Host 强杀 | Job handle 关闭；记录的 child PID 已退出 |
| 512 MiB 连续内存申请 | 在 256 MiB Job ceiling 前停止 |
| CPU busy loop | 1 CPU-second limit 在 wall limit 前终止 child |
| private disk flood | runner 检测后只终止该 Job，返回 violation sentinel |
| stderr flood | Host 累计上限触发 wrapper kill；tail 仍有界 |
| wire/request/response overflow | transport/broker 在 handler 边界失败 |
| forged/stale/revoked handle | authority 在 dispatch 前失败 |
| grant revoke 后旧 handle | confirmation version 检查立即失效 |
| localhost Origin/session/CSRF 绕过 | 全部返回 403；合法三重凭据通过 |
| permission scope 扩大与 rollback | 新旧目标都保持 staged，拒绝自动继承 |

### 7.1 自动化结果

| 门禁 | 结果 |
| --- | --- |
| 最新插件专项矩阵（含真实安装、Host、Grant、management、Windows 探针） | 176 passed；4 条既有 FastAPI `on_event` 弃用警告 |
| Phase 4 security 定向矩阵 | 19 passed |
| 完整 backend 回归 | 2019 passed；同 4 条既有弃用警告 |
| 公共 SDK | 58 passed |
| static | Phase 4 范围 Ruff、format check、compileall、`git diff --check` 全通过 |

完整 backend 通过后增加的 root-overlap、management credential 和 audit-directory 三项加固，
由最新 176 项插件矩阵重新覆盖；没有并行运行安装器与 backend 全量，避免用资源争用制造时序
假失败。

## 8. 保留边界与下一阶段

本阶段通过了 Windows OS 层 direct file/network 负例，所以可以继续 Phase 5。但以下陈述仍然
不成立：

- “任意 PyPI wheel 都已在默认产品里以 untrusted 运行”；
- “publisher 名称已完成签名认证”；
- “网络、文件、secrets、账户或交易 permission 已有可调用 Host API”；
- “管理 API 或 v2 registry 已进入默认 FastAPI lifecycle”；
- “Marketplace、自动下载/更新或浏览器插件 UI 已开放”。

尤其是 Phase 3 installer 的 fresh-process probe 仍按 `local-trusted` 执行普通 venv sidecar；在
probe 本身也进入 AppContainer、且兼容 runtime 的只读依赖根被精确固定前，不得用它安装并
执行未知来源 Python wheel。

Phase 5 应建立产品组合根，只从 active registry 生成 supervisor，给 authority 注入同一 Grant
Store，给兼容的 self-contained runtime 生成 SandboxPolicy，并先开放 command/settings/
notification/event/job 与 namespaced private storage。任何不能在 AppContainer 内启动的 runtime
继续停留在 `first-party-pinned`/`local-trusted`。

## 9. 回滚

Phase 4 是 additive，可独立回滚：

1. 停止消费 `platform-grants-v2.json` 和 `audit-v2/events`；
2. revert `app.plugin_security_v2`、Host capability/sandbox 接线、installer permission 命令和本文；
3. 恢复 Phase 3 的 required-permission 一律 staged 行为；
4. 保留 v2 immutable installations、Phase 3 registry/history 和 v1 runtime registry；
5. AppContainer profile/ACL 可在确认无运行进程后按精确 profile/SID 单独清理。

回滚不修改 v1 Pyne/Pine runtime、业务数据库、Data Engine、HTTP/WS 路由或前端状态。
