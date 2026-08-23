# CandleScope 图表脚本快测与高级策略研究 UX 逐步执行方案

> 状态：`PHASE_1_COMPLETE`
>
> 2026-08-24 Phase 0 自动化、公开 API、浏览器、bundle、单/四图与 lease 基线已通过；
> 四个同视口视觉合同稿已经用户人工产品评审批准。Phase 1 已提取 typed backtest client、Run
> 轮询和 marker/equity/摘要/focused trade 纯投影，legacy DOM 与 wire 行为保持不变；没有新增或
> 开启产品 flags，Phase 2 尚未开始。证据见
> [Phase 0 结果](evidence/BACKTEST_CHART_FIRST_PHASE0_RESULT_20260824_zh.md) 与
> [Phase 1 结果](evidence/BACKTEST_CHART_FIRST_PHASE1_RESULT_20260824_zh.md)。
>
> 文档类型：产品合同 + 仓库级执行计划
>
> 适用仓库：`H:\program\CandleScope`
>
> 目标读者：产品、前端、后端、测试、发布负责人

## 0. 文档结论

CandleScope 不应让普通用户先进入一个包含数据集、快照、精度、账户模型、StrategyRevision、Study、风控和审计字段的大表单，再想办法拼出一次回测。

普通用户的默认路径应改为：

`当前实时图表 -> 选择开始方式 -> 编写脚本 -> 运行 -> 当前图查看买卖点与原因 -> 判断修改是否更好`

产品提供两套完整体验，并建立一个共享图表平台：

| 层级 | 用户心智 | 默认入口 | 主要内容 |
| --- | --- | --- | --- |
| 图表脚本快测 | “我写完脚本，想马上看看它在当前品种和周期的表现” | 现有实时行情页顶部“策略” | 三种开始方式、自动保存、一个“运行”按钮、图上成交解释、底部结果与修改前后对比 |
| 高级策略研究 | “我要控制数据、模型、执行、风险和实验过程” | 独立全屏“高级研究”页面 | 复用行情图表，接入精度模式、Python/模型、版本、Study、比较、可信度和回放桥 |

K 线回放仍是第三个独立产品对象，用于训练和复盘，不与策略回测合并。

两套体验必须复用同一套图表渲染、行情服务、品种/周期选择、指标、绘图、外部标记、主题和国际化能力，但不能共享可变 runtime、WebSocket 生命周期、回测账户或 Run/Study UI store。

这不是重写回测内核。本方案继续使用现有 Host-owned 回测运行、不可变数据快照、报告、Study 和回放桥；新增面向当前图表的脚本快测层，以及一个像 K 线回放一样拥有独立 runtime 的高级研究应用。

---

## 1. 为什么现在难用

当前 `/backtest.html` 同时把以下任务放在一个页面里：

1. 选择数据集和数据版本；
2. 选择精度和成交输入；
3. 选择或创建策略版本；
4. 配置资金、仓位、费用、滑点、延迟和风险；
5. 创建并监控 Run；
6. 阅读可信度、图表、比较、回放桥和 Study。

这些能力对研究者有价值，但普通用户只需要回答四个问题：

- 写哪个脚本，或使用哪个模板；
- 大概用多少钱；
- 回测哪段时间；
- 现在能不能运行。

现有页面的根本问题不是字段样式，而是产品起点错误：它从 `BacktestRun` 数据结构出发，而不是从用户正在看的图表出发。

### 1.1 本方案接受与不接受的 TradingView 思路

接受：

- 策略附着在当前图表；
- 品种和周期由当前图表自动带入；
- 运行后直接在主图显示买卖点；
- 结果固定出现在图表下方；
- 修改策略参数或切换图表后，结果能快速更新；
- 编写脚本与查看结果属于同一工作区，而不是另开一套后台系统。

不照搬：

- 不把估算成交包装成精确成交；
- 不允许结果与当前品种、周期或数据版本不一致时继续显示；
- 不把指标脚本自动当作交易策略；
- 不在用户不知情时联网下载或补齐数据；
- 不把 Python 信任确认、批量 Study 和审计字段塞进普通模式。

### 1.2 CandleScope 自己的优势

图表脚本快测应把现有研究能力翻译成普通用户能理解的差异点：

- “快速估算 / 成交序列精算”，并在精算结果中继续明确区分“逐笔成交 / 聚合成交”，而不是只显示内部枚举或把 aggTrade 包装成 raw trade；
- “数据已冻结，可复现”，而不是要求用户先理解 `data_epoch`；
- “费用来自哪个市场预设”，而不是静默使用零费率；
- “这一段结果可打开 K 线回放复盘”，而不是只给一张收益曲线；
- “当前结果已过期，需要重跑”，而不是把旧成交点画到新图上。

---

## 2. 北极星体验与成功标准

### 2.1 第一次成功回测

前提：当前图表对应的本地历史数据已经可用。

普通用户应能在 60 秒内完成：

1. 点击顶部“策略”；
2. 选择模板、最近脚本或粘贴代码；
3. 点击“运行”；
4. 在当前图表看到买卖点；
5. 在底部看到明确的回测对象、净收益、最大回撤、交易次数和权益曲线。

第一次流程最多允许三个主要决策，不要求用户理解数据集、快照、策略版本或账户模型。

### 2.2 量化验收指标

| 指标 | 发布门槛 |
| --- | --- |
| 数据已就绪时，首次结果路径 | 不超过 3 个主要操作 |
| 发布基准数据上的首次结果 | `回测执行 p95 + 2 秒`，且端到端不超过 60 秒 |
| 已附着策略后切换品种或周期 | 旧标记在同一渲染帧内隐藏，绝不跨上下文保留 |
| 普通模式首屏字段 | 不超过 6 个可编辑字段 |
| 普通模式内部术语泄漏 | 主路径中为 0；只允许在“可信度详情”出现 |
| 普通模式主操作 | 只有“运行”；不出现“保存 revision”“创建 Run”等动作 |
| 完成结果的上下文识别 | 结果上方始终显示 symbol、interval、范围、精度和费用状态 |
| 交易解释覆盖 | 支持结构化 trace 的交易与拒单 100% 可追到决定时证据 |
| 自动比较 | 只对可直接比较的前后 Run 展示差值；不可比较必须说明原因 |
| 初始图表包体影响 | 编辑器和结果面板必须懒加载；主入口增量目标小于 20 KiB gzip |
| 多图表隔离 | 任意一个单元格切换/运行不得改变其他单元格结果 |
| 无数据/不支持状态 | 100% 返回可行动原因，不得空白或假成功 |
| 高级页前端复用 | 不复制第二套图表/行情实现；共享平台合同测试通过 |

产品埋点只记录状态、耗时、错误码和功能使用，不记录策略源码、参数明文或交易数据内容。

### 2.3 首轮视觉确认范围

Phase 4 实现前，必须先产出并评审同一视口、同一设计系统下的三个普通模式状态：

1. 首次打开：三个开始入口，编辑器尚未加载；
2. 运行完成：ResultContextBar、核心指标、前后差值和交易原因入口；
3. 脚本出错：编辑器行内诊断、问题说明和“运行”按钮。

“结果已过期”作为运行完成状态的变体一起评审。评审只回答四个问题：

- 用户是否始终只看到一个主操作“运行”；
- 用户是否无需理解 revision、Run、dataset 或 snapshot；
- 用户是否一眼看懂本次结果针对什么；
- 出错时用户是否知道应该改哪一行或执行哪个动作。

三个状态未通过评审前，不进入 Phase 4 的生产 UI 实现。

---

## 3. 双层信息架构

## 3.1 普通模式：现有行情页中的图表脚本快测

入口位于当前活动图表的顶部工具栏，名称为“策略”。点击后直接打开与当前图表绑定的底部工作区，而不是先跳转独立页面。

底部工作区包含四个一级标签：

| 标签 | 默认内容 |
| --- | --- |
| 脚本 | 首次开始入口或 Monaco 编辑器；草稿自动保存；唯一主按钮“运行” |
| 概览 | 固定回测对象、净收益、最大回撤、交易次数、权益曲线、相对上次变化 |
| 交易 | 虚拟化交易列表；点击定位当前主图 |
| 设置 | 脚本参数、资金与仓位、费用预设、日期范围、快速估算说明 |

“可信度详情”放在概览中的可展开区域，不占用普通模式的一级标签。高级字段通过“在高级研究中打开”进入独立页面。

### 3.1.1 首次打开不展示空白编辑器

首次打开只提供三个同等清晰的入口：

1. 使用策略模板；
2. 打开最近脚本；
3. 粘贴已有代码。

用户选择入口后才加载完整编辑器：

- “使用策略模板”进入模板选择，选中后复制为草稿；
- “打开最近脚本”显示最近使用时间和脚本名称，不显示 revision ID；
- “粘贴已有代码”进入已聚焦编辑器，并等待用户主动粘贴，不读取系统剪贴板；
- 有可恢复草稿时，“打开最近脚本”默认指向该草稿；
- 用户可返回开始入口，但不会丢失自动保存的草稿。

V1 每个图表单元格只允许附着一个策略脚本。不要在第一版实现多策略共用账户或叠加结果。

### 3.1.2 快测状态

顶部“策略”入口显示当前脚本名称及状态：编辑中、运行中、已完成、结果已过期或出错。

普通模式自动从当前图表取得 exchange、market type、symbol 和 interval。用户不填写 dataset ID、data epoch、snapshot hash、provider kind 或账户模型。

普通模式唯一主操作叫“运行”：

- 草稿持续自动保存；
- 用户点击“运行”时，系统先执行编译和能力检查；
- 检查通过后，后台生成或复用不可变 StrategyRevision；
- 随后冻结图表上下文并创建 BacktestRun；
- 这些内部步骤只表现为一个运行进度，不显示“保存 revision”或“创建 Run”；
- 相同脚本内容、参数和上下文的重复点击必须幂等复用，不产生版本/Run 风暴。

### 3.1.3 图上结果

买入、卖出、平仓和拒单标记通过现有外部标记源合并到当前 K 线图。结果必须满足完整身份匹配后才可投影。

禁止仅按 `symbol + interval` 判断匹配。至少校验：

- workspace/cell；
- exchange；
- market type；
- symbol；
- interval；
- strategy revision；
- parameter hash；
- dataset ID；
- data epoch；
- snapshot hash；
- start/end time；
- execution profile revision。

任意一项变化，旧标记立即隐藏，底部结果进入“结果已过期”。

### 3.1.4 固定回测对象条

概览与交易结果上方始终显示一行不可滚出视野的 `ResultContextBar`。默认格式：

`BTCUSDT · 15m · 全部本地可用数据 · 快速估算 · 已包含费用`

显示规则：

- symbol、interval、范围、精度和费用状态必须来自已完成 Run，而不是当前表单草稿；
- `ALL_AVAILABLE` 只能显示“全部本地可用数据”，并可展开查看绝对 start/end；禁止使用可能被理解为交易所全量覆盖的“全部历史”；
- 可增加简短脚本名称，但不显示 revision/hash；
- 点击可展开可信度详情，查看数据版本、snapshot、费用来源和脚本版本；
- 当前图表上下文改变后，该行立即改成“结果已过期：当前图表为 ETHUSDT · 1h”；
- stale 状态不继续显示旧交易标记，但保留汇总结果供用户查看；
- “重新运行”仍使用统一的“运行”按钮，不增加第二个主操作名称。

