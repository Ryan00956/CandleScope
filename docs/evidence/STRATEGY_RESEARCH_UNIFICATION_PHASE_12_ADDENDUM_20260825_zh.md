# Phase 12 补记（2026-08-25）

本补记不改已绑定 hash 的 RESULT/DoD 文件。Verifier 仍绑定 `87af1d96`。

## smoke:backtest

启动 LOCAL_OFFLINE uvicorn `127.0.0.1:8000`，导入 80 根 CSV 后：

```
npm.cmd run smoke:backtest
exit 0
{"ok":true,"cycles":1,"runId":"bt_f6ebc08b9e564d47ba653b82bcf02eb4","reportHash":"sha256:f148bc32802465d94df484e866f4f6f2d534ce942e8be44cb5300b9eb1afb11a"}
```

先前 ECONNREFUSED 是因为当时没有后端进程，不是产品回归。

## mixed soak

对运行中的 :8000 进程：`runtime_mode=LOCAL_OFFLINE`，`data_manager=not_initialized`，`/api/v1/klines/history` `/api/v1/stream` `/api/v1/replay/sessions` 与远程 Origin `/api/v1/local/datasets` 均为 403。

LIVE 当前图表快测 / 浏览器 mixed soak：**ENV_STOP**。本进程没有 LIVE DataEngine，也没有浏览器 MCP。不得把 LOCAL_OFFLINE API soak 或 smoke:backtest 写成 mixed LIVE soak PASS。

证据：`docs/evidence/strategy-research-unification-phase-12-mixed-env-20260825.json`

## 全量 pytest vs main

见 `docs/evidence/STRATEGY_RESEARCH_UNIFICATION_PHASE_12_PYTEST_VS_MAIN_20260825.md`。plugin 簇失败在 main 上同样存在；未发现 unification 引入的新失败。suite 在 plugin sandbox/sidecar 约 65% 处挂起。
