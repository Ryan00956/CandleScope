# CandleScope 本地分析模式

本地分析模式用于把用户已有的 OHLC/OHLCV CSV 转换成可缩放、可标记、可绘图的 K 线工作台。这里的“本地”首先描述数据来源和分析项目归属，并不假设用户的电脑必须断网。产品边界是本地图表不能偷偷补线上 K 线、把直播价格混入 CSV，或因缺口触发网络 fallback。

当前实现仍使用独立的 `LOCAL_OFFLINE` 技术 profile 来保证这一数据边界：进程只加载本地数据 API，不创建交易所适配器、DataEngine、Backfill、Replay、行情 WebSocket、价格轮询、插件 host 或在线目录刷新。该隔离是实现手段，不是本地分析工作流本身的产品目的。

## 启动

先准备项目依赖。

Windows：

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

cd ..\frontend
npm install
```

Linux / macOS：

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt

cd ../frontend
npm install
```

然后从仓库根目录启动。Windows：

```powershell
.\start-local-offline.ps1
```

Linux / macOS：

```bash
./start-local-offline.sh
```

默认页面为 `http://127.0.0.1:15173/local.html`，本地资料库存放在 `backend/data/local-data`。也可以指定独立目录：

```powershell
.\start-local-offline.ps1 -DataDir "D:\CandleScopeData\local-data"
```

```bash
./start-local-offline.sh --data-dir "$HOME/CandleScopeData/local-data"
```

手动启动时，必须在启动后端前选定 profile。

Windows：

```powershell
$env:CANDLESCOPE_RUNTIME_MODE = "LOCAL_OFFLINE"
$env:CANDLESCOPE_LOCAL_DATA_DIR = "D:\CandleScopeData\local-data"
cd backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 18080
```

Linux / macOS：

```bash
export CANDLESCOPE_RUNTIME_MODE=LOCAL_OFFLINE
export CANDLESCOPE_LOCAL_DATA_DIR="$HOME/CandleScopeData/local-data"
cd backend
./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 18080
```

受支持的启动脚本和默认配置固定监听 loopback；不要用 Uvicorn CLI 参数把本地 profile 覆盖为 `0.0.0.0`。若要切回直播模式，需要停止进程后以 `LIVE` profile 重新启动，不能在页面中热切换。

## CSV 合同

一份 CSV 对应一个商品和一个源周期；导入后可以从这个源周期精确聚合出更大的固定周期。必需 OHLC 列和可选成交量列的默认名称：

```csv
time,open,high,low,close,volume
1704067200000,42000,42140,41880,42080,125.4
1704067260000,42080,42210,42020,42190,98.2
```

标准列名按大小写不敏感匹配，因此 TradingView 导出的 `Volume` 会自动映射为成交量；若忽略大小写后存在多个同名列，导入器会拒绝含糊映射。`volume` 缺失时，数据集会明确写入 `volume_available=false`，SQLite 和 K 线 API 使用 `null`，前端不绘制或显示成交量；任何一层都不会把缺失值改写成 `0`。导入页也可以选择“成交量必须存在”，此时缺列会拒绝发布。

导入页需要用户确认：

- 商品标识，例如 `BTC-USDT`；
- 周期，例如 `1m`、`5m`、`1h`、`1d`、`1w` 或 `1M`；
- 时间格式：Unix 秒、Unix 毫秒或 ISO 时间；
- 无时区 ISO 时间使用的 IANA 时区，例如 `UTC`、`Asia/Shanghai`。
- 成交量是可选还是必须存在；默认允许可审计的 OHLC-only 数据集。

导入器会拒绝重复或乱序时间、非有限数值、负成交量、同一文件内周期相位变化的时间戳，以及不满足 OHLC 关系的行。固定周期以第一根 K 线确定稳定相位，从而兼容 TradingView 中按交易时段对齐的 2 小时等 K 线；周线和月线仍按各自的日历边界严格校验。源数据中的缺口会写入 `excluded_ranges`，视为数据集的终止事实；本地分析不会尝试联网修复或静默填充。

## 多周期与自定义周期

图表周期栏会保留导入的源周期，并列出能从它精确生成的常用大周期；也可以输入 `90m` 这样的自定义周期。派生规则是 fail-closed 的：当前只支持 UTC 固定网格上的秒、分钟、小时和日线，目标周期必须大于源周期、必须是源周期的整数倍，单根目标 K 线最多聚合 10,000 根源 K 线。比如 `15m -> 30m / 1h / 90m` 分别使用 2、4、6 根基础 K 线；`15m -> 89m` 会明确返回 `interval_not_composable`，不会近似、截断或改用更小的隐含周期。