### 3.1.5 三个核心界面状态

普通模式第一轮只设计和验收三个核心状态：

| 状态 | 必须出现 | 不应出现 |
| --- | --- | --- |
| 首次打开 | 三种开始方式、简短说明、高级研究入口 | 空白编辑器、数据集字段、复杂设置 |
| 运行完成 | ResultContextBar、核心指标、前后差值、图上交易、原因入口 | revision ID、Run ID、默认展开的可信度字段 |
| 脚本出错 | 代码行诊断、问题说明、修复后的“运行” | 只有错误码的 toast、清空草稿 |

“结果已过期”作为运行完成状态的变体，不新建第四套完整界面。

## 3.2 高级模式：独立全屏策略研究

高级模式不是给当前密集表单换个标题，而是像 K 线回放一样拥有独立页面、独立路由和独立 runtime 的完整研究应用。现有 `/backtest.html` 在迁移期作为该应用入口，旧工作台通过兼容路由保留到功能迁移完成。

高级页首次进入不展示所有字段，而是先选择研究任务：

| 任务入口 | 默认展开的能力 |
| --- | --- |
| 精确成交验证 | 数据精度、成交模型、费用、滑点、延迟、订单事件与可信度 |
| 参数稳健性研究 | 参数空间、fold、样本外、holdout、目标与约束 |
| Python/模型测试 | Bundle、运行环境、信任确认、模型输入输出与 runtime receipt |
| 多市场比较 | 数据篮子、symbol 独立性、比较口径和禁止组合规则 |
| 交易回放复盘 | Run/交易区间、review bridge、盲态与 reveal |

任务入口只决定默认展开哪些共享面板，不创建五套 runtime 或重复业务逻辑。用户可以返回任务首页或切换任务，已选择的脚本和上下文不丢失。

进入任务后，页面以行情图表为中心：

- 顶部复用品种、市场、周期、时间和图表控制；
- 中间复用实时行情图表、指标、绘图和结果标记能力；
- 左/右侧面板承载策略版本、数据、执行模型、账户和风险；
- 底部承载 Run、交易、报告、日志、比较和 Study；
- 实时观察、冻结快照和 Run 结果有清晰的模式标识。

高级页面可以接入：

- 明确选择数据集和数据版本；
- BAR、逐笔成交和更高精度输入；
- StrategyRevision、Pyne/Pine、Python Bundle、ONNX/外部模型；
- 账户、资金费率、延迟、参与率、订单模型和风控；
- Run 历史、比较、克隆和导出；
- Study、样本外、holdout 和选择警告；
- 可信度报告和 K 线回放桥。

从普通模式打开高级研究时必须传递一个不可变 `BacktestResearchLaunchContext`：

- 当前 run ID 与上一个可比较 run ID，若存在；
- 同一份 strategy draft ID 与 revision ID，不复制源码；
- 当前脚本参数和 quick preset ID；
- chart session identity：exchange、market type、symbol、interval；
- 日期范围与绝对 start/end；
- dataset/snapshot identity，若已经解析；
- 来源 workspace/cell；
- 返回图表的 deep-link 信息。

URL 只传 context/run ID，页面必须从权威存储重新读取对象，不把整份可变配置塞进 query string。

高级页加载完成后，脚本、参数、品种、周期、日期和最近 Run 必须与普通模式一致。高级页增加控制能力，但不得要求用户重新选择或手工复制这些对象。

## 3.3 一个共享图表平台，两套独立 runtime

普通行情页和高级研究页复用能力，不复用可变页面状态。

| 必须复用 | 必须隔离 |
| --- | --- |
| `MarketPageFrame` / `MarketWorkspaceFrame` 的 source-neutral 布局 | 页面级 React store 与 controller |
| 图表 renderer、pane、价格轴和时间轴 | WebSocket 订阅生命周期 |
| chart-session 类型与品种/周期组件 | 快测 cell runtime 与高级研究 runtime |
| Host 行情服务与规范存储接口 | 回测账户、订单、Run/Study 状态 |
| 指标、绘图、外部 marker/layer adapter | 数据快照、结果缓存和任务队列 |
| 主题、i18n、错误边界和可访问性组件 | 页面恢复、URL 和窗口生命周期 |

高级页可以显示实时行情作为研究参考，但回测执行只能读取已冻结快照。实时流不能直接成为一个正在运行的 BacktestRun 的可变输入。

## 3.4 K 线回放的边界

`TrainingRun`、`BacktestRun` 和 `BacktestStudy` 继续分离：

- 回放回答“在不知道未来的情况下训练和复盘”；
- 单次回测回答“固定策略在固定数据与模型下表现怎样”；
- Study 回答“参数和样本外结论是否稳健”。

普通模式和高级研究都只通过“复盘这段交易”的只读桥进入回放，不把回放控制器或账户 store 嵌进回测 runtime。

---

## 4. 普通用户可见的产品合同

## 4.1 默认设置

普通模式必须提供可解释的默认值，并在设置摘要中始终可见：

| 项目 | 普通模式默认 | 约束 |
| --- | --- | --- |
| 计算精度 | 快速估算 | 对应 `BAR_APPROX`，必须显示“基于 K 线估算” |
| 日期范围 | 全部可用本地数据 | 平移或缩放图表不会触发重跑 |
| 初始资金 | 10,000，币种随账户预设 | 用户可改 |
| 仓位 | 每次使用权益的 10% | 映射为明确的 sizing policy，不使用固定 1 手的隐式默认 |
| 杠杆 | 1x | 用户切换高杠杆时显示风险提示 |
| 费用 | 交易所/市场版本化预设 | 不允许静默为 0；无可靠预设时要求一次确认 |
| 滑点 | 市场预设或保守默认 | 来源和数值在“可信度”可见 |
| 自动运行 | 快速估算开启 | 成交序列精算默认关闭 |

后端现有 `taker_fee_bps=0`、`maker_fee_bps=0` 只能作为底层兼容默认，图表脚本快测不得直接依赖它们。

## 4.2 日期范围

普通模式只提供三种日期范围：

1. 全部可用数据；
2. 当前可见范围；
3. 自定义日期。

“当前可见范围”在用户点击运行时冻结为绝对时间，之后缩放图表不会改变已经运行的结果。

## 4.3 自动运行规则

为接近 TradingView 的体验，附着策略后默认自动响应品种和周期变化，但必须控制资源与状态竞争：

1. 监听 chart-session 的稳定切换事件；
2. 立即隐藏旧标记并标记 stale；
3. 等待 600 ms 防抖；
4. 取消尚未提交的旧解析请求；
5. 若是快速估算且数据已就绪，自动创建新 Run；
6. 若需要下载数据，停在“需要准备数据”，不偷偷联网；
7. 若是成交序列精算，停在“需要重新运行”，由用户确认；
8. 已提交的不可变 Run 不删除；后到的旧结果不得覆盖新上下文。

切换活动图表单元格只切换面板视图，不自动重跑。只有该单元格的 chart-session 发生变化才触发自己的状态机。

## 4.4 用户术语映射

| 内部术语 | 普通模式文案 |
| --- | --- |
| BacktestRun / Run | 运行结果；不显示对象名和 ID |
| StrategyRevision | 主路径不显示；高级详情中为“脚本版本” |
| dataset_id | 主路径不显示；上下文条只显示 symbol/范围 |
| data_epoch | 主路径不显示；可信度详情中为“数据版本” |
| snapshot_hash | 主路径不显示；可信度详情中为“数据指纹” |
| fidelity_mode | 计算精度 |
| BAR_APPROX | 快速估算 |
| TRADE_TAPE | 逐笔成交精算；输入是 raw trade |
| AGG_TRADE_TAPE / AGG_TRADE | 聚合成交序列精算；输入是 aggTrade，不得称为逐笔成交 |
| sizing_policy | 仓位方式 |
| execution_model_revision | 成交模型版本 |
| BacktestStudy | 批量研究 |
| holdout | 保留验证区间 |
| review bridge | 打开 K 线回放复盘 |

普通设置可以用“成交序列精算”概括 `PRECISE` 偏好，但 ResultContextBar、报告、导出和可信度详情必须显示 Run 实际使用的“逐笔成交精算”或“聚合成交序列精算”。两者不得只显示同一个“逐笔精算”标签。

错误提示优先回答“发生了什么、为什么、下一步能做什么”，错误码放入可展开详情。

## 4.5 可行动错误合同

普通模式不得以错误码、对象 ID 或通用 toast 作为主要反馈。错误必须落在用户正在处理的代码或下一步动作上：

| 错误类型 | 主反馈位置 | 必须提供的动作 |
| --- | --- | --- |
| 语法/编译错误 | Monaco 行内诊断、问题面板、自动滚动到首个错误 | 修复后点击“运行” |
| 策略能力不支持 | 对应代码行或脚本顶部诊断 | 打开支持说明或使用可运行模板 |
| 数据不足 | ResultContextBar 下方 | “准备数据并运行” |
| 周期不支持 | interval 旁及结果区 | 直接列出可用周期并允许一键切换 |
| 成交序列数据缺失 | 精度摘要旁 | “改用快速估算”或按目标精度显示“准备逐笔成交数据 / 准备聚合成交数据” |
| 费用预设未知 | 设置摘要 | 选择/确认费用后“运行” |
| 后端暂不可用 | 原操作区域 | “重试运行”并保留草稿和设置 |

内部错误码、trace ID 和技术详情只能出现在“复制诊断详情”中。错误恢复不得清空草稿、切换图表或丢失最近成功结果。

---

## 5. 脚本体验

脚本不是第二阶段附加能力，而是普通模式的核心入口。首个可交付版本就必须支持“三种开始方式 -> 编辑 -> 运行”，不能把空白编辑器、保存动作或内部版本管理暴露给普通用户。

## 5.1 策略与指标必须分型

现有指标脚本运行协议与回测策略 provider 不是同一合同。V1 必须要求脚本声明类型：

- `indicator`：只计算并绘图；
- `strategy`：产生目标仓位、订单意图或受支持的策略输出。

指标脚本不能因为包含买卖文字就自动进入回测。若用户从指标编辑器点击“转换为策略”，系统只能生成一个明确的策略模板，并要求用户补齐下单逻辑后重新编译。

## 5.2 快速脚本流程

普通用户从现有行情页顶部“策略”进入底部脚本工作区：

1. 恢复最近脚本，或选择 Pyne/Pine 兼容策略模板；
2. 编写或粘贴代码；
3. 编辑器后台做轻量语法诊断；
4. 草稿在后台自动保存；
5. 用户点击唯一主操作“运行”；
6. 系统完成编译、能力和数据依赖诊断；
7. 检查通过后生成或复用不可变 StrategyRevision；
8. 自动解析当前图表上下文；
9. 使用当前 symbol/interval 运行并在原图显示结果。

策略编辑器复用现有 Monaco 语言支持，但不复用指标运行时冒充策略运行时。

