# 指标模块

基于事件驱动的增量指标计算引擎。

## 架构

```
indicator/
├── __init__.py          # 自动注册 + 公共 API
├── types.py             # IndicatorKey, IndicatorResult, IndicatorSpec 等类型
├── base.py              # 指标抽象基类
├── events.py            # 指标事件定义
├── registry.py          # 指标注册中心（全局单例: registry）
├── engine.py            # 指标引擎（调度 + 生命周期管理）
└── indicators/          # 内置指标实现
    ├── ma.py            # MA  — 简单移动平均线
    ├── ema.py           # EMA — 指数移动平均线
    ├── macd.py          # MACD — 指数平滑异同移动平均线
    ├── rsi.py           # RSI — 相对强弱指数
    ├── boll.py          # BOLL — 布林带
    └── atr.py           # ATR — 平均真实波幅
```

## 核心设计思想

### 1. 指标是实例，不是函数

`MA(close, 20)` 和 `MA(close, 60)` 是两个独立实例，各自维护自己的状态。实例通过 `IndicatorKey`（symbol + interval + 指标名 + 参数哈希）唯一标识。

### 2. 两阶段更新

每个指标分离 `update_partial()`（未收盘 bar 的预览值）和 `update_closed()`（收盘确认后推进状态）：
- **preview value**（临时值）：前端实时展示
- **final value**（收盘值）：策略/告警使用

### 3. O(1) 增量更新

内置指标维护滚动状态（sum、EMA 等），每根新 bar 只需常数时间处理，无需每次全量重算。

### 4. 实例缓存与去重

引擎按 `IndicatorKey` 缓存实例。多个订阅者（图表、策略、告警）共享同一个计算实例。

### 5. 标准化输出

所有指标产出 `IndicatorResult`，包含一个或多个 `IndicatorOutput` 序列，每个序列由 `OutputPoint(timestamp, value)` 组成。前端可以统一渲染任何指标。

### 6. 注册中心驱动

所有指标（内置 + 自定义）通过同一个 `IndicatorRegistry` 注册。API 暴露参数 schema，前端可自动生成配置表单。

## 快速使用

```python
from app.indicator import create_engine, registry

# 列出所有可用指标
for spec in registry.list_specs():
    print(spec.name, spec.display_name)

# 计算指标
engine = create_engine()
result = engine.compute("BTCUSDT", "1m", "MA", {"period": 20}, bars)

# 读取输出
for name, output in result.outputs.items():
    print(f"{output.display_name}: {output.latest_value}")
```

## 数据流

```
DataManager bar 事件
    │
    ├── BAR_CLOSED ──→ engine.on_bar_closed()
    │                     └── instance.update_closed(bar)  # 推进状态
    │
    ├── BAR_UPDATED ─→ engine.on_bar_updated()
    │                     └── instance.update_partial(bar)  # 预览值
    │
    └── BACKFILL ────→ engine.on_bars_backfilled()
                          └── instance.recompute(bars)  # 全量重算
```

## 内置指标

| 名称 | 类别 | 输出 | 验证模式 |
|------|------|------|----------|
| MA   | 趋势 | `ma` | 窗口滚动求和 |
| EMA  | 趋势 | `ema` | 递推状态 |
| MACD | 趋势 | `dif`, `dea`, `hist` | 多输出 |
| RSI  | 震荡 | `rsi` | 有状态振荡器 |
| BOLL | 波动 | `middle`, `upper`, `lower` | 主图叠加 + 滚动标准差 |
| ATR  | 波动 | `atr` | 多输入 (H/L/C) |

## 添加新指标

1. 在 `indicators/` 下创建文件
2. 继承 `Indicator`，实现 `init()`, `update_partial()`, `update_closed()`
3. 定义 `get_spec()` 返回参数 schema
4. 在 `__init__.py` 中注册

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/indicators/registry` | 列出所有指标定义 |
| GET | `/api/v1/indicators/registry/{name}` | 获取单个指标定义 |
| POST | `/api/v1/indicators/compute` | 在 OHLCV 数据上计算指标 |