每根派生 K 线只在对应目标 bucket 的全部源 K 线都存在时产生。开盘价取第一根，最高/最低取完整 bucket 的极值，收盘价取最后一根，成交量及其他可加字段仅在源字段完整可用时求和；源缺口、数据集两端不足一整组、错位时间戳都会让该目标 bucket 被省略，不会插值。图表历史分页、事件标记投影和内置指标计算都使用同一个已选周期，指标缓存也把周期纳入身份。

后端也支持可选字段映射：`quote_volume`、`trades`、`taker_buy_base`、`taker_buy_quote`。当前页面只暴露标准 OHLC/OHLCV 列；自定义列映射可直接使用 `/api/v1/local/imports/csv` API。

## 存储与可复现性

每次成功导入发布为不可变修订：

```text
local-data/
  local-<dataset-id>/
    current.json
    library.json
    <sha256-data-epoch>/
      manifest.json
      bars.sqlite
      quality-report.json
      import-receipt.json
```

`data_epoch` 由规范化后的商品、周期、K 线和排除区间计算。导入先写入 staging，完成 SQLite `quick_check`、质量报告和 SHA-256 后再原子发布，因此失败导入不会成为可见数据集。

## 资料库、质量与修订

CSV 默认通过后台任务导入。上传阶段显示字节进度，后端解析阶段显示已处理行数；任务可以取消，取消或失败都不会发布半成品修订。任务状态可从 `/api/v1/local/imports/jobs/{job_id}` 查询。大文件上限仍由 `CANDLESCOPE_LOCAL_DATA_MAX_UPLOAD_BYTES` 控制，默认 512 MiB。

资料库名称与归档状态写在 `library.json`，不会改变不可变的 `data_epoch`。删除操作先把完整数据集移到 `.trash` 回收站，可从页面恢复；归档的数据集默认不出现在工作列表，但仍保留全部修订。

选择“作为当前数据集的新修订”时，导入器要求商品和周期与原数据集一致。质量中心显示当前修订的行数、源缺口、缺失成交量和接收状态；修订历史可以对比新增、删除、变更和相同行数，也可以把 `current.json` 原子切回任一已验证修订。切换只改变当前指针，不删除较新的修订。

## 项目包

`.csproject` 项目包包含数据集全部修订、质量报告、导入回执和资料库元数据，并携带当前修订的事件、指标选择、绘图与图表设置。导出必须绑定当前 `dataset_id + data_epoch`；若绘图存储不可读，导出会停止而不是生成缺图的包。

导入时会检查 ZIP 路径、文件清单、每个文件的 SHA-256、SQLite `quick_check` 与数据库哈希，再原子安装。若本机已有同一 `dataset_id`，导入器会分配新的本地身份，并在恢复事件、指标和绘图时重写对应的数据集作用域，避免覆盖现有项目。

## 通用事件标记

本地分析页面支持与数据集修订绑定的手工事件和事件 CSV。手工使用时，用户先把十字光标移动到目标 K 线，再选择类型、颜色、标题和备注。内置的“备注”“信号”“开仓”“平仓”“自定义”只是显示模板；持久化模型是通用事件，不要求用户提供订单格式。

事件 CSV 只要求一列时间，价格、类型、标题、备注和颜色均可选，未映射列会原样保存在事件的扩展字段中。导入页会先展示数据预览和自动建议的列映射，再由用户明确执行校验和导入。Unix 秒、Unix 毫秒和带 `Z`/偏移的 ISO 时间受支持；不带时区的日期文本会被拒绝，避免隐式使用电脑时区。

仓库中的 [`examples/local-analysis-events.csv`](../examples/local-analysis-events.csv) 可直接用于体验列映射、未知类型保留和范围外拒绝报告。

用户可以选择“归到所在 K 线”或“只接受 K 线开盘时间”。两种方式都由当前 `dataset_id + data_epoch` 对应的只读 K 线库批量校验；处于数据缺口、数据范围外或修订已变化的事件不会被静默挪动。每个拒绝行都会保留 CSV 行号和原因。同一文件同一行使用文件 SHA-256 形成稳定 ID，重复导入会报告跳过而不是生成重复标记；未知类型按“自定义”显示，同时保留原始类型值。