内置策略应以只读模板进入同一个脚本工作区，用户复制后即可修改。普通模式不需要在“内置策略”和“用户脚本”之间建立两套运行流程。

Python 策略、压缩包、受信执行确认、ONNX 和外部模型只出现在高级研究页，避免普通模式出现安全和环境配置负担。

## 5.3 编辑后的运行行为

- 每次编辑自动保存草稿，但不自动创建 revision；
- 点击“运行”且检查通过后才生成或复用 revision；
- 代码变化后旧结果显示“结果已过期”，并隐藏标记；
- 编译失败保留草稿和上一版有效汇总，但上一版结果不得伪装成当前草稿结果；
- 普通模式不显示 revision 历史、hash 或“保存版本”动作；
- 高级研究显示完整版本历史和 Run 关联。

## 5.4 草稿与不可变版本

脚本草稿与 StrategyRevision 分离：

- 草稿允许自动保存、恢复光标和未通过检查的内容；
- revision 只能由一次通过检查的“运行”产生或复用；
- Run 只能引用 revision，不能引用会继续变化的草稿；
- workspace cell 只保存 draft/revision ID，不把源码复制进 workspace JSON；
- 高级研究页通过 draft/revision ID 读取同一个脚本对象，不复制第二份源码。

---

## 6. 数据准备与可信度合同

## 6.1 为什么需要图表上下文解析层

当前回测 API 要求调用者已知 `dataset_id + data_epoch + snapshot_hash`，而普通用户只知道当前图表的 exchange、market type、symbol、interval 和日期范围。

因此新增一个薄的 Host facade，将图表上下文解析为可复现回测上下文。它不能绕过现有 snapshot 校验，也不能把前端缓存随意当作可信数据集。

## 6.2 两阶段 API

### A. 只读解析

`POST /api/v1/backtests/chart-context/resolve`

请求：

```json
{
  "exchange": "binance",
  "market_type": "usdm",
  "symbol": "BTCUSDT",
  "interval": "1h",
  "range_mode": "ALL_AVAILABLE",
  "start_time_ms": null,
  "end_time_ms": null,
  "fidelity_preference": "FAST"
}
```

响应只能是以下状态之一：

| 状态 | 含义 | UI 行为 |
| --- | --- | --- |
| `READY` | 已有完整不可变数据可复用 | 可立即运行 |
| `NEEDS_DATA` | 本地覆盖不足 | 显示缺口、预计下载量和“准备数据并运行” |
| `UNSUPPORTED_INTERVAL` | 无法从本地数据精确构造该周期 | 解释支持周期，不近似替代 |
| `UNSUPPORTED_FIDELITY` | 当前数据不支持该精度 | 建议切换快速估算，或明确导入逐笔成交/聚合成交数据 |
| `AMBIGUOUS_MARKET` | 合约/现货身份不明确 | 要求用户选择，不猜测 |
| `UNAVAILABLE` | 数据服务不可用 | 显示重试与高级研究入口 |

`READY` 响应返回：

- resolution token；
- chart context hash；
- dataset ID；
- data epoch；
- snapshot hash；
- coverage；
- fidelity capabilities；
- quality warnings；
- cost preset；
- account/execution preset；
- token expiry。

### B. 用户授权的数据准备

`POST /api/v1/backtests/chart-context/materialize`

仅在用户点击“准备数据并运行”后调用。请求包含 resolution token、用户确认和 idempotency key。后端通过 Host 的规范市场数据与存储路径下载、补齐、冻结并校验数据，完成后返回新的 `READY` 上下文。

规则：

- `resolve` 绝不联网；
- `materialize` 只能由明确用户操作触发；
- 不支持的自定义周期只能从同一 dataset/data epoch 做精确整数倍聚合；
- 不能精确聚合时 fail closed；
- 前端传入的 visible candles 不能直接成为可信 snapshot；
- 下载、冻结和校验失败不得创建 Run。

## 6.3 快速预设

扩展 `/capabilities`，返回版本化 quick presets，而不是由前端拼几十个底层字段：

```json
{
  "id": "CRYPTO_PERP_STANDARD_V1",
  "label": "标准永续合约",
  "account_model": "LINEAR_PERP_ONE_WAY_V1",
  "sizing_policy": "EQUITY_PERCENT_V1",
  "equity_percent": "10",
  "leverage": "1",
  "fee_source": "exchange-market-preset",
  "execution_model_revision": "..."
}
```

提交现有 `/runs/validate` 和 `/runs` 时，仍展开为完整显式参数，以保持 Run 可复现。Run 报告同时记录 quick preset ID/revision。

## 6.4 “为什么发生这笔交易”证据合同

交易解释是普通模式 P0，不是后期锦上添花。点击图上的买入、卖出、平仓或拒单标记时，系统必须展示决定发生当时的结构化证据，不能使用大模型或事后规则生成看似合理的解释。

新增 `TradeExplanationV1`。为保证 Host、前端、后续 Rust provider 和导出文件能够复算同一个证据哈希，数值变量不直接使用语言相关的浮点 JSON 表示，而使用规范十进制字符串：

```ts
type TradeExplanationScalarV1 =
  | { kind: "string"; value: string }
  | { kind: "decimal"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null"; value: null };

interface TradeExplanationV1 {
  schema: "TRADE_EXPLANATION_V1";
  canonicalization: "JCS_SHA256_V1";
  runId: string;
  tradeId: string | null;
  orderId: string | null;
  fillId: string | null;
  decisionId: string;
  decisionTraceOrdinal: number | null;
  decisionTimeMs: number;
  action: "ENTER" | "EXIT" | "REVERSE" | "REJECT";
  reasonCode: string | null;
  reasonLabel: string | null;
  source: {
    strategyRevisionId: string;
    line: number | null;
    column: number | null;
    conditionId: string | null;
  };
  conditions: Array<{
    id: string;
    label: string;
    result: boolean | null;
  }>;
  variables: Record<string, TradeExplanationScalarV1>;
  execution: {
    state: "ACCEPTED" | "FILLED" | "REJECTED" | "CANCELLED";
    reasonCode: string | null;
  };
  completeness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  omissions: {
    conditionsDropped: number;
    variablesDropped: number;
    valuesTruncated: number;
  };
  evidenceHash: string;
}
```

生成规则：

- strategy provider 在决策时输出有预算上限的结构化 explain payload；
- Pyne/Pine compiler 尽可能附带 source span、condition ID 和用户可读条件标签；
- Host 为每个 decision 分配稳定 ID，并把 order/fill/trade/rejection 关联回 decision；
- variables 只保存策略声明允许解释的标量，禁止转储完整 ObservationFrame、账户或未来数据；
- Host 对 explain payload 做大小、字段、类型和敏感信息校验；
- signal trace 保持分页、哈希和上限；超过预算时明确标记 PARTIAL；
- provider 不支持结构化解释时显示“该策略没有提供可验证的交易原因”，不能猜测；
- 平仓、反向和拒单分别说明“策略原因”和“Host 执行/风控原因”。

`JCS_SHA256_V1` 冻结以下跨语言规则：

- 哈希输入为除 `evidenceHash` 外的完整对象，包含 `schema`、`canonicalization`、`completeness` 和 `omissions`；
- 使用 UTF-8、对象 key 字典序、数组原顺序、无无意义空白的 canonical JSON；最终值为小写十六进制 `sha256`；
- 时间和 ordinal 必须是 JavaScript safe integer；策略数值使用 `kind=decimal` 的十进制字符串，展开科学计数法、移除无意义前导/尾随零并把 `-0` 规范为 `0`；拒绝 NaN、Infinity 和超范围整数；
- conditions 保持编译器产生的稳定源码顺序；variables 按 key 排序后进入预算，不能依赖 map/dict 插入顺序；
- V1 默认预算为 canonical payload 64 KiB、最多 64 个 conditions、128 个 variables、key 最多 128 UTF-8 bytes、单个字符串值最多 2 KiB；
- 超预算时按上述稳定顺序截断，在 `omissions` 记录丢弃/截断数量并标记 `PARTIAL`；字段非法、哈希不匹配或无法规范化时标记 `UNAVAILABLE`，不得把未验证内容显示成可信解释；
- API contract fixture 必须由当前 Python Host 与 TypeScript client 复算相同哈希；任何新增 provider 实现（包括 Rust）在暴露解释能力前也必须通过同一 fixture。分页、导出和重新加载后的哈希必须不变。

前端点击标记后显示：哪个条件触发、主要变量值、为什么入场/平仓/拒单，以及普通文案“运行时使用的脚本版本”。revision ID、trace ordinal 和 evidence hash 只在展开详情中出现。

## 6.5 自动比较修改前后的结果

每次运行完成后，系统自动寻找“最近一次可直接比较 Run”，普通用户不手选 Run ID。

定义 `comparison_context_hash`，包含以下必须相同的字段：

- exchange、market type、symbol、interval；
- dataset ID、data epoch、snapshot hash；
- start/end time 与 range mode；
- fidelity mode；
- account model、initial balance、sizing policy 和 leverage；
- fee、funding、slippage、latency 与 execution model revision；
- metrics version；
- strategy provider protocol、compiler revision、language runtime/ABI revision 和 Host strategy adapter revision；
- 确定性随机种子、RNG policy revision，以及会改变 bar/成交事件顺序的 builder revision。

strategy source/revision 与 strategy parameters 不进入该 hash，因为它们正是要比较的变化；但 revision 中属于执行环境而非用户策略内容的 compiler/runtime/provider 版本必须拆出并进入 hash。系统选择同一 comparison context 下、当前 Run 之前最近完成的 Run 作为 baseline。任一非策略执行身份缺失或不同，都必须返回 incompatible，不能把运行环境变化归因于脚本修改。

扩展现有 Run compare 为 `RUN_COMPARE_V3`：

- 净收益：before、after、delta；
- 最大回撤：before、after、delta；
- 交易次数：before、after、delta；
- 参数差异；
- 决策/成交 hash 差异；
- 新增、消失和保持一致的交易数量；
- fingerprint version、alignment status 与各 fingerprint occurrence count；
- cost difference 与不可直接比较原因。

交易级变化只允许使用 Host 生成的稳定 `TRADE_FINGERPRINT_V2` 做精确多重集差：

```text
sha256(jcs({
  fingerprint_version: "TRADE_FINGERPRINT_V2",
  symbol,
  side,
  entry_decision_time,
  entry_decision_ordinal_at_time,
  entry_action,
  entry_action_ordinal,
  exit_decision_time,
  exit_decision_ordinal_at_time,
  exit_action,
  exit_action_ordinal
}))
```

fingerprint 使用与 `JCS_SHA256_V1` 相同的 typed canonical JSON 规则，禁止用无分隔符的字符串拼接。ordinal 必须来自 decision trace 中同一时间点的确定性顺序和同一 decision 内的 action 顺序，不能使用数据库返回顺序、前端数组下标或 run-specific trade ID。比较使用 `fingerprint -> occurrence count` 多重集，不把重复 fingerprint 压成一个 set；同一根 K 线或同一毫秒的多次加减仓必须保留正确数量。trade ID 只用于把本 Run 的结果定位回交易详情，不进入跨 Run fingerprint。

