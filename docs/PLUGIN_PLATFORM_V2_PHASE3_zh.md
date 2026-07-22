# CandleScope 通用插件平台 v2 — Phase 3 执行记录

> 状态：**实现与技术验收已完成，随本阶段独立提交交付**，2026-07-22。
>
> 父基线：`codex/plugin-platform-v1@d755f27`（Phase 2）。
>
> 边界：本阶段只交付 Bundle/Installer/activation v2。没有把 v2 registry 接入产品默认
> 启动，没有授予 Host API、加载 web assets、开放网络/文件/secrets/交易，也没有把插件视为
> 不受信任代码安全运行。上述能力继续由 Phase 4 及后续阶段负责。

## 1. 验收结论

Phase 3 已建立一条显式、可回滚的 v2 供应链：开发者从受控目录确定性构建 `.cspkg`，调用者
用外层 SHA-256 固定制品，安装器在 content-addressed store 中创建独立 venv，并在第一次
activation registry mutation 前验证全部内容和所有 backend entrypoint。v1 `.cspkg` 与
`runtime-registry.json` 不迁移、不猜测、不覆盖。

这使通用插件具备“可打包、可检查、可安装、可 staged、可启停、可精确回滚”的管理基础，
但还没有 Phase 4 的 Grant Store 和 OS 沙箱，所以不能把它宣传成可安全运行任意社区代码的
Marketplace 平台。

## 2. 包格式

### 2.1 目录布局

构建输入和归档 payload 使用同一布局：

```text
plugin-source/
├── manifest.json
├── wheels/
│   └── *.whl
├── web/                       # 可选；本阶段只存储和校验，不加载
├── schemas/                   # 可选 canonical JSON schema
├── probes/
│   └── <manifest-probe-id>.json
└── sbom/
    └── cyclonedx.json
```

构建器自动生成 `bundle.json`。`manifest.json` 仍严格使用 Phase 1 冻结的公共
`PluginManifest`，打包字段不会混入公共 manifest。

### 2.2 `bundle.json`

```json
{
  "schemaVersion": 2,
  "format": "candlescope.plugin-bundle/2",
  "compatibility": {
    "python": ">=3.11,<3.14",
    "operatingSystems": ["linux", "macos", "windows"],
    "architectures": ["arm64", "x86_64"]
  },
  "contents": [
    {
      "path": "manifest.json",
      "kind": "manifest",
      "sha256": "sha256:<64 lowercase hex>",
      "size": 1
    }
  ],
  "probeAssets": [
    {"id": "hello-transcript", "path": "probes/hello-transcript.json"}
  ]
}
```

`contents` 精确覆盖除 `bundle.json` 自身之外的每个归档成员；把 `bundle.json` 放进自己的
digest table 会产生自引用，因此它由外层 `.cspkg` SHA-256 固定。归档内不允许存在未声明
文件。所有 JSON payload 使用公共 SDK canonical JSON 加一个结尾换行。

### 2.3 验证顺序

安装前按以下顺序 fail closed：

1. 调用者提供的外层 SHA-256；
2. ZIP 数量、路径、大小、压缩比、类型、symlink、加密、重复和大小写冲突；
3. canonical `bundle.json` 及其 exact content table；
4. 每项 size 和 SHA-256；
5. 公共 `PluginManifest`、重复 ID、Host engine、Python、OS 和架构；
6. probe asset 与 manifest 中 semantic transcript digest 的绑定；安装后把归档 requests
   逐条送入 venv sidecar，并要求真实 responses 的 canonical digest 精确相等；
7. CycloneDX 基本结构及每个 bundled wheel 的 name/version 覆盖；
8. wheel 路径、dist-info、Name、Version、Tag、安装体积和重复 distribution；
9. frontend entry 文件与 manifest 声明的一致性。

v2 parser 要求 `bundle.json` 和 `format=candlescope.plugin-bundle/2`；v1 parser 继续只接受
原 schema v1，二者都不根据相似字段猜测升级。

## 3. 安装与 activation