事件包含 K 线时间、可选价格、类型、标题、备注、颜色、来源和可扩展字段。页面支持新增、编辑、移动到当前选点、删除、按类型筛选，以及从事件列表定位图表。若旧事件不在当前 2,000 根窗口内，定位动作只从同一个本地数据集读取目标附近的 K 线，不会访问交易所。

事件保存在浏览器本地存储中，键包含 `dataset_id + data_epoch`；因此同一数据集的新修订不会继承旧修订的标记。绘图继续使用同一数据身份下的绘图存储。写入失败时事件不会只停留在内存里伪装成已保存；损坏的事件文档会 fail closed，并由用户显式重置。

## 共享指标体验

本地分析页复用正式行情页的 `IndicatorPanel`、显式-bars 指标 Runtime、计算调度、输出归一化和窗格投影。指标目录不再在前端维护第二份清单，而是由 `/api/v1/local/indicators/presets` 从正式内置注册表投影；因此名称、默认参数、参数 schema、窗格目标和新增内置指标都使用同一来源。当前注册表包含 MA、EMA、RSI、MACD、BOLL、ATR 和 VOL；VOL 只有在数据集确实包含 volume 列时才能添加，OHLC-only 数据集仍会显示该项目及不可用原因。

选择与参数按 `dataset_id + data_epoch` 保存在浏览器中，刷新页面后会恢复；同类指标仍可同时存在，例如 MA(20) 与 MA(60)。Pine/Pyne 自定义脚本 Runtime 没有在离线 profile 中启动，面板保留禁用的“自定义”入口并说明原因，不会静默请求普通在线指标 API。

共享 Runtime 注入的是数据集绑定的本地计算 transport。计算请求只提交指标身份、参数和已选周期；后端根据 `dataset_id + data_epoch` 打开对应不可变 SQLite 修订，读取源 K 线或先执行同合同的完整 bucket 聚合，再做一次性内置计算。它不接收浏览器提供的 OHLCV，不创建 DataManager、交易所连接、回填、指标 WebSocket 或插件 host。源数据缺口不会修复或插值，缺失成交量也不会被当成真实的零成交量。

当前一次静态计算默认最多支持 250,000 根 K 线，可通过 `CANDLESCOPE_LOCAL_INDICATOR_MAX_BARS` 下调或上调；超过时明确拒绝，不会截断后冒充完整结果。同一修订、同一指标请求的完整结果会写入本地分析缓存，重复计算直接命中缓存。Pine/Pyne 和自定义脚本尚未进入本地 profile；后续接入时必须继续使用显式的本地执行合同，不能回退到在线指标、插件或行情链路。

## 本地数据边界

- 本地 profile 只注册 `/api/v1/local/*`、健康检查和 API 文档；直播、回放和插件 API 不加载，并由 profile middleware 拒绝。
- Python 进程安装 loopback-only 网络 guard，在 DNS、TCP connect 和 UDP send 边界阻断非 loopback 目标。
- `local.html` 使用 `LocalKlineApi` 和静态 `SeriesWindowStore`，没有 WebSocket URL，也没有定时轮询。
- 本地工作区复用正式 `DrawingToolbar` 与 Drawing Engine；绘图仍按 `dataset_id + data_epoch` 隔离保存。
- 图表外观设置、图表类型及其高级参数、价格轴偏好、视口保存和截图导出复用正式图表 Runtime；数据集身份仍独立保存视口。
- 指标只调用数据集绑定的 `/api/v1/local/datasets/{dataset_id}/indicators/compute/batch`，结果带回同一 `data_epoch`；普通 `/api/v1/indicators/*` 路由仍不加载。
- 当前 profile 的网络 guard 是防止本地数据链路误入线上 fallback 的应用内防线，并不表示使用本地分析功能时要求电脑处于断网状态。

## 第一阶段范围

已支持 OHLC/OHLCV CSV 后台导入、进度与取消、严格校验、不可变修订、修订对比/切换、质量中心、资料库重命名/归档/回收站、完整项目包、静态 K 线、从单一源周期向上重采样及自定义整数倍周期、左侧历史分页、缺口披露、共享内置指标目录、ATR、按数据能力开放的 VOL、正式图表设置/价格轴/视口/导出、通用手工事件、任意事件 CSV 列映射、逐行拒绝报告、事件筛选与定位，以及本地绘图存储。当前暂不支持 Excel/Parquet、一个数据集内多商品或同时导入多套源周期、向下拆分 K 线、非整数倍/错位/周月日历派生周期、Pine/Pyne 自定义脚本、插件和回放；这些能力不能以在线 fallback 方式进入本地 profile。