不做模糊时间匹配。fingerprint 字段缺失、ordinal 不稳定或旧 Run 未生成 V2 时，普通模式只显示汇总指标差值，并明确写“交易无法逐笔对齐”。若 `directComparisonAllowed=false`，不得展示有方向性的改善/恶化结论，只显示不可比较字段和“在相同条件下重新运行”。

普通概览只显示四项紧凑差值和“新增/消失交易”入口；完整曲线、参数、成本与交易集合差留在高级研究。

---

## 7. 前端平台、状态与所有权

## 7.1 持久状态

`ChartWorkspaceCellState` 增加可选的策略附着记录，并将 workspace schema 从 7 升级到 8：

```ts
interface ChartStrategyAttachmentRecord {
  schemaVersion: 1;
  strategyDraftId: string | null;
  strategyRevisionId: string | null;
  displayName: string;
  language: "pyne" | "pine";
  parameters: Record<string, unknown>;
  rangeMode: "ALL_AVAILABLE" | "VISIBLE" | "CUSTOM";
  customRange: { startMs: number; endMs: number } | null;
  fidelityPreference: "FAST" | "PRECISE";
  quickPresetId: string;
  autoRun: boolean;
}
```

只持久化用户选择和脚本对象 ID，不把报告、权益曲线、交易列表或源码副本写入 workspace 文档。草稿源码进入独立、版本化的 strategy draft store。

Schema 7 -> 8 迁移要求：

- 每个旧 cell 的 attachment 默认为 `null`；
- round-trip 不改变旧 session、drawing、indicator 和布局；
- copy/split 默认复制 attachment 配置，但不复制运行中状态；
- blank cell 不复制 attachment；
- close cell 时释放 runtime 和轮询；
- link group V1 不同步策略，避免批量误运行。

## 7.2 运行时状态

新增按需创建的 `ChartStrategyTesterRuntime`。只有已经附着策略，或用户正在该 cell 打开首次开始/脚本工作区时才创建实例；普通的未附着 `LiveChartCell` 不创建 runtime、store、timer、AbortController、轮询或编辑器 chunk：

```ts
type ChartStrategyTesterStatus =
  | "DETACHED"
  | "RESOLVING"
  | "NEEDS_DATA"
  | "READY"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "STALE"
  | "FAILED"
  | "UNSUPPORTED";

interface ResultProjectionIdentity {
  cellScope: string;
  chartContextHash: string;
  strategyRevisionId: string;
  parameterHash: string;
  datasetId: string;
  dataEpoch: string;
  snapshotHash: string;
  startTimeMs: number;
  endTimeMs: number;
  executionProfileRevision: string;
  runId: string;
}

interface ChartStrategyTesterView {
  status: ChartStrategyTesterStatus;
  draftAutoSaveState: "IDLE" | "SAVING" | "SAVED" | "ERROR";
  activeRunId: string | null;
  baselineRunId: string | null;
  resultContext: ResultContextBarView | null;
  comparison: RunCompareV3 | null;
  selectedExplanation: TradeExplanationV1 | null;
  actionableError: ActionableBacktestError | null;
}
```

运行时负责：草稿自动保存、运行时 revision 生成/复用、上下文解析、数据准备授权、validate/create、轮询、取消前端等待、加载报告/图表、ResultContextBar、可比 baseline、交易解释、stale 判定和清理。

生命周期要求：

- runtime 由 `ChartStrategyTesterRuntimeFactory` 按 cell ID 懒创建；重复 render 或 active cell 切换不得重复创建；
- 已附着但不活动的 cell 只保留轻量状态机；没有运行中/排队 Run 时不轮询，Monaco、交易列表和结果面板保持未加载；
- 用户 detach、关闭 cell、删除 workspace、关闭 flag 或页面卸载时，必须释放 timer、AbortController、队列项、observer、结果引用和 marker source；后端不可变 Run 本身不删除；
- split/copy 只复制持久 attachment，目标 cell 首次真正激活策略能力时再创建 runtime；复制操作本身不得产生并发 Run 风暴；
- 打开 16/64 个未附着策略的 cell 时，tester runtime 实例数必须为 0；附着 N 个策略时实例数最多为 N，自动 Run 仍受 workspace 并发上限约束。

后端 Run 生命周期仍由现有 BacktestService 拥有。前端不能伪造完成状态，也不能因为 cell 卸载而删除后端 Run。

## 7.3 App shell 插槽

现有 `MarketPageFrame.featureSurfaces` 是抽屉/弹层入口，但底部测试器会改变图表可用高度，应新增明确的 source-neutral slot：

```ts
interface MarketWorkspaceFrameProps {
  toolbar: ReactNode;
  exportOverlay: ReactNode;
  chart: ReactNode;
  bottomPanel: ReactNode;
  rightRail: ReactNode;
}
```

底部面板由 App shell 布局拥有，业务状态仍由活动 `LiveChartCell` 的 runtime 提供。不要用 fixed overlay 挡住 K 线时间轴。

## 7.4 标记投影

`ChartCellCanvas` 当前合并 trade-flow 与 plugin marker source。改为显式组合：

```ts
combineExternalMarkerSources([
  tradeFlow.view.markerSource,
  backtestMarkerSource,
  pluginMarkerSource,
])
```

要求：

- backtest marker source 是纯投影；
- 不在 canvas 组件内请求 API；
- 只返回当前可见范围和 overscan 所需标记；
- 完整交易列表保留在结果存储中，不因渲染预算截断；
- 点击交易行通过 chart adapter 定位，不直接操作 lightweight-charts 私有对象。

## 7.5 共享图表平台合同

高级研究页不能复制一份 `LiveChartCell.tsx` 后独立演化，也不能直接把普通行情页整个 React tree 嵌入 iframe。应先抽出 source-neutral 的共享合同：

```ts
type MarketChartSourceMode =
  | "LIVE_REFERENCE"
  | "FROZEN_SNAPSHOT"
  | "RUN_RESULT";

interface MarketChartSourceRuntime {
  mode: MarketChartSourceMode;
  session: ChartSession;
  sessionIdentity: string;
  seriesStore: unknown;
  markerSource: ExternalMarkerSource | null;
  layerSource: PluginChartLayerSource | null;
  status: "LOADING" | "READY" | "STALE" | "ERROR";
}
```

普通行情页继续由 `LiveChartCell` 组合该合同。高级研究页新增 `ResearchMarketChart`，使用相同 chart-session、Host 行情客户端、series store、renderer 和 adapter，但自己创建和销毁 runtime。

`LIVE_REFERENCE` 只用于查看当前市场和选择研究范围；用户创建 Run 时必须解析并切换到 `FROZEN_SNAPSHOT`。`RUN_RESULT` 只投影与当前 Run identity 匹配的行情、标记和图层。

## 7.6 高级研究 runtime

新增 `BacktestResearchRuntime`，生命周期跟随高级页面，而不是跟随普通行情 workspace cell：

```ts
interface BacktestResearchLaunchContext {
  schemaVersion: 1;
  contextId: string;
  sourceWorkspaceId: string;
  sourceCellId: string;
  strategyDraftId: string;
  strategyRevisionId: string | null;
  parameters: Record<string, unknown>;
  quickPresetId: string;
  chartSession: ChartSession;
  range: {
    mode: "ALL_AVAILABLE" | "VISIBLE" | "CUSTOM";
    startTimeMs: number | null;
    endTimeMs: number | null;
  };
  latestRunId: string | null;
  baselineRunId: string | null;
  createdAtMs: number;
}

interface BacktestResearchRuntime {
  chart: MarketChartSourceRuntime;
  launchContext: BacktestResearchLaunchContext | null;
  activeStrategyRevisionId: string | null;
  selectedDatasetIdentity: Record<string, string> | null;
  activeRunId: string | null;
  activeStudyId: string | null;
  liveReferenceEnabled: boolean;
}
```

约束：

- 进入高级页可以创建自己的实时订阅；离开时必须完整释放；
- 不借用普通行情页的 WebSocket 对象或 refs；
- 普通页与高级页同时打开时由 Host lease/连接协调层去重底层资源；
- 高级页实时图表故障不改变已冻结 Run；
- Run/Study 状态不写入普通行情 workspace store；
- 返回普通页只通过 ID 恢复，不传递可变 controller。
- launch context 只引用共享 draft/revision/run 对象；高级页不得复制脚本源码后独立保存。

---

## 8. 建议目录与代码边界

新增能力分为共享图表平台、普通脚本快测和高级研究应用三部分。第一阶段不搬动全部旧文件，先建立新边界并用 adapter 迁移。

```text
frontend/src/features/market-chart-platform/
  marketChartSourceTypes.ts
  MarketChartSurface.tsx
  createLiveReferenceSource.ts
  createFrozenSnapshotSource.ts
  createRunResultSource.ts
  __tests__/

frontend/src/features/backtest/
  chart-tester/
    chartStrategyTesterTypes.ts
    chartStrategyTesterState.ts
    chartStrategyContext.ts
    chartStrategyRunRequest.ts
    chartStrategyResultProjection.ts
    useChartStrategyTesterRuntime.ts
    StrategyScriptWorkspace.tsx
    StrategyTemplatePicker.tsx
    StrategyDraftStore.ts
    StrategyEditorPanel.tsx
    StrategyStartState.tsx
    StrategyQuickSettings.tsx
    StrategyTesterBottomPanel.tsx
    ResultContextBar.tsx
    ActionableBacktestError.tsx
    StrategyTesterOverview.tsx
    StrategyTesterTrades.tsx
    TradeExplanationPopover.tsx
    RunDeltaSummary.tsx
    StrategyTrustDetails.tsx
    __tests__/

  research/
    BacktestResearchApp.tsx
    backtestResearchTypes.ts
    useBacktestResearchRuntime.ts
    ResearchMarketChart.tsx
    ResearchTaskPicker.tsx
    ResearchStrategyPanel.tsx
    ResearchDataPanel.tsx
    ResearchExecutionPanel.tsx
    ResearchRunPanel.tsx
    ResearchStudyPanel.tsx
    ResearchResultsPanel.tsx
    __tests__/
```

现有文件的职责：

| 文件 | 处理方式 |
| --- | --- |
| `backtestApi.ts` | 增加 chart-context API 与 typed quick presets |
| `backtestTypes.ts` | 保留 Run/Report wire 类型；不要加入 cell UI 状态 |
| `BacktestResultChart.tsx` | 提取纯 marker/equity 投影后继续复用 |
| `BacktestApp.tsx` | 作为旧工作台兼容 adapter；功能逐块迁移到 `research/`，不再增加新 controller |
| `LiveChartCell.tsx` | 创建每 cell runtime，连接入口、脚本面板、结果 view model 和 marker source |
| `ChartCellCanvas.tsx` | 继续作为共享 canvas adapter，接受 source-neutral marker/layer source |
| `MarketWorkspaceFrame.tsx` | 增加 bottomPanel 布局槽 |
| `chartWorkspaceTypes.ts` | schema 8 与 attachment 持久合同 |
| `chartWorkspaceStorage.ts` | schema 7 -> 8 迁移 |
| `TopBar.tsx` | 普通主入口为“策略”，高级研究作为次级入口 |
| `backtest-main.tsx` | 启动新的 `BacktestResearchApp`；旧 App 受兼容 flag 控制 |
| `MarketPageFrame.tsx` | 普通页与高级页共享外壳，不承载回测状态 |

