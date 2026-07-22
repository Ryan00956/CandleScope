# CandleScope 通用插件平台 v2 — Phase 1 执行记录

> 状态：**实现与技术验收已完成，随本阶段独立提交交付**，2026-07-22。
>
> 父基线：`codex/plugin-platform-v1@381dd02`（Phase 0）。
>
> 边界：本阶段只交付公开 SDK 契约、参考 sidecar、schema、fixture、测试与文档。
> CandleScope 生产 Host、Bundle/Installer v2、Grant Store、OS 沙箱、前端扩展、市场数据、
> 文件、网络、secrets 和交易能力均未接入；Phase 2 尚未开始。

## 1. 验收结论

Phase 1 的退出门全部满足。社区作者现在可以针对一套冻结、语言无关、fail-closed 的
`candlescope.plugin/2` 契约编译和测试插件，但不能把这一结果解释为 CandleScope 产品已经
能够安装或运行任意 v2 插件。生产接入从 Phase 2 开始，并继续受后续权限与沙箱阶段约束。

| 退出门 | 结果 | 证据 |
| --- | --- | --- |
| additive v2，v1 不变 | 通过 | 新代码只位于 `platform_v2`；架构测试禁止导入 v1 实现和 CandleScope 私有模块；v1 fixture 与 transcript 哈希保持冻结值 |
| manifest schema 与模型一致 | 通过 | Draft 2020-12 schema 和 Python model 对同一正例接受、对三个负例拒绝；另测重复 ID、权限重叠、SemVer 和资产路径 |
| 严格 wire JSON | 通过 | 拒绝重复 key、NaN/Infinity、非 UTF-8、53-bit 不安全整数、超限消息/字符串/容器/深度和未知结构字段 |
| 通用生命周期 | 通过 | handshake、describe、activate、invoke、eventBatch、healthCheck、cancel、prepareUpgrade、deactivate、shutdown 均有严格 envelope/state 处理 |
| 双向 `host.call` | 通过 | capability handle 校验、请求关联、原调用恢复、取消、过期/晚到响应、未知或撤销 handle 全部 fail closed；过期响应不会误消费仍有效的 pending 调用 |
| 可分发 SDK | 通过 | wheel/sdist 构建成功；全新 Python 3.12/3.13 venv 离线 `--no-deps` 安装、schema 加载、两个 console entrypoint 与两套 transcript 重放均通过 |
| 仓库回归 | 通过 | SDK 55、backend 1934、frontend 2334 项测试通过；backend compileall、frontend typecheck/lint/build 通过 |

## 2. 本阶段交付物

- `candlescope_plugin_sdk.platform_v2`：常量、错误、严格 JSON、manifest/descriptor 模型、
  JSON-RPC envelope、参考 dispatcher、同步 JSONL server 与 schema loader；
- `manifest-v2.schema.json`：关闭未知字段的 Draft 2020-12 schema；
- `candlescope-hello-command`：最小通用 Command sidecar；
- `hello_command_transcript_v2.json`：基础生命周期、取消与双向 Host 调用的语言无关 fixture；
- 正例 manifest 和 unknown field、unsupported activation、missing permission 三个负例；
- `protocol-v2.md`：公开协议、状态机、错误、上限、取消和安全边界；
- wheel/sdist package smoke：从已构建 wheel 导入，加载 packaged schema，执行 v1/v2
  entrypoint，并重放冻结 transcript；
- 中英文 SDK README 与总体执行方案的 Phase 1 状态更新。

现有顶层 v1 import、`candlescope.script-runtime/1`、v1 console entrypoint 和 wire fixture
均未改名或重编码。

## 3. 冻结的公开契约

### 3.1 协议标识与硬上限

| 项目 | 冻结值 |
| --- | --- |
| Plugin protocol | `candlescope.plugin/2` |
| Host API family | `candlescope.host-api/1` |
| 控制传输 | `jsonl/1` |
| manifest `schemaVersion` | `2` |
| 单条控制消息 | 1 MiB |
| JSON 最大深度 | 32 |
| 单容器最大成员数 | 10,000 |
| 单字符串最大 UTF-8 大小 | 256 KiB |
| 默认最大 in-flight | 32 |
| 跨语言安全整数 | `±9,007,199,254,740,991` |

所有请求和响应都携带显式 `generation`。激活 generation 必须单调增加；旧 generation 的
请求、结果和 Host 响应不会被自动套用到新实例。

### 3.2 manifest 与扩展边界

manifest 顶层固定为：

- `schemaVersion`、`plugin`、`engines`；
- `backend`、`frontend`、`activationEvents`；
- 统一的 `contributions[]`；
- `permissions.required[]` 与 `permissions.optional[]`；
- `probes[]`。

结构字段默认全部 closed-world，未知字段直接拒绝。只有以下两个位置允许受大小限制的
JSON 扩展对象：

- `contributions[].configuration`：由对应 contribution kind 的未来版本解释；
- `permissions.*[].scope`：由对应 permission broker 解释。

运行时 `describe` 只能缩小静态 manifest，不能新增 contribution、entrypoint 或权限。
required/optional 权限不能重叠；所有 entrypoint、contribution 和 surface 引用必须可解析且
ID 唯一；资产路径必须是包内安全相对路径。

### 3.3 生命周期与双向调用

参考 dispatcher 冻结以下行为：

1. `handshake` 协商 protocol、transport 和 Host API；
2. `describe` 返回不越权的 runtime descriptor；
3. `activate` 接收实例 ID、generation 和 opaque capability handles；
4. `invoke`/`eventBatch` 只在激活状态和当前 generation 执行；
5. 插件需要宿主能力时发起相关联的 `host.call`，原调用保持 pending；
6. Host 响应必须匹配当前 generation、pending call 和仍有效的 handle；
7. `cancel` 同时终止原调用及其 Host call，晚到结果返回稳定错误；
8. `deactivate` 清理 pending，`shutdown` 终止控制循环。

