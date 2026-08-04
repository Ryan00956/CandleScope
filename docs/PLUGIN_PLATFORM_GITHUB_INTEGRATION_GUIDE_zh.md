# CandleScope GitHub 项目接入指南

## 1. 产品边界

CandleScope 不把 GitHub URL 当作可执行插件。GitHub helper 只做**只读 assessment**，不会 clone、
下载 Release asset、运行 workflow/install/build script 或二进制。assessment 的固定决定是：

```json
{
  "status": "assessment-only",
  "mayBuild": false,
  "mayInstall": false,
  "mayExecute": false,
  "nextStep": "human-review-and-complete-source-lock"
}
```

这是“容易接入各种项目”与“默认运行任意仓库代码”之间的关键边界。

## 2. 支持与不支持

当前 assessment 支持公开 GitHub repository，加显式 tag 或完整 40 位 commit。固定 API origin 为
`https://api.github.com`，redirect 禁用，单响应不超过 4 MiB。

当前不支持：私有仓库、默认分支浮动 pin、自动 clone、自动 source build、自动运行 GitHub Actions、
自动下载/执行 Release asset、把 GitHub token 当 publisher 身份。

## 3. 第一步：选择可接入的项目

优先项目应具备：

- 稳定 tag 与可验证 commit；
- 明确许可证和 NOTICE；
- 小而稳定的公共 API；
- 可以离线构建或已有可验证预编译 artifact；
- 不依赖 GUI、全局服务、管理员权限或运行时下载；
- 能用 command/indicator/provider 等贡献点表达；
- 能把数据输入限制在 Host call 和 point-in-time 范围。

## 4. 第二步：显式开启 assessment

```powershell
$env:CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED = "1"

# 可选；匿名 rate limit 不足时才设置。token 不写入 receipt。
$env:GITHUB_TOKEN = (gh auth token)
```

必须同时给 `--allow-network`，否则 fail-closed：

```powershell
backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json assess-github `
  https://github.com/BurntSushi/aho-corasick `
  --tag 1.1.4 `
  --output docs\plugin-adapters\aho-corasick-assessment.md `
  --allow-network
```

成功后同时保存 Markdown 和严格 JSON。检查 repository、tag object、commit、tree、父提交、签名、
Release metadata、语言、许可证和包元数据；不要只看 `assessmentSha256` 就批准执行。

## 5. 第三步：选择 Adapter 模板

支持七类 pending scaffold：

```text
java-library
native-cli
python-package
node-library
wasm-computation
service
sandbox-view
```

示例：

```powershell
backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json scaffold-adapter native-cli `
  --id candlescope.aho-corasick `
  --name "aho-corasick Search" `
  --publisher candlescope-contributors `
  --license GPL-3.0-only `
  --assessment docs\plugin-adapters\aho-corasick-assessment.json `
  --output examples\plugins\aho-corasick-adapter
```

输出目录必须不存在。脚手架原子生成且不可执行：runtime、source lock、receipt、SBOM、license、
transcript 均为 pending，`thirdPartyCodeExecutionApproved=false`，也不会生成活动 workflow。

## 6. 第四步：人工审核并实现 thin Adapter

审核者必须回答：

1. 上游哪些 public API 被调用？
2. 是否复制了上游算法？若是，不是 thin Adapter；
3. 输入/输出 schema、unknown field、大小上限是什么？
4. timeout、cancel、上游异常如何映射？
5. 是否访问网络、文件、环境、数据库、账户或密钥？
6. 是否有 system runtime/package manager fallback？
7. 依赖能否固定并离线构建？
8. license/NOTICE/redistribution 是否允许当前打包方式？
9. control transcript 是否覆盖生命周期与错误？
10. OS/arch/runtime matrix 哪些是真实跑过的？

Adapter 只能使用公共 SDK/协议，禁止导入 `backend/app` 或其他 Host private 模块。

## 7. 第五步：完成 source lock

completed source lock 至少绑定：

- assessment raw hash 与 canonical identity；
- repository、tag/commit；
- 每个 artifact URL、size、SHA-256；
- 本地 license bytes；
- manifest runtime target；
- 固定 toolchain 与离线构建状态；
- 两次可复现构建；
- 每个 package input 的 path/size/SHA-256；
- control transcript 及 manifest probe；
- CycloneDX SBOM、NOTICE；
- reviewer、UTC time、public API、capability、Host import 和 execution approval。

验证：

```powershell
backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json source-lock-check <adapter-root>
```

任意 pending 文件、输入漂移、license/transcript 篡改或 Host private import 都应在 build 前失败。

## 8. 第六步：构建、inspect、安装

```powershell
backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json build <adapter-root> dist\plugin.cspkg `
  --os windows --arch x86_64

backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json inspect dist\plugin.cspkg
```

必须在两个干净输出目录构建并比较完整 bytes。随后用新产品根目录执行：fresh install、同 bundle
quick repeat、fresh-process check、update、rollback、disable/enable、uninstall。GitHub helper 此时应恢复
为 `0`；已构建 bundle 不依赖它继续运行。

## 9. 第七步：进入分发路径

两种选择：

- 团队/个人本地：保留 source lock 和 build receipt，用户走 trusted-local 双确认；
- 公共生态：满足 `PLUGIN_PLATFORM_MARKETPLACE_RELEASE_CHECKLIST_zh.md`，进入签名 index、透明度、
  rollout、revocation 和 AppContainer 路径。

不要把“assessment 通过”“可以构建”“可以本地执行”“可以 Marketplace 发布”合并成一个布尔值。

## 10. ta4j 与 aho-corasick 参考

- Java/ta4j：`examples/plugins/ta4j-elliott-adapter`；
- Native/aho-corasick：`examples/plugins/aho-corasick-adapter`；
- 已冻结 assessment：`docs/plugin-adapters/`；
- ta4j 升级规则：`PLUGIN_PLATFORM_TA4J_PROVENANCE_UPGRADE_zh.md`。

这两个参考证明可以复用优秀上游算法库，但不会把仓库的构建系统和权限模型原样搬进 Host。
