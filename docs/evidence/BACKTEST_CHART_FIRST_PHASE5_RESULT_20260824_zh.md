# Backtest Chart-first Phase 5 第一次真实回测结果（2026-08-24）

## 结论

Phase 5 状态为 `COMPLETE`。默认关闭的行情页策略测试器现在可以把一次用户“运行”严格展开为：

`冻结草稿与参数 -> 创建/复用 StrategyRevision -> resolve -> smoke -> validate -> 再 resolve -> create -> 按 Run ID 观察终态`

三份普通模式 Pyne 模板由新的 `PYNE_CHART_V1 / chart-pyne-v1` provider 真实编译和执行，不使用
`eval`，未知语句、变量或费用来源均失败关闭。Run、revision、snapshot 和 quick preset identity 仍由
Host 持有；普通 UI 不显示内部 ID。已创建的不可变 Run 可从 `/backtest.html` 查看并导出。

本阶段没有提前实现 Phase 6 的 ResultContextBar、四项结果指标、权益曲线、交易列表或主图标记。
“概览”只诚实显示 Run 完成状态；因此 Phase 0 完成态参考图中的结果卡片仍是下一阶段边界。

## 后端与不可变身份

- `PYNE_CHART_V1` 接受版本化策略声明、常量、SMA/RSI/highest/lowest、`[1]`、条件分支、
  crossover/crossunder 与 `target_position`；编译诊断带行列，未知语法不执行。
- provider 在隔离子进程内执行，persisted revision 的 smoke、validate、execute 使用同一
  `chart-pyne-v1` runtime identity。
- repository 在锁内按 `language + source_hash + dependency_hash + runtime_revision` 原子
  get-or-insert。相同源码复用已有 active revision，源码改变才创建新 revision。
- quick preset 的 `preset_id/revision/fee_source` 进入 Run immutable config；费用缺失或来源未知时
  拒绝创建，不把 Pydantic 默认 `0` 当成可信费率。
- 相同 smoke receipt 改为幂等复用。浏览器复跑曾真实触发 receipt 唯一键冲突，修复后重复 smoke
  返回 200，不增加 Run 或 revision。

## 前端流水线与普通模式

- 点击“运行”先冻结 source、parameters、chart session 与 draft content revision，再计算稳定
  SHA-256 parameter/materialize/Run idempotency keys。
- READY 路径固定先 smoke 和 validate，再重新 resolve；两次不可变 context identity 不一致时在
  create 前失败，不能把旧 token 偷渡到新上下文。
- NEEDS_DATA 首次只返回确认状态；只有用户点击“准备数据并运行”才 materialize，随后必须重新
  resolve。自动化测试验证未确认时调用序列只有 `revision -> resolve`。
- 双击运行复用同一个 in-flight promise。浏览器首轮发现第二次点击可能落到尚无 Run ID 的“停止等待”；
  现在该按钮只在真实 Run ID 已返回后出现。
- “停止等待”只 abort 当前前端 GET 轮询，不调用 cancel endpoint，不改变后台 Run；“恢复观察”按
  保留的 Run ID 继续读取。
- Settings 恰好显示资金、仓位、费用、日期、精度五项摘要；dataset、snapshot、revision 和
  RunCreateRequest 不进入普通 DOM。
- API 错误保留 `code/message/details`，provider 行列诊断回到脚本问题区并可定位源码。
- React runtime snapshot 与服务端诊断定位改为可取消的异步发布，避免 effect 内同步 state update
  造成级联渲染；未关闭 lint 规则。

## 真实浏览器与 API 证据

浏览器为仓库内 Playwright CLI 驱动的 headed Chrome；Vite 为 `127.0.0.1:15178`，后端为隔离
`LOCAL_OFFLINE` fixture runtime `127.0.0.1:18088`。fixture 含 60 根 BTCUSDT 1h 现货 K 线，准备
脚本禁止网络访问。

### READY、幂等与真实 Run

浏览器记录的真实请求顺序全部为 200：

1. `POST /strategy-revisions`
2. `POST /chart-context/resolve`
3. `POST /strategy-revisions/{revision_id}/smoke`
4. `POST /runs/validate`
5. `POST /chart-context/resolve`
6. `POST /runs`
7. `GET /runs/{run_id}`，直到终态

| 场景 | revision | Run | 结果 |
| --- | --- | --- | --- |
| SMA 模板 | `srv2_de154131e2db4c30aae76d7e786faf13` | `bt_5a0d82ab851f4a21aaa9721f00670aa8` | `COMPLETED` |
| 修改源码并双击运行 | `srv2_1a559d08509144969c4bf848dfa8f95d` | `bt_f6697fdbddce414cb981849b1b140e17` | 只创建一次，`COMPLETED` |
| 停止/恢复观察场景 | `srv2_6818e9e4097349d0bb8e35d8bc0014e1` | `bt_26c7aecfa56f482fb1487c9ea1faac47` | 后端继续并 `COMPLETED` |

相同源码和上下文再次运行后复用第二行的 revision 与 Run，最终计数仍为 2；停止/恢复场景才把隔离
fixture 增至 3 revisions / 3 Runs。没有 revision/Run 风暴。

### 停止观察、legacy 与导出

- 仅把目标 Run 的 `GET` 在浏览器侧延迟 5 秒；revision/resolve/smoke/validate/create 均走真实后端。
- UI 出现真实 Run ID 后点击“停止等待”，该 GET 以 `net::ERR_ABORTED` 结束；后端 Run 已独立到达
  `COMPLETED`，Run 数不变。