参考 server 是 SDK 契约样例，不是生产沙箱。它只把 canonical JSONL 写到 stdout；意外异常
细节只写 stderr，对 wire 返回稳定的 `INTERNAL_ERROR`。

## 4. 冻结哈希

| 对象 | SHA-256 |
| --- | --- |
| manifest schema 文件 | `adf8d3bc735ff75339432e3e5aeefd5a1d1eea19eaac5387669d1b5201787763` |
| manifest schema canonical JSON | `sha256:16bc9cb9f51b66ad2e717cd74798cd5c2e0b6a7d6d0fc2f442ba60f68cb1b5a5` |
| packaged Hello manifest 文件 | `c4ff848d74d831ea13f8a5b6ed5bf3b34213ff9ee8bb1c6ae4e971e6df85b4eb` |
| packaged Hello manifest canonical JSON | `sha256:9f472a450c48025b2119ff880515898f7bd7748c06e1c99d2a6491754bc0d688` |
| v2 transcript fixture 文件 | `33fab9afb8ebed7ff81b70c20598a53733473fc79a2800fbcef1aa29ce006423` |
| v2 lifecycle transcript | `sha256:d98ebd2fc9f5b0695925caf47ecf961eae47a56b5e8ec110f28acc9365afdd38` |
| v2 Host call request | `sha256:222b0607fabda26e6abe34cdfef51c9ca1ab3e46511f53a3da8da595588641f5` |
| v2 Host call response | `sha256:12aeb5bc661db1b3926ea80574c1ae4ec2a409d06bed146325279af5c6da10b5` |
| v1 transcript fixture 文件（保持不变） | `dd217159ab14af660481610cef5c369edbde3e7577bcf78e85bfad16cab5cf9c` |
| v1 transcript canonical JSON（保持不变） | `sha256:021825fb264a63555e0eb331f24f6ea0632b0d2a0c962ef89a35673526391ba2` |

这些哈希由测试直接断言；协议内容若发生变化，必须显式更新 fixture、兼容性说明和协议版本，
不能静默刷新 golden。

## 5. 构建与验证证据

### 5.1 SDK

- Ruff check：通过；
- Ruff format check：29 个文件格式正确；
- package compileall：通过；
- pytest：`57 passed in 0.80s`；
- fresh-wheel smoke：CPython 3.12.7 与 3.13.9 均通过离线 `--no-index --no-deps`
  安装、v1/v2 import、schema 加载、entrypoint 与 transcript 重放。

项目 metadata 声明 Python 3.11+，源码以 Python 3.11 为最低语法目标；当前主机没有可用的
CPython 3.11，因此本阶段没有声称做过 3.11 fresh-venv 实测。Phase 1 明定的 3.12/3.13
退出门已完整覆盖。

本轮非发布构建产物位于临时目录：

| 产物 | 大小 | 本轮 SHA-256 |
| --- | ---: | --- |
| `candlescope_plugin_sdk-0.2.0-py3-none-any.whl` | 44,932 bytes | `5b0c1976935e4081e07e41216800e84e750de30f51127cebe4ef6a0d8a5470a7` |
| `candlescope_plugin_sdk-0.2.0.tar.gz` | 59,614 bytes | `d34b308fae25ee34e65692fa8edc3e5af41fa5c480ee2ac77b2e493ef7945dae` |

这些文件仅用于本地门禁，没有发布，也没有覆盖任何已存在的 `0.2.0` artifact。为保持 v1
包身份，本阶段没有在预览分支上擅自改变 package version；任何外部分发前必须先确定正式
版本、重新构建、记录 Release artifact 和 SHA-256，绝不能用相同版本号替换已发布文件。

### 5.2 仓库级回归

- backend：compileall 通过，`1934 passed, 4 warnings in 189.39s`；四个 warning 为既有
  FastAPI `on_event` deprecation；
- frontend：architecture allowlist 为 0，typecheck、ESLint、`2334 pass, 0 fail`、
  456 modules 的 Vite production build 全部通过，构建耗时 5.94s；
- Phase 0/1 focused backend gate：41 项通过；
- SDK 架构门禁确认没有 CandleScope 私有依赖，也没有从 v2 偷渡导入 v1 实现模块。

## 6. 安全边界与未交付能力

本阶段模型中的 permission、scope 和 capability handle 是公开契约，不是权限实现。真正的
授权、撤销、审计与资源隔离必须由后续 Host/Broker/OS sandbox 完成。尤其不得：

- 因 manifest 声明就直接授予网络、文件、secrets、账户或交易能力；
- 把参考 Python dispatcher 当作不可信代码的安全边界；
- 让插件自行选择或复用 capability handle；
- 将 descriptor、前端 metadata 或插件 stdout 当作可信 HTML/命令/路径；
- 在 Phase 4 之前把 L4 live trading 暴露给第三方插件。

## 7. 回滚与 Phase 2 入口

Phase 1 是 additive SDK 变更，没有数据库 migration、registry mutation 或默认运行时路由。
回滚只需 revert 本阶段提交；顶层 v1 SDK 和现有生产 Host 继续工作。

Phase 2 可以在本提交之后开始，但必须继续满足：

- 生产 Host 复用已有 sidecar transport/supervisor 的可靠部分，不能复制第二套失联重启逻辑；
- 先实现通用控制面和 generation ownership，不提前开放数据、网络、文件、secrets 或 UI；
- Host 对 schema、manifest、descriptor、capability 和协议协商全部 fail closed；
- 新阶段使用独立、可单独 revert 的提交，并重新运行 SDK/backend/frontend 门禁。
