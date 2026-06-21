# Pyne Runtime 代码审查问题逐条核验

本文对应 `docs/development/code_review_execution_plan_zh.md` 中 P0-P10 的问题清单，按原编号 1:1 核验。核验方式为源码静态阅读、测试覆盖检查和少量只读运行探针；本轮不修改业务代码。

结论用语：

- 确认存在：当前代码中能直接定位到对应行为或风险。
- 部分存在：原问题方向成立，但范围、原因或当前实现细节需要收窄。
- 需语义决策：代码行为存在，但是否算 bug 取决于 Pyne 对 Pine 兼容性/安全边界的产品定义。
- 原描述过强：问题不是完全不存在，但原文表述比当前事实更绝对。

## P0 - 运行/配置入口

### [P0-01] 进程执行模式在 Windows / spawn 下 provider 可能无法 pickle

- 结论：确认存在。
- 证据：`src/pyne_runtime/executor.py` 的 process 路径把完整 `settings` 传入子进程，`settings` 又可能包含 `data_provider` 等宿主对象；Windows spawn 会要求这些对象可 pickle。
- 建议：把进程执行路径的可序列化契约写清楚；对 provider 建议改为注册名/配置字典/工厂描述符传递，或在进入 process 模式前主动检测并返回结构化错误。

### [P0-02] 同名函数 `normalize_security_mode` 行为分歧（raise vs 静默回退）

- 结论：确认存在。
- 证据：`src/pyne_runtime/settings.py` 中无效值回退到 `safe`，`src/pyne_runtime/security.py` 中同名函数会抛 `PyneSecurityError`。
- 建议：保留单一权威实现；无效配置应统一为显式错误，避免用户以为启用了某个安全模式但实际静默降级。

### [P0-03] `with_security_mode` 手工逐字段复制，易随新字段遗漏

- 结论：确认存在。
- 证据：`src/pyne_runtime/settings.py` 的 `with_security_mode()` 手工重新构造 `PyneSettings`；同项目其他位置已使用 `dataclasses.replace()`。
- 建议：改为 `dataclasses.replace(self, security_mode=...)`，并补一条“新增字段仍保留”的回归测试。

### [P0-04] `mintick` 默认值不一致（1.0 vs 0.01）

- 结论：确认存在。
- 证据：`SymbolInfo.mintick` 和 settings/env normalize 的默认值为 `1.0`，但 `PyneMath`/namespace fallback 使用 `0.01`。
- 建议：定义唯一默认来源；如果无交易品种信息，应明确是拒绝执行、使用 `1.0`，还是使用 Pine 常见的最小跳动假设。

### [P0-05] 运行时异常信息直接回传，存在信息泄露风险

- 结论：确认存在。
- 证据：`src/pyne_runtime/runtime.py` 对泛型异常返回 `Script error: {exc}`，可能把路径、对象 repr、内部实现细节带给调用方。
- 建议：区分调试模式和生产模式；生产默认返回错误码、短消息和 hint，详细异常写入日志或受控 debug 字段。

### [P0-06] CLI `run` 未捕获脚本/数据读取异常

- 结论：部分存在。
- 证据：`src/pyne_runtime/cli.py` 的参数/数据加载辅助函数会直接抛 `ValueError`、文件读取错误等；运行结果本身有 ok/code，但进入执行器前的读取/解析错误不完全统一。
- 建议：CLI 顶层包一层契约化异常处理，stderr 输出短错误，退出码区分用户输入错误、运行错误和内部错误。

### [P0-07] `_read_script` 字符串/路径启发式存在歧义

- 结论：确认存在。
- 证据：`src/pyne_runtime/api.py` 的 `_read_script()` 对 `str` 同时承担脚本文本和路径语义，调用方可能把短脚本误判为路径，或把路径文本当脚本。
- 建议：公开 API 拆成 `script_text` 与 `script_path` 两种入口，或仅对 `Path` 执行文件读取；CLI 可保留路径语义。

### [P0-08] `validate()` 不校验运行期资源限制，仅语法 + import 安全

- 结论：确认存在。
- 证据：`api.validate()` 调用 `ast.parse()` 和 `validate_script_security()`，不会模拟 output limits、timeout、drawing limits、provider capability 等运行期限制。
- 建议：把函数命名/文档收窄为静态校验；如要覆盖运行期限制，新增 dry-run/contract validate 并明确需要样本数据。

### [P0-09] inline 模式下全局 `pyne_cache` 被每次构造 runtime 重配置

- 结论：确认存在。
- 证据：`PyneRuntime.__init__()` 调用全局 `pyne_cache.configure(max_items=...)`；inline 多次构造 runtime 会影响同进程其他执行。
- 建议：缓存实例应挂到 runtime/settings 作用域，或至少只在进程启动时配置一次；文档需说明当前全局作用域。

### [P0-10] `execute_pyne_script` 的 provider/syminfo 透传仅覆盖 inline，进程路径依赖 settings 序列化

- 结论：部分存在。
- 证据：`executor.py` 会用 `dataclasses.replace()` 把 provider/syminfo/timeframe/session 写入 settings；inline 直接使用，process 则通过子进程参数序列化整份 settings。
- 建议：问题不在“完全未传”，而在“process 只能传可 pickle 对象”。建议把进程路径参数契约和 P0-01 合并整改。

