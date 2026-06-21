# 代码审查修复复核报告

本报告对 `code_review_issue_validation_zh.md`、`code_review_execution_plan_zh.md`、
`code_review_fix_execution_log_zh.md` 三份文档对应的**当前 git 未提交改动**进行独立复核，
判断标记为「修复」的改动是否正确。**本报告仅审查，未改动任何代码。**

- 复核范围：`git diff`（25 个 `src/` 文件 + 19 个 `tests/` 文件 + 2 个新增测试文件）。
- 验证手段：逐条比对改动与日志声明、阅读相关上下文源码、运行完整测试套件。
- 测试结果：`pytest` **396 passed**（仅在进程退出阶段出现已知的 Windows 临时目录
  `PermissionError` 噪声，非测试失败）。

## 总体结论

声明为「修复」的条目**绝大多数实现正确**，与日志描述一致，且有定向测试覆盖。
未发现会导致功能错误或回归的严重问题。复核中发现 **1 个真实但轻微的缺口**、
以及 **3 处值得记录的行为变更/设计注意点**，详见下文。所有「暂缓」条目均确属
设计/语义/性能取舍，未在本批改动中强行修改，处理方式合理。

---

## 一、已验证正确的修复（抽样列举）

| 编号 | 改动 | 复核结论 |
|------|------|----------|
| P0-01 / P0-10 | process executor 入口增加 `pickle.dumps` 预检，失败返回 `PYNE_PROCESS_SERIALIZATION_ERROR` | 正确。预检的 `(script, ohlcv, params, security_mode, settings)` 与实际 `ctx.Process(args=...)` 传参完全一致（仅多一个本就可 pickle 的 Queue）。 |
| P0-02 | `normalize_security_mode` 非法值改 `raise ValueError` | 正确（行为变更见下文第二节）。 |
| P0-03 | `with_security_mode` 改用 `dataclasses.replace` | 正确，消除手工逐字段遗漏风险。 |
| P0-04 / P2-08 / P3-02 / P4-11 | `mintick` 默认与 fallback 统一为 `1.0` | 正确，`math_ext`、`namespace` 两处均已对齐。 |
| P1-02 / P6-01 | `enforce_output_limits` 改为遍历 `schema.OUTPUT_KEYS`，递归统计 `data`/`regions` | 正确，关闭了 barcolor/signal 等绕过路径；`_count_output_points` 递归只对 `data`/`regions` 计数，不会重复计数。 |
| P1-08 | `validate_script_security` 移除 SyntaxError 静默 return | 正确，语法错误现在向上传播。 |
| P2-01/05/06 | `PyneData.from_ohlcv` 增加唯一/严格递增/OHLC 关系/非负 volume 校验，`PyneContext.from_ohlcv` 统一走 `PyneData` 入口 | 正确，两入口严格度统一。 |
| P2-03 | 派生序列显式命名 `hl2/hlc3/ohlc4/hlcc4` | 正确。 |
| P2-04 | `PyneNA._nan` 遇 `PyneSeries` 返回等长全 NaN 序列，且全部反射运算符已挂载 | 正确，`na + series` 与 `series + na` 对称。 |
| P2-10 | DataFrame 改 `isinstance(value, pd.DataFrame)` | 正确，pandas 不可用时安全返回 False。 |
| P3-03 | `build_script_namespace` 包装 installer 检测跨阶段覆盖 | 正确，基于 identity 比对；测试确认现有装配无冲突。 |
| P3-06 / P5-10 | `params` 暴露 `MappingProxyType(dict(...))` 只读副本 | 正确，脚本无法回写 input 模块共享 dict。 |
| P4-01 | `ta.sma` 改为同时维护窗口 sum 与有效计数，窗口含 NaN 返回 na | 算法正确（逐项核对滑窗差分与 `valid = counts == period`）。 |
| P4-05 | `highest`/`lowest` 对 `period<=0` 返回全 NaN | 正确，与 `highestbars/lowestbars` 一致。 |
| P5-02 | `PyneArray` 改 `list(values) if values is not None else []` | 正确，修复 numpy 真值歧义。 |
| P5-03 | `includes/indexof/lastindexof` 使用 missing-aware 相等 | 正确，`_values_equal` 处理 NaN==NaN。 |
| P5-05 | `input.source` 优先用 `PyneSeries.name` 识别来源 | 正确。 |
| P5-06 | `PyneVar.reset` 复用 `set()` | 正确，归一化一致。 |
| P5-08 | `_value/_initialized` 改 `field(init=False)` | 正确，私有字段不再可由构造注入。 |
| P6-02 | line plot 对 `color=<series/list/ndarray>` 也逐 bar 写 point color | 正确，`has_per_bar_color` 在两处复用一致。 |
| P6-04 | drawing 上限改抛 `PyneSecurityError`，`classify_security_error` 增加 `Drawing object limit` 分类 | 正确，归入 `PYNE_OUTPUT_LIMIT_EXCEEDED`。 |
| P6-09 | `to_frame` 重复列名追加 `_2/_3` 后缀 | 正确。 |
| P7-02 | provider capability：缺属性仍放行；显式 `None`、dict 缺键改为不支持 | 正确，符合「兼容旧 provider、但不默认放行显式声明」的语义。 |
| P7-05 | 非法 history offset 抛 `PYNE_UNSUPPORTED_FEATURE` | 正确，未闭合 `]` 与非整数下标均拦截。 |
| P7-07 | provider 返回值校验 list/dict/含 time；context 构造错误包装为 `PyneRequestError` | 正确。 |
| P8-05 | strategy direction / risk 方向 / risk mode / OCA type 非法值抛错 | 正确，四处均从静默回退改为显式报错。 |
| P9-08 | `is_incremental_pyne_script` 捕获 `SyntaxError` 返回 False | 正确。 |
| P10-01/03/08/09 | 新增增量会话管理、inline↔process parity、CLI process 失败契约、golden 容差比较测试 | 已运行通过。 |

