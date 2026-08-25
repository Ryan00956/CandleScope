# 本地数据与策略研究统一 Phase 4 结果（2026-08-25）

## 结论

Phase 4 通过。`CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED` 默认 0。LIVE 仅在旗标开启时挂载 `/api/v1/local`。全部本地资料库路由检查 Origin/Host/loopback，不信任 `X-Forwarded-For`。Vite proxy 保留浏览器 Origin。F1–F6 HTTP 矩阵通过。LOCAL_OFFLINE 仍可用且 network guard 生效。

## 测试

`pytest` access + local_data_api + offline profile + jobs + research runtime：27 passed。

## 回滚

关闭 `CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED`；LIVE 不挂载资料库。
