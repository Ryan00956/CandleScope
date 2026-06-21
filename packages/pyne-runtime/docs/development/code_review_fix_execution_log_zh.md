# 代码审查问题修复执行日志

本文记录 `code_review_issue_validation_zh.md` 中问题的逐条处理结果。规则：

- 明确 bug：直接修复，并记录上下文、改动和验证。
- 语义不确定、公共 API 设计、执行模型取舍：不强行修改，记录暂缓原因和后续决策点。
- 每个编号只记录一次最终处理状态；同源问题会互相引用，但仍保留原编号。

## P0 - 运行/配置入口

### [P0-01] 进程执行模式在 Windows / spawn 下 provider 可能无法 pickle

- 上下文：process executor 会把 `script/ohlcv/params/security_mode/settings` 作为子进程参数传递；Windows spawn 要求这些参数可 pickle，尤其 `settings.data_provider` 容易是宿主对象。
- 处理：修复。进入 process executor 前增加参数 pickle 预检，失败时返回结构化 `PYNE_PROCESS_SERIALIZATION_ERROR`，避免 `process.start()` 在 Windows 上裸抛。
- 验证：新增/运行 executor 定向测试。

### [P0-02] 同名函数 `normalize_security_mode` 行为分歧（raise vs 静默回退）

- 上下文：settings 侧对非法 security mode 静默回退 `safe`，security 侧抛错。
- 处理：修复。settings 侧改为显式 `ValueError`，使无效配置不会被静默降级。
- 验证：新增/运行 settings/security 定向测试。

### [P0-03] `with_security_mode` 手工逐字段复制，易随新字段遗漏

- 上下文：`PyneSettings.with_security_mode()` 手工重建 dataclass，新增字段容易漏传。
- 处理：修复。改为 `dataclasses.replace()`，保留所有既有字段。
- 验证：新增/运行 settings 定向测试。

### [P0-04] `mintick` 默认值不一致（1.0 vs 0.01）

- 上下文：`SymbolInfo` 默认 `mintick=1.0`，但 `PyneMath` 和 namespace fallback 使用 `0.01`。
- 处理：修复。`PyneMath` 默认和 fallback 统一到 `1.0`。
- 验证：新增/运行 math/metadata 定向测试。

### [P0-05] 运行时异常信息直接回传，存在信息泄露风险

- 上下文：当前 runtime 泛型异常返回 `Script error: {exc}`；这对本地调试有价值，但生产多租户场景可能泄露内部信息。
- 处理：暂缓。该项需要先定义 debug/production 错误暴露策略；直接隐藏异常会破坏现有错误可诊断性和部分测试契约。
- 后续建议：新增 settings 选项，例如 `expose_runtime_error_details`，默认按执行环境决定。

### [P0-06] CLI `run` 未捕获脚本/数据读取异常

- 上下文：CLI 在进入 runtime 前读取 params、OHLCV、script、输出文件；其中部分异常会直接冒泡。
- 处理：修复。`run` 子命令包裹读取/执行/写出阶段，返回 JSON 格式 CLI 错误和非 0 退出码。
- 验证：新增/运行 CLI 定向测试。

### [P0-07] `_read_script` 字符串/路径启发式存在歧义

- 上下文：API 中 `str` 既可能是脚本文本，也可能是文件路径；现有行为会在无换行且路径存在时读文件。
- 处理：暂缓。该项属于公共 API 设计变更，直接移除 str path 兼容会破坏已有调用方。
- 后续建议：新增显式 `run_file()` / `validate_file()` 或 keyword-only `script_path`，并逐步弃用启发式。

### [P0-08] `validate()` 不校验运行期资源限制，仅语法 + import 安全

- 上下文：当前 validate 是静态语法/安全导入检查；运行期资源限制需要数据和实际执行上下文。
- 处理：暂缓。当前行为不是明确 bug，而是函数契约需要命名/文档澄清。
- 后续建议：保留 `validate()` 为静态检查，另增 `dry_run_validate()` 或 contract validate。

### [P0-09] inline 模式下全局 `pyne_cache` 被每次构造 runtime 重配置

- 上下文：缓存目前是进程全局单例；改为 runtime scoped 会改变脚本可见的 cache 行为。
- 处理：暂缓。属于执行模型/隔离边界设计问题，不在 P0 第一批中强改。
- 后续建议：先确定 cache 是全局、session scoped 还是 execution scoped，再迁移。

### [P0-10] `execute_pyne_script` 的 provider/syminfo 透传仅覆盖 inline，进程路径依赖 settings 序列化

- 上下文：provider 等对象实际会写入 settings 并传给 process；风险点是 process 参数必须可 pickle。
- 处理：修复。与 P0-01 同源，通过 process 参数序列化预检覆盖。
- 验证：同 P0-01。

## P1 - 安全与隔离

### [P1-01] safe/research 模式不是真正的沙箱，可通过 `__globals__` 逃逸（高危）

