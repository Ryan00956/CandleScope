# K 线回放独立历史归档

状态：已实现。BAR 回放默认读取独立 `replay-history` 数据面；实时
`candlescope.db` 只负责在线行情、近期缓存、在线回填与在线 gap ledger。

## 责任边界

```text
candlescope.db
  实时行情、近期缓存、在线回填、在线 gap ledger

replay-history-origin/
  index.json
  objects/sha256/<prefix>/<content-hash>.parquet
  catalogs/<exchange>/<market>/<symbol>/<interval>/<catalog-epoch>.json
  catalogs/<exchange>/<market>/<symbol>/<interval>/current.json

replay-history-cache/
  remote-metadata/current.json
  catalogs/.../<catalog-epoch>.json
  objects/sha256/<prefix>/<按需下载的 content-hash>.parquet
  derived-cache/v1/<revision>/<query-hash>.json.zlib

replay.db
  Run、订单、成交、账户、checkpoint、快照引用、archive pin

replay.db.datasets/
  <prefix>/<snapshot-hash>.json.zlib
```

`REPLAY_BAR_SOURCE=archive` 是默认值。配置 `REPLAY_HISTORY_ORIGIN_URI` 后，
远端 `index.json` 与不可变 manifest 是随机范围的唯一权威；
`REPLAY_HISTORY_ARCHIVE_DIR` 退化为可淘汰本地缓存，缓存中有无 Parquet
都不会改变候选范围。选中起点并持久化 selection commitment 后，运行时才
下载与 `warmup + forward` 相交的内容寻址对象。不会用实时 SQLite 填补
归档缺口，也不会触发在线 backfill。
`REPLAY_BAR_SOURCE=legacy_sqlite` 仅用于显式回滚。

`replay.db` 与 `replay.db.datasets` 是同一个恢复集合。备份或恢复前必须停止
回放后端，确保 SQLite 中的引用与内容寻址快照来自同一时点。存储 schema
只向前迁移；回滚到旧的、仍支持回放的版本时，要么先关闭
`REPLAY_ENABLED`，要么同时恢复升级前的这两个路径，不能让旧代码打开新
schema。

## 连续性与随机合同

归档导入时只接受时间严格递增、周期对齐、OHLC 合法的 K 线。缺失 K 线会
把覆盖范围切成多个最大连续段。

对连续段 `[segment_start, segment_end]`、预热根数 `W` 和前向根数 `F`：

```text
first_start = segment_start + W * interval
last_start  = segment_end - (F - 1) * interval
count       = (last_start - first_start) / interval + 1
```

只有 `first_start <= last_start` 的段参与随机。所有段按 `count` 做前缀和，
服务端的无模偏 SHA-256 随机索引映射到整个候选时间点全集。因此每个有效
时间点等概率；并非先等概率选段。

`AGG_TRADE` 会把上述 BAR 候选范围与远程“官方日包可用性 catalog”的 UTC
连续日取交集。该 catalog 由 Binance 官方 S3 目录中同时存在的 ZIP 与
`CHECKSUM` 对生成；它记录连续日期段并绑定 catalog epoch，不读取本地缓存，
也不要求远端预先转换并存放全部 Parquet/receipt。交集内仍按实际候选点数量
等概率抽样，因此空缓存、部分缓存和完整缓存得到相同的随机域。

选中并持久化 commitment 后，运行时才下载覆盖该窗口的 Binance 官方日包：
先取小型 `CHECKSUM`，再取 ZIP，校验 SHA-256、ZIP/CSV 身份、日期边界、事件
顺序和日内 aggregate-trade ID；转换为本地不可变 Parquet 后，再对跨日 ID
连续性和冻结 dataset epoch 做最终校验。失败保留原 commitment，重试同一
时间，不会因为本地缺包而缩小候选域或重新抽签。不会要求 aggTrade 聚合出的
K 线逐根等于官方 K 线：Binance 可能把跨分钟的原始成交合成一个 `aggTrade`，
这类偏差属于已声明的 `VERIFIED_AGG_TRADE_APPROXIMATE_BARS`。历史兼容性证明
可作为离线审计证据保留，但不再决定随机范围，也不是创建 Run 的前置条件。

catalog 构建只读取 manifest 的边界和连续段，不扫描 Parquet 正文。选中
时间后，`BarDatasetBuilder` 从已绑定 revision 读取 `warmup + forward`
区间，再次校验缺口、行数、闭合状态与 K 线字段，最后冻结成内存快照。
逐根推进不查询 Parquet 或 SQLite。

随机选择先以 `PREPARING_DATA` 写入 `replay.db`，记录服务端 seed、选中
时间、catalog、source revision、请求和 selection 的规范哈希。下载失败会
保留为 `FAILED`；`POST /api/v1/replay/runs/preparations/{id}/retry` 只能认领
原 commitment，不能重新调用随机选择。Run 与初始 checkpoint 原子落库后
才切换为 `READY`。进程重启时遗留的 `PREPARING_DATA` 会转成可审计的
`FAILED`，随后仍可按同一 commitment 重试。

## 不可变版本

Parquet 文件按自身 SHA-256 寻址。catalog epoch 是身份、周期、对象引用、
连续段、边界和行数的规范 JSON 哈希。发布顺序为：

1. 校验官方来源 checksum；
2. 写临时 Parquet；
3. 计算内容哈希并发布不可变对象；
4. 写不可变 catalog manifest；
5. 原子替换 `current.json`。

catalog、随机选择、冻结快照和 `ALL_AVAILABLE` 都保存并使用具体
`source_revision`。之后导入新月份或上游修订时，既有 Run 仍读取旧
manifest 和旧内容对象。

