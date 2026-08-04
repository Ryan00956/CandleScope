# CandleScope `trusted-local` 用户指南

## 1. 一句话理解

`trusted-local` 的含义是：**你允许这个本地插件以当前 Windows 用户身份执行应用代码**。
它不是“官方认证”、不是“无病毒”、也不是 AppContainer 沙箱等级。

即使选择 trusted-local，CandleScope 仍不会自动授予：

- 交易所账户或 API key；
- 实盘下单 authority；
- 任意网络和文件访问；
- CandleScope 私有数据库访问；
- 未在 manifest 中声明的 Host API；
- 无限子进程或后台常驻权。

## 2. 什么时候可以考虑使用

适合：你自己从固定源码构建的 Adapter、团队内部已审核插件、没有 Marketplace release 但必须使用的
预编译本地算法。

不适合：来源不明的聊天附件、网盘二进制、只给 GitHub 默认分支却没有 tag/commit 的仓库、要求关闭
杀毒或管理员运行的安装包、运行时仍要下载依赖的插件。

## 3. 安装前检查清单

至少核对：

1. `.cspkg` 来源与预期一致；
2. SHA-256 与作者发布的独立渠道一致；
3. plugin id、publisher、version、license 合理；
4. runtime kind、artifact、runtimeId、OS/arch 与你的预期一致；
5. `Runtime diff` 是否发生；
6. required/optional permission 是否最小；
7. 网络、文件、密钥、账户、交易、子进程各栏；
8. sandbox 状态，不要只看发布者名称；
9. 是否有稳定 tag/commit、SBOM、license inventory 和构建 receipt；
10. 是否可以随时关闭相应 feature flag 并回滚。

## 4. UI 的两次确认在防什么

本地安装不会在选文件时直接执行代码。流程是：

```text
选择 .cspkg
  -> 浏览器计算 SHA-256
  -> Host 再计算并严格 inspect
  -> 展示 runtime/permission/sandbox diff
  -> 填写至少 12 字符的审计原因
  -> 四项逐项确认
  -> 第一次确认生成短时、单次令牌
  -> 第二次确认安装并首次执行
```

四项确认分别证明你理解：当前用户代码执行、账户/密钥/实盘仍独立、精确 runtime 身份、沙箱状态。
第二次令牌有过期时间且只能使用一次；修改文件、原因或选择后需要重新确认。

## 5. Marketplace 与 trusted-local 的差别

| 项目 | Marketplace | trusted-local |
| --- | --- | --- |
| 来源 | 签名 index + publisher key | 本地文件/本地构建 |
| artifact | digest、SBOM、license、透明度记录 | Host inspect；供应链证据由用户审核 |
| 默认 Windows 执行 | `marketplace-sandboxed` AppContainer | 当前用户上下文 |
| 用户确认 | release/apply/activate | 原因 + 四项勾选 + 两次确认 |
| “官方”含义 | 独立展示维护方，不能由签名推断 | 不适用 |
| 账户/密钥/交易 | 不自动授予 | 不自动授予 |

发布者已验证只证明“哪个 key 签了这个 artifact”，不证明代码没有漏洞。

## 6. 安装后的观察

在“已安装插件”中检查：

- 状态为 `active`；
- 信任模式确实为 `trusted-local`；
- runtime kind/id 与确认时相同；
- 健康状态为可用；
- 没有意外权限 grant；
- 更新来源和 rollback target 正确；
- 停用/卸载后的数据保留说明符合预期。

若出现意外 CPU、内存、网络或子进程，先停用插件，再收集诊断；不要先删除安装目录破坏证据。

## 7. 停用、回滚与卸载

- **停用**：停止运行，保留 installation 和私有数据；
- **回滚**：切换到上一个 activation，通常需要重启/新 generation；
- **卸载**：移除 activation，默认仍保留已验证 installation 与私有数据；
- **全局关闭**：将对应新功能开关设为 `0`，旧 v2 Python/v1 仍可工作。

不要手工删除 registry、history、installations、bundle cache 或 audit 文件。需要紧急操作时按
`PLUGIN_PLATFORM_ROLLBACK_RUNBOOK_zh.md` 执行。

## 8. 出现警报时

1. 在 UI 停用插件；
2. 记录时间、plugin id/version、bundle SHA-256、runtime kind/id、generation；
3. 保留 audit、activation history、receipt、stderr redaction 后的日志；
4. 若进程未退出，记录 PID 后由 Host stop；
5. 关闭单一 runtime flag，而不是删除整个 CandleScope 数据目录；
6. 若怀疑恶意 release，保持 artifact/receipt 供分析并执行 revocation quarantine；
7. 不上传账户、token、策略输入、私有 bars 或未脱敏路径。

诊断允许收集什么、禁止收集什么，见 `PLUGIN_PLATFORM_DIAGNOSTICS_BOUNDARIES_zh.md`。