- 上下文：当前限制主要依赖 builtins/import 白名单，namespace 仍暴露 Python 对象和完整 `numpy`。
- 处理：暂缓。该项是安全边界设计，不适合用局部 patch 假装修复；真正修复需要 process/container 级隔离和安全威胁模型。
- 后续建议：把 safe/research 文档改名为“受限环境”，不承诺沙箱；不可信脚本默认 process/container。

### [P1-02] `enforce_output_limits` 未覆盖全部 OUTPUT_KEYS，输出上限可绕过

- 上下文：原实现只统计 lines/histograms/bars/markers，漏掉 barcolors/bgcolors/signals/hlines/fills/objects 等。
- 处理：修复。输出限制改为遍历 schema 的 `OUTPUT_KEYS`，并递归统计 `data`/`regions` 点数。
- 验证：新增/运行 barcolor 超出 max_output_points 的定向测试。

### [P1-03] `pyne_cache` 进程全局单例，inline 模式跨脚本串扰/泄漏（承 P0-09）

- 上下文：cache 作用域与 P0-09 相同，脚本可通过多个入口访问同一个全局缓存。
- 处理：暂缓。需要先决定 cache 作用域，避免破坏现有 cache API。
- 后续建议：与 P0-09 合并设计 execution/session scoped cache。

### [P1-04] `execution_timeout` 仅主线程+Unix 生效，inline 模式 Windows 无超时

- 上下文：Windows inline 没有可靠的信号中断机制；强制超时需要进程或 worker 级隔离。
- 处理：暂缓。该项属于执行后端设计，不能在 inline 中可靠局部修复。
- 后续建议：不可信脚本强制 process；inline 文档标明 best-effort。

### [P1-05] `classify_security_error` 依赖错误消息子串匹配，脆弱

- 上下文：错误码分类来自消息文本，短期可用但不稳定。
- 处理：暂缓。需要引入 typed security/output exception 或 exception code 字段，影响错误面较广。
- 后续建议：新增 `PyneSecurityError(code=...)` 后迁移分类逻辑。

### [P1-06] `SAFE_BUILTINS` 缺 `__build_class__` 等，safe/research 下无法定义 class

- 上下文：补 `__build_class__` 会扩大安全面；是否支持 class 需要和 P1-01 的受限环境边界一起决定。
- 处理：暂缓。当前不直接开放 class。
- 后续建议：若决定支持 class，先写逃逸回归测试，再以显式 feature gate 开放。

### [P1-07] `cache.get_or_load` 并发语义与 TTL 语义需文档化

- 上下文：当前 miss 后释放锁执行 loader，可能重复加载；TTL 目前从 loader 完成后开始，已有测试覆盖。
- 处理：暂缓。不是明确 bug，属于 cache single-flight 语义选择。
- 后续建议：如 provider 请求成本高，再实现 per-key in-flight 合并。

### [P1-08] `validate_script_security` 对 SyntaxError 静默跳过安全检查

- 上下文：直接调用 security validator 时，非法语法会被静默 return；runtime/api 上层虽有语法处理，但函数自身契约不安全。
- 处理：修复。移除 SyntaxError 静默吞掉逻辑，让语法错误向上层传播。
- 验证：新增/运行 direct validator SyntaxError 定向测试，并确认 `api.validate()` 仍返回语法诊断。

## P2 - 数据模型与序列语义

### [P2-01] 缺少对时间戳单调递增 / 唯一性的校验

- 上下文：`PyneData` 和 runtime context 都会接收 OHLCV；原 context 路径还会把缺失 time 补 0。
- 处理：修复。`PyneData.from_ohlcv()` 增加唯一性和严格递增校验，`PyneContext.from_ohlcv()` 统一先走 `PyneData` normalizer。
- 验证：新增/运行 duplicate/non-monotonic time 定向测试。

### [P2-02] 最后一根 bar 的 `time_close` 退化为 NaN

- 上下文：无显式 `time_close` 时，非最后一根用下一根 time，最后一根原来只能 NaN。
- 处理：修复。最后一根使用当前 timeframe 推导 close time；无法识别 timeframe 时仍保留 NaN。
- 验证：新增/运行 `timeframe="1h"` 下最后一根 `time_close` 测试。

### [P2-03] 派生序列（hl2/hlc3/ohlc4/hlcc4）携带错误的 `name`

- 上下文：`PyneSeries` 二元运算保留左操作数 name，派生字段会继承 `high/open` 等名字。
- 处理：修复。派生属性构造时显式设置 `hl2/hlc3/ohlc4/hlcc4` 名称。
- 验证：新增/运行使用 `hl2.name` 等作为 plot title 的测试。

### [P2-04] `na` 与序列的算术不对称、会丢失形状

- 上下文：`series + na` 走 series 运算并保持形状，`na + series` 原来走 `PyneNA` 标量 NaN。
- 处理：修复。`PyneNA` 遇到 `PyneSeries` 时返回同长度全 NaN 序列。
- 验证：新增/运行 `pn.na + PyneSeries` 定向测试。