## P1 - 安全与隔离

### [P1-01] safe/research 模式不是真正的沙箱，可通过 `__globals__` 逃逸（高危）

- 结论：确认存在安全边界风险。
- 证据：namespace 注入完整 `numpy`、运行时函数/对象和自定义模块；`SAFE_BUILTINS` 只是约束 builtins，不是 OS/process 级沙箱。
- 建议：把 safe/research 定义为“受限脚本环境”而非沙箱；高危场景必须使用进程/容器隔离，并增加已知逃逸向量的安全回归测试。

### [P1-02] `enforce_output_limits` 未覆盖全部 OUTPUT_KEYS，输出上限可绕过

- 结论：确认存在。
- 证据：`security.enforce_output_limits()` 只统计 `lines`、`histograms`、`bars`、`markers` 等少数键；`bgcolors`、`barcolors`、`signals`、`hlines`、`fills`、drawing objects、strategy 输出等未统一纳入。
- 建议：以 schema 的输出键为源头统一计数，并区分 series 点数、对象数量、策略事件数量。

### [P1-03] `pyne_cache` 进程全局单例，inline 模式跨脚本串扰/泄漏（承 P0-09）

- 结论：确认存在。
- 证据：`src/pyne_runtime/cache.py` 定义全局 `pyne_cache`，namespace 又把 `pyne`/`cache` 暴露给脚本。
- 建议：默认改为 execution/session scoped cache；如保留全局缓存，必须引入命名空间、租户 key 或显式清理策略。

### [P1-04] `execution_timeout` 仅主线程+Unix 生效，inline 模式 Windows 无超时

- 结论：确认存在。
- 证据：`security.execution_timeout()` 在非主线程、无 `SIGALRM`/`ITIMER` 时直接退化为 best-effort；Windows inline 场景无法强制打断 CPU 死循环。
- 建议：对不可信脚本默认使用 process 模式；inline 模式文档标明无强制超时，或引入子进程/worker 作为统一执行后端。

### [P1-05] `classify_security_error` 依赖错误消息子串匹配，脆弱

- 结论：确认存在。
- 证据：`errors.py` 通过 `"output series"`、`"Import"` 等字符串片段分类，错误文案变化会改变错误码。
- 建议：改为 typed exception 或错误对象携带 code；消息只用于展示。

### [P1-06] `SAFE_BUILTINS` 缺 `__build_class__` 等，safe/research 下无法定义 class

- 结论：确认存在。
- 证据：运行探针 `class A: pass` 返回 `PYNE_RUNTIME_ERROR`，错误为 `__build_class__ not found`；`SAFE_BUILTINS` 未提供该内建。
- 建议：先决定是否支持脚本内 class；若支持，需要补 `__build_class__` 并评估 sandbox 逃逸面；若不支持，应在 validate 阶段给出明确诊断。

### [P1-07] `cache.get_or_load` 并发语义与 TTL 语义需文档化

- 结论：需语义决策。
- 证据：`cache.get_or_load()` miss 后释放锁执行 loader，再回写缓存；并发 miss 可能重复加载。当前 TTL 时间戳在 loader 后创建，已避免“长 loader 吞掉 TTL”的最坏情况。
- 建议：文档说明“非 single-flight”；如需要避免重复 provider 请求，应实现 per-key in-flight 合并。

### [P1-08] `validate_script_security` 对 SyntaxError 静默跳过安全检查

- 结论：确认存在。
- 证据：`security.validate_script_security()` 捕获 `SyntaxError` 后直接 return，由上层语法检查负责；如果调用方只调用该函数，会误以为脚本安全。
- 建议：函数名/契约改为“对可解析 AST 做安全检查”；或对 SyntaxError 抛出 typed validation error。

## P2 - 数据模型与序列语义

### [P2-01] 缺少对时间戳单调递增 / 唯一性的校验

- 结论：确认存在。
- 证据：`PyneData._normalize_bar()` 和 `PyneContext.from_ohlcv()` 都未校验 time 的单调性或唯一性。
- 建议：数据入口增加严格模式校验；对 request/provider 返回值也复用同一校验。

### [P2-02] 最后一根 bar 的 `time_close` 退化为 NaN

- 结论：确认存在。
- 证据：`PyneContext._derive_time_close()` 在没有显式 `time_close` 时用下一根 bar 时间推导，最后一根无 next time 则返回 `NaN`。
- 建议：结合 timeframe 推导最后一根 close time；无法推导时用明确 missing reason，而不是静默 NaN。

### [P2-03] 派生序列（hl2/hlc3/ohlc4/hlcc4）携带错误的 `name`

- 结论：确认存在。
- 证据：`PyneSeries._binary()` 保留左操作数 name，导致 `hl2` 等派生序列名称继承为 `high` 或 `open`。
- 建议：构建派生序列后显式 `rename()`；增加 result/to_frame 中派生序列列名测试。

### [P2-04] `na` 与序列的算术不对称、会丢失形状

