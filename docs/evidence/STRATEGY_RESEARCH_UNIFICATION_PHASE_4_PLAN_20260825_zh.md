# 本地数据与策略研究统一 Phase 4 执行计划（2026-08-25）

## 范围

- `CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED` 严格解析，默认 0。
- LIVE 仅在旗标开启时挂载 `/api/v1/local` 并启动 LocalDataRuntime。
- 全部本地资料库路由依赖可信本机 Origin/Host/loopback；不信任 X-Forwarded-For。
- LOCAL_OFFLINE 行为保持，仍强制 loopback + network guard。
- Vite proxy 保留浏览器 Origin。
- 安全矩阵 F1–F6。

## 回滚

关闭旗标；LIVE 不再挂载资料库。