### [P2-05] OHLC 数值缺少合理性校验

- 上下文：原 normalizer 只做类型转换，不校验 high/low 是否覆盖 open/close，也不校验 volume 非负。
- 处理：修复。`PyneData` 增加 OHLC 关系和非负 volume 校验；runtime context 复用同一入口。
- 验证：新增/运行非法 OHLC/volume 定向测试。

### [P2-06] 两条入口对缺失字段的严格度不一致

- 上下文：`PyneData` 要求字段完整，`PyneContext` 原来用 `get(..., 0)` 补默认。
- 处理：修复。`PyneContext.from_ohlcv()` 先调用 `PyneData.from_ohlcv()`，缺字段统一报错。
- 验证：新增/运行 runtime 缺 `close` 字段测试。

### [P2-07] `PyneSeries` 不可哈希且 `==` 返回序列，集合 / `in` 操作会异常

- 上下文：这是向量化 series 语义与 Python 容器协议的冲突；当前行为能防止误用，但错误信息可改进。
- 处理：暂缓。不是数值 bug，直接改 `==` 会破坏 Pine-like 表达式。
- 后续建议：显式文档化不可 hash，并为身份比较提供专用 helper。

### [P2-08] namespace 中 `mintick=0.01` 兜底为不可达死代码（对 P0-04 的补充）

- 上下文：与 P0-04 同源。
- 处理：修复。namespace fallback 改为 `1.0`。
- 验证：同 P0-04。

### [P2-09] 时间框架 `multiplier` 单位混用，字段语义含糊

- 上下文：当前 public `TimeframeInfo.multiplier` 已被测试和脚本使用，直接改字段语义会破坏兼容性。
- 处理：暂缓。属于 API 设计问题。
- 后续建议：新增 `amount/unit/duration_seconds` 字段，保留旧 multiplier 兼容。

### [P2-10] DataFrame 识别仅靠模块名前缀，扩展性差

- 上下文：原来通过模块名前缀判断 pandas DataFrame。
- 处理：修复。改为在 pandas 可用时使用 `isinstance(value, pd.DataFrame)`。
- 验证：数据入口测试随 P2 组一起运行；如后续支持 DataFrame protocol，再增加独立测试。

## P3 - 命名空间装配

### [P3-01] 直接向脚本注入完整 `numpy`，绕过策略形成文件 I/O / 代码执行面

- 上下文：`np`/`numpy` 是现有公开兼容入口，直接删除会破坏大量脚本；安全上又和 P1-01 同源。
- 处理：暂缓。归入安全模型重设计，不做局部破坏式修改。
- 后续建议：增加 settings feature gate，safe 默认只暴露白名单数学函数，research/unsafe 才暴露完整 numpy。

### [P3-02] `math` 的 `mintick` 兜底 `0.01` 为不可达死代码（对 P2-08 的呼应）

- 上下文：与 P0-04/P2-08 同源。
- 处理：修复。`PyneMath` 默认值和 namespace fallback 统一为 `1.0`。
- 验证：同 P0-04。

### [P3-03] 多个 `install_*` 函数对同名键无冲突检测，存在静默覆盖风险

- 上下文：namespace 按阶段安装 data/api/plot/utility/compat/builtins，跨阶段覆盖原来不会报警。
- 处理：修复。`build_script_namespace()` 包装每个 installer，检测跨阶段覆盖并抛内部错误。
- 验证：运行 input/plot/API 定向测试，确认现有 namespace 无意外冲突。

### [P3-04] 大量 Python 内建名被刻意遮蔽，需明确文档化

- 上下文：`open/time/str/map/input` 等 Pine 兼容名遮蔽 Python 名称，这是设计兼容取舍。
- 处理：暂缓。不是实现 bug。
- 后续建议：补 namespace 参考文档和常见误用诊断。

### [P3-05] `RuntimeServices.__post_init__` 急切构造全部子模块

- 上下文：急切构造会有性能成本，但也保持执行装配简单。
- 处理：暂缓。需 profile 后决定是否懒加载。
- 后续建议：先增加 runtime startup benchmark。

### [P3-06] 原始可变 `params` 字典被直接注入命名空间且与 input 模块共享引用

- 上下文：脚本能通过 `params` 修改 input 模块使用的同一 dict。
- 处理：修复。namespace 暴露只读 `MappingProxyType(dict(...))` 副本，input 模块继续使用自己的参数来源。
- 验证：新增/运行脚本内修改 `params` 被拒绝且 `input.int()` 仍读取原覆盖值的测试。

### [P3-07] `__builtins__` 由 `build_builtins(policy)` 注入（对 P1 的装配侧记录）

- 上下文：这是安全策略装配机制本身。
- 处理：暂缓。不是 bug；与 P1-01/P1-06 的安全边界设计一起处理。
- 后续建议：给每个 security mode 增加 builtins 快照测试。

### [P3-08] `pyne` / `cache` 等多入口指向同一缓存，作用域与隔离需文档化

