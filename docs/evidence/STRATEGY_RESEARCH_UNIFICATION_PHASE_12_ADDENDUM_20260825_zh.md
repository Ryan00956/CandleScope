# Phase 12 补记（2026-08-25）

本补记已随新候选重新绑定 hash，不再沿用旧 `87af1d96` 候选。

## smoke:backtest

启动 LOCAL_OFFLINE uvicorn 后，`npm.cmd run smoke:backtest` 通过。先前 `127.0.0.1:8000` ECONNREFUSED 是当时未启动后端，不是产品回归。

## 浏览器验收

此前“无交互式浏览器”的 ENV_STOP 已被本轮真实浏览器验收取代：

- LOCAL_OFFLINE：30 根 CSV 导入、看图、SMA 运行、报告闭环 PASS，console error 为 0。
- LIVE：策略页未绑定提示、行情页真实图表、chart-first tester 绑定闭环 PASS，console error 为 0。

截图和结构化结果见 `docs/evidence/strategy-research-unification-phase-12/` 与 `docs/evidence/strategy-research-unification-phase-12-browser-20260825.json`。

## 60 分钟 mixed soak

仍为 **ENV_STOP**。已有的 60 分钟证据只覆盖 LOCAL_OFFLINE API（711 cycles / 3600131 ms）；本轮浏览器验收是短时双环境交互，不得写成 60 分钟 mixed browser soak PASS。

## 全量门禁

前端全量测试已修复为 3481/3481 PASS；后端全量仍因既有 Phase 1 历史契约漂移失败；全量 lint 仍有 140 个既有错误。详见 RESULT、DoD 与 `STRATEGY_RESEARCH_UNIFICATION_PHASE_12_PYTEST_VS_MAIN_20260825.md`。
