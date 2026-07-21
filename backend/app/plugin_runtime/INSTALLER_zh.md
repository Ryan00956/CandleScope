# `.cspkg` Runtime 插件安装器

[English](INSTALLER.md)

Phase 3 提供可发布的 `.cspkg` 格式和本地管理 CLI。它解决插件依赖、入口、探针和
激活状态反复手工对齐的问题：插件作者发布一个确定的 bundle，CandleScope 为每个
bundle 创建独立 venv，协议探针通过后才原子激活。

当前 Indicator/Pyne 路由仍是 legacy。安装成功代表插件已可由通用 Host 启动，
不代表生产指标流已经切到 sidecar；该切换属于 Phase 4。

## 最短发布流程

1. 插件只依赖 `candlescope-plugin-sdk` 的公开接口，实现并启动
   `BaseRuntimePlugin`；
2. 为插件和全部运行时依赖构建 wheel；不能放 sdist、源码目录或需要在线解析的依赖；
3. 写一份 manifest template，其中 wheel 的 `sha256` 和 `size` 可以省略；
4. 用确定性 builder 生成 `.cspkg`；
5. 用 `inspect` 取得外层 SHA-256，并和 `.cspkg` 一起通过可信发布渠道提供；
6. 用户显式传入该 SHA-256 安装；重启 CandleScope 后 Host 读取新 registry。

仓库内的 Hello template 位于
`packages/candlescope-plugin-sdk/examples/hello-runtime.manifest.json`。

```powershell
cd backend

python scripts/candlescope_plugin.py build `
  --manifest ..\packages\candlescope-plugin-sdk\examples\hello-runtime.manifest.json `
  --wheel C:\release\candlescope_plugin_sdk-0.1.0-py3-none-any.whl `
  --output C:\release\hello-runtime-0.1.0.cspkg

python scripts/candlescope_plugin.py inspect `
  C:\release\hello-runtime-0.1.0.cspkg

python scripts/candlescope_plugin.py install `
  C:\release\hello-runtime-0.1.0.cspkg `
  --sha256 sha256:<inspect 输出的 64 位摘要>

python scripts/candlescope_plugin.py check hello-runtime
python scripts/candlescope_plugin.py list
python scripts/candlescope_plugin.py rollback hello-runtime
```

所有命令都支持全局 `--json`。测试或便携安装可用 `--root <dir>`；单独指定 registry
可用 `--registry <file>`，其父目录就是 managed root。同时传入两者时必须位于同一
目录，保证所有 registry writer 使用同一把锁。`install --auto-start` 会让下次应用
启动时预启动 runtime；`--required` 必须和 `--auto-start` 一起使用。默认安装为
enabled、按需启动。

安装命令只接受本地文件，不负责下载。外部 release lock、下载缓存或 marketplace
必须先把已固定摘要的 artifact 落到本地，再调用同一安装入口。

## Manifest schema v1

```json
{
  "schemaVersion": 1,
  "plugin": {
    "id": "acme-runtime",
    "name": "Acme Runtime",
    "version": "1.2.3",
    "package": "candlescope-plugin-acme",
    "protocol": "candlescope.script-runtime/1"
  },
  "python": {
    "requires": ">=3.11,<3.14",
    "module": "candlescope_plugin_acme.sidecar"
  },
  "wheels": [
    {
      "path": "wheels/candlescope_plugin_acme-1.2.3-py3-none-any.whl",
      "package": "candlescope-plugin-acme",
      "version": "1.2.3"
    },
    {
      "path": "wheels/candlescope_plugin_sdk-0.1.0-py3-none-any.whl",
      "package": "candlescope-plugin-sdk",
      "version": "0.1.0"
    }
  ],
  "probe": {
    "source": "plot(close)",
    "context": {
      "exchange": "binance",
      "marketType": "spot",
      "symbol": "BTCUSDT",
      "interval": "1m"
    },
    "bars": [
      {
        "time": 1700000000,
        "open": 100,
        "high": 102,
        "low": 99,
        "close": 101,
        "volume": 10,
        "isClosed": true
      }
    ],
    "params": {},
    "options": {},
    "analysisSha256": "sha256:<AnalyzeResult.to_wire() 的 canonical hash>",
    "executionSha256": "sha256:<ExecuteBatchResult.to_wire() 的 canonical hash>"
  }
}
```