- 结论：确认存在。
- 证据：`PyneSeries` 能把右侧 `PyneNA` 转为标量 `np.nan` 并保持序列形状；但 `na + series` 会优先走 `PyneNA` 标量运算，返回标量 NaN。
- 建议：为 `PyneNA` 针对 `PyneSeries` 实现反向委派，或禁止 `na` 左操作数参与序列算术并给出明确错误。

### [P2-05] OHLC 数值缺少合理性校验

- 结论：确认存在。
- 证据：归一化只做类型转换，不校验 `high >= max(open, close)`、`low <= min(open, close)`、volume 非负等。
- 建议：增加可配置数据质量校验；默认至少在 strict/provider 输入中拒绝明显非法 OHLC。

### [P2-06] 两条入口对缺失字段的严格度不一致

- 结论：确认存在。
- 证据：`PyneData.from_ohlcv()`/`_normalize_bar()` 要求默认列存在；`PyneContext.from_ohlcv()` 直接 `d.get(..., 0)`，缺失字段会补 0。
- 建议：统一入口，runtime 执行前都先转 `PyneData` 或共享同一个 normalizer。

### [P2-07] `PyneSeries` 不可哈希且 `==` 返回序列，集合 / `in` 操作会异常

- 结论：确认存在。
- 证据：`PyneSeries.__eq__()` 返回 `PyneSeries`，dataclass 自定义等值后没有可用 hash；Python 集合语义与向量化等值冲突。
- 建议：显式 `__hash__ = None` 并文档化不可作为 key；如需身份比较，提供 `is_same_series()` 或 id 字段。

### [P2-08] namespace 中 `mintick=0.01` 兜底为不可达死代码（对 P0-04 的补充）

- 结论：确认存在。
- 证据：namespace 使用 `getattr(ctx.syminfo, "mintick", 0.01)`，但正常 context 的 `SymbolInfo.mintick` 总有默认 `1.0`。
- 建议：删除不可达 fallback，统一由 `SymbolInfo`/settings 决定。

### [P2-09] 时间框架 `multiplier` 单位混用，字段语义含糊

- 结论：确认存在。
- 证据：`metadata._parse_timeframe()` 对小时返回分钟数，对秒/分钟/日/周/月则返回不同单位下的原始数量或近似语义。
- 建议：拆成 `amount`、`unit`、`seconds`/`duration_ms` 等字段，避免单个 multiplier 承担多种单位。

### [P2-10] DataFrame 识别仅靠模块名前缀，扩展性差

- 结论：确认存在。
- 证据：`coerce_ohlcv()` 用 `hasattr(data, "to_dict")` 且模块名以 `pandas` 开头判断 DataFrame。
- 建议：优先使用 pandas 类型检测；若不依赖 pandas，则用 DataFrame protocol 并在错误消息中说明所需列。

## P3 - 命名空间装配

### [P3-01] 直接向脚本注入完整 `numpy`，绕过策略形成文件 I/O / 代码执行面

- 结论：确认存在。
- 证据：namespace 注入 `np` 和 `numpy` 完整模块；这扩大了 safe/research 的可达对象面。
- 建议：默认只暴露白名单数学函数；完整 numpy 仅在 unsafe/research explicit opt-in 中开放，并纳入安全说明。

### [P3-02] `math` 的 `mintick` 兜底 `0.01` 为不可达死代码（对 P2-08 的呼应）

- 结论：确认存在。
- 证据：`PyneMath` 默认构造参数为 `0.01`，但 runtime namespace 正常传入 `ctx.syminfo.mintick`，默认值又来自 `SymbolInfo` 的 `1.0`。
- 建议：移除或统一默认值，并增加 mintick 默认来源测试。

### [P3-03] 多个 `install_*` 函数对同名键无冲突检测，存在静默覆盖风险

- 结论：确认存在。
- 证据：namespace 按顺序调用多个 install 函数并直接向同一个 dict 写入键；没有重复键断言。
- 建议：安装 helper 应检查冲突并允许显式 override 列表；CI 加 namespace key 快照测试。

### [P3-04] 大量 Python 内建名被刻意遮蔽，需明确文档化

- 结论：确认存在。
- 证据：namespace 暴露 Pine 风格 `open`、`time`、`str`、`map`、`input` 等，和 Python 内建/模块名存在冲突。
- 建议：文档列出遮蔽清单；validate 对高风险误用给 hint。

### [P3-05] `RuntimeServices.__post_init__` 急切构造全部子模块

- 结论：确认存在。
- 证据：`RuntimeServices.__post_init__()` 每次执行都会构造 TA、input、state、output、strategy 等模块，即使脚本未使用。
- 建议：低风险优化为懒加载；先用 profiling 确认收益，再改构造顺序。

### [P3-06] 原始可变 `params` 字典被直接注入命名空间且与 input 模块共享引用

- 结论：确认存在。
- 证据：namespace 直接把 `services.params` 放入脚本 globals，同时 `InputModule` 使用同一引用。
- 建议：传入前做浅拷贝/只读映射；脚本需要输出参数变更时使用显式 API。

### [P3-07] `__builtins__` 由 `build_builtins(policy)` 注入（对 P1 的装配侧记录）

- 结论：确认存在。
- 证据：namespace 明确设置 `__builtins__` 为安全策略构建的 dict。
- 建议：本身是设计点，但应把各 security mode 的 builtins 快照纳入测试和文档，避免隐式变化。