默认根目录中五类状态保持分离：

```text
plugin-platform-v2/
├── installations/<plugin-id>/<outer-sha256>/
│   ├── bundle.cspkg
│   ├── content/
│   ├── venv/
│   └── receipt.json
├── staging/
├── history/<plugin-id>/{activations,rollbacks}/
├── quarantine/
└── platform-registry-v2.json
```

- installation ID 就是去掉 `sha256:` 前缀的外层 digest；已存在的目录只校验和复用，永不
  就地更新；
- 每个 bundle 使用独立 venv，所有 wheel 只经 `pip --no-index --no-deps --only-binary`
  离线安装；
- receipt 固定 bundle、manifest、wheel metadata 和 fresh-process probe 结果；
- activation registry 只保存当前选择、entrypoint 启动描述和状态，不保存 grant、secret、
  plugin data 或运行时健康；
- `runtime-registry.json` 文件名被 v2 installer 明确拒绝。

一次 install 的提交顺序为：

```text
pin + verify whole bundle
  -> extract to unique staging
  -> create isolated venv + offline install
  -> fresh parent Host probes every entrypoint
  -> write receipt
  -> rename staging to content-addressed final directory
  -> re-verify content + distributions + fresh-process probe
  -> write immutable activation history
  -> atomic replace platform-registry-v2.json
```

任一 entrypoint 失败时不会产生 activation；已成功探测的前一项也不会单独发布。

## 4. 新进程语义探针

`probe_runner.py` 不是 import smoke。安装器启动一个全新的父 Python 进程，先用 Phase 2
共享的 bounded JSONL/process primitives 启动 venv 中的插件，逐条重放每个
`controlTranscript` 并核对真实 response transcript digest；随后再通过真实
`EntrypointSupervisor` 启动另一进程：

```text
handshake -> describe
          -> activate -> healthCheck -> deactivate -> shutdown
```

没有 required permission 的插件执行完整链路。声明 required permission 的插件只完成
handshake/describe/shutdown，并进入 `staged`；Phase 3 不伪造 capability grant。rollback 在
atomic registry switch 前对目标 installation 再运行同一新进程探针。

## 5. Registry、幂等和掉电语义

`platform-registry-v2.json` 使用 `schemaVersion=2` 和单调 `revision`。每次 mutation 先写不可变
history，再用同目录 temporary file、flush/fsync 和 `os.replace` 原子替换 registry：

- replace 前掉电：旧 registry 完整保留，最多留下不可达 history；
- replace 后掉电：新 registry 只引用已经完成安装和 history 的对象；
- rollback 要求当前 activation 与其 history 的 `after` 字节语义完全一致，然后恢复精确
  `before`；
- quick repeat 会重验 immutable store 和新进程协议，但不创建 venv、不重新安装 wheel、
  不写 registry；
- `restartRequired=true` 是显式事实：Phase 3 尚无产品热加载/重启确认通道；
- `uninstall` 删除 activation，但保留 content-addressed installation 供审计；本阶段不做
  destructive GC。

## 6. CLI

v1 命令保持原样；v2 必须使用显式命名空间：

```powershell
Set-Location H:\program\CandleScope-plugin-platform\backend

python scripts\candlescope_plugin.py v2 --json build `
  C:\path\to\plugin-source C:\path\to\plugin.cspkg

python scripts\candlescope_plugin.py v2 --json inspect C:\path\to\plugin.cspkg

python scripts\candlescope_plugin.py v2 --root C:\path\to\managed --json install `
  C:\path\to\plugin.cspkg --sha256 sha256:<digest> --enable

python scripts\candlescope_plugin.py v2 --root C:\path\to\managed --json check `
  candlescope.hello-command
python scripts\candlescope_plugin.py v2 --root C:\path\to\managed --json list
python scripts\candlescope_plugin.py v2 --root C:\path\to\managed --json disable `
  candlescope.hello-command
python scripts\candlescope_plugin.py v2 --root C:\path\to\managed --json enable `
  candlescope.hello-command