共享平台依赖规则：

- `market-chart-platform` 不得依赖 `chart-tester` 或 `research`；
- `chart-tester` 与 `research` 可以依赖共享平台和 backtest API；
- 两者不得互相 import React controller/store；
- deep link 只传 typed ID/context；
- 实时行情客户端只在共享平台/既有 Host 服务中实现一次。

后端建议：

```text
backend/app/backtest/chart_context.py
backend/app/backtest/quick_presets.py
backend/app/backtest/trade_explanation.py
backend/app/backtest/run_comparison.py
backend/app/api/v1/backtests.py
backend/tests/test_backtest_chart_context.py
backend/tests/test_backtest_quick_presets.py
backend/tests/test_backtest_trade_explanation.py
backend/tests/test_backtest_run_comparison_v3.py
```

`chart_context.py` 只能调用 Host 的规范数据目录/存储服务和现有 BacktestRuntime，不自建第二套下载器、缓存或重采样器。

---

## 9. 分阶段执行计划

每一阶段单独提交。每个提交必须在功能旗标关闭时保持现有图表和 legacy workbench 行为不变。

## Phase 0：冻结合同与基线

实施状态（2026-08-24）：`COMPLETE_VISUAL_APPROVED`。

- ADR：[ADR-BACKTEST-013](adr/ADR-BACKTEST-013-CHART-FIRST-STRATEGY-TESTER.md)
- 执行计划：[BACKTEST_CHART_FIRST_PHASE0_PLAN_20260824_zh.md](evidence/BACKTEST_CHART_FIRST_PHASE0_PLAN_20260824_zh.md)
- 结果与人工门禁：[BACKTEST_CHART_FIRST_PHASE0_RESULT_20260824_zh.md](evidence/BACKTEST_CHART_FIRST_PHASE0_RESULT_20260824_zh.md)
- 需求—测试追踪：[BACKTEST_CHART_FIRST_PHASE0_TRACEABILITY_20260824_zh.md](evidence/BACKTEST_CHART_FIRST_PHASE0_TRACEABILITY_20260824_zh.md)

人工视觉/产品评审已于 2026-08-24 获用户明确批准；本阶段退出条件成立。

### 目标

在写 UI 前冻结术语、状态、数据行为、默认值和回滚边界。

### 步骤

1. 评审并批准本文档；
2. 新增 `ADR-BACKTEST-013-CHART-FIRST-STRATEGY-TESTER.md`；
3. ADR 明确普通模式不改变 `BacktestRun/Study/TrainingRun`；
4. ADR 明确“共享图表能力、隔离页面 runtime”的依赖规则；
5. ADR 明确普通模式只暴露脚本、当前回测对象、“运行”和结果；
6. 冻结 `TradeExplanationV1`、`JCS_SHA256_V1`、解释预算、`comparison_context_hash`、`TRADE_FINGERPRINT_V2` 多重集语义与 `RUN_COMPARE_V3`；
7. 产出首次打开、运行完成、脚本出错三个状态及 stale 变体的视觉稿；
8. 完成普通用户走查并记录修改结论；
9. 记录当前 `/backtest.html`、K 线回放和主图的浏览器基线截图；
10. 记录前端 bundle、单图启动、四图启动、WebSocket lease 和现有 backtest smoke 基线；
11. 建立需求到测试 ID 的 traceability 表。

### 验证

- `npm run check:architecture`
- `npm run check:i18n`
- `npm run typecheck`
- `npm run test:backtest`
- 后端现有 backtest 单测

### 退出标准

- 产品、前端、后端和测试对“快速估算”“精算”“自动运行”“无数据”行为无歧义；
- 产品与前端对普通脚本快测、高级独立页面和共享图表平台边界无歧义；
- 不存在要求普通模式直接填写 dataset ID 的设计；
- 不存在要求普通用户保存 revision、选择 Run ID 或理解 snapshot 的设计；
- 交易解释不依赖事后生成，自动比较不允许跨不兼容上下文；
- 三个核心状态和 stale 变体已通过产品评审；
- 基线证据可重跑。

### 建议提交

`docs(backtest): freeze chart-first strategy tester contract`

### 回滚

纯文档提交可直接 revert，不影响运行时。

## Phase 1：提取可复用回测客户端与结果投影

实施状态（2026-08-24）：`COMPLETE`。

- 执行计划：[BACKTEST_CHART_FIRST_PHASE1_PLAN_20260824_zh.md](evidence/BACKTEST_CHART_FIRST_PHASE1_PLAN_20260824_zh.md)
- 结果证据：[BACKTEST_CHART_FIRST_PHASE1_RESULT_20260824_zh.md](evidence/BACKTEST_CHART_FIRST_PHASE1_RESULT_20260824_zh.md)
- 机器可读证据：[backtest-chart-first-phase1-20260824.json](evidence/backtest-chart-first-phase1-20260824.json)
- Phase 1 没有用户可见新入口或新 flag；`VITE_CHART_STRATEGY_TESTER_ENABLED=0` 仍按本文档留在
  Phase 3 实施。

### 目标

先拆出纯逻辑，避免新 UI 复制 `BacktestApp` 的 controller。

### 步骤

1. 为 `backtestApi.ts` 的已有接口补充稳定 wire tests；
2. 从 `BacktestResultChart.tsx` 提取 fill/rejection -> marker 的纯函数；
3. 提取 equity series 和报告摘要转换函数；
4. 提取 Run 轮询与终态判定 helper；
5. 为现有 signal trace 与 Run compare 响应补齐 typed client；
6. 提取 focused trade、reason、decision/accept/fill 时间的纯 view model；
7. 让 legacy workbench 改用这些 helper；
8. 确认 DOM 和请求序列不变。

### 验证

- marker 时间、方向、文本和排序 golden test；
- rejection 与 fill 同时出现时不丢失；
- signal trace 分页、compare compatibility 和 focused trade view model 有 contract tests；
- legacy workbench 现有组件测试全通过；
- `npm run test:backtest && npm run typecheck`。

### 退出标准

- 新 chart tester 可以复用 API、轮询和投影；
- `BacktestApp.tsx` 不再是唯一能构造结果的地方；
- 用户可见行为零变化。

### 建议提交

`refactor(backtest): extract reusable run and result projections`

### 回滚

单提交 revert，legacy workbench 恢复内联逻辑。

## Phase 2：实现图表上下文解析与快速预设

### 目标

把当前图表安全解析为现有回测 Run 所需的不可变上下文。

### 步骤

1. 定义 resolve/materialize Pydantic 请求与响应；
2. 实现 `ChartBacktestContextResolver`；
3. 只从 Host 规范存储查找可复用数据；
4. 返回 coverage gap、可用精度和不支持原因；
5. 实现用户授权 materialize；
6. 对同一 resolution/idempotency key 去重；
7. 生成或读取版本化 cost/account/execution presets；
8. 扩展 capabilities；
9. 保持现有 `/datasets/snapshot` 和 `/runs` 合同不变；
10. 增加 `BACKTEST_CHART_CONTEXT_ENABLED=0`。

### 验证

- READY、NEEDS_DATA、UNSUPPORTED_INTERVAL、UNSUPPORTED_FIDELITY、AMBIGUOUS_MARKET；
- resolve 在离线/网络断开时仍为纯本地读取；
- materialize 未带用户确认时 fail closed；
- dataset/data epoch 不匹配时拒绝；
- 不支持的 89m 等周期不近似补齐；
- 并发相同请求只产生一个快照；
- 错误响应不包含本地绝对路径或敏感信息。

### 退出标准

- 任意 chart-session 都得到可行动的 typed 结果；
- READY 结果可直接通过现有 `/runs/validate`；
- 没有引入第二套下载、缓存或重采样实现。

### 建议提交

`feat(backtest): resolve chart sessions into immutable run contexts`

### 回滚

关闭 `BACKTEST_CHART_CONTEXT_ENABLED`；旧数据集和 legacy workbench 路径不受影响。

## Phase 3：每图表单元格状态、持久化与 stale 状态机

### 目标

建立与多图表架构一致的隔离状态，不先做完整 UI。

### 步骤

1. 增加 `ChartStrategyAttachmentRecord`；
2. workspace schema 升级到 8；
3. 编写 7 -> 8 迁移和 round-trip tests；
4. 新增独立 StrategyDraftStore，保存源码、语言、光标和保存状态；
5. 新增纯 reducer/state machine；
6. 新增按需 `ChartStrategyTesterRuntimeFactory`，未附着 cell 不创建 runtime；
7. 定义所有 chart-session、draft、revision transition 的 stale 原因；
8. 定义请求 generation token，阻止旧响应覆盖新状态；
9. 实现 split/copy/blank/close/detach 的 attachment 与 dispose 行为；
10. 增加 `VITE_CHART_STRATEGY_TESTER_ENABLED=0`；
11. flag off 时不加载 editor/runtime chunk，也不创建空 runtime。

### 验证

- symbol/interval/market type/exchange 变化全部 stale；
- 参数、revision、range、fidelity、preset 变化全部 stale；
- 草稿更新不会改写已存在的 revision 或 Run；
- cell A 的响应不能写入 cell B；
- 快速连续切换 20 次，最终状态只对应最后一个 session；
- 16/64 个未附着 cell 的 tester runtime、timer、轮询与 editor chunk 计数均为 0；
- 附着 N 个策略只产生至多 N 个 runtime；detach/close 后实例和资源计数回到基线；
- 旧 workspace 数据无损迁移；
- flag off 的 storage 与 DOM 无新增副作用。

### 退出标准

- 状态机可在无 React、无网络环境完整测试；
- 草稿恢复与不可变 revision 边界通过；
- 多图表身份隔离通过；
- runtime 按需创建与完整 dispose 通过容量测试；
- 旧 workspace 可恢复。

### 建议提交

`feat(backtest): add per-cell chart strategy tester state`

### 回滚

关闭前端 flag；若需代码回滚，schema 8 reader 保留一版以避免已写入数据无法读取。

## Phase 4：现有行情页中的脚本工作区

### 目标

让普通用户从三个开始入口进入编辑器，并只通过“运行”完成编译、版本冻结和回测。

### 步骤

1. 顶部增加“策略”入口，活动图表独占；
2. 为 `MarketWorkspaceFrame` 增加可调整高度的 bottomPanel slot；
3. 实现首次打开状态：使用策略模板、打开最近脚本、粘贴已有代码；
4. 用户选择后再懒加载 `StrategyScriptWorkspace` 与 Monaco；
5. 实现草稿防抖自动保存、光标恢复和保存失败恢复；
6. 接入后台轻量诊断，但不增加“检查/保存”主按钮；
7. 界面只提供一个主操作“运行”；
8. 实现脚本出错状态：定位行列、问题列表、保留草稿；
9. 在同一工作区提供概览、交易和设置占位状态；
10. 提供“在高级研究中打开”次级入口；
11. 增加中英文文案、运行快捷键与焦点管理。