- 上下文：与 P0-09/P1-03 同源。
- 处理：暂缓。等待 cache 作用域设计。
- 后续建议：若保留全局缓存，明确 `pyne.cache`、`cache`、`cache_clear` 为同一对象入口。

## P4 - TA/数学/时间/字符串语义

### [P4-01] `ta.sma` 用 `nancumsum` 处理 NaN，窗口含 NaN 时结果错误（不返回 na）

- 上下文：`np.nancumsum` 把 NaN 当 0 累加，导致含 NaN 的窗口仍产出数值。
- 处理：修复。SMA 改为同时维护窗口 sum 和有效值计数，只有窗口内有效值数量等于 period 时才输出平均值。
- 验证：新增/运行含内部 NaN 的 SMA 定向测试。

### [P4-02] 平窗口振荡指标返回中性常数而非 na

- 上下文：CMO/WPR/STOCH/CCI 等对分母为 0 的处理涉及 Pine 兼容性。
- 处理：暂缓。需要 TradingView/Pine capture 或明确产品语义后再改。
- 后续建议：为每个指标补平窗口 golden，再决定保留中性值还是改 NaN。

### [P4-03] `adx`/`dmi` 用 `nan_to_num(dx, 0)` 把热身期 NaN 污染为 0

- 上下文：看起来是语义风险，但会影响 ADX/DMI golden 和 strategy 输出。
- 处理：暂缓。需要 Pine 参考数据验证 warmup 期望。
- 后续建议：补 ADX/DMI capture 后再移除 `nan_to_num`。

### [P4-04] 模块内存在多套语义不一致的 EMA 实现

- 上下文：EMA/RMA/TSI 内部平滑函数存在不同 seed/NaN 策略。
- 处理：暂缓。属于重构和语义统一，不是单点 bug。
- 后续建议：先写 EMA policy 表和 parity 测试，再抽共享内核。

### [P4-05] `highest`/`lowest` 缺少 `period<=0` / `period>n` 边界保护

- 上下文：`highest/lowest` 对 `period<=0` 会形成空窗口并触发 numpy 空数组错误；`period>n` 当前自然返回全 NaN。
- 处理：修复。`period<=0` 直接返回全 NaN，与 `highestbars/lowestbars` 的防护一致。
- 验证：新增/运行 invalid period 定向测试。

### [P4-06] 各函数间 NaN 策略不统一

- 上下文：这是跨 TA 库的系统性语义问题。
- 处理：暂缓。当前已修一个明确错误的 SMA；其余需逐函数 golden。
- 后续建议：建立 NaN policy matrix，逐项迁移。

### [P4-07] `math.random` 默认不可复现，威胁运行时确定性

- 上下文：未传 seed 时随机是否可复现是产品语义；传 seed 当前已有确定性测试。
- 处理：暂缓。
- 后续建议：若要求整体 deterministic replay，增加 runtime-level seed。

### [P4-08] `str.format` 与 Pine / Python 格式说明符不兼容

- 上下文：当前实现是 Python format 加简易 fallback，不是完整 Pine formatter。
- 处理：暂缓。需要 Pine format 语法表。
- 后续建议：单独实现 Pine format parser。

### [P4-09] 时间毫秒/秒启发式与时区偏移解析受限

- 上下文：timestamp 单位启发式和时区 fallback 属于 API 兼容策略。
- 处理：暂缓。
- 后续建议：新增显式单位参数和 unknown timezone strict mode。

### [P4-10] 普遍的逐 bar Python 循环，大序列性能存在热点

- 上下文：性能问题需要 benchmark 排序，否则容易做低收益重写。
- 处理：暂缓。
- 后续建议：先加 TA/request/strategy benchmark。

### [P4-11] `math_ext` 默认 `mintick=0.01` 与实际注入 `1.0` 不一致（交叉 P3-02 / P2-08）

- 上下文：与 P0-04 同源。
- 处理：修复。`PyneMath` 默认值统一到 `1.0`。
- 验证：同 P0-04。

## P5 - 输入、集合与状态

### [P5-01] 同标题输入参数共享同一 key，导致 schema 去重 + 取值串扰

- 上下文：input key 当前兼作 UI key 和参数覆盖 key；直接改唯一 key 会影响前端/CLI 参数覆盖。
- 处理：暂缓。需要输入 schema 版本或兼容迁移。
- 后续建议：新增内部唯一 id，同时保留 display title 和 legacy param alias。

### [P5-02] `PyneArray.__init__` 使用 `values or []`，传入 numpy 数组会抛“真值歧义”

- 上下文：numpy array 不能参与 Python truth-value 判断。
- 处理：修复。改为 `list(values) if values is not None else []`。
- 验证：新增/运行 `PyneArray(np.array(...))` 定向测试。

### [P5-03] 数组成员检测对 `na`/`NaN` 永不命中

- 上下文：Python `NaN != NaN`，原 `in`/`list.index` 无法找到 NaN。
- 处理：修复。数组 includes/indexof/lastindexof 使用 missing-aware equality。
- 验证：新增/运行 NaN 成员检测测试。