### [P3-08] `pyne` / `cache` 等多入口指向同一缓存，作用域与隔离需文档化

- 结论：确认存在。
- 证据：namespace 中 `_pyne_namespace()` 暴露全局 `pyne_cache` 的 `get_or_load`、`clear`、`stats`。
- 建议：与 P1-03 一起处理；若保留多入口，文档写清楚它们是同一全局缓存对象。

## P4 - TA/数学/时间/字符串语义

### [P4-01] `ta.sma` 用 `nancumsum` 处理 NaN，窗口含 NaN 时结果错误（不返回 na）

- 结论：确认存在。
- 证据：运行探针显示 `[1, NaN, 3]` 上 period=2 的结果为 `[NaN, 0.5, 1.5]`；含 NaN 窗口被除以 period 后给出数值。
- 建议：SMA 应在窗口存在 NaN 时返回 NaN，或明确采用 skip-na 语义并修正分母；优先对齐 Pine。

### [P4-02] 平窗口振荡指标返回中性常数而非 na

- 结论：需语义决策。
- 证据：CMO/WPR/CCI 等在分母为 0 时返回 `0.0`，stoch 返回 `50.0`。
- 建议：逐个核对 Pine 行为；若选择中性常数，应文档化并加 golden，否则改为 NaN。

### [P4-03] `adx`/`dmi` 用 `nan_to_num(dx, 0)` 把热身期 NaN 污染为 0

- 结论：确认存在。
- 证据：`ta.py` 中 ADX/DMI 在 RMA 前对 `dx` 执行 `np.nan_to_num(..., nan=0.0)`。
- 建议：保持 warmup NaN，等有效窗口形成后再计算；用 TradingView capture 或外部基准补 golden。

### [P4-04] 模块内存在多套语义不一致的 EMA 实现

- 结论：确认存在。
- 证据：`ta.ema`、`ta.rma`、TSI 内部 `_ema_skip_leading_na` 等存在不同 seed 和 NaN 策略。
- 建议：抽出统一 EMA/RMA 内核，调用方通过参数选择 seed/skip-na 策略，并为各策略命名。

### [P4-05] `highest`/`lowest` 缺少 `period<=0` / `period>n` 边界保护

- 结论：部分存在。
- 证据：`period<=0` 会形成空窗口并可能触发 numpy 空数组错误；`period>n` 当前大体会返回全 NaN，不是同等严重。
- 建议：显式拒绝 `period<=0`；对 `period>n` 保持全 NaN 并加测试。

### [P4-06] 各函数间 NaN 策略不统一

- 结论：确认存在。
- 证据：SMA、WMA、oscillator、rolling utils 对 NaN 分别采用忽略、整窗 NaN、替换为 0/50 等不同策略。
- 建议：写一份 TA NaN policy 表，按函数对齐 Pine；测试覆盖 warmup、内部 NaN、尾部 NaN 三类场景。

### [P4-07] `math.random` 默认不可复现，威胁运行时确定性

- 结论：需语义决策。
- 证据：`math_ext.random()` 无 seed 时使用 `np.random.default_rng(None)`，每次执行随机。
- 建议：如果运行时要求可复现，应由 settings 提供默认 seed；如果对齐 Pine 的随机行为，则文档标明 nondeterministic。

### [P4-08] `str.format` 与 Pine / Python 格式说明符不兼容

- 结论：确认存在。
- 证据：`string_ext.py` 先尝试 Python `.format()`，失败后做简单占位替换；这无法完整表达 Pine 的格式规则。
- 建议：实现 Pine format token parser，或明确声明当前是 Python 子集。

### [P4-09] 时间毫秒/秒启发式与时区偏移解析受限

- 结论：确认存在。
- 证据：timestamp 用绝对值阈值判断秒/毫秒；未知时区回退 UTC，偏移解析只覆盖有限格式。
- 建议：要求显式单位，或把启发式行为写入文档；未知时区建议抛错而非静默 UTC。

### [P4-10] 普遍的逐 bar Python 循环，大序列性能存在热点

- 结论：确认存在。
- 证据：TA、rolling utils、linreg/correlation、lower timeframe 等大量按 bar Python 循环。
- 建议：先 benchmark 定位热点；对稳定函数向量化或使用滑动窗口数据结构，避免一次性大范围重写。

### [P4-11] `math_ext` 默认 `mintick=0.01` 与实际注入 `1.0` 不一致（交叉 P3-02 / P2-08）

- 结论：确认存在。
- 证据：`PyneMath.__init__` 默认值与 `SymbolInfo` 默认值不同；runtime 正常路径使用后者。
- 建议：与 P0-04/P2-08/P3-02 合并修复，保留一个唯一默认。

## P5 - 输入、集合与状态

### [P5-01] 同标题输入参数共享同一 key，导致 schema 去重 + 取值串扰

- 结论：确认存在。
- 证据：`input.py` 使用 title 或类型/index 生成 key；相同 title 会命中同一 `_params` 和 `_seen_keys`。
- 建议：key 应包含调用序号或显式 id；schema 可保留 title 但内部 key 必须唯一。

