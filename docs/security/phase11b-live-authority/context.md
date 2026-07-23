# Phase 11B Live Authority Hardening Context

本文件记录本次派生安全设计所使用的本地上下文。它不是漏洞报告，也不证明
Phase 11B 已经实现。

## Source identity

- source root: `H:\program\CandleScope-plugin-platform`
- branch: `codex/plugin-platform-v1`
- target revision: `e464c4f7add0e64b1139692ce0daaeef71fb2159`
- target Git tree: `c824383f391e842d1ace2dadde5233c392f55ff6`
- source drift at inventory time: `none`
- source drift at review time: `present`，仅包含本分析目录、Phase 11B0 执行记录和
  路线图状态注记；`backend/`、`frontend/` 与 `packages/` 没有变化
- analysis id: `hardening_20260723_phase11b_live_authority`

## Evidence collection

集合以目标 revision 的原始 Git blob 为准，不受工作区 CRLF checkout 影响。摘要按以下规则计算：按表中顺序拼接
`<lowercase sha256><two spaces><repository-relative path>`，记录之间使用单个
LF，然后对 UTF-8 字节做 SHA-256。

- collection SHA-256:
  `b025a166090f5ff5947f5ec97f0a102c22fa52c16ca0da9312e3e5765317db6d`
- artifact count: `16`

| Evidence | Repository-relative path | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| E001 | `docs/GENERAL_PLUGIN_PLATFORM_V2_EXECUTION_zh.md` | 58040 | `3fe1162c52d00f7aa473394feb11b89e003108a679bd0762101258c5273ed7ed` |
| E002 | `docs/PLUGIN_PLATFORM_V2_PHASE11A_zh.md` | 12716 | `a49c49f838abc10712bde19f764155eae9cabb960187060d23b96c5d9a3f3f86` |
| E003 | `backend/app/plugin_security_v2/grants.py` | 40943 | `2721babb22680168f3b5bd18bc5e7a576277b4da67e2b794ddd745a5020b76f2` |
| E004 | `backend/app/plugin_installer_v2/bundle.py` | 45427 | `3fcd496246791078b533818e03da7343c2554618ec54e9c3882ce30c54700252` |
| E004 | `backend/app/plugin_installer_v2/registry.py` | 11666 | `cc5c68ed145df2a317fab6035e7b8f3181c33c4ec300303f689ef981c6d913fc` |
| E005 | `backend/app/plugin_security_v2/capabilities.py` | 27613 | `4f15a3198587a0db4e5bb852f48ac81787cf95dcc6887f6623b90d767d700f62` |
| E005 | `backend/app/plugin_gateway_v2/network.py` | 27571 | `abef95a5a0aa2400c31ac26b4a749648eecaf98766de33527ebfbf25f49638ca` |
| E005 | `backend/app/plugin_core_v2/runtime.py` | 54391 | `e32664922c59e8a83c71ada0ab40f4daea3fbda3856d20ce616f8a20a28b6fd7` |
| E006 | `backend/app/plugin_paper_v2/runtime.py` | 53431 | `8405d91965d2b300fad5409178edb71b8277bfcabdf23f8efbd78f256169bdf4` |
| E006 | `packages/candlescope-plugin-sdk/src/candlescope_plugin_sdk/platform_v2/paper.py` | 21025 | `84faacd36f0042008d795109474a6287a5e59f0887c27a44858e65196c07f4e3` |
| E007 | `backend/app/plugin_security_v2/audit.py` | 8230 | `3dc0860f56d83e30b27270268af46e6db8968e94f2f2c8b84f1bda0bd6b8a1b7` |
| E007 | `backend/app/plugin_core_v2/api.py` | 29705 | `05fe818c36d9678e2f5d402a1d045ba9dd1b5712585409fb10b4542491a7ca62` |
| E008 | `backend/app/plugin_security_v2/management.py` | 9780 | `cc7ffdb8bd339a9e5574d56c597de5da4740e854bafe654f828ce3ec74d67dea` |
| E008 | `frontend/src/features/plugins/PluginPlatformSurfaces.tsx` | 35181 | `3927f0242beb132316b1c59da0e4b73822079a658a78c231bd830ca768d722e0` |
| E008 | `frontend/src/features/plugins/SandboxPluginFrame.tsx` | 6872 | `fdc90194a180609804281350016b75369249075d349a514071956f4d23a249e9` |
| E008 | `frontend/src/index.css` | 186880 | `aae22761e873e8cc4c83a88450c3b32364e2cda832fd940c1ae29dc554cb65a0` |

## Verification performed

在上述 revision 上执行：

```powershell
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONPATH='H:\program\CandleScope-plugin-platform\backend;H:\program\CandleScope-plugin-platform\packages\candlescope-plugin-sdk\src'
python -m pytest tests/test_plugin_grants_v2.py tests/test_plugin_capabilities_v2.py tests/test_plugin_integration_gateway_v2.py tests/test_plugin_paper_v2.py -q
```

结果：`31 passed in 23.76s`。这个结果只验证现有 Paper、授权、能力和网络撤销基线，
不验证任何实盘行为。

## Evidence limitations

- 没有真实 API key、OAuth token、实盘/测试网账户或交易所请求参与本次分析。
- 没有 secret vault、独立 Broker 进程、Live DTO、交易所 adapter 或审计导出原型。
- 当前 bundle verifier 有完整摘要/内容验证，但 Phase 12 的 publisher signature、
  transparency record 与 revocation 尚未交付。
- 本次没有测量 IPC 延迟、Broker RSS、交易所响应延迟或 kill/revoke 的实盘时间界限。
- 前端结论来自源码与现有浏览器隔离证据；尚未实现或运行 Live confirmation UI。
- 本设计把恶意插件作为主要攻击者；Host 主进程或操作系统账户完全失陷不在本阶段可闭合的范围内。
- 派生文档写入后，当前工作树不再等于目标 revision；证据 hash 始终指向
  `e464c4f` 的原始 Git blob，未把派生状态注记重新混入证据集合。
