# 交易所插件模板

复制本目录来创建新交易所插件，例如：

```text
backend/app/exchanges/plugins/coinbase/
```

建议最小文件结构：

```text
coinbase/
  __init__.py
  adapter.py
  normalizer.py
  symbols.py
  plugin.py
```

接入步骤：

1. 复制 `_template` 目录并改名为交易所 id，例如 `coinbase`。
2. 替换所有 `Template` / `template` 命名。
3. 在 `adapter.py` 中实现交易所能力、symbol list、REST/WS 参数。
4. 在 `normalizer.py` 中把交易所 raw payload 转成统一 `MarketEvent`。
5. 在 `symbols.py` 中实现 symbol 归一化。
6. 在 `plugin.py` 中配置 normalizer、protocol、限速、实时策略、价格 stream type。
7. 在 `registry.bootstrap_default_adapters()` 中注册插件，或后续接入自动发现。
8. 添加交易所专属测试。

## 必做测试

至少覆盖：

- `capabilities()` 的 market / interval / feature 声明。
- REST K 线请求 path 和 params。
- REST K 线 payload normalizer。
- WS 订阅 payload 或 path。
- WS K 线 payload normalizer。
- ticker payload normalizer。
- symbol normalizer。
- rate limit policy。

## 设计约定

- 插件内可以处理交易所专属差异，主流程不要新增 `exchange == "xxx"` 分支。
- 新交易所 key 使用三段式：`{exchange}:{market_type}:{symbol}`。
- 如果交易所不支持某项能力，在 capability 或 adapter 方法中明确返回不支持，不要让调用链深处失败。
- 旧兼容 re-export 只给内置历史模块使用；新交易所优先只放在 `plugins/{exchange}` 下。