### [P5-02] `PyneArray.__init__` 使用 `values or []`，传入 numpy 数组会抛“真值歧义”

- 结论：确认存在。
- 证据：运行探针 `PyneArray(np.array([1,2,3]))` 抛 `ValueError: truth value of an array ... is ambiguous`。
- 建议：改为 `list(values) if values is not None else []`。

### [P5-03] 数组成员检测对 `na`/`NaN` 永不命中

- 结论：部分存在。
- 证据：`indexof/includes` 依赖 Python equality/list search；数值 NaN 不等于自身，因此无法按值命中。`PyneNA` 单例在某些身份场景可能命中，但语义不稳。
- 建议：实现专用 missing-aware equality，明确 `na` 与 `NaN` 的成员检测规则。

### [P5-04] `array.sort` 对 `NaN`/混合类型行为未定义

- 结论：确认存在。
- 证据：`PyneArray.sort()` 直接调用 Python list sort；混合类型会 TypeError，NaN 排序位置不稳定。
- 建议：定义排序 key 和 missing placement；非法混合类型返回统一 Pyne 错误。

### [P5-05] `input.source` 依赖对象 identity 反查来源，回退“close”被静默吞掉

- 结论：确认存在。
- 证据：`_identify_source()` 用对象 identity/array identity 识别，失败后默认返回 `"close"`。
- 建议：为 `PyneSeries` 携带 source id/name；识别失败应保留用户传入表达式或报诊断。

### [P5-06] `PyneVar.reset` 绕过 `to_missing_scalar` 归一，na 处理与 `set`/`set_each` 不一致

- 结论：确认存在。
- 证据：`PyneVar.reset()` 直接赋默认值，`set()`/`set_each()` 则会走 missing 归一逻辑。
- 建议：reset 复用 set 的归一化路径，或抽出 `_normalize_value()`。

### [P5-07] `PyneVar.set_each` 用 object 数组 + Python 逐条循环承接状态

- 结论：确认存在。
- 证据：`set_each()` 构造 object array 并逐项处理 missing。
- 建议：若只承载标量 numeric，可走 vectorized float array；保留 object fallback 但减少常规路径开销。

### [P5-08] `PyneVar` 把私有字段暴露为 dataclass 构造参数

- 结论：确认存在。
- 证据：`PyneVar` 是 dataclass，默认值和内部 `_value` 字段可经构造参数传入。
- 建议：使用 `field(init=False)` 隐藏内部状态，提供工厂或 `__post_init__` 初始化。

### [P5-09] `input.int/float` 对越界用户值静默 clamp、对非法值抛非 errors.py 异常

- 结论：确认存在。
- 证据：int/float input 会对 min/max 静默夹取；非法类型转换抛 Python `ValueError`/`TypeError`。
- 建议：越界策略需显式：要么 clamp 并记录 schema warning，要么报用户输入错误；异常统一映射到 errors.py。

### [P5-10] 输入参数与 namespace 共享同一可变 `params` 字典（与 P3-06 同源）

- 结论：确认存在。
- 证据：同 P3-06，`params` 同时交给 `InputModule` 与脚本全局变量。
- 建议：和 P3-06 合并整改：只读副本、显式 mutation API、测试脚本内修改不影响 input 解析。

## P6 - 绘图与结果输出

### [P6-01] drawing 上限只约束可变对象，序列/标记类输出完全不限量

- 结论：部分存在。
- 证据：drawing collector 对对象数量有 `max_drawing_objects`，security 对部分 series/marker 点数有限制；但 `bgcolors`、`barcolors`、`signals`、`fills`、`hlines`、objects/strategy 事件没有统一输出限额。
- 建议：把输出限额从个别 key 扩展为 schema 级统一策略，分别限制点数、对象数和事件数。

### [P6-02] `plot(color=<数组>)` 的逐 bar 颜色被丢弃，仅取首 bar 颜色

- 结论：确认存在。
- 证据：line plot 分支只有 `color_array` 参数会写入每个 point 的 color；传 `color=<数组>` 时 line entry 取首个颜色，point 没有逐 bar color。
- 建议：统一 `color` 与 `color_array` 的处理，数组/序列颜色都应落到每个点。

### [P6-03] 绘图对象坐标取自序列时坍缩为“最后一个非 na 值”，与 Pine 逐 bar 创建语义不一致

- 结论：确认存在。
- 证据：绘图对象创建会把序列值转为单个标量，缺少“每根 bar 生成对象/事件”的语义。
- 建议：区分静态对象 API 和逐 bar 对象事件 API；序列坐标应产生事件流或要求用户显式给标量。

### [P6-04] drawing 上限超限抛裸 `RuntimeError`，未走 errors.py 统一错误面

- 结论：确认存在。
- 证据：`plot/collector.py` 的对象上限检查直接抛 `RuntimeError`；runtime 会归入泛型运行时错误。
- 建议：新增 `PyneOutputLimitError` 或复用 security typed error，错误码与 hint 统一。

### [P6-05] 对失效/已删除引用的 setter 静默 no-op

- 结论：确认存在。
- 证据：line/label/box/table 等 setter 找不到 entry 时直接跳过。
- 建议：至少在 strict/debug 模式发 warning；对已经删除的引用和从未存在的引用区分错误。