- 移除延迟并点击“恢复观察”，同一 Run ID 的 GET 返回 200，UI 显示完成。
- `/backtest.html` 能看到这些 Runs 和报告；导出
  `bt_f6697fdbddce414cb981849b1b140e17-backtest.json` 为 20,177 bytes，SHA-256
  `30469b34494ca49255a38eafc7b7c455f7cc37d554a051503f39bde0b14b3b79`。

### NEEDS_DATA、错误与多图

- 浏览器用受控 resolve 响应验证 UI 合同：首次只显示“准备数据并运行”、预计 60 根 K 线和
  “只有确认后才会开始准备”。该截图不声称本地后端真实物化成功；未确认不物化、确认后物化并
  重新 resolve 由纯流水线测试验证。
- `target_position(missing)` 显示第 4 行、第 19 列及定位动作；草稿没有被清空。
- 四图工作区切到 BTCUSDT 15m 时为“未附着 / 草稿尚未创建”；切回 BTCUSDT 1h 恢复
  `SMA Cross 3` 草稿，证明 attachment 和 panel context 不串格。
- 1366×768 下 `documentElement` 为 1366×768，scroll/client 宽高完全相等；bottom panel 和运行
  按钮仍在视口内。

### 已知测试环境差异

LOCAL_OFFLINE 主行情接口按合同拒绝网络行情，因此四个 chart 显示“数据加载失败”，插件平台也显示
LOCAL_OFFLINE fail-closed 提示；Vite worktree 通过 junction 共享依赖时字体请求被 fs allow 拒绝并使用
fallback。这些 console/network 记录没有被写成零错误，也没有归因于 Phase 5 回测 API。所有 Phase 5
backtest 请求单独核对为 200；真实 Run、报告与导出不依赖主行情图成功加载。

## 截图与视觉对照

| 资产 | SHA-256 |
| --- | --- |
| [真实完成态](backtest-chart-first-phase5/real-completed-overview-1440x900.png) | `00e937158955c390100019debd9dd935d81a7c877d2745b65ffcee5f5fd43dd3` |
| [五项设置摘要](backtest-chart-first-phase5/settings-five-summaries-1440x900.png) | `7e54a28e6eaccbf63e3b501a40357ad2eeff5c15bdb077daaf39a2e912f53413` |
| [可定位源码错误](backtest-chart-first-phase5/actionable-source-error-1440x900.png) | `6bd529200195553a7eae10798206dc9ead503c241b41b7d4f2d0d31beab9d75e` |
| [四图隔离与 compact viewport](backtest-chart-first-phase5/four-cell-isolation-1366x768.png) | `feed34c6f900b2f13ae6a9c77b5e5ad0271f1212b6fc0e2962954f7b2593d99b` |
| [NEEDS_DATA 确认态](backtest-chart-first-phase5/needs-data-confirmation-1366x768.png) | `e77529b1a63eaf4dfcc73d6f4b19beb438e8fec862af770eb3337cc5039d6692` |

Phase 0 运行完成参考图 SHA-256 为
`c426cc09cdc824cafcd896c2798013f3f3fe038accd5c7a7fa915618fd4f5a41`，错误参考图为
`edb86dec3a7b8fa5ba5a85b2e48b10156ab1d5696226a687d8c1a2d6dd18df5d`。源图与实现图已在同一
视觉输入中检查：chart/panel 分界、面板头、tabs、脚本/问题双栏和错误态几何一致；完成态缺少的
ResultContextBar、指标和交易内容明确属于 Phase 6，不把阶段边界伪写成像素一致。LOCAL_OFFLINE 的
无行情图和插件提示是 fixture 状态差异。

## 自动化门禁

| 验证 | 结果 |
| --- | --- |
| `npm run test:backtest` | PASS，70 tests / 3 suites，0 fail |
| `npm test` | PASS，3,347 tests / 3 suites，0 fail，133.69 s |
| 后端 Phase 5 + workspace + chart-context pytest | PASS，27 tests，0 fail |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS，全仓 ESLint |
| `npm run check:architecture` | PASS，0 migration allowlist entries |
| `npm run check:i18n` | PASS，3,677 keys / 602 source files |
| 默认 flag-off `npm run build` | PASS，641 modules；保留既有 >500 kB chunk warning |
| 显式 flag-on `npm run build` | PASS，641 modules；保留既有 >500 kB chunk warning |
| Python `py_compile` | PASS |
| `git diff --check` | PASS |

flag-off build 的 live entry 为 536.34 kB raw / 155.66 kB gzip；flag-on 为 536.52 / 155.74 kB。
Phase 5 bridge chunk 为 44.66 / 13.28 kB，仍位于 lazy boundary；关闭 flag 时入口和 panel 不渲染。

## 已处理的非通过尝试

1. 浏览器首轮双击时，第二次点击可能落到过早出现的“停止等待”；按钮改为只有真实 Run ID 存在时
   才显示，并增加 component 回归。
2. 相同源码重复运行首轮在 smoke receipt 唯一键处返回 500；repository 改为 receipt hash 幂等
   insert，复跑全链 200，Run/revision 计数不变。
3. 最终全仓 lint 发现两个 effect 内同步 state update；改为可取消的微任务/定时发布后，lint、
   typecheck、70 项回测测试与 3,347 项全量测试全部通过，没有禁用规则。

## 退出标准与回滚

- 模板和最近脚本均可在普通行情页三步内得到真实完成 Run：PASS。
- Run 在高级研究/legacy 页面可见且可导出：PASS。
- source、revision、snapshot、context、quick preset 与 config identity 冻结：PASS。
- `VITE_CHART_STRATEGY_TESTER_ENABLED` 和后端 backtest/chart-context flags 继续默认关闭。
- 回滚本阶段单提交或关闭 flag 后不再加载普通模式流水线；已经创建的不可变 revision 和 Run 保留，
  仍可从高级研究查看，不删除用户数据。

Phase 6 尚未开始。