### [P5-04] `array.sort` 对 `NaN`/混合类型行为未定义

- 上下文：混合类型排序策略需要明确 Pine typed-array 兼容规则。
- 处理：暂缓。直接按字符串/类型排序可能隐藏用户错误。
- 后续建议：先定义 missing placement 和混合类型报错策略。

### [P5-05] `input.source` 依赖对象 identity 反查来源，回退“close”被静默吞掉

- 上下文：派生序列已具备稳定 name 后，可以避免纯 identity 识别失败。
- 处理：修复。`input.source` 优先使用 `PyneSeries.name` 识别 open/high/low/close/hl2/hlc3/ohlc4/hlcc4。
- 验证：新增/运行 `input.source(hlcc4)` 默认值测试。

### [P5-06] `PyneVar.reset` 绕过 `to_missing_scalar` 归一，na 处理与 `set`/`set_each` 不一致

- 上下文：reset 原来直接赋值，和 set 的 missing 归一不一致。
- 处理：修复。reset 复用 `set()`。
- 验证：新增/运行 reset `na` 归一化测试。

### [P5-07] `PyneVar.set_each` 用 object 数组 + Python 逐条循环承接状态

- 上下文：这是性能问题；当前行为语义清晰。
- 处理：暂缓。
- 后续建议：用 benchmark 证明瓶颈后再优化 numeric fast path。

### [P5-08] `PyneVar` 把私有字段暴露为 dataclass 构造参数

- 上下文：`_value/_initialized` 是内部状态，不应由外部构造注入。
- 处理：修复。两个字段改为 `field(init=False)`。
- 验证：新增/运行私有构造参数不可用测试。

### [P5-09] `input.int/float` 对越界用户值静默 clamp、对非法值抛非 errors.py 异常

- 上下文：越界 clamp 是 UI 参数策略；非法值错误面要不要归入 `PYNE_INVALID_PARAM` 需要统一错误设计。
- 处理：暂缓。
- 后续建议：先定义 input 参数错误码和 clamp/warn/error 策略。

### [P5-10] 输入参数与 namespace 共享同一可变 `params` 字典（与 P3-06 同源）

- 上下文：与 P3-06 同源。
- 处理：修复。namespace 暴露只读副本。
- 验证：同 P3-06。

## P6 - 绘图与结果输出

### [P6-01] drawing 上限只约束可变对象，序列/标记类输出完全不限量

- 上下文：series/marker/barcolor/signal 等输出上限与 P1-02 同源。
- 处理：部分修复。P1-02 已把 security output limit 扩展到所有 schema output keys 的 collection/data/regions。
- 验证：同 P1-02。

### [P6-02] `plot(color=<数组>)` 的逐 bar 颜色被丢弃，仅取首 bar 颜色

- 上下文：line plot 只有 `color_array` 会写入 point color，`color=<series>` 只设置 `per_bar_color` 标记。
- 处理：修复。line plot 对 `color_array` 和 `color=<series/list/ndarray>` 统一按 bar 写入 point color。
- 验证：新增/运行 `plot(close, color=colors)` 点级颜色测试。

### [P6-03] 绘图对象坐标取自序列时坍缩为“最后一个非 na 值”，与 Pine 逐 bar 创建语义不一致

- 上下文：对象 API 当前偏“最终对象状态”模型，而 Pine 更接近逐 bar 创建/更新事件。
- 处理：暂缓。属于绘图对象语义模型重设。
- 后续建议：新增 object event stream 后再支持序列坐标逐 bar 展开。

### [P6-04] drawing 上限超限抛裸 `RuntimeError`，未走 errors.py 统一错误面

- 上下文：collector 直接抛 `RuntimeError`，runtime 只能归为 `PYNE_RUNTIME_ERROR`。
- 处理：修复。超限改抛 `PyneSecurityError`，并分类为 `PYNE_OUTPUT_LIMIT_EXCEEDED`。
- 验证：更新/运行 drawing object limit 测试。

### [P6-05] 对失效/已删除引用的 setter 静默 no-op

- 上下文：setter 静默 no-op 可能隐藏脚本错误，但也兼容删除后重复设置。
- 处理：暂缓。需要决定 strict/debug 模式。
- 后续建议：strict 模式抛错，默认模式记录 warning。

### [P6-06] `bgcolor` 不支持逐 bar 颜色，Pine 的 `cond ? color : na` 着色有损

- 上下文：当前 bgcolor 模型是 condition + 单色 regions。
- 处理：暂缓。需要输出 schema 支持每 bar 背景色。
- 后续建议：把 bgcolor 输出扩展为 per-bar color regions。

### [P6-07] `plot(style="histogram")` 的 `color_up` 与 `color_down` 取同一颜色，与 `bar()` 语义不一致

- 上下文：Pine 的 `plot(..., color=...)` 和本地 `bar()` 默认分色不是同一 API。
- 处理：暂缓。属于兼容语义决策。
- 后续建议：用 Pine capture 确认默认颜色语义。