---

## 二、发现的问题与注意点

### 1.（缺口·轻微）`_derive_time_close` 未覆盖「分钟后缀 `m`」时间框架

`context.py` 新增的 `_timeframe_seconds()` 用于在最后一根 bar 推导 `time_close`（P2-02）。
它处理了纯数字（分钟）、`s/S`、`h/H`、`d/D`、`w/W`、`M`，但**遗漏了 `m`（分钟）后缀**：

```python
suffix = period[-1]
if suffix.isdigit(): ...        # 处理 "15"
if suffix in {"s","S"}: ...
if suffix in {"h","H"}: ...
# 没有 {"m"} 分支 → 落到 return None
```

而 `metadata._parse_timeframe` 明确支持 `m` 后缀（如 `"15m"`）。因此当 `timeframe="15m"`
时，最后一根 bar 的 `time_close` 仍退化为 `NaN`，与本条修复意图（消除最后一根 NaN）不符。
定向测试只覆盖了 `"1h"`，未覆盖该路径，故未被发现。

- 影响：轻微。仅影响以显式 `m` 后缀传入分钟级 timeframe 且无显式 `time_close` 的最后一根 bar。
- 建议：在 `{"m"}` 分支返回 `timeframe.multiplier * 60`（其余后缀的换算均已正确核对）。

### 2.（行为变更·需记录）`shift` 移除「负偏移/前视」语义未登记在修复日志

`series.py::PyneSeries.shift` 与 `utils.py::shift` 现对 `periods < 0` 抛 `IndexError`
（"forward history references"），删除了原先的向前取值分支。该改动**未对应任何 P 编号**，
日志中无记录。

- 复核判断：改动本身**合理且正确**——与既有 `close[-1]` 已抛 `IndexError` 的行为一致，
  符合 Pine「不可前视」语义，并有新增测试覆盖（`test_series.py`）。
- 建议：仅需在修复日志中补一条记录，以免后续审计时被当作「未交代的改动」。

### 3.（设计注意）CLI `run` 的 `except Exception` 粒度过宽且错误通道不统一