Builder 按 manifest 的 wheel basename 匹配 `--wheel` 参数，审计 wheel 内的
`METADATA`、`WHEEL`、`RECORD`，并填入每个 wheel 的真实 `size` 和 `sha256`。
最终 archive 只能包含 `manifest.json` 和 manifest 明确列出的 wheel；未知字段、重复
JSON key、大小写冲突路径、绝对路径、`..`、symlink、加密 entry 和额外文件都会被
拒绝。

`.cspkg` 外层不允许 directory entry。嵌套的标准 wheel 可以包含路径规范且压缩/解压
大小都为零的 directory entry（NumPy 等官方 wheel 会这样打包）；它们仍受路径、重复、
大小写冲突、symlink、加密与总解压大小检查，不能借此放宽 bundle 边界。

`plugin.package/version` 必须精确匹配一个主 wheel。`python.module` 必须能用下面的
形式启动 JSON Lines sidecar：

```powershell
<plugin-venv-python> -I -u -m candlescope_plugin_acme.sidecar
```

所有 wheel 必须一起离线可安装。安装器固定使用：

```text
pip --isolated install --no-index --no-deps --only-binary=:all: <bundled wheels...>
pip --isolated check
```

因此不会联网、不会从 sdist 构建，也不会把插件装进 CandleScope backend 的 Python。

## Probe hash

Probe 必须小、确定且不依赖网络、当前时间、随机数或本机状态。Host 会先校验
handshake/descriptor 的 runtime ID、package、version，再分别执行 `analyze` 与
`executeBatch`。结果通过以下规则 canonicalize：UTF-8、key 排序、紧凑分隔符、禁止
NaN/Infinity，然后计算 SHA-256。

```python
import hashlib
import json


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


print(canonical_sha256(runtime.analyze(analyze_request).to_wire()))
print(canonical_sha256(runtime.execute_batch(execute_request).to_wire()))
```

代码或依赖升级导致输出变化时，应发布新版本和新 bundle，不能只覆盖旧 release 的
hash。

## 安装、激活和回滚语义

默认根目录和 Phase 2 registry 位于同一个用户数据目录：

- Windows：`%LOCALAPPDATA%/CandleScope/plugins`；
- Linux：`$XDG_DATA_HOME/candlescope/plugins`，未设置时为
  `~/.local/share/candlescope/plugins`。

布局：

```text
plugins/
  .installer.lock
  runtime-registry.json
  staging/
  installs/<runtime-id>/<64-hex-bundle-id>/
    receipt.json
    venv/
  history/<runtime-id>/
    activations/<activation-id>.json
    events/<rollback-event-id>.json
  quarantine/
```

安装目录以完整 bundle SHA-256 为 ID，创建后不会原地升级或覆盖。安装过程在全局文件
锁内执行：验证外层 hash和 archive，创建 staging venv，离线安装，校验全部
distribution 版本，运行 `pip check` 和协议结果探针，然后把 staging 原子重命名为
不可变安装目录。最后先记录 activation history，再通过同目录临时文件、flush、fsync
和 `os.replace` 原子替换 registry。registry 替换是唯一激活提交点。

相同 bundle 和相同策略重复安装会复用、复查现有 venv，不产生新 activation。
升级会创建新的安装目录和 activation，但旧目录保留。`rollback <runtime-id>` 只读取
当前 activation 的精确 `before`，验证目标环境后只还原该 runtime；其他社区插件或
手工 registry 条目保持原样。回滚从不删除安装目录，所以可以继续向前回退。

如果坏 hash、wheel 审计、pip、descriptor 或结果 probe 失败，registry 不变。
应用进程不会热加载写入后的 registry，成功的 install/rollback 会报告
`restartRequired=true`。

## 信任和安全边界

- 外层 SHA-256 证明本地 bytes 与调用者固定的 bytes 相同，不证明发布者身份；摘要
  必须从可信 release/lock 获取，不能和未知 bundle 从同一个不可信位置临时计算；
- 独立 venv 和 sidecar 是依赖、协议和故障边界，不是恶意代码沙箱；
- 安装会执行 wheel 安装逻辑并启动 runtime probe，只安装可信插件；
- v1 没有签名、透明日志、权限声明、网络隔离、secrets 或任意前端代码；
- CLI 不自动删除旧安装或 quarantine。磁盘回收应在未来的显式 GC 命令中实现，不能
  破坏 rollback chain。