### [P6-08] `_color_for_index` 处理 list[dict] 时 `"time" not in item` 导致对齐脆弱

- 上下文：当前同时支持 index-aligned dict 和 time-aligned dict。
- 处理：暂缓。需要兼容迁移，不直接拒绝旧输入。
- 后续建议：新增显式 index/time alignment 模式。

### [P6-09] `PyneResult.to_frame` 按时间合并多条序列时同名列静默覆盖

- 上下文：同名 plotted series 写入同一 DataFrame 列，后者覆盖前者。
- 处理：修复。重复列名自动追加 `_2/_3` 后缀。
- 验证：新增/运行 duplicate series name to_frame 测试。

### [P6-10] 绘图层 legacy 别名与函数对象属性较多，维护面偏大

- 上下文：这是 API 维护复杂度问题，不是单点 bug。
- 处理：暂缓。
- 后续建议：做 public API 清单和 deprecation plan。

## P7 - request/security 与跨周期数据

### [P7-01] 默认 `lookahead=off` 仍以 HTF bar 开盘时间对齐，可能泄漏“未收盘”高周期值（前视/重绘偏差）

- 上下文：修复需要 requested `time_close` 或 timeframe close gate，并会改变 request.security 当前对齐结果。
- 处理：暂缓。需要 Pine parity 数据确认。
- 后续建议：用 HTF/LTF capture 建立 lookahead_on/off golden 后再改。

### [P7-02] provider capability 校验默认放行，dict 缺键或 None 时不拦截

- 上下文：无 `capabilities` 属性的旧 provider 需要继续兼容；但显式 `capabilities=None` 或 dict 缺 key 不应默认支持。
- 处理：修复。缺属性保留兼容放行；显式 None、dict 缺匹配 key 改为不支持。
- 验证：新增/运行 capability None 和 dict missing key 测试。

### [P7-03] `LowerTimeframeSeries` 聚合按 chart bar 逐组构建 Python 列表再 numpy 运算

- 上下文：性能热点，需要 benchmark。
- 处理：暂缓。
- 后续建议：增加 lower-tf 大样本 benchmark 后向量化。

### [P7-04] `_requested_context_cache` 无上限

- 上下文：缓存作用域目前是单次 runtime execution，风险有限；上限需要 settings 字段。
- 处理：暂缓。
- 后续建议：新增 per-execution request cache limit。

### [P7-05] 历史偏移解析对非法下标静默回退为 0（当前 bar）

- 上下文：`close[bad]` 原来会被解析成 `close[0]`。
- 处理：修复。非法 history offset 抛 `PYNE_UNSUPPORTED_FEATURE`。
- 验证：新增/运行 invalid history offset 测试。

### [P7-06] 对齐结果统一强制 `float64`，布尔/类型语义丢失

- 上下文：当前 plot/series 多数路径以 numeric series 为核心，保留 dtype 会牵动输出 schema。
- 处理：暂缓。
- 后续建议：先定义 typed request series。

### [P7-07] provider 返回的 OHLCV 缺乏结构校验，缺 `time` 默认 0 影响排序

- 上下文：provider bars 在排序前用 `get("time", 0)`；缺字段错误不稳定。
- 处理：修复。排序前校验 provider 返回 list、每项为 dict、必须含 time；context 构造错误包装为 `PyneRequestError`。
- 验证：新增/运行 provider 缺 time 测试。

### [P7-08] `security_lower_tf` 末根 chart bar 的分组为开区间，纳入尾部所有 lower-tf bar

- 上下文：末根是否纳入尾部 lower-tf bars 取决于 preview/confirmed bar 语义。
- 处理：暂缓。
- 后续建议：引入 barstate/time_close 后区分 closed 与 preview。

## P8 - 策略回放与订单语义

### [P8-01] 每次策略 API 调用都对全量订单历史做整体重放，close/exit 更在逐 bar 循环内重放，复杂度爆炸

- 上下文：这是架构级性能问题，修复需要重写 replay/ledger 生命周期。
- 处理：暂缓。
- 后续建议：先加订单量 benchmark，再做批量 replay 或增量 ledger。

### [P8-02] 风险强平合成订单写回持久 `strategy_orders`，重复重放会累积重复合成单

- 上下文：此项和 replay 架构耦合，直接改写回位置容易影响 lifecycle/golden。
- 处理：暂缓。
- 后续建议：把 synthetic orders 从输入事件流拆到 replay output 流，并补重复重放测试。

### [P8-03] 市价单在信号 bar 当根以收盘价（或指定价）成交，而非 Pine 默认的下一根开盘

- 上下文：成交时点是策略模拟模型选择。
- 处理：暂缓。
- 后续建议：新增 next-bar-open 模式和 Pine parity capture。

### [P8-04] 持仓 size 以未取整 float 累积，`== 0` 精确判定可能漏掉 epsilon 残留持仓

- 上下文：涉及 ledger、margin、position avg 多处；需要统一 quantity precision。
- 处理：暂缓。
- 后续建议：定义 qty epsilon/precision 后整体替换。

