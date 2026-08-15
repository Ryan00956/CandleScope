# Backtest Python First N6 Studio 产品路径（2026-08-15）

## 结论

状态：`PYTHON_STUDIO_PRODUCT_PATH_PASS`（flag-off 默认，未 merge / 未 push）。

普通用户路径不再要求手写 JSON、Pine、Pyne 或外部仓库。Studio 从官方模板生成
`strategy.json` / `strategy.py` / `requirements.lock`，或导入 zip/目录；静态检查不执行
用户代码；冻结 bundle/revision 后走既有 Host smoke → Run → Study → export。

`VITE_BACKTEST_PYTHON_STRATEGY_ENABLED`、`BACKTEST_PYTHON_STRATEGY_ENABLED`、
`BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED` 保持默认 `0`。flag-off 时不渲染入口、不写
sessionStorage、不调用 bundle API。

## 产品路径

- 模板创建与 zip/目录导入共用 inspect → freeze → smoke。
- 参数表单复用 revision schema；不支持项写明 raw trade / queue exact / Host 订单真相。
- `SANDBOXED_LOCAL` 默认；`TRUSTED_LOCAL` 显示权限事实并要求显式确认，没有“继续”按钮。
- 首次运行前展示数据覆盖与 warmup。
- smoke 失败映射源码行列、合同原因和下一步。
- 结果页写明 Python 只产生决策，Host 产生订单/成交/报告。
- Clone / Compare / Study / 进度取消恢复沿用既有 Host 页面。
- 导出绑定 bundle identity、Run manifest 和 report hash。
- reload 从 sessionStorage 恢复 revision / Run / Study（仅 flag-on）。

## Host 接线

PYTHON_SOURCE smoke、create_run 校验和 worker 使用 `PythonHostProvider`，不再误走
builtin `IsolatedStrategyProvider`。Study 接受已冻结的 PYTHON_SOURCE revision。

## 验证

- frontend typecheck / lint / 全量 tests（3267 passed）/ build 通过。
- `npm run test:backtest` 覆盖模板、导入 zip、smoke 诊断、persist/restore、flag-off。
- backend `test_python_studio_host_path.py`：TRUSTED smoke、create_run、create_study。
- 本环境无 Playwright，未能做真实浏览器双路径；见 scratch `n6-browser-unavailable.log`。
- 浏览器证据因此绑定 mapping/state 测试，而不是浏览器截图。

不要把本阶段写成 production-ready 或已 merge。