高周期 `ALL_AVAILABLE` 页面从固定 revision 的 Parquet 分区做有界聚合，
结果写入可重建的 `derived-cache`。缓存不参与执行、随机或数据身份；实际
逐根推进仍只使用冻结的基础周期快照。

## Binance 导入

先安装可选 Parquet 依赖：

```powershell
Set-Location backend
.\.venv\Scripts\python.exe -m pip install -r requirements-parquet.txt
```

查看下载计划：

```powershell
.\.venv\Scripts\python.exe scripts\import_binance_replay_history.py `
  --market-type spot --symbol BTCUSDT --interval 1m `
  --start 2017-07-01 --end 2026-07-30 `
  --archive-dir .\data\replay-history --plan-only
```

正式导入：

```powershell
.\.venv\Scripts\python.exe scripts\import_binance_replay_history.py `
  --market-type spot --symbol BTCUSDT --interval 1m `
  --start 2017-07-01 --end 2026-07-30 `
  --archive-dir .\data\replay-history
```

已关闭月份优先使用 monthly 文件；如果 monthly checksum 返回 404，导入器
会自动改试该月所有已完整结束的 daily 文件。当前未关闭月份直接使用 daily
文件。Binance 不存在的 pre-listing 对象默认记录为 missing，首个
checksum-valid K 线成为 listing boundary。其他下载、checksum、ZIP、
schema 或解析错误一律失败，不发布新的 `current.json`。

重复运行会复用 source checksum 未变化的对象。monthly 对象可以完整替换
同月 daily 对象；部分重叠会拒绝，避免悄悄覆盖不一致的数据。

早期 Binance spot 官方文件中存在 checksum 正确、但不是 UTC 周期网格的
维护期部分 K 线。导入器不会把它们改造成普通 K 线：非网格行会被排除并
形成 gap，source row/rejected row/reason 计数写入不可变 manifest。仅对
“close 恰好等于下一周期边界”的旧格式做 `-1 ms` 半开区间规范化，并记录
normalized row 数量。

审计当前 catalog 与全部对象哈希：

```powershell
.\.venv\Scripts\python.exe scripts\audit_replay_history.py `
  --archive-dir .\data\replay-history `
  --market-type spot --symbol BTCUSDT --interval 1m `
  --verify-objects
```

与实时 SQLite 的重叠区间做只读 shadow parity（不会修改或回填任一数据源）：

```powershell
.\.venv\Scripts\python.exe scripts\audit_replay_history_parity.py `
  --archive-dir .\data\replay-history `
  --live-db .\data\candlescope.db `
  --market-type spot --symbol BTCUSDT --interval 1m
```

增加 `--require-exact` 后，任一缺行或字段差异都会以退出码 `3` 关闭切换
门禁。报告会保留差异字段、最大绝对差与有界样本，便于区分实时采集误差、
上游历史修订和归档导入错误；不应为了通过 parity 而改写官方 checksum
归档。

## 运行配置与回滚

```dotenv
REPLAY_ENABLED=1
REPLAY_BAR_SOURCE=archive
REPLAY_HISTORY_ARCHIVE_DIR=./data/replay-history-cache
REPLAY_HISTORY_ORIGIN_URI=https://replay.example.com/replay-history/
REPLAY_HISTORY_CATALOG_REFRESH_SECONDS=300
REPLAY_HISTORY_DOWNLOAD_TIMEOUT_SECONDS=60
REPLAY_DB_PATH=./data/replay.db
```

对象存储发布端先完成不可变对象与 catalog 发布，再原子生成轻量索引：

```powershell
.\.venv\Scripts\python.exe scripts\publish_replay_history_remote_index.py `
  --archive-dir .\data\replay-history-origin

.\.venv\Scripts\python.exe scripts\publish_replay_agg_trade_remote_index.py `
  --archive-dir .\data\replay-agg-trades-origin
```

`ORIGIN_URI` 支持只读 `file`、`http` 和 `https` 根地址；本机 `file` origin
适合 shadow/开发，生产可直接切到同目录布局的 HTTP(S) 对象存储。远端暂时
不可达时只允许使用最后一次完整校验的元数据快照；远端返回损坏的 live index
则 fail closed，不会用旧快照掩盖发布错误。正文下载有超时和大小上限，并在
原子进入缓存前校验 size/checksum。

归档不存在时 catalog 为空，不会回退到实时库。需要临时恢复旧行为时：

```dotenv
REPLAY_BAR_SOURCE=legacy_sqlite
KLINES_DB_PATH=./data/replay-dev/source-candlescope.db
```

回滚不应删除 `replay-history`。旧 Run、审计和复现仍可能引用旧 catalog
epoch。Run 创建时会把 revision 写入 `replay_archive_pin`；启动迁移还会为
旧 Run 从其持久化快照引用补 pin。GC 另外扫描所有回放 session 的引用和旧版
内联快照，因此非 TrainingRun 的 v1 session 也受保护。归档 GC 默认只做
dry-run；物理删除要求回放后端已停止，以取得 archive runtime lease，并
始终保留所有 current revision、session 引用与 Run pin：

```powershell
.\.venv\Scripts\python.exe scripts\gc_replay_history_archive.py `
  --archive-dir .\data\replay-history `
  --replay-db .\data\replay.db

# 检查 dry-run 报告后，先停止后端，再显式执行：
.\.venv\Scripts\python.exe scripts\gc_replay_history_archive.py `
  --archive-dir .\data\replay-history `
  --replay-db .\data\replay.db --apply
```

若任一 pin revision、current manifest 或保留对象缺失/校验失败，GC 会
拒绝执行；导入 publish 与 GC sweep 也由跨进程 mutation lock 串行化。
