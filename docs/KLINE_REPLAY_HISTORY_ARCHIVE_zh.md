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

replay.db
  Run、订单、成交、账户、checkpoint、已选择的有界快照
```

`REPLAY_BAR_SOURCE=archive` 是默认值。运行时只读取 manifest 和 Parquet，
不会用实时 SQLite 填补归档缺口，也不会触发在线 backfill。
`REPLAY_BAR_SOURCE=legacy_sqlite` 仅用于显式回滚。

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

已关闭月份优先使用 monthly 文件；当前未关闭月份使用已完整结束的 daily
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
epoch；归档对象 GC 必须在后续实现 pin-aware 引用审计后才可开放。
