# CandleScope aho-corasick Adapter

状态：`REVIEWED_LOCAL_REFERENCE_RELEASE`

这是 Phase 9 的第二个真实 GitHub 项目接入样例。Adapter 不实现字符串搜索算法，只通过
`aho-corasick 1.1.4` 的公开 Rust API 将 CandleScope command input 映射为规范化 match output。

## 固定身份

| 字段 | 值 |
| --- | --- |
| upstream | `BurntSushi/aho-corasick` |
| tag | `1.1.4` |
| commit | `17f8b32e3b7c845ef3c5429b823804f552f14ec9` |
| runtime | `native-executable` / Windows x86_64 |
| executable SHA-256 | `dc2a213ff9bb2ef7db8a9c499a583655e2bb32bdd47d9234c5f63a779ab5924d` |
| bundle SHA-256 | `9fbb59299b2f3d900b4d8a2bd1c677f36b801eb27cfd39c2dca73efa44bcc249` |
| permissions | none |
| Marketplace approval | `false` |

## 输入

```json
{
  "patterns": ["he", "she", "hers", "波浪"],
  "haystack": "ushers 波浪",
  "matchKind": "standard",
  "asciiCaseInsensitive": false,
  "overlapping": true,
  "maxMatches": 1000
}
```

限制：1～1024 个非空 pattern、pattern 总计不超过 256 KiB、haystack 不超过 256 KiB、
`maxMatches` 为 1～10000。overlapping 只允许与 upstream `standard` match kind 组合。

输出使用 UTF-8 byte offset，避免 Unicode code-point/UTF-16 offset 产生歧义，并携带 upstream
version/commit provenance。超过 `maxMatches` 时明确返回 `truncated=true`。

## 从审核缓存离线构建

首次 reviewer 可在明确授权后运行一次：

```powershell
cargo fetch --locked
```

release 过程不访问网络：

```powershell
cargo test --locked --offline
..\..\..\backend\.venv\Scripts\python.exe scripts\build_release.py `
  --report evidence\build-report.json
```

脚本验证 Rust/Cargo 1.97.1、Cargo.lock、两份 crate cache、公共 SDK 和全部固定 source input，
随后在两个隔离 target dir 中离线构建；两个 PE 必须 byte-identical 且等于 supply-chain lock。

完成 transcript/SBOM/receipt/source lock 需要显式 reviewer 动作：

```powershell
..\..\..\backend\.venv\Scripts\python.exe scripts\finalize_release.py `
  --reviewer <reviewer-id> `
  --confirmed-at <YYYY-MM-DDTHH:mm:ssZ> `
  --approve-reviewed-source
```

不要在没有重新审核 upstream、crate、license、public API 和 build output 时复制旧 approval。

## 构建与安装 `.cspkg`

在仓库根运行：

```powershell
backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json source-lock-check examples\plugins\aho-corasick-adapter

backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json build examples\plugins\aho-corasick-adapter `
  dist\aho-corasick-adapter-0.1.0-windows-x86_64.cspkg `
  --os windows --arch x86_64
```

安装前必须独立比较输出 digest：

```powershell
$env:CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED = "1"
$env:CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED = "1"
$env:CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED = "1"

backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v2 --root <fresh-root> --json install `
  dist\aho-corasick-adapter-0.1.0-windows-x86_64.cspkg `
  --sha256 sha256:9fbb59299b2f3d900b4d8a2bd1c677f36b801eb27cfd39c2dca73efa44bcc249 `
  --enable

backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v2 --root <fresh-root> --json check candlescope.aho-corasick
```

`CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED` 不参与 bundle 运行；assessment 完成后可以保持 `0`。

完整背景、失败记录和机器门禁见
`docs/PLUGIN_PLATFORM_MULTI_RUNTIME_PHASE9_zh.md`。