### [P8-05] 方向 / OCA 类型等归一化对非法值静默回退，缺乏校验

- 上下文：非法方向、risk mode、OCA type 原来会回退默认或透传，隐藏脚本错误。
- 处理：修复。strategy direction、risk allow_entry direction、risk mode、OCA type 对非法值抛错。
- 验证：新增/运行非法 direction/risk mode/OCA tests。

### [P8-06] mintick / 滑点 / 限价校验依赖 `syminfo.mintick`，与 P2-08、P3-02 同源默认值问题联动

- 上下文：mintick 默认已在 P0/P2/P3/P4 统一。
- 处理：部分修复。默认值联动已处理；策略层更严格的 mintick 校验暂缓。
- 验证：同 P0-04。

### [P8-07] 风险强平合成单 id 直接用 reason，可能与用户订单 id 冲突并进入 lifecycle

- 上下文：当前测试和输出契约使用 `risk.max_drawdown` 等 reason 作为订单 id；修改会改变公共 strategy 输出。
- 处理：暂缓。需要 strategy output schema 迁移。
- 后续建议：新增内部 `synthetic_id`/保留 `reason` 字段，再弃用 reason-as-id。

### [P8-08] 事件发射层大量 `*` / `*_when` 包装 + 逐 bar Python 循环，性能与维护面偏大

- 上下文：维护/性能问题。
- 处理：暂缓。
- 后续建议：抽统一条件展开器，结合 P8-01 benchmark 推进。

## P9 - 增量执行

### [P9-01] 预览态每根 bar 对整个 context 做全量 `deepcopy`，且克隆后又清空 series/markers（先拷后弃）

- 上下文：性能问题，涉及 preview 状态隔离。
- 处理：暂缓。
- 后续建议：设计 preview overlay/copy-on-write context。

### [P9-02] 长生命周期会话中 `_orders`/`_closed_trades`/`_object_events`/series data 无上限累积，安全模式限额未覆盖

- 上下文：需要 retention policy 和新增 settings 限额。
- 处理：暂缓。
- 后续建议：补 IncrementalLimits 覆盖后再实现裁剪。

### [P9-03] 读取 strategy 标量属性会触发风险强平副作用，纯读产生持仓/账本变更且结果依赖读取时机

- 上下文：移除 property 副作用需要重排增量 strategy 生命周期阶段。
- 处理：暂缓。
- 后续建议：把风险同步固定到 bar step/end_bar，不在 property getter 中执行。

### [P9-04] 增量引擎与批量回放引擎为两套独立实现，存在显著语义漂移风险

- 上下文：架构问题。
- 处理：暂缓。
- 后续建议：共享成交/风险核心或加强 parity matrix。

### [P9-05] 增量 TA 为独立逐步实现，EMA 种子 / RSI·ATR 的 Wilder 平滑需与批量 ta 严格对齐

- 上下文：需要批量/增量 golden parity。
- 处理：暂缓。
- 后续建议：同 P4 的 TA policy/golden 一起做。

### [P9-06] manager 去重缓存的 event_key 仅含 OHLCV 标量，忽略 session_*/其它 raw 字段，且 time 缺省回退 0 易碰撞

- 上下文：改 event key 需要定义哪些 raw 字段参与去重。
- 处理：暂缓。
- 后续建议：使用规范化 bar hash，缺 time 拒绝。

### [P9-07] 每根 bar 双重 `deepcopy`（缓存一份 + 返回一份），叠加 `Window.__getitem__` 每次全量 `list()` 取值

- 上下文：性能问题。
- 处理：暂缓。
- 后续建议：不可变结果快照和 Window O(1) 索引。

### [P9-08] `is_incremental_pyne_script` 直接 `ast.parse` 未捕获 `SyntaxError`，非法脚本抛出裸异常

- 上下文：直接调用检测 helper 时非法语法会裸抛；runtime 语法检查已有单独错误面。
- 处理：修复。检测 helper 捕获 SyntaxError 并返回 False。
- 验证：新增/运行 direct detection invalid syntax 测试。

### [P9-09] 增量风险强平合成单 id 复用风险原因字符串，可能与用户订单 id 冲突（与 P8-07 同源）

- 上下文：与 P8-07 同源，涉及 strategy 输出 schema。
- 处理：暂缓。
- 后续建议：同 P8-07 一起迁移 synthetic id。

## P10 - 测试与契约

### [P10-01] 增量会话管理与限额完全无测试覆盖

- 上下文：`PyneIncrementalSessionManager` 的 acquire/release 引用计数、seed/snapshot、`process_bar` 去重，以及 `IncrementalLimits` 的窗口限制原来没有定向测试；这会放大 P9 的长生命周期风险。
- 处理：修复。新增 `tests/test_incremental_manager.py`，覆盖引用计数释放、首次 seed 后 snapshot、重复 bar event 去重返回深拷贝、窗口大小/总量超限抛 `PyneSecurityError`。
- 验证：运行 `pytest tests/test_incremental_manager.py`，并纳入 P10 分组测试。

