# K 线回放独立历史归档

状态：已实现。BAR 回放默认读取独立 `replay-history` 数据面；实时
`candlescope.db` 只负责在线行情、近期缓存、在线回填与在线 gap ledger。

## 责任边界

```text
candlescope.db
  实时行情、近期缓存、在线回填、在线 gap ledger

replay-history/
  objects/sha256/<prefix>/<content-hash>.parquet
  catalogs/<exchange>/<market>/<symbol>/<interval>/<catalog-epoch>.json
  catalogs/<exchange>/<market>/<symbol>/<interval>/current.json
  derived-cache/v1/<revision>/<query-hash>.json.zlib

replay.db
  Run、订单、成交、账户、checkpoint、快照引用、archive pin

replay.db.datasets/
  <prefix>/<snapshot-hash>.json.zlib
```

`REPLAY_BAR_SOURCE=archive` 是默认值。运行时只读取 manifest 和 Parquet，
不会用实时 SQLite 填补归档缺口，也不会触发在线 backfill。
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

`AGG_TRADE` 还会把上述 BAR 候选范围与固定 BAR revision 的逐根兼容性索引
取交集。仅有 checksum 和连续 aggregate-trade ID 还不够：Binance 可能把跨
分钟边界的多笔成交聚合成一个 `aggTrade`，因此部分官方 K 线无法从聚合事件
精确还原。离线兼容性构建器会逐根对账时间、OHLC、base/quote volume 和
taker-buy volume，只发布最大连续匹配段。候选起点的整个前向区间必须落在
同一个匹配段内；交集内仍按实际候选点数量等概率抽样。选中后创建 Run 时
还会再次做对象 checksum 与逐根一致性校验。

兼容性证明按 `BAR revision / raw dataset epoch / parity policy` 不可变保存。
后续导入并校验新的日期只会追加证明，不会覆盖同一 BAR revision 已发布的
旧日期覆盖；重叠但内容身份不同的证明会 fail closed。

catalog 构建只读取 manifest 的边界和连续段，不扫描 Parquet 正文。选中
时间后，`BarDatasetBuilder` 从已绑定 revision 读取 `warmup + forward`
区间，再次校验缺口、行数、闭合状态与 K 线字段，最后冻结成内存快照。
逐根推进不查询 Parquet 或 SQLite。

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
REPLAY_HISTORY_ARCHIVE_DIR=./data/replay-history
REPLAY_DB_PATH=./data/replay.db
```

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