### 验证

- 单图、四图和最大化图表入口归属正确；
- 切换 active cell 后脚本与设置写入正确 cell；
- 首次打开不渲染空白 Monaco；
- 三个入口、草稿恢复、自动保存失败、编译失败和 flag off 均有正确状态；
- 普通模式 DOM 中不存在“保存 revision”“创建 Run”或“选择数据集”；
- `Ctrl/Cmd+Enter` 等价于点击“运行”；
- Tab、Escape、Enter 和焦点返回可用；
- 1366x768 不遮挡主要操作。

### 退出标准

- 用户不进入 `/backtest.html` 即可开始、编辑和运行脚本；
- 主路径只有一个“运行”操作，不出现内部对象；
- 首屏主要操作不超过三个。

### 建议提交

`feat(backtest): add chart-bound strategy script workspace`

### 回滚

关闭前端 flag；bottomPanel 渲染 `null`，普通行情页恢复原布局。

## Phase 5：一个“运行”按钮与第一次回测

### 目标

完成从普通用户点击“运行”到不可变 BacktestRun 的后台流水线。

### 步骤

1. 实现 quick settings 摘要，只显示资金、仓位、费用、日期和精度；
2. 点击“运行”后锁定本次草稿内容与参数 hash；
3. 后台执行编译、能力和依赖检查；
4. 按 source hash + language + compiler/runtime revision 生成或复用 StrategyRevision；
5. 调用 chart-context resolve；
6. READY 时组合完整 RunCreateRequest；
7. 顺序执行 validate -> create；
8. NEEDS_DATA 时显示“准备数据并运行”；
9. materialize 完成后重新 resolve，禁止复用过期 token；
10. 创建覆盖 revision/context/config 的稳定 idempotency key；
11. 显示排队、运行、停止等待和失败；
12. 后端 Run 继续运行时，前端只停止观察，不伪称已取消 Run。

### 验证

- 模板脚本和用户脚本在已有数据下都能一键运行；
- 相同 source/config/context 重复运行幂等复用；
- source 改变才产生新 revision；普通 UI 不感知该步骤；
- 需要数据的确认、进度、失败和重试；
- 双击运行只创建一个 Run；
- validate 与 create 之间 context 改变则放弃创建；
- 费用未知时不能静默用 0；
- API 中断后可按 run ID 恢复观察；
- 所有错误码映射为用户可行动文案。

### 退出标准

- 发布 fixture 可从模板/最近脚本在三步内得到完成 Run；
- 创建的 Run 在高级研究和 legacy workbench 都可见且可导出；
- Run identity 与当前图表冻结上下文完全一致。

### 建议提交

`feat(backtest): run safe quick backtests from the active chart`

### 回滚

关闭 chart tester flag；已创建 Run 保留，仍可从高级研究或 legacy workbench 查看。

## Phase 6：结果上下文、底部面板与主图标记

### 目标

让结果回到用户正在看的图表，并让用户始终知道这份结果针对什么。

### 步骤

1. 在已有 bottomPanel 中接入概览、权益曲线和交易列表；
2. 实现固定 `ResultContextBar`；
3. 实现脚本/概览/交易/设置标签的稳定切换；
4. 接入 backtest marker source；
5. 实现交易行定位图表；
6. 实现可信度详情与高级研究 deep link；
7. 结果加载使用 run ID 缓存，缓存键包含 report/chart hash；
8. 面板切换 cell 时恢复各自高度和标签，但不复制结果；
9. chart context 变化后，同一帧隐藏标记并把 context bar 切成 stale 文案。

### 验证

- 结果 identity 匹配才显示标记；
- ResultContextBar 的 symbol、interval、范围、精度、费用均来自完成 Run；
- `ALL_AVAILABLE` 显示“全部本地可用数据”和可核对的绝对边界，不出现“全部历史”；
- stale 后一个渲染帧内隐藏；
- 10 万笔交易列表滚动不一次性创建全部 DOM；
- marker 仅按 visible range + overscan 投影；
- 面板 resize 不破坏时间轴和右侧栏；
- 导出截图时明确包含或排除底部面板，不能随机；
- 空结果、零交易和报告缺失均可解释。

### 退出标准

- 用户无需离开图表即可理解主要结果；
- 用户不展开详情也能确认回测对象与费用/精度口径；
- 交易列表、图上标记和报告统计来自同一个 run identity；
- 四图切换无结果串格。

Phase 6 结束即形成独立的“首次可用快测”里程碑：用户已经能从当前图表完成编辑、运行、查看固定结果上下文与交易投影。该里程碑可单独做可用性和性能验收，但在 Phase 7 的可信解释与可比性合同完成前，不得称为完整可信修改闭环，也不得据此生产默认开启。

### 建议提交

`feat(backtest): project run results into the active chart workspace`

### 回滚

关闭前端 flag 后 bottomPanel slot 渲染 `null`，图表布局恢复基线。

## Phase 7：交易解释与修改前后自动比较

### 目标

让普通用户能回答“为什么发生这笔交易”和“这次修改是否真的更好”，并保证解释与比较都来自可验证的 Run 证据。

### 步骤

1. 扩展 strategy provider 输出有预算的结构化 explain payload；
2. 为 decision、order、fill、trade 和 rejection 建立稳定关联；
3. 实现 `TradeExplanationV1`、`JCS_SHA256_V1`、固定预算、跨语言复算、确定性截断与 completeness；
4. 为 Pyne/Pine 尽可能生成 source span、condition ID 和变量白名单；
5. 扩展 marker/trade row 点击行为，打开 `TradeExplanationPopover`；
6. 提供 COMPLETE、PARTIAL、UNAVAILABLE 三种真实状态；
7. 实现包含 provider/compiler/runtime/RNG/builder revision 的 `comparison_context_hash` 与最近可比 baseline 选择；
8. 将 Run compare 扩展为 `RUN_COMPARE_V3`；
9. 为 trade 生成稳定 `TRADE_FINGERPRINT_V2`，并按 occurrence count 做精确多重集差；
10. 在普通概览增加净收益、最大回撤、交易次数和新增/消失交易摘要；
11. 完整比较 deep-link 到高级研究；
12. 接入 `BACKTEST_TRADE_EXPLANATION_ENABLED`、`VITE_CHART_TRADE_EXPLANATION_ENABLED` 和 `VITE_CHART_RUN_COMPARE_ENABLED`。

### 验证

- 每条解释只能读取 decision time 当时已有的信息；
- explanation evidence hash 在 Python/TypeScript contract fixture 中一致；任何新增 provider 实现接入前通过同一 fixture，且分页、导出和重新加载后可复算；
- 超过固定解释预算时截断顺序和 omissions 稳定，结果必须为 PARTIAL；非法数值或 hash 不匹配必须为 UNAVAILABLE；
- 入场、平仓、反向和拒单都能区分策略原因与 Host 原因；
- provider 无解释时显示 UNAVAILABLE，不生成推测文本；
- trace 超预算显示 PARTIAL 且不破坏 Run；
- 只有 comparison context 完全一致才显示方向性 delta；
- 最大回撤、净收益和交易次数 delta 与报告复算一致；
- trade diff 只做 V2 fingerprint 多重集差；同时间多次加减仓不碰撞、不丢数量，也不做模糊匹配；
- 不可逐笔对齐时仍可安全显示汇总比较。

### 退出标准

- 支持解释的交易和拒单均可从图表标记追到结构化证据；
- 普通用户无需选择 Run ID 即可看到最近可比结果；
- 任何“不解释/不可比较”状态都真实且可行动。

### 建议提交

`feat(backtest): explain trades and compare script revisions automatically`

### 回滚

关闭解释与自动比较的前端入口；底层 trace/compare 数据保留，基础结果面板继续工作。

## Phase 8：自动运行、并发与缓存

### 目标

实现“切到哪个品种和周期就出哪个结果”，同时不制造竞态和资源风暴。

### 步骤

1. 接入 chart-session transition；
2. 实现 600 ms 防抖和 generation token；
3. 只对 FAST + READY 自动运行；
4. 对 NEEDS_DATA、PRECISE 和 unsupported 停止自动运行；
5. 同一 cell 同时最多一个 resolve 和一个观察中的 Run；
6. 全 workspace 默认最多两个自动 Run 并发，其余排队；
7. 用户手动运行优先于自动队列；
8. 相同 identity 命中已完成 Run 时复用结果，不重复运行；
9. 缓存只复用完全匹配的 immutable identity；
10. 面板显示“自动运行已暂停”的具体原因。

### 验证

- 连续切换品种/周期不会展示中间结果；
- 四图同时变化不会超过并发上限；
- 16/64 图中未附着策略的 cell 不创建 runtime 或排队；批量 split/copy 不因复制 attachment 立即形成 Run 风暴；
- 手动运行可抢占未提交的自动任务；
- PRECISE 永不自动下载或自动提交；
- 命中缓存不改变报告身份；
- 后端过载返回可重试状态，不无限重试。

### 退出标准

- TV-like 自动更新体验成立；
- 无跨 context 结果、无 Run 风暴、无隐藏数据下载；
- 并发限制有浏览器和后端证据。

### 建议提交

`feat(backtest): auto-rerun chart strategies with bounded concurrency`

### 回滚

通过远程/本地配置关闭 auto-run，保留手动运行；必要时关闭整个 chart tester flag。

## Phase 9：抽取共享行情图表平台

### 目标

在构建高级研究页之前，抽出普通行情页和研究页真正需要共享的图表与行情合同，避免复制第二套实时前端。

### 步骤

1. 定义 `MarketChartSourceRuntime` 与三种 source mode；
2. 从现有实时路径提取 source-neutral `MarketChartSurface`；
3. 让 `LiveChartCell` 通过 adapter 使用共享 surface，用户行为保持不变；
4. 把 chart-session、symbol/interval control、series store、marker/layer source 作为显式输入；
5. 建立 `createLiveReferenceSource`，复用现有 Host 行情客户端；
6. 建立 `createFrozenSnapshotSource` 和 `createRunResultSource`；
7. 明确每种 source 的创建、暂停、恢复和 dispose 合同；
8. 增加架构检查，禁止共享平台反向依赖 backtest UI；
9. 为实时页建立 before/after DOM、请求、WebSocket lease 和性能对比。

### 验证

- 普通行情页功能和视觉基线无回归；
- 相同 session 不产生额外的前端行情实现；
- source 切换时旧 series、marker 和订阅完整清理；
- LIVE_REFERENCE 不会被 Run 当作可变执行输入；
- FROZEN_SNAPSHOT 断网后仍能读取已冻结数据；
- flag off 的多图表容量指标不劣化；
- 架构测试阻止 `market-chart-platform -> backtest` 依赖。

### 退出标准

- 实时行情页已在生产路径使用共享平台 adapter；
- 高级研究页可以在不 import `LiveChartCell` controller/store 的情况下创建同能力图表；
- 资源所有权和 dispose 证据完整。

### 建议提交

`refactor(chart): extract shared market chart platform for research apps`

