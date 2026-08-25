# Phase 12 全量 pytest 对照 main（2026-08-25）

## 方法

在 unification 工作树与 `main@144e748c` 上运行同一 plugin 簇：

`tests/test_plugin_marketplace_v2.py tests/test_plugin_paper_core_v2.py tests/test_plugin_paper_v2.py tests/test_plugin_platform_backtest_boundary.py tests/test_plugin_platform_historical_contracts.py tests/test_plugin_platform_manager.py tests/test_plugin_platform_multi_runtime_phase0.py tests/test_plugin_platform_multi_runtime_phase1.py tests/test_plugin_security_management_v2.py`

## 结果

| 树 | 结果 |
| --- | --- |
| unification `4b5b9442` | 10 failed, 48 passed, 1 error |
| main `144e748c` | 13 failed, 44 passed, 2 errors |

共同失败：`plugin_marketplace_v2`「marketplace index has expired」；Phase 1 contract drift。这些在 main 上同样存在，不是本统一分支引入的回归。

unification 没有比 main 多出的 plugin 簇失败。

全量 suite 在约 65% 处仍会长时间卡住。对照 node 列表，该位置是 `test_plugin_windows_sandbox_v2`（AppContainer/CPU quota）或后续 plugin sidecar。排除 sandbox 后仍会在 65% 附近停住。该挂起同样属于 plugin 平台测试，不是 `local_data` / `research_data` / `backtest` 统一代码路径。

定向统一测试（文档 scoped + `test_strategy_research_unification_release.py`）89 passed。