### [P6-06] `bgcolor` 不支持逐 bar 颜色，Pine 的 `cond ? color : na` 着色有损

- 结论：确认存在。
- 证据：当前 `bgcolor` 记录 condition 和单一 color，缺少每根 bar 颜色数组。
- 建议：支持颜色序列，输出中记录 per-bar region/color，兼容 `na` 代表无背景。

### [P6-07] `plot(style="histogram")` 的 `color_up` 与 `color_down` 取同一颜色，与 `bar()` 语义不一致

- 结论：需语义决策。
- 证据：histogram scalar color 分支会把 up/down 都设为同一颜色；`bar()` 有按正负区分的 color_up/color_down。
- 建议：如果 Pyne 期望 histogram 默认按正负着色，应补默认分色；如果对齐 Pine 的显式 color 表达式，则文档说明差异。

### [P6-08] `_color_for_index` 处理 list[dict] 时 `"time" not in item` 导致对齐脆弱

- 结论：确认存在。
- 证据：颜色 dict 缺 time 时退化为按索引对齐；输入既可以 time 对齐也可以 index 对齐，混用时容易错位。
- 建议：颜色序列统一为带 time 的 series-like 结构；缺 time 时明确按 index，且校验长度。

### [P6-09] `PyneResult.to_frame` 按时间合并多条序列时同名列静默覆盖

- 结论：确认存在。
- 证据：`result.py` 构造行时使用 `row[str(name)] = value`，同名序列会覆盖前一列。
- 建议：列名冲突时自动加后缀或抛错；保留原始 series id。

### [P6-10] 绘图层 legacy 别名与函数对象属性较多，维护面偏大

- 结论：确认存在。
- 证据：`plot/functions.py` 同时维护 plot、bar、drawing 对象、别名、函数对象属性等多类兼容入口。
- 建议：梳理 public API 清单，把 legacy alias 标记 deprecated；内部按 plot、drawing、style helper 拆分模块。

## P7 - request/security 与跨周期数据

### [P7-01] 默认 `lookahead=off` 仍以 HTF bar 开盘时间对齐，可能泄漏“未收盘”高周期值（前视/重绘偏差）

- 结论：确认存在风险。
- 证据：alignment 使用 requested bar 的 open time 与 chart time 对齐，没有用 requested close time gate 当前 HTF bar 是否已确认。
- 建议：默认 lookahead off 应只暴露已收盘 HTF bar；需要 provider 提供或推导 `time_close`，并增加 HTF/LTF parity 测试。

### [P7-02] provider capability 校验默认放行，dict 缺键或 None 时不拦截

- 结论：确认存在。
- 证据：provider capabilities 为 `None` 或 dict 缺少相关 key 时，校验返回支持。
- 建议：默认 deny 更安全；缺 capability 应返回结构化“不确定/不支持”，除非 provider 显式声明 permissive。

### [P7-03] `LowerTimeframeSeries` 聚合按 chart bar 逐组构建 Python 列表再 numpy 运算

- 结论：确认存在。
- 证据：lower timeframe 聚合为每个 chart bar 构造 Python list/array 再 reduce。
- 建议：对大数据实现向量化 group reduce 或预分组索引；先增加性能基准。

### [P7-04] `_requested_context_cache` 无上限

- 结论：确认存在但作用域有限。
- 证据：`RequestModule` 内部缓存 requested context，未设置 max size；该模块通常随一次 runtime execution 构造，风险主要在单次脚本中请求大量 symbol/timeframe。
- 建议：增加 per-execution LRU/数量上限，并把超限映射为 Pyne 请求错误。

### [P7-05] 历史偏移解析对非法下标静默回退为 0（当前 bar）

- 结论：确认存在。
- 证据：request eval 解析历史 index 失败时返回 offset 0。
- 建议：非法下标应抛 validation/request error；至少 debug 模式 warning，避免把错误脚本变成当前 bar 读取。

### [P7-06] 对齐结果统一强制 `float64`，布尔/类型语义丢失

- 结论：确认存在。
- 证据：alignment 输出 `np.asarray(values, dtype=np.float64)`。
- 建议：保留原 dtype 或返回 typed series；数值计算时再显式转换。

### [P7-07] provider 返回的 OHLCV 缺乏结构校验，缺 `time` 默认 0 影响排序

- 结论：确认存在。
- 证据：provider bars 按 `item.get("time", 0)` 排序，后续 `PyneContext.from_ohlcv()` 对缺失 OHLCV 又会补 0。
- 建议：provider 返回值进入 runtime 前必须走严格 normalizer；缺 time/OHLCV 直接报 provider contract error。

### [P7-08] `security_lower_tf` 末根 chart bar 的分组为开区间，纳入尾部所有 lower-tf bar

- 结论：确认存在。
- 证据：末根 chart bar 没有 next chart time 时，lower-tf group 的结束位置取 requested_times 末尾。
- 建议：末根未确认时应根据 session/time_close 或当前 bar 状态裁剪；至少对 preview/closed 状态区分。

## P8 - 策略回放与订单语义

### [P8-01] 每次策略 API 调用都对全量订单历史做整体重放，close/exit 更在逐 bar 循环内重放，复杂度爆炸