`cli.py` 用单个 `except Exception` 包裹「读参数/读 OHLCV/执行/写出」全过程，统一上报
`PYNE_CLI_INPUT_ERROR` 并 `print(..., file=sys.stderr)` 返回退出码 **2**。

- 这会把非「输入读取」类的意外异常也标记为 `*_INPUT_ERROR`，错误码语义偏宽。
- 同时，脚本级失败（`result.ok == False`）走的是 **stdout** 正常 payload + 退出码 **1**，
  与上述 stderr + 退出码 2 形成两条不同的错误通道。调用方需同时解析两者。
- 影响：功能正确，但错误面契约不够清晰。属可接受的现状，建议后续细分错误码。

### 4.（行为变更·需周知）`normalize_security_mode` 由静默回退改为 `raise`

P0-02 将非法 security mode 从静默降级 `safe` 改为抛 `ValueError`。这是**正确**的安全收敛，
但对任何依赖「非法值自动回退」的既有调用方是破坏性变更。CLI 路径下该异常会被第 3 点的
宽 `except` 捕获为 `PYNE_CLI_INPUT_ERROR`（退出码 2），表现合理。仅需在变更说明/迁移
文档中明确周知。

---

## 三、对「暂缓」条目的复核意见

随机抽查 P0-05、P0-07、P0-09、P1-01、P1-04、P2-07、P2-09、P4-02/03/04、P7-01、
P8-01~04、P9-01~07、P10-02/04/05/06 等「暂缓」条目，均属于：
**安全边界重设计 / 公共 API 语义变更 / 执行模型与隔离边界 / Pine parity 基准缺失 /
性能热点（需 benchmark 排序）** 这几类。这些确实不宜用局部 patch「假装修复」，
日志「记录暂缓原因 + 后续建议」的处理方式恰当，未发现把设计问题误判为 bug 的情况，
也未发现把真实 bug 误列为暂缓的情况。

---

## 三·补 测试改动复核（全部 21 个测试文件已逐一核对）

- **夹具修正必要且正确**：`test_incremental.py`、`test_cli.py` 将 `high` 由 2 调到 3，
  是因为新增 OHLC 校验（P2-05）会拒绝 `close=3 > high=2` 的旧夹具（即 P10-07 所述
  「修正不合法 OHLC 测试夹具」）。属配合改动，非掩盖问题。
- **`test_barstate.py` 的 `Time Close` 期望 `[20,30,40]`→`[20,30,40,100]`**：默认分钟
  timeframe（`"1"`，数字后缀）经 `_timeframe_seconds` 得 60 秒，末根 `40+60=100`。
  这反向印证了第二节问题 1——数字(分钟)与 `h` 路径均被覆盖且正确，唯 `m` 后缀无覆盖。
- **新增断言均有效**：所有新测试断言均指向正确的错误码/数值/行为
  （如 `PYNE_PROCESS_SERIALIZATION_ERROR`、`PYNE_OUTPUT_LIMIT_EXCEEDED`、
  `PYNE_UNSUPPORTED_FEATURE`、SMA 含 NaN 返回 na、`to_frame` 重名加 `_2` 等），
  未发现无效或 no-op 断言。
- **CLI 双通道为有意设计且已被测试固化**（呼应第二节问题 3）：进程内语法错误走
  **stdout + 退出码 1**（`PYNE_SYNTAX_ERROR`）；输入读取异常走 **stderr + 退出码 2**
  （`PYNE_CLI_INPUT_ERROR`）。
- golden 测试由「整体精确相等」改为「结构精确 + `value` 容差 `abs=1e-9`」（P10-09），
  改动正确，降低跨平台浮点脆性。

## 四、复核结论汇总

- 标记为「修复」的改动：**实现正确，回归测试全绿（396 passed）**。
- 必须修：无。
- 建议补充（均为轻微/非阻断）：
  1. `_timeframe_seconds` 补 `m` 分钟后缀分支；
  2. 在修复日志补记 `shift` 前视语义移除；
  3. 视情况细分 CLI `run` 的异常错误码；
  4. 在迁移说明中周知 `normalize_security_mode` 的破坏性行为变更。
