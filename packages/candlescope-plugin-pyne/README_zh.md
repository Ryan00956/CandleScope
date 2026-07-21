# CandleScope Pyne Runtime 插件

`candlescope-plugin-pyne` 是 CandleScope 与独立发布的 `pyne-runtime` 引擎之间的
公开协议桥。它不导入 CandleScope backend 私有包，也不复制 Pyne 源码；CandleScope
通过 `candlescope.script-runtime/1` 在独立 managed venv 中启动它。

## 兼容性锁

- 插件：`candlescope-plugin-pyne==0.1.0`
- SDK：`candlescope-plugin-sdk==0.1.0`
- 引擎：`pyne-runtime==0.2.0rc1`
- Python：`>=3.11,<3.14`
- Runtime ID：`candlescope.pyne`

`release/release-lock.json` 固定官方 Pyne wheel 的 Release URL 与 SHA-256。版本、wheel
内容、descriptor 或确定性 probe 任一不匹配都会 fail closed，不再靠手工同步适配层。

插件 sidecar 本身已经是 CandleScope 管理的进程边界，因此桥内固定使用 Pyne
`executor_mode="inline"`。宿主请求超时后可终止并重启整个 sidecar，不需要再嵌套一层
Pyne worker，Windows 下也不会引入额外 spawn 状态。

## Render IR 覆盖范围

协议 v1 只承诺 line series。Pyne 的 marker、hline、fill、背景、K 线着色、signal 和
真正有状态的 realtime session 尚未声明兼容。执行中如果出现这些输出，插件只在
`output.meta.unsupportedOutputKinds` 中报告类型名，不会把私有结构塞进公共协议冒充
兼容。

所以“插件可以安装”不等于“可以切换默认路由”。Phase 5 只完成独立发行与安装门禁；
shadow、cutover 与源码快照删除仍是后续独立阶段。

## 本地开发

```powershell
cd packages\candlescope-plugin-pyne
python -m pytest -q
python -m ruff check src tests scripts
python -m ruff format --check src tests scripts
python -m build
```

构建 `.cspkg` 时需要四个 wheel：本插件、SDK、官方 Pyne Runtime，以及和目标
Python/操作系统匹配的 NumPy。`scripts/build_bundle.py` 会读取 wheel metadata、核对
精确版本、校验官方 Pyne wheel SHA，再调用通用 `.cspkg` builder。生成的 bundle 是
平台/ABI 相关产物，外层 SHA-256 必须和 bundle 一起发布。

从本目录执行一条完整的 Windows CPython 目标构建链：

```powershell
$wheelhouse = 'C:\release\candlescope-pyne\wheelhouse'
New-Item -ItemType Directory -Force $wheelhouse | Out-Null

python -m build --wheel --outdir $wheelhouse .
python -m build --wheel --outdir $wheelhouse ..\candlescope-plugin-sdk
Invoke-WebRequest `
  -Uri 'https://github.com/Ryan00956/pyne-runtime/releases/download/v0.2.0rc1/pyne_runtime-0.2.0rc1-py3-none-any.whl' `
  -OutFile "$wheelhouse\pyne_runtime-0.2.0rc1-py3-none-any.whl"
python -m pip download --only-binary=:all: --no-deps `
  --dest $wheelhouse numpy==2.3.3

$bridge = (Get-ChildItem "$wheelhouse\candlescope_plugin_pyne-0.1.0-*.whl").FullName
$sdk = (Get-ChildItem "$wheelhouse\candlescope_plugin_sdk-0.1.0-*.whl").FullName
$pyne = (Get-ChildItem "$wheelhouse\pyne_runtime-0.2.0rc1-*.whl").FullName
$numpy = (Get-ChildItem "$wheelhouse\numpy-2.3.3-*.whl").FullName

python scripts\build_bundle.py `
  --wheel $bridge --wheel $sdk --wheel $pyne --wheel $numpy `
  --output C:\release\candlescope-pyne\candlescope-pyne-0.1.0.cspkg `
  --json
```

builder 输出的 `.cspkg` SHA-256 应进入同一次可信 Release。安装方仍应使用通用
`candlescope-plugin install <bundle> --sha256 <published digest>`，不能临时对未知 bundle
自行计算摘要后当作信任来源。插件升级时同时升级 package version、release lock 与
probe hash，禁止覆盖同版本 artifact。