- 结论：确认存在。
- 证据：strategy module 的 entry/order/close/exit/cancel 等每次追加事件后调用 `_replay_position()`；close/exit 在循环中多次触发。
- 建议：批量收集订单事件后单次 replay，或实现增量 ledger；先加订单数量维度 benchmark。

### [P8-02] 风险强平合成订单写回持久 `strategy_orders`，重复重放会累积重复合成单

- 结论：确认存在。
- 证据：batch replay 的风险强平函数会 append synthetic order 到 collector 的持久 `strategy_orders`。
- 建议：replay 过程不应写回输入事件流；合成单应进入独立输出流或带 deterministic id 去重。

### [P8-03] 市价单在信号 bar 当根以收盘价（或指定价）成交，而非 Pine 默认的下一根开盘

- 结论：需语义决策，当前实现确认为同 bar 成交。
- 证据：replay 按订单 timestamp 在当前 bar 处理，并用当前 bar 价格基准成交。
- 建议：明确 Pyne 策略成交模型；若要兼容 Pine 默认，应支持 next-bar-open，并把 process_orders_on_close 作为显式模式。

### [P8-04] 持仓 size 以未取整 float 累积，`== 0` 精确判定可能漏掉 epsilon 残留持仓

- 结论：确认存在。
- 证据：成本/仓位计算中有多处 `current_size == 0`、`new_size == 0` 等精确浮点比较。
- 建议：使用 mintick/qty precision 或 epsilon 判定；成交数量统一量化。

### [P8-05] 方向 / OCA 类型等归一化对非法值静默回退，缺乏校验

- 结论：确认存在。
- 证据：risk/replay/orders 的 normalize helper 对未知方向、risk mode 等返回默认值。
- 建议：非法枚举应抛用户输入错误；仅对缺省值使用默认。

### [P8-06] mintick / 滑点 / 限价校验依赖 `syminfo.mintick`，与 P2-08、P3-02 同源默认值问题联动

- 结论：确认存在。
- 证据：strategy 模块使用 syminfo mintick 进行价格步进/滑点相关计算；默认值不统一会改变成交价格。
- 建议：先统一 mintick 默认；策略层对缺失/非法 mintick 做显式校验。

### [P8-07] 风险强平合成单 id 直接用 reason，可能与用户订单 id 冲突并进入 lifecycle

- 结论：确认存在。
- 证据：batch 风险强平 synthetic order 的 id 使用 reason 字符串。
- 建议：使用内部保留命名空间，例如 `__pyne_risk_liquidation:{reason}:{bar}`，并避免和用户订单混在同一 id 空间。

### [P8-08] 事件发射层大量 `*` / `*_when` 包装 + 逐 bar Python 循环，性能与维护面偏大

- 结论：确认存在。
- 证据：strategy module 中大量 wrapper 函数和 per-bar 条件循环，且常伴随 replay。
- 建议：抽出统一条件展开器和事件构造器；性能问题与 P8-01 一并验证。

## P9 - 增量执行

### [P9-01] 预览态每根 bar 对整个 context 做全量 `deepcopy`，且克隆后又清空 series/markers（先拷后弃）

- 结论：确认存在。
- 证据：`IncrementalContext.clone_for_preview()` 对 self 做 `copy.deepcopy()`，随后清空 `_series`、`_markers` 等。
- 建议：实现轻量 preview overlay，只复制会被写入的状态；不拷贝随后丢弃的数据。

### [P9-02] 长生命周期会话中 `_orders`/`_closed_trades`/`_object_events`/series data 无上限累积，安全模式限额未覆盖

- 结论：确认存在。
- 证据：增量 strategy/context 保存订单、交易、对象事件、series 数据；除部分 window/drawing 限制外没有统一会话上限。
- 建议：为增量会话增加 retention policy 和安全限额，支持按 bar 数/事件数裁剪。

### [P9-03] 读取 strategy 标量属性会触发风险强平副作用，纯读产生持仓/账本变更且结果依赖读取时机

- 结论：确认存在。
- 证据：增量 strategy 的 `position_size`、`equity` 等 property 会调用 `_sync_risk_liquidation()`。
- 建议：属性读取必须无副作用；风险同步应在 bar step 生命周期固定阶段执行。

### [P9-04] 增量引擎与批量回放引擎为两套独立实现，存在显著语义漂移风险

- 结论：确认存在。
- 证据：batch strategy replay 与 incremental strategy 分别维护订单、成交、风险和 ledger 逻辑。
- 建议：抽共享核心成交/风险计算，或建立高覆盖 parity matrix 作为长期门禁。

### [P9-05] 增量 TA 为独立逐步实现，EMA 种子 / RSI·ATR 的 Wilder 平滑需与批量 ta 严格对齐

- 结论：确认存在。
- 证据：`incremental/ta.py` 有独立 `_StepSMA`、`_StepEMA`、`_StepRSI`、`_StepATR` 等实现。
- 建议：把 seed/warmup/NaN policy 抽为共享 spec；增量和批量都跑同一批 golden。

### [P9-06] manager 去重缓存的 event_key 仅含 OHLCV 标量，忽略 session_*/其它 raw 字段，且 time 缺省回退 0 易碰撞

