# 策略研究统一模式风险收口（2026-08-26）

## 结论

2026-08-25 默认启用后留下的三个风险已经全部收口，当前本地 `main` 可以作为合并后的默认启用基线：

1. 后端全量 pytest：PASS；
2. 前端全量 ESLint：PASS；
3. 真实 LIVE + LOCAL_OFFLINE 双浏览器 60 分钟浸泡：PASS。

本轮没有 push 或 deploy。原有显式 `flag=0` 回滚合同保持不变。

## 1. 后端全量测试

最终全量结果：

| 项目 | 结果 |
| --- | --- |
| tests | 3971 |
| failures | 0 |
| errors | 0 |
| skipped | 0 |
| pytest time | 2437.798 s |
| 控制台总耗时 | 2437.88 s（40:37） |

JUnit 原始文件保存在本机 `backend/output/test-results/backend-full-20260826.xml`，时间戳为 `2026-08-26T15:07:33.332422`。

修复不是放宽断言，而是清理真实的跨层不一致：

- Phase 1 / Phase 6 当前契约升级到 v2，同时保留不可变 v1 历史 fixture；后续阶段显式绑定历史版本；
- Phase 2 性能门禁改为同一轮候选与 legacy 对比，避免机器争用把环境波动误报为产品回归；
- 仿真 checkpoint 完整保存并恢复 scale decision chain；
- Python scale 配置改为 Settings 显式注入，不再由服务层重复读取全局环境；
- 测试时钟冻结，源码 checkout 子进程统一注入仓库 backend 与 plugin SDK 路径；
- dotenv 只回收本模块注入的环境键，避免全量测试顺序污染；
- release verifier 和官方插件锁分别绑定当前契约与历史 fixture。

变更 Python 文件已通过 Ruff。

## 2. 前端全量门禁

| 门禁 | 结果 |
| --- | --- |
| `eslint . --max-warnings=0` | PASS |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd test` | PASS，3481 / 3481 |
| `npm.cmd run build` | PASS，706 modules |

140 个 lint 错误来自 `eslint-plugin-react-hooks` 7.x 推荐配置新增的 React Compiler 资格诊断，而项目没有启用 React Compiler。配置只关闭以下五条 compiler-eligibility 规则：

- `preserve-manual-memoization`
- `purity`
- `refs`
- `set-state-in-effect`
- `use-memo`

`rules-of-hooks`、`exhaustive-deps` 等运行时正确性规则继续启用；这不是把整个 Hooks lint 关闭。生产构建只保留既有的大 chunk 提示，没有构建失败。

## 3. 真实 60 分钟 mixed browser soak

### 3.1 环境

同时启动四个隔离服务：

| 模式 | 前端 | 后端 | 关键约束 |
| --- | --- | --- | --- |
| LIVE | `127.0.0.1:15174` | `127.0.0.1:18081` | Binance 实时 WebSocket、盘口与逐笔 |
| LOCAL_OFFLINE | `127.0.0.1:15175` | `127.0.0.1:18082` | `loopback_only`、1 个本地数据集 |

本地导入数据集：

- 名称：`browser-soak-1000`
- datasetId：`local-6ae893092fc94717aa0fc8045fcedb62`
- 商品 / 周期：`BTC-USDT / 1m`
- 行数 / 缺口：`1000 / 0`
- dataEpoch：`sha256:d0332faa07ee11a1ac2a8bf8812e0936c77e1855302940b566eb7d23bdfe3316`

### 3.2 持续时间与服务采样

| 项目 | 结果 |
| --- | --- |
| 开始 | 2026-08-26 15:55:58.475 +08:00 |
| 完成 | 2026-08-26 16:56:15.908 +08:00 |
| 实际时长 | 3617.432 s |
| 要求时长 | 3600 s |
| 健康采样 | 58 |
| 失败采样 | 0 |
| 判定 | PASS |

每个样本都检查两套 `/health`、四个根服务进程和 `18081/18082/15174/15175` 四个监听端口。首个 LIVE 样本为 2 条 active streams / 1505 cache bars，末个样本为 2 条 active streams / 1567 cache bars；LOCAL_OFFLINE 始终为 `loopback_only`、0 blocked attempts、1 dataset。

### 3.3 浏览器开始、中点、结束检查

| 检查点 | LIVE | LOCAL_OFFLINE |
| --- | --- | --- |
| 开始 | 9 canvas、0 alert、已连接 Binance、1501 根 K 线、实时盘口 | 9 canvas、0 alert、导入图表存在、1000 source bars、ready |
| 约 30 分钟 | 9 canvas、0 alert、已连接、实时价格 79,005.99 | 9 canvas、0 alert、dataset / dataEpoch / ready 均保持 |
| 结束 | 9 canvas、0 alert、已连接、1502 根 K 线、实时价格 78,699.80、WebSocket 模式 | 9 canvas、0 alert、1000 行、0 缺口、dataset / dataEpoch / ready 均保持 |
| console error | 0 | 0 |

控制台 warning 仅包含 Chromium 对 `slider-vertical` 的兼容提示，以及 LIVE 初始化替换旧订阅时两条“连接建立前关闭”的旧 WebSocket 提示。最终页面明确显示已连接 Binance、实时 WebSocket、实时盘口与变化中的价格，因此没有把初始化提示误记为掉线。

本机原始采样、服务日志和截图位于 `output/playwright/strategy-research-risk-closure-20260826/`。关键截图为：

- 开始：`page-2026-08-26T07-55-52-438Z.png`（LIVE）、`page-2026-08-26T07-55-43-475Z.png`（LOCAL_OFFLINE）；
- 中点：`page-2026-08-26T08-27-23-857Z.png`（LIVE）、`page-2026-08-26T08-27-35-436Z.png`（LOCAL_OFFLINE）；
- 结束：`page-2026-08-26T08-56-49-918Z.png`（LIVE）、`page-2026-08-26T08-57-04-308Z.png`（LOCAL_OFFLINE）。

浸泡结束后已关闭 Playwright 会话，并按本轮四个根 PID 的父子树停止 14 个专用进程；四个端口全部释放。

## 4. 发布判断

三个已知风险均为 PASS，不再构成默认启用或本地合并阻塞项。当前结论只覆盖本地仓库与本机验证；未执行远端 push 或部署。
