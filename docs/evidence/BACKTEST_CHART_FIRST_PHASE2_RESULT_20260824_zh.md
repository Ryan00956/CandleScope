# Backtest Chart-first Phase 2 图表上下文解析结果（2026-08-24）

## 结论

Phase 2 状态为 `COMPLETE`。当前 chart session 现在可通过两个默认关闭的公开 API 得到可行动、
有类型的解析结果，并在用户明确确认后复用 Host 数据链路冻结为现有回测内核可验证的不可变
snapshot。实现没有新增下载器、缓存或近似重采样器，也没有创建 Run、改变 legacy workbench，
或开启任何默认关闭开关。

本阶段没有 Phase 3 前端入口或用户可见 UI，因此没有把 DOM/截图检查描述为 Phase 2 视觉证据；
前端只增加 typed client 合同。未 push、merge、deploy，主工作树用户修改保持原样。

## 实现

### Resolve 与 typed 结果

- 新增 `POST /api/v1/backtests/chart-context/resolve`，状态域固定为 `READY`、`NEEDS_DATA`、
  `UNSUPPORTED_INTERVAL`、`UNSUPPORTED_FIDELITY`、`AMBIGUOUS_MARKET`、`UNAVAILABLE`。
- `READY` 返回 resolution token、chart context hash、dataset/data epoch/snapshot hash、coverage、
  fidelity capabilities、quality warnings、cost/account/execution preset 与 5 分钟到期时间。
- resolve 只调用本地不可变 dataset、Host `get_bounds` 和 `query(auto_backfill=False)`；不提交
  backfill，不把浏览器可见 candles 当作 snapshot，也不触发网络准备。
- 市场别名在 Host 边界规范化；缺少交易所/市场身份的数据集 fail closed 为
  `AMBIGUOUS_MARKET`。
- `PRECISE` 只有匹配成交档案时才可能 READY；不存在匹配档案时直接返回
  `UNSUPPORTED_FIDELITY`，不会误导用户进入无法完成的 materialize。

### Materialize 与不可变数据边界

- 新增 `POST /api/v1/backtests/chart-context/materialize`；要求有效 token、显式
  `user_confirmed=true` 和 idempotency key。
- 只复用现有 `BackfillCoordinator.request_and_wait`、`DataManager.query` 与
  `LocalDatasetService`；Host K 线必须已闭合、连续、对齐且 OHLCV 合法，之后才原子发布不可变
  revision。
- 周期继续使用既有 `IntervalResolver` 和 snapshot provider；只允许同一不可变 revision 的精确
  整数倍聚合，`5m -> 89m` 明确拒绝，不增加第二套重采样实现。
- 同一 context 的并发请求只物化一个 snapshot；同一 idempotency key 不能跨 context 复用；
  candidate revision 在进入物化前再次校验，token 在公布的到期毫秒即失效。
- 失败路径不创建 Run，底层异常和绝对路径不进入 HTTP 错误响应。

### Presets、capabilities 与兼容性

- capabilities 增加默认关闭的 `BACKTEST_CHART_CONTEXT_ENABLED`、版本化 chart-context 能力描述
  和 `CRYPTO_PERP_STANDARD_V1` / `CRYPTO_SPOT_STANDARD_V1` quick presets。
- quick preset 只负责给 UI 稳定的 preset ID；后续 Run 仍提交展开后的 account、sizing、cost、
  execution 字段，不把可变默认值藏进 Run。
- 既有 `/datasets/snapshot`、`/runs/validate`、`/runs` route 与请求合同未改写；前端原 33-method
  wire test 保持通过，两个 chart-context method 是纯加法。

## 自动化与公开 API 证据