python scripts\candlescope_plugin.py v2 --root C:\path\to\managed --json rollback `
  candlescope.hello-command
python scripts\candlescope_plugin.py v2 --root C:\path\to\managed --json uninstall `
  candlescope.hello-command
```

`install` 默认 disabled；只有显式 `--enable` 且没有 required permission 才记录 active。

## 7. 退出门证据

| 退出门 | 自动化证据 |
| --- | --- |
| deterministic build / pinned outer SHA | 同源两次 bundle 逐字节一致；inspect 输出可固定 digest |
| traversal / symlink / duplicate / bomb / extra | adversarial ZIP tests 在解析 payload 前拒绝 |
| inner hash / canonical JSON / duplicate IDs | content table、公共 SDK model 和 canonical codec 负例 |
| Python/OS/arch/Host compatibility | verify 阶段 fail closed |
| probe/SBOM/wheels 全覆盖 | semantic digest、CycloneDX component 和 dist-info 交叉校验 |
| multi-entrypoint 无半激活 | main 成功、第二 entrypoint import 失败后 registry 不存在 |
| quick repeat | venv marker、activation ID、registry bytes 均不变 |
| atomic activation/rollback | registry replace 注入 OSError 后旧 bytes 和旧版本不变，可安全重试 |
| mixed v1/v2 | 同 root 的 v1 registry sentinel 字节保持不变 |
| fresh-process install/rollback | receipt、check、rollback audit 都包含真实 Host probe |

### 7.1 自动化结果

| 门禁 | 结果 |
| --- | --- |
| Phase 3 bundle/installer/architecture | 19 passed |
| 完整 plugin family | 144 passed；4 条既有 FastAPI `on_event` 弃用警告 |
| SDK | 58 passed |
| backend | 2000 passed；4 条既有 FastAPI `on_event` 弃用警告 |
| frontend | architecture/typecheck/lint、2334 tests、Vite production build 全通过 |
| static | Phase 3 范围 Ruff、format check、compileall、`git diff --check` 全通过 |
| 外部 CLI smoke | `v2 install -> check -> list` 通过；state=active，probe=activated，未创建 v1 registry |

backend 首次全量在与 SDK/compileall 并行时出现一项本阶段外的 replay shutdown 200ms 时序
波动：1997 passed、1 failed。该用例隔离复跑先连续 8 次通过后失败 1 次，随后直接调用连续
20 次通过；未修改 replay 代码。取消并行争用后的完整 backend 复跑为 1998/1998 通过。
该观察保留在验收记录中，不把偶发失败误报成 Phase 3 修复。加入最终 semantic transcript
和 static web 门禁后的最终完整 backend 复跑为 2000/2000 通过。

## 8. 安全边界与 Phase 4 前置门

Phase 3 解决供应链完整性、可复验安装和原子状态，不是恶意代码沙箱。venv 只隔离 Python
依赖，不能阻止插件读取用户文件、直接联网、创建子进程或消耗资源。因此：

- 只允许 first-party-pinned 或 local-trusted 测试插件；
- v2 registry 尚未被 `app.main`、FastAPI 或产品启动读取；
- web assets 被存储和校验，但不加载到浏览器；
- required permission 不可 enable；
- 不提供 marketplace、签名 publisher trust、自动下载、自动更新或 fallback；
- Phase 4 必须证明 Grant Store、审计、进程树回收、direct network deny、文件隔离和资源限制，
  才能扩大信任范围。

## 9. 回滚

本阶段是 additive，可单独 revert：

1. 删除 `app.plugin_installer_v2`、对应 tests/testkit 和本文；
2. 将 `backend/scripts/candlescope_plugin.py` 恢复为直接调用 v1 CLI；
3. 忽略或移走 `platform-registry-v2.json`；它从未被产品默认启动消费；
4. 保留或离线删除未被使用的 v2 installation store。

回滚不修改 v1 `runtime-registry.json`、官方 Pyne/Pine installation、HTTP/range/WS 路由、
数据库或前端状态。