### 回滚

共享 adapter 作为单提交可 revert；高级研究 flag 仍关闭，现有实时路径恢复原组合。

## Phase 10：独立全屏高级策略研究页

### 目标

像 K 线回放一样建立独立路由、独立 runtime、图表中心布局和可扩展面板体系，同时复用 Phase 9 的实时行情前端能力。

### 步骤

1. 新建 `BacktestResearchApp` 和 `BacktestResearchRuntime`；
2. 复用 `MarketPageFrame`、`MarketWorkspaceFrame` 与共享 chart surface；
3. 创建独立 `LIVE_REFERENCE` 行情 source 和完整 dispose；
4. 实现高级研究任务首页：精确成交、参数稳健性、Python/模型、多市场、回放复盘；
5. 每个任务只组合相关共享面板，不复制 runtime；
6. 实现图表中心布局，以及策略、数据、执行、Run/Study 和结果面板槽；
7. 支持 LIVE_REFERENCE、FROZEN_SNAPSHOT、RUN_RESULT 三种明确模式；
8. 从普通快测按 launch context/run ID 打开；
9. 使用同一 draft/revision store 恢复脚本，原样恢复参数、symbol、interval、日期和最近 Run；
10. 支持从高级研究返回来源 workspace/cell；
11. 接入策略 revision、数据集、Run 列表和报告的第一批只读/运行能力；
12. URL 参数只接受 context/run/study ID，后端重新读取权威对象；
13. 旧 `BacktestApp` 由 `VITE_BACKTEST_LEGACY_WORKBENCH_ENABLED` 保留兼容入口。

### 验证

- `/backtest.html` 默认进入新的高级研究 shell，旧 bookmark 由 adapter 兼容；
- deep link 打开正确 Run；
- 从普通模式进入时无需重新选择脚本、参数、品种、周期或日期；
- 五个任务入口分别只展示相关面板；切换任务不丢失上下文；
- 来源 cell 不存在时安全回退到主图；
- 高级页实时图表与普通页使用相同 symbol/interval/renderer/data service 合同；
- 同时打开普通页和高级页时，Host lease 不泄漏、不重复放大底层连接；
- LIVE_REFERENCE 更新不改变 FROZEN_SNAPSHOT 或已完成 Run；
- 旧 Run 无数据迁移也能查看。

### 退出标准

- 高级页拥有独立 runtime 和可扩展页面框架；
- 高级用户先选择任务，不面对全字段首页；
- 普通模式与高级模式使用同一份脚本对象和最近 Run；
- 共享行情前端不是代码复制，也不是共享可变 store；
- 双向跳转不重新创建或篡改 Run。

### 建议提交

`feat(backtest): add standalone advanced research application`

### 回滚

关闭 `VITE_BACKTEST_RESEARCH_ENABLED` 并启用 legacy workbench flag；现有 Run/Study 数据不变。

## Phase 11：高级能力迁移、Study 与回放复盘

### 目标

将现有工作台能力按边界迁入高级研究页，并让普通用户从一个快测结果自然进入深度研究，而不把专业字段塞回普通模式。

### 步骤

1. 迁移数据集、快照、coverage 和质量详情；
2. 迁移 Pyne/Pine revision、Python Bundle、受信确认和外部模型入口；
3. 迁移账户、费用、资金费率、延迟、参与率、成交模型和风控；
4. 迁移 Run 创建、监控、恢复、克隆、比较和导出；
5. 迁移可信度报告、信号 trace、权益和交易投影；
6. 迁移 Study、样本外、holdout、reveal 和选择警告；
7. 普通页与高级页的交易行/回撤区间提供“在 K 线回放中复盘”；
8. 通过现有 review bridge 创建只读复盘上下文；
9. 普通设置提供“批量研究这些参数”，只创建高级页草稿，不自动开始 Study；
10. 每迁移一块能力，旧工作台对应区块进入只读或隐藏状态；
11. 完成 parity matrix 后才讨论移除 legacy 入口。

### 验证

- 新旧工作台 capability parity matrix 无遗漏；
- Python/外部模型只在高级 runtime 初始化；
- 高精度数据和实时参考行情同时显示时来源标签正确；
- bridge 不泄漏复盘区间之后的数据；
- reveal 权限与现有合同一致；
- Study 草稿不自动开始；
- 返回图表后仍显示原 Run，不混入 replay 状态。

### 退出标准

- 高级研究页覆盖现有工作台全部受支持能力；
- “脚本快测 -> 高级研究 -> 回放复盘 -> 建立 Study”路径闭环；
- 三种对象仍有独立 ID、状态和生命周期。

### 建议提交

`feat(backtest): migrate advanced research study and replay workflows`

### 回滚

重新启用 legacy workbench flag 并隐藏尚未合格的高级面板；Run、Study 和 Replay 数据不需回滚。

## Phase 12：发布验证、灰度与回滚演练

### 目标

用证据证明新入口简单、可信、隔离且不伤害主图性能。

### 步骤

1. 完成单元、组件、API、浏览器和桌面测试；
2. 建立真实发布 fixture；
3. 运行单图、四图、16 图 flag-off 回归；
4. 运行快速切换与并发压力；
5. 运行 60 分钟浏览器稳定性观察；
6. 执行脚本快测、交易解释、自动比较、自动运行、共享平台 adapter、高级研究、legacy adapter 和后端 resolver 回滚演练；
7. 保存 manifest、命令、环境、结果和截图证据；
8. 先对开发环境默认开，生产构建继续默认关；
9. 独立评审通过后再讨论生产默认开。

### 验证矩阵

| 维度 | 最低覆盖 |
| --- | --- |
| 视口 | 1366x768、1920x1080、桌面窗口缩放 |
| 布局 | 单图、双图、四图、最大化、flag-off 16 图回归 |
| 市场 | 现货、永续；至少两个 symbol |
| 周期 | 原生周期、可精确聚合周期、不支持周期 |
| 数据 | READY、缺口、离线、损坏、epoch 变化 |
| 策略 | 内置、Pyne/Pine、编译失败、不支持数据 |
| 普通状态 | 首次打开、运行完成、脚本出错、结果已过期 |
| Run | 完成、零交易、失败、断线恢复、旧响应晚到 |
| 结果 | ResultContextBar、标记、权益、交易列表、可信度、导出、deep link |
| 解释 | COMPLETE、PARTIAL、UNAVAILABLE、拒单、预算上限、证据复算 |
| 比较 | 可比较、不可比较、drawdown delta、TRADE_FINGERPRINT_V2 多重集差、同毫秒多次加减仓 |
| 高级页 | 五类任务入口、无损上下文、实时参考、冻结快照、Run 结果、Python、Study、回放桥 |
| 资源 | 0/N 个按需 tester runtime、16/64 未附着 cell 零实例、普通页/高级页同时打开、关闭、重连、Host lease 清理 |
| 回滚 | 快测、auto-run、高级研究、legacy adapter、后端 resolver 分别关闭 |

### 必跑命令

```powershell
cd H:\program\CandleScope\frontend
npm run check:architecture
npm run check:i18n
npm run typecheck
npm run lint
npm run test:backtest
npm test
npm run build
```

后端按仓库当前解释器运行 backtest API、service、runtime、snapshot、Study 和新增 chart-context 测试；不得只跑新增测试后宣称发布通过。

### 退出标准

- 所有发布 gate 有机器可读证据；
- 第一次成功回测达到第 2 节目标；
- 无跨 cell、跨 symbol、跨 interval 的结果污染；
- 普通模式没有内部对象主操作，三状态走查通过；
- 交易解释与自动比较的真实性 gate 全通过；
- 高级研究复用实时行情前端且无可变 store 串页；
- legacy capability parity 完成；
- flag-off 性能不劣于基线；
- 回滚演练证明不删除已有 Run 或 workspace；
- 独立评审无 P0/P1 问题。

### 建议提交

`test(backtest): qualify chart-first strategy tester release gates`

### 回滚

按顺序关闭：advanced research -> auto-run -> run compare -> trade explanation -> chart tester -> chart-context resolver，并启用 legacy workbench adapter。现有 Run/Study 始终保留。

---

## 10. 测试场景清单

以下场景必须写成自动化验收，而不是只靠截图：

### S1：首次打开

用户第一次点击“策略”，只看到“使用策略模板、打开最近脚本、粘贴已有代码”三个入口；Monaco、数据集、版本和高级设置均未出现。

### S2：已有本地数据的第一次运行

给定 BTCUSDT 1h 图表和一个策略模板，用户修改脚本并点击“运行”。系统在后台保存草稿、生成或复用 revision、冻结上下文并创建 Run；普通 UI 只显示一个运行进度，完成后主图与底部结果一致。

### S3：本地数据不足

resolve 返回缺口时，UI 显示缺少区间和“准备数据并运行”；未点击确认不得发起网络请求或创建 Run。

### S4：切换周期导致结果过期

从 1h 切到 15m，旧标记立即消失，ResultContextBar 显示“结果已过期：当前图表为 15m”；旧响应晚到也不能恢复 1h 标记。

### S5：成交序列精算模式

用户选择成交序列精算后切换 symbol，系统只标记 stale，不自动下载、不自动运行；所需成交数据不足时直接提供“改用快速估算”。若实际 Run 使用 aggTrade，ResultContextBar 必须显示“聚合成交序列精算”，不能显示“逐笔成交精算”。

### S6：四图隔离

四个 cell 分别附着不同脚本。切换 active cell 只改变底部面板内容，任一草稿、Run、比较或解释状态不得修改其他 cell。

### S7：费用预设缺失

无法识别 exchange/market 费用时，结果对象条不得显示“已包含费用”，运行区域要求确认费用；不得使用后端零费率默认偷偷运行。

### S8：脚本编译失败

用户点击“运行”后编译失败，编辑器定位到具体行列并显示修复提示；草稿和上一份成功汇总保留，主界面不以错误码 toast 作为主要反馈。

### S9：后端重启

前端持有 run ID，后端重启恢复后可以重新读取状态和报告；前端不得自行把 RUNNING 改成 COMPLETED。

### S10：完整交易解释

用户点击一个买入标记，看到触发条件、条件真假、决定时变量、脚本文案版本和成交结果；所有字段能追到同一 decision evidence hash，且不读取未来数据。

### S11：交易解释不可用

provider 未提供结构化 explain payload 时，显示“该策略没有提供可验证的交易原因”，仍可查看价格、盈亏和执行原因；不得生成推测文本。

### S12：修改后自动比较

用户修改脚本并再次运行，系统自动选择同一 comparison context 下最近完成的 baseline，概览显示净收益、最大回撤、交易次数和新增/消失交易变化，无需选择 Run ID。

### S13：不可直接比较

用户同时改变周期或精度后运行，compare 返回 incompatible fields；普通概览不显示改善/恶化，只提供“在相同条件下重新运行”。

### S14：高级研究无损交接

从普通模式打开高级研究后，同一 draft/revision、参数、symbol、interval、日期、quick preset 和最近 Run 原样恢复；用户不需要重新配置。

### S15：高级研究任务入口

