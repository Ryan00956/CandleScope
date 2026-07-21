# Script Runtime Plugin Host

[English](README.md)

`app.plugin_runtime` 是 CandleScope 拥有的通用脚本 runtime sidecar 宿主。它只
依赖公开的 `candlescope-plugin-sdk` 协议模型，不导入 Pyne 或 Pine Compatibility
实现，也不参与现有 Indicator 路由选择。

Phase 2/3 的边界：

- 读取严格、版本化的 runtime activation registry；
- 使用绝对可执行路径和 argv 直接启动进程，永不经过 shell；
- 完成 `handshake` 和 `describe`，校验 runtime ID、包名、版本和能力协商；
- 串行化 JSON-RPC 请求，限制消息、stderr、启动/请求/关闭时间；
- 超时、崩溃、stdout 污染和协议错误会销毁当前会话；
- 后续请求可以在受限时间窗和次数内惰性重启，超限后熔断；
- FastAPI 生命周期拥有所有 sidecar，并向 `/health` 只暴露汇总状态。
- 严格验证确定性的 `.cspkg` 和调用者固定的外层 SHA-256；
- 每个 bundle 建立独立 venv，只离线安装 bundle 内 wheel；
- descriptor 和固定结果探针通过后，原子激活并保留逐插件回滚链。

现有 `/api/v1/indicators/*` 和 WebSocket 仍使用 legacy Pyne 路径。Phase 4 才会
增加 `legacy/shadow/sidecar` 路由，因此仅启用 Host 不会改变指标结果。

## Activation registry v1

默认 registry 是用户数据目录中的：

- Windows：`%LOCALAPPDATA%/CandleScope/plugins/runtime-registry.json`；
- Linux：`$XDG_DATA_HOME/candlescope/plugins/runtime-registry.json`，未设置时使用
  `~/.local/share/candlescope/plugins/runtime-registry.json`。

默认路径不存在代表“零插件”，是正常状态。显式设置
`CANDLESCOPE_RUNTIME_REGISTRY` 后，文件缺失或格式错误会 fail closed。

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "hello-runtime",
      "package": "candlescope-plugin-sdk",
      "version": "0.1.0",
      "enabled": true,
      "autoStart": true,
      "required": false,
      "launch": {
        "executable": "C:/absolute/plugin-venv/Scripts/python.exe",
        "args": [
          "-I",
          "-u",
          "-m",
          "candlescope_plugin_sdk.examples.hello_runtime"
        ],
        "workingDirectory": "C:/absolute/plugin-venv"
      },
      "timeouts": {
        "startupSeconds": 5,
        "requestSeconds": 30,
        "shutdownSeconds": 2
      },
      "limits": {
        "maxMessageBytes": 16777216,
        "maxStderrBytes": 65536
      },
      "restart": {
        "maxAttempts": 3,
        "windowSeconds": 60
      }
    }
  ]
}
```

Registry 是解析完成后的激活状态，不是下载清单。Phase 3 的 `.cspkg` 安装器已负责
验证调用者固定的哈希、建立独立 venv，再原子写入该文件；Host 不会下载或猜测
入口。手工 registry 仍可用于本地开发，但属于 unmanaged 条目，不能使用安装器的
精确 `check`/`rollback`。

安装器生成的条目还包含 `managed.installationId`、`managed.activationId` 和
`managed.bundleSha256`。这些字段把 registry 条目绑定到不可变安装目录及其精确
activation history；手写条目无需添加它们。

`required=true` 必须同时启用 `autoStart`。required runtime 启动失败会中止应用
启动；optional runtime 失败则保留诊断并把插件汇总标记为 `degraded`。

## 运行、安装与回滚

正常安装后端依赖时会同时安装仓库内的 SDK：

```powershell
cd backend
python -m pip install -r requirements.txt
```

构建、检查、安装和逐插件回滚：

```powershell
python scripts/candlescope_plugin.py inspect C:\release\runtime.cspkg
python scripts/candlescope_plugin.py install C:\release\runtime.cspkg `
  --sha256 sha256:<可信 release 摘要>
python scripts/candlescope_plugin.py check <runtime-id>
python scripts/candlescope_plugin.py rollback <runtime-id>
```

完整 manifest、发布和原子事务说明见
[`INSTALLER_zh.md`](INSTALLER_zh.md)。成功 install/rollback 后需要重启应用；Phase 3
不热加载 registry。

指定开发 registry：

```powershell
$env:CANDLESCOPE_RUNTIME_REGISTRY = "C:\absolute\runtime-registry.json"
python -m uvicorn app.main:app --host 127.0.0.1 --port 18080
```

紧急关闭整个插件 Host，不读取 registry，也不启动任何 sidecar：

```powershell
$env:CANDLESCOPE_PLUGIN_HOST_ENABLED = "0"
```

`GET /health` 只返回 `status/configured/enabled/ready/failed`，不会公开可执行命令、
registry 路径或 stderr。完整诊断由内部 `RuntimeHostService.diagnostics()` 提供，
`include_stderr` 默认关闭。

## 安全边界

- 插件进程只继承 OS、临时目录、locale、证书和 PATH 等小型 allowlist；宿主进程
  中的任意 API key 或自定义环境变量不会自动传入。
- stdout 只能包含逐行 JSON-RPC；日志进入有界 stderr tail。
- POSIX 使用独立 process group，终止时覆盖子进程；Windows 当前保证主 sidecar
  被终止，但这不是针对恶意后代进程的完整沙箱。
- v1 不提供 secrets、网络权限声明、交易动作或宿主文件访问 capability。
- Sidecar 和独立 venv 是依赖/故障边界，不是恶意代码安全沙箱。只应激活可信包。
- Phase 3 验证调用者固定的 SHA-256 和 wheel 内容，但 SHA-256 不证明发布者身份；
  v1 尚无签名、透明日志或 OS 权限沙箱。

## 定向门禁

```powershell
cd backend
$env:PYTHONPATH = (Resolve-Path '..\packages\candlescope-plugin-sdk\src').Path
python -m pytest -q `
  tests/test_plugin_runtime_*.py `
  tests/test_plugin_bundle.py `
  tests/test_plugin_installer.py
```

测试包含真实 SDK Hello Runtime 会话，以及 bundle 路径/元数据负例、独立 venv、
幂等安装、探针失败、升级、逐插件回滚；Host 侧继续覆盖崩溃、超时、重复 key、
错 ID、非法 JSON、消息上限、stderr 上限、环境隔离、重启熔断和生命周期回收。