### [P10-02] ta/request golden 为运行时自快照，不提供与 Pine 的正确性基准

- 上下文：该问题属 golden 来源可信度；当前 JSON fixture 明确是 Pyne-defined snapshot，不能通过本地代码修改伪造成 TradingView/Pine 参考。
- 处理：暂缓。不改 fixture 来源声明。
- 后续建议：用 capture 工作流逐个导入外部 TradingView 输出，fixture 中保留 capture metadata，并在未捕获时显式标注为 runtime regression snapshot。

### [P10-03] process 执行器仅冒烟，缺 inline↔process 输出 parity

- 上下文：process executor 原来只验证能跑一条 plot 和杀死死循环，没有断言同脚本在 inline/process 下输出一致。
- 处理：修复。新增 inline/process parity 测试，覆盖 indicator metadata、series name、原始 close 输出和 `ta.sma` 计算输出。
- 验证：运行 `pytest tests/test_executor.py`，并纳入 P10 分组测试。

### [P10-04] strategy_pine_equivalent 含未捕获参考的占位用例

- 上下文：`external_capture.status == "not_captured"` 的样例缺少 TradingView 参考数据；强行把当前 runtime 输出写成期望会掩盖“Pine equivalent”命名问题。
- 处理：暂缓。不把未捕获样例伪装成外部基准。
- 后续建议：优先 capture `pending_entries`、`risk_size_limit`、`oca_risk` 的缺失段；未捕获样例在测试报告中区分为 pending external parity。

### [P10-05] pytest/CI 配置缺少严格门禁（警告、标记、覆盖率）

- 上下文：`-W error`、`--strict-markers`、coverage threshold 会改变整个仓库的 CI 契约；当前本地环境还会在 pytest 退出后的临时目录清理阶段触发 Windows PermissionError 噪声。
- 处理：暂缓。不在本次混入全局 CI 门禁。
- 后续建议：单独做质量门禁 PR，先清理已知 warning/平台噪声，再增加 `pytest-cov` 和最低覆盖率阈值。

### [P10-06] examples 仅冒烟，无数值 golden

- 上下文：示例脚本的数值 golden 需要先决定哪些示例承载语义契约，哪些只保证打包可运行；直接对全部示例固化数值会提高维护成本。
- 处理：暂缓。
- 后续建议：挑选 `ma_cross`、`rsi_signals`、`supertrend` 建立小样本数值 fixture，其余保留 smoke。

### [P10-07] 增量↔批量 parity 仅极小样本，未覆盖复杂路径与预览副作用

- 上下文：这属于 parity matrix 覆盖面不足；扩展复杂策略、preview/closed 交错、OCA、金字塔等路径需要更系统的测试设计。
- 处理：暂缓。本次只修正了 `_bars()` 中不合法 OHLC 测试夹具，使既有 parity 测试在新数据校验下仍有效。
- 后续建议：新增多 bar、多 preview、风险/OCA/金字塔组合的 shared parity helper，并纳入 golden 策略矩阵。

### [P10-08] CLI run 的失败/超时/进程模式分支无契约测试

- 上下文：CLI run 原来主要覆盖成功路径；P0 已补输入读取错误 JSON，本项继续补 process mode 和运行失败输出契约。
- 处理：修复。新增 `--executor-mode process` 成功写 payload 测试，以及 process 模式语法错误时返回非零退出码、stdout JSON 中包含 `PYNE_SYNTAX_ERROR` 的测试。
- 验证：运行 `pytest tests/test_cli.py`，并纳入 P10 分组测试。

### [P10-09] golden 浮点用精确相等，跨平台脆性且与 strategy 容差不一致

- 上下文：ta/request golden 使用 list/dict 精确相等比较浮点值，和 strategy external capture 的容差比较不一致。
- 处理：修复。`tests/test_golden_ta.py` 与 `tests/test_golden_request_security.py` 改为逐点比较：结构和时间精确一致，`value` 数值使用 `pytest.approx(abs=1e-9)`。
- 验证：运行 `pytest tests/test_golden_ta.py tests/test_golden_request_security.py`，并纳入 P10 分组测试。

### P10 分组验证

- 命令：`pytest tests/test_executor.py tests/test_incremental_manager.py tests/test_cli.py tests/test_golden_ta.py tests/test_golden_request_security.py`
- 结果：21 passed。Windows 退出阶段仍出现 pytest 临时目录清理 PermissionError 噪声，但 pytest 已返回成功。

## 最终回归验证

- 命令：`$env:PYTHONPATH=(Resolve-Path src).Path; pytest`
- 结果：396 passed。pytest 结束后的 atexit 阶段仍打印 Windows 临时目录清理 PermissionError，但测试命令返回成功。
- 代码质量检查：尝试运行 `ruff check src tests` 与 `python -m ruff check src tests`，当前环境未安装/未暴露 ruff，未能执行。