高级页首次进入只显示五个研究任务。选择“参数稳健性研究”只展开参数、fold、OOS、holdout 和目标约束相关面板，其他高级面板保持收起。

### S16：高级页复用实时行情前端

从当前 BTCUSDT 1h 图表打开高级研究，页面使用相同的 symbol/interval 组件、图表 renderer 和 Host 行情服务建立自己的 LIVE_REFERENCE runtime；关闭高级页后订阅与 lease 完整释放。

### S17：实时参考与冻结回测隔离

高级页在 LIVE_REFERENCE 持续更新时创建一个 FROZEN_SNAPSHOT Run。之后实时价格变化不得改变快照、成交、权益或报告；切换到 RUN_RESULT 时只显示匹配该 Run 的标记。

### S18：功能回滚

关闭 chart tester/advanced research flag 并启用 legacy workbench 后，主图、指标、绘图、交易流、多图布局和旧 `/backtest.html` 均通过；普通快测已产生的数据无需迁移或删除。

---

## 11. 可观测性与错误合同

建议事件：

- `chart_strategy_workspace_opened`
- `chart_strategy_start_option_selected`
- `chart_strategy_draft_saved`
- `chart_strategy_revision_created`
- `chart_strategy_attached`
- `chart_context_resolved`
- `chart_context_needs_data`
- `chart_data_materialize_confirmed`
- `chart_backtest_submitted`
- `chart_backtest_completed`
- `chart_backtest_stale`
- `chart_backtest_result_opened`
- `chart_backtest_context_became_stale`
- `chart_backtest_actionable_error_shown`
- `chart_backtest_trade_explanation_opened`
- `chart_backtest_comparison_shown`
- `chart_backtest_comparison_blocked`
- `chart_backtest_research_opened`
- `backtest_research_opened`
- `backtest_research_task_selected`
- `backtest_research_source_changed`
- `backtest_research_disposed`

允许属性：耗时桶、状态、错误码、fidelity、range mode、数据行数桶、布局 cell 数、是否自动运行。

禁止属性：源码、完整参数、symbol 自定义文本、dataset 路径、交易明细、报告内容。

错误码到用户动作至少覆盖：

| 错误族 | 用户动作 |
| --- | --- |
| 数据不足 | 准备数据 / 缩短区间 / 导入数据 |
| 周期不支持 | 切换列出的可用周期 |
| 精度不支持 | 使用快速估算 / 明确导入逐笔成交或聚合成交数据 |
| 策略能力不支持 | 查看依赖 / 修改策略 |
| 快照变化 | 重新解析并运行 |
| 费用未知 | 选择或确认费用预设 |
| 后端不可用 | 重试 / 打开高级研究查看已有 Run |
| 资源繁忙 | 保留队列 / 手动取消等待 |

---

## 12. 功能旗标与发布策略

新增旗标：

```text
BACKTEST_CHART_CONTEXT_ENABLED=0
BACKTEST_TRADE_EXPLANATION_ENABLED=0
VITE_CHART_STRATEGY_TESTER_ENABLED=0
VITE_CHART_STRATEGY_AUTO_RUN_ENABLED=0
VITE_CHART_TRADE_EXPLANATION_ENABLED=0
VITE_CHART_RUN_COMPARE_ENABLED=0
VITE_BACKTEST_RESEARCH_ENABLED=0
VITE_BACKTEST_LEGACY_WORKBENCH_ENABLED=1
```

规则：

- 新增产品能力和生产示例继续默认关闭；legacy workbench 在迁移期默认开启；
- 本地开发可以在 `.env` 覆盖打开；
- “本机已打开用于测试”不能当作生产成熟度证据；
- 每个 flag 有独立测试和回滚记录；
- 后端 resolver 关闭时，普通入口显示不可用，不降级为前端猜 dataset；
- explanation 关闭时，交易仍可查看，但明确显示“交易原因功能未启用”；
- run compare 关闭时，基础结果不受影响；
- chart tester 关闭时，高级研究与 legacy workbench 继续工作；
- auto-run 关闭时，手动运行继续工作；
- advanced research 关闭时，legacy workbench 可恢复；
- parity 与回滚演练完成前，legacy flag 不得删除；
- 共享图表平台不是产品 flag：若 adapter 需要回滚，必须通过提交/构建级回滚恢复既有实时路径。

---

## 13. 不做的事情

第一轮明确不做：

- 多策略共用一个虚拟账户；
- 策略自动实盘交易；
- 把可见 K 线数组直接上传为可信数据集；
- 在图表切换时自动触发逐笔成交或聚合成交数据下载；
- 把 Python 受信执行放到普通模式；
- 把 Study、holdout、优化器塞进底部概览；
- 把指标脚本启发式转换成交易策略；
- 用大模型、事后价格或通用模板生成“为什么交易”的解释；
- 用模糊时间匹配伪造新增/消失交易的精确对比；
- 为追求“秒出结果”而跳过 snapshot/fee/fidelity 披露；
- 让高级研究页直接借用普通行情页的可变 React/WebSocket store；
- 复制第二套行情客户端、图表 renderer 或 symbol/interval 组件；
- 在 capability parity 与回滚验证前删除 legacy workbench；
- 合并 BacktestRun、Study 与 TrainingRun。

---

## 14. Definition of Done

只有同时满足以下条件，才能称为“图表脚本快测与高级策略研究完成”：

- [ ] 普通用户可从当前图表三步内修改模板/最近脚本并运行；
- [ ] 首次打开只显示模板、最近脚本、粘贴代码三个入口，不默认展示空白编辑器；
- [ ] 普通模式唯一主操作为“运行”，草稿保存与 revision 创建完全后台化；
- [ ] symbol、market、interval 和范围自动来自当前图表；
- [ ] ResultContextBar 始终显示 symbol、interval、范围、精度和费用状态；
- [ ] 数据不足时先披露再由用户触发准备；
- [ ] 默认费用不是静默 0；
- [ ] 快速估算、逐笔成交精算与聚合成交序列精算有清晰、真实且不可混用的标签；
- [ ] 买卖点、交易列表、指标和报告来自同一 immutable run identity；
- [ ] 切换图表后旧结果立即 stale 且不再投影；
- [ ] 单图与多图状态完全隔离；
- [ ] 支持的 Pyne/Pine 策略可在图表工作区编辑并运行，revision 由后台生成/复用；
- [ ] 编译错误定位到代码行；数据/周期/精度错误提供直接修复动作；
- [ ] 草稿、revision 和 Run 三种生命周期严格分离；
- [ ] 支持解释的交易与拒单可追到决定时条件、变量、版本和 evidence hash；
- [ ] evidence hash 按冻结 canonicalization 和预算跨语言复算一致，PARTIAL/UNAVAILABLE 不伪装成完整解释；
- [ ] 不支持解释时明确标记，不生成推测内容；
- [ ] 修改后自动选择最近可比 Run，显示净收益、最大回撤、交易次数和交易集合变化；
- [ ] comparison context 包含所有非策略执行版本；交易变化使用 V2 fingerprint 多重集，同时间多次交易不碰撞；
- [ ] 不兼容 Run 不展示改善/恶化结论；
- [ ] 指标脚本不能直接冒充策略；
- [ ] Python、Study、比较、审计和高级风控可在高级研究使用；
- [ ] 高级研究是独立全屏页面和独立 runtime；
- [ ] 高级研究首先按五类任务进入，不默认展示全字段页面；
- [ ] 从普通模式进入高级研究时，脚本、参数、品种、周期、日期和最近 Run 无损恢复；
- [ ] 普通页与高级页复用同一图表/行情平台，不复制实现；
- [ ] 高级页 LIVE_REFERENCE、FROZEN_SNAPSHOT、RUN_RESULT 来源明确且不可混用；
- [ ] 高级页关闭后 WebSocket、lease、轮询和缓存引用完整释放；
- [ ] 未附着策略的 cell 不创建 tester runtime；detach/close/flag-off 后相关资源回到基线；
- [ ] legacy workbench capability parity 与回滚通过；
- [ ] 回放桥保持只读和 no-lookahead；
- [ ] 所有新增入口可通过 flag 独立回滚；
- [ ] flag off 时主图性能和现有功能不劣化；
- [ ] 完整 test/build/browser/soak/rollback 证据归档；
- [ ] 独立评审通过，且没有 P0/P1 未决项。

---

## 15. 推荐实际开工顺序

不要先重写整个 `/backtest.html`，也不要把高级页建立在复制 `LiveChartCell` 上。推荐顺序是：

1. Phase 0：批准合同；
2. Phase 1：提取结果投影；
3. Phase 2：打通 chart context -> immutable snapshot；
4. Phase 3：完成每 cell 状态和 stale 安全线；
5. Phase 4 + 5：上线“三种开始方式 -> 运行”的最小闭环；
6. Phase 6：加入固定回测对象条、标记和结果；
7. Phase 7：加入可信交易解释与修改前后自动比较；
8. Phase 8：再开启 TV-like 自动运行；
9. Phase 9：从已验证实时路径抽取共享图表平台；
10. Phase 10：建立按任务进入的独立高级研究 shell/runtime；
11. Phase 11：按 parity matrix 迁移高级能力、Study 与回放桥；
12. Phase 12：用发布证据决定是否默认开启。

第一个可用性里程碑止于 Phase 6：用户已能从三个入口开始，只点击“运行”，并在当前图表看清固定回测对象、交易投影和主要结果；它可以单独验收首轮路径与性能，但还不是完整可信修改闭环。

第一个可信产品里程碑止于 Phase 7：在 Phase 6 基础上，用户还能查看可验证的交易原因，并只在兼容上下文中比较修改前后差异。第二个产品里程碑是 Phase 8 的自动运行。第三个产品里程碑是 Phase 9–11 的共享图表平台和按任务进入的高级研究页。

---

## 16. 与现有文档的关系

本方案不替代现有回测内核、可信度和研究合同，只替代“普通用户应该先进入独立研究页”的前端信息架构结论。

继续有效：

- `docs/BACKTEST_PRODUCT_CONTRACT_zh.md`：对象边界、Host-owned execution、身份和 fail-closed 合同；
- `docs/BACKTEST_SYSTEM_EXECUTION_zh.md`：回测内核、API、报告、发布基线；
- `docs/BACKTEST_MATURITY_EXECUTION_PLAN_zh.md`：能力成熟度与门槛；
- `docs/BACKTEST_PYTHON_FIRST_PRODUCTIZATION_EXECUTION_zh.md`：Python 高级策略路径；
- 现有 Backtest ADR：数据、精度、账户、Study、报告与回放边界。

本方案优先级更高的部分：

- 普通用户入口；
- chart-first 脚本快测主流程；
- 每 cell 策略附着；
- 底部策略测试器；
- 单一“运行”动作与自动版本冻结；
- 固定 ResultContextBar、可行动错误、交易解释和自动比较；
- 自动运行语义；
- 共享实时行情前端能力与独立 runtime 边界；
- 高级研究作为按任务进入的独立全屏应用，并与普通模式共享同一脚本/上下文对象。

如实现中发现本文与现有不可变 Run、数据快照或 no-lookahead 合同冲突，必须修改本 UX 方案，不能削弱底层可信度合同。