- 结论：确认存在。
- 证据：manager event key 由 preview/closed、time 或 0、OHLCV 组成，不包含 raw/session/metadata。
- 建议：key 使用规范化 bar hash，缺 time 时拒绝或使用唯一序号；把 session 相关字段纳入 hash。

### [P9-07] 每根 bar 双重 `deepcopy`（缓存一份 + 返回一份），叠加 `Window.__getitem__` 每次全量 `list()` 取值

- 结论：部分存在。
- 证据：manager 对缓存写入和缓存命中返回使用 deepcopy；fresh process 返回路径没有完全“双重”同形态，但整体复制成本确实高。`Window.__getitem__` 每次把 deque 转 list。
- 建议：缓存结果改不可变快照或 copy-on-write；Window 支持正负索引的 O(1)/低成本访问。

### [P9-08] `is_incremental_pyne_script` 直接 `ast.parse` 未捕获 `SyntaxError`，非法脚本抛出裸异常

- 结论：确认存在。
- 证据：运行探针 `is_incremental_pyne_script("if")` 直接抛 `SyntaxError`；函数内部没有 try/except。
- 建议：由上层先 parse 一次并传 AST，或在该函数内返回 false/typed diagnostic。

### [P9-09] 增量风险强平合成单 id 复用风险原因字符串，可能与用户订单 id 冲突（与 P8-07 同源）

- 结论：确认存在。
- 证据：增量 strategy 风险强平订单 id 也使用 reason 字符串。
- 建议：与 P8-07 共用内部 synthetic id 方案，并保留原 reason 为独立字段。

## P10 - 测试、golden 与 CI 门禁

### [P10-01] 增量会话管理与限额完全无测试覆盖

- 结论：部分存在，原描述过强。
- 证据：当前有 `tests/test_incremental.py`，覆盖了若干增量与策略 parity；但 SessionManager、IncrementalLimits、process_bar/ref_count 等管理面覆盖不足。
- 建议：把问题改写为“管理层与限额覆盖不足”；补 session lifecycle、cache/refcount、limit enforcement 测试。

### [P10-02] ta/request golden 为运行时自快照，不提供与 Pine 的正确性基准

- 结论：确认存在。
- 证据：TA golden 文件标明是 Pyne-defined fixture，request/TA 测试主要对当前期望 JSON 做精确比对，不等同 TradingView/Pine 基准。
- 建议：逐步替换为 TradingView capture 或可信参考实现；保留 Pyne snapshot 只能作为回归测试。

### [P10-03] process 执行器仅冒烟，缺 inline↔process 输出 parity

- 结论：确认存在。
- 证据：`tests/test_executor.py` 覆盖简单 process 执行和 timeout，但没有同脚本 inline/process 输出等价断言。
- 建议：增加 provider/syminfo/params/output 多场景 parity；尤其覆盖 Windows spawn 可序列化边界。

### [P10-04] strategy_pine_equivalent 含未捕获参考的占位用例

- 结论：确认存在。
- 证据：strategy golden harness 对 `not_captured` 状态会跳过真实参考值断言，多个策略 fixture 仍为未捕获状态。
- 建议：把未捕获用例标记 xfail 或从 parity 门禁中移出；补齐 capture 后再启用严格断言。

### [P10-05] pytest/CI 配置缺少严格门禁（警告、标记、覆盖率）

- 结论：确认存在。
- 证据：`pyproject.toml` pytest 配置较轻量，只配置 testpaths/pythonpath；未见 warnings-as-errors、strict markers、coverage 门槛。
- 建议：分阶段加 `--strict-markers`、warning 过滤、覆盖率报告；先不要直接高门槛卡死现有开发。

### [P10-06] examples 仅冒烟，无数值 golden

- 结论：确认存在。
- 证据：`tests/test_examples.py` 主要断言示例能执行、meta/output 存在，不校验核心数值。
- 建议：为关键 examples 增加小数据集数值快照；示例 smoke 与 correctness 分开。

### [P10-07] 增量↔批量 parity 仅极小样本，未覆盖复杂路径与预览副作用

- 结论：部分存在，原描述已偏旧。
- 证据：当前 `tests/test_incremental.py` 已包含多组策略 parity，不只是极小 3-bar 样本；但 preview 副作用、长序列、复杂风险/OCA/request 路径仍不足。
- 建议：保留“覆盖不足”结论，删除“仅极小样本”的绝对表述；用矩阵列出已覆盖和未覆盖场景。

### [P10-08] CLI run 的失败/超时/进程模式分支无契约测试

- 结论：确认存在。
- 证据：CLI 测试覆盖 schema/validate/version 和部分 happy path；对 run 的读取失败、timeout、process executor 分支缺少契约断言。
- 建议：补 CLI 黑盒测试，固定 stderr/stdout JSON、退出码、错误码。

### [P10-09] golden 浮点用精确相等，跨平台脆性且与 strategy 容差不一致

- 结论：确认存在。
- 证据：TA/request golden 多处使用精确列表 equality；strategy 外部 capture 路径使用容差比较。
- 建议：统一浮点比较 helper，支持 NaN 等价、绝对/相对容差和 dtype 检查。