| 验证 | 结果 |
| --- | --- |
| Phase 2 定向后端 | PASS，19 tests，0 fail，4.40 s |
| backtest/local-data/market-dataset 回归 | PASS，245 tests，0 fail，4 个既有 FastAPI `on_event` warnings，20.49 s |
| `npm run test:backtest` | PASS，39 tests / 3 suites，0 fail，376 ms |
| `npm test` | PASS，3,310 tests，0 fail，137.14 s |
| `npm run typecheck` | PASS |
| `npm run check:architecture` | PASS，0 migration allowlist entries |
| `npm run check:i18n` | PASS，3,562 keys / 592 source files |
| `npm run lint` | PASS，全仓 ESLint |
| `npm run build` | PASS，630 modules，6.82 s；保留既有 >500 kB chunk warning |
| Python compile | PASS，Phase 2 相关模块与测试 |
| `git diff --check` | PASS |

生产 build 的 backtest entry 为 `93.01 kB raw / 22.47 kB gzip`；Phase 1 为
`92.66 / 22.43 kB`，增量 `0.35 / 0.04 kB`。

公开 HTTP 合同测试通过真实 FastAPI 路由完成：`resolve(NEEDS_DATA) -> 未确认 materialize 被拒 ->
确认 materialize(READY) -> 既有 /runs/validate(ok=true)`。同组测试还验证请求 extra field 返回
422、默认 flag 返回 `FLAG_DISABLED`，以及物化后 snapshot hash 能被原 Run 验证链接受。该 smoke
使用隔离临时目录和内存 Host facade，没有网络请求、端口或残留进程。

## 验收矩阵

| 合同 | 证据 | 结果 |
| --- | --- | --- |
| 六种 typed resolve 状态 | status/HTTP 单测 | PASS |
| resolve 离线纯本地读取 | READY 使用禁止 Host read 的 facade；Host query 强制 `auto_backfill=False` | PASS |
| materialize 显式确认 | runtime 与 HTTP fail-closed tests | PASS |
| dataset/data epoch 漂移拒绝 | candidate revision drift test，并在 context lock 内二次校验 | PASS |
| 89m 不近似补齐 | 5m immutable dataset 非整数倍测试 | PASS |
| 并发只产生一个 snapshot | 同 context 两个并发 idempotency key，revision 数为 1 | PASS |
| 幂等键不能跨 context | BTC/ETH 并发冲突测试 | PASS |
| 错误不泄漏路径 | backfill 抛出私有绝对路径，wire 只返回脱敏错误 | PASS |
| READY 进入既有 Run 验证 | FastAPI `/runs/validate` smoke | PASS |
| 既有 snapshot/Run 合同不变 | additive route diff + legacy wire/regression tests | PASS |

## 已处理的非通过尝试

1. 首轮 FastAPI collection 因 union return annotation 被当作 response model 而失败；两个新 route
   明确使用 `response_model=None` 后通过，没有改动既有 route。
2. 首轮 1m -> 3m fixture 没有按 3m epoch 对齐，正确返回 `UNAVAILABLE`；fixture 改为 15m 对齐
   基点后通过，没有放宽产品周期规则。
3. 首轮 243-test 回归因 subprocess 缺少本仓库 plugin SDK `PYTHONPATH` 而有 2 项 import failure；
   使用绝对 SDK source path 重跑相同范围后 243/243，通过；最终扩展回归为 245/245。
4. 探索性 `black --check` 报告 9 个文件会被重排；仓库没有 Black 配置或门禁，未进行大范围机械
   改写。仓库实际门禁 ESLint、TypeScript、pytest、build 与 `git diff --check` 均通过。

## 退出标准与回滚

- 任意合法 chart session 得到可行动 typed 结果：PASS。
- READY 可直接通过现有 `/runs/validate`：PASS。
- 没有第二套下载、缓存或重采样实现：PASS。
- 默认状态仍关闭；关闭 `BACKTEST_CHART_CONTEXT_ENABLED` 即恢复旧入口行为。
- 代码回滚为本阶段单提交 revert；已生成的不可变 local revisions 可保留且不会被旧路径自动使用。

Phase 3 尚未开始。
