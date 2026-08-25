# Phase 12 只读审计：codex/local-offline-mode 脏状态

- 路径：`H:\program\CandleScope-local-offline`
- 分支：`codex/local-offline-mode`
- HEAD：`d3c2fe37d1deacba8951b5725353ca967eca2d79`
- 本阶段未删除、未归档、未 merge。

## 分类

### 本地模式相关、已由本统一分支覆盖（不要从旧树移植）

- `backend/app/api/v1/local_data.py`
- `backend/app/local_data/*`（含 untracked `resampling.py`）
- `backend/tests/test_local_data_api.py`
- `backend/tests/test_local_data_service.py`
- `docs/local-offline-mode.md`
- `frontend/src/features/local-data/*`（含 untracked interval selector/policy）
- `frontend/src/index.css` 本地样式片段

### 非本地 package/release 项（保留在旧树，不纳入本产品合并）

- `backend/app/official-plugin-releases.json`
- `backend/scripts/plugin_platform_multi_runtime_phase10.py`
- `backend/tests/test_first_party_plugin_bootstrap.py`
- `packages/candlescope-plugin-pine-compat/*`
- `packages/candlescope-plugin-pyne/*`
- `packages/candlescope-plugin-sdk-typescript/LICENSE`
- `packages/candlescope-plugin-sdk/pyproject.toml`

### 仍需用户决定保留的工作树改动

- `README.md` / `README_zh.md` 在旧树上的本地模式文案
- 上述 plugin release lock / architecture 测试，与本统一工作无关

计数：tracked 修改 33 + untracked 4 = 37，与 Phase 0 清单一致。
