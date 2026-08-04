# CandleScope 多运行时插件诊断与数据收集边界

> 目标是让插件故障可复现、可归因，同时不把交易数据、账户权限或用户秘密变成诊断材料。
> 默认本地收集、最小化、脱敏；Marketplace telemetry 默认关闭。

## 1. 可以收集的字段

在定位安装、启动、协议、资源和清理问题时，可收集：

- 事件时间、Host/version、OS/arch；
- plugin id/version、release id、bundle/artifact SHA-256；
- runtime kind、runtime id、Registry revision/digest；
- trust mode、sandbox policy id、是否存在 AppContainer SID；
- activation generation、Supervisor state、稳定错误码；
- 请求类型、trace id 的随机/脱敏值、开始/结束/耗时；
- 进程数、线程数、句柄数、RSS、CPU 时间等聚合指标；
- receipt、audit、transparency record、SBOM/license/provenance 的摘要；
- cache hit/miss/quarantine、download count 和 HTTP 状态的聚合值；
- 清理前后 active process/Supervisor/profile 数；
- conformance case id、输入/输出摘要和 pass/fail；
- 浏览器 console/page error 的计数、已脱敏 network request 清单。

“摘要”是 SHA-256 或稳定枚举，不是把原始内容复制到报告。

## 2. 默认禁止收集

不得自动进入 telemetry、issue、截图、trace 或公开附件：

- API key、access token、cookie、authorization header、私钥、助记词；
- 交易账户 id、持仓、余额、订单、broker authority 或 live control payload；
- 用户策略源码、参数、私有 indicator、prompt 或模型输入；
- 原始/私有 K 线、逐笔、订单簿、回放 archive；
- 用户名、机器名、完整本地路径、环境变量全集；
- plugin stdin/stdout 的完整业务 frame；
- crash dump、memory dump 或可能包含 secret 的进程内存；
- 未经同意的 GitHub 私有仓库 metadata/source；
- 可逆的 trace id、账户映射或长期设备标识。

确需原始样本时，必须由用户明确选择文件和范围，先复制到独立取证目录、脱敏，再确认是否分享。
诊断授权不等于交易授权，也不允许临时扩大插件权限。

## 3. 错误码到证据的最小映射

| 现象 | 首选证据 | 不应先做的事 |
| --- | --- | --- |
| install/verify 失败 | receipt、artifact/SBOM/license/provenance digest、稳定错误码 | 重新下载未固定依赖 |
| runtime 找不到 | runtime id、Registry revision/ancestry、verified cache 状态 | 使用系统 PATH fallback |
| process crash | exit code、最后有界 stderr、generation、Job state | 上传 dump 或所有环境变量 |
| hang/timeout | request type、deadline、线程/句柄/RSS、cancel receipt | 无限延长 timeout |
| invalid stdout | frame index、byte count、UTF-8/JSON 错误枚举 | 保存包含业务数据的整段 stdout |
| stale result | request/generation/timestamp、discard reason | 接受旧 generation 结果 |
| network loss | URL 的 host/模板 id、cache hit/miss、error code | 绕过摘要验证或在线源码构建 |
| disk full | target volume free bytes、transaction state、temp/staging path 的脱敏值 | 删除用户数据证明可恢复 |
| cache corruption | expected/actual digest、quarantine receipt、archive restore result | 覆盖损坏文件而不留证据 |
| sandbox denial | policy id、capability、Windows error code、SID present | 切换为 trusted-local 自动重试 |
| cleanup residue | PID、image basename、parent/job id、stop receipt | 按进程名批量结束无关程序 |

## 4. 本地只读取证步骤

1. 停止对故障插件的新调用，但先不删除安装、cache 或 quarantine；
2. 记录 UTC/本地时间、复现动作、plugin/version 和当前 activation generation；
3. 导出 Plugin Manager 中的 trust、runtime、permission、health 和 stable error code；
4. 读取对应 install/activation/audit/quarantine receipt，只导出摘要字段；
5. 检查 Runtime Registry 当前 revision、ancestry 和 artifact digest；
6. 检查 Host 管理的 PID、Job Object、Supervisor、AppContainer profile；
7. 对照 conformance case 或最小公开样本重放，不使用用户私有行情；
8. 执行 Host-owned stop，再检查 residual process/Supervisor/profile；
9. 生成脱敏包清单，让用户在分享前审阅；
10. 只有定位需要时才请求一个额外原始文件，并记录用途和删除期限。

调查期间不要清空数据库、插件根、整个 cache 或 Grant Store。任何清理动作都应晚于证据保存且只
针对已解析的目标路径。

## 5. 脱敏规则

- 路径只保留 basename、workspace 相对路径或稳定哈希；
- URL 保留 scheme/host/固定模板，移除 query、fragment、token；
- trace/request id 使用当前事件内随机别名，不形成跨事件设备标识；
- stdout/stderr 仅保留错误枚举、长度、摘要和最多必要的已审阅片段；
- JSON 先按 allowlist 选字段，再序列化；不能先全量导出后用正则“清理”；
- 截图前遮盖用户名、路径、仓库权限、账户和行情；
- 浏览器 trace/network 需单独检查 header、body 和 local storage；
- artifact 可提交 SHA-256；只有开源且许可证允许、用户同意时才附原文件。

## 6. Retention 与分享

建议默认：

- 临时诊断包保存在用户明确选择的本地目录；
- 修复验证结束后由用户决定保留或删除；
- Marketplace 聚合 telemetry 不保存原始请求/响应；
- 安全事件所需的 artifact、receipt 和签名链可长期保留，但与用户行情/账户数据分离；
- 向 issue、聊天或外部服务分享前，列出文件、字段、大小、摘要和接收方；
- 删除时只删除已确认的诊断副本，不删除原安装、用户数据或审计源。

## 7. Fail-closed 原则

诊断代码不能改变执行合同：

- telemetry 不可授予权限或激活 release；
- 日志失败不允许绕过签名、摘要、sandbox 或 runtime pin；
- 诊断模式不允许更宽的网络/文件/子进程能力；
- 无法脱敏时停止导出，而不是上传完整 payload；
- 证据不完整时结论标记为 provisional，不将推测写成已验证根因；
- crash/hang/cancel 后仍按 generation 和 deadline 拒绝迟到结果。

## 8. 事件报告模板

```text
事件时间：
Host / OS / arch：
Plugin id / version / bundle SHA：
Runtime kind / id / Registry revision：
Trust / sandbox policy：
用户动作与期望：
稳定错误码：
最小复现步骤：
Receipt / audit / artifact 摘要：
资源与清理结果：
已完成脱敏：
未收集的数据：账户、secret、策略、私有行情、完整路径
临时缓解：
回滚结果：
仍待验证：
```

回滚操作见 `PLUGIN_PLATFORM_ROLLBACK_RUNBOOK_zh.md`；用户侧风险和处置见
`PLUGIN_PLATFORM_TRUSTED_LOCAL_USER_GUIDE_zh.md`。
