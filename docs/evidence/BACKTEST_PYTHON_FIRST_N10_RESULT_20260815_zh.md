# Backtest Python First N10 未合并发布验收（2026-08-16 收口）

## 结论

状态已从 `RELEASE_GATES_OPEN` 收口为
`VALIDATED_CLEAN_SHA_UNMERGED`。

- 基线：`5df19ae76686977f324644e9e62a63b73cf6a743`
- 干净代码候选：`443307d25994ac5d42abf53b16fe63e9f3b7342e`
- 分支：`codex/backtest-foundation`
- `merged=false`、`pushed=false`、`productionEnabled=false`
- 后端与前端全部回测生产开关保持默认 `0`

本次只完成 Python First 与仓库内回测框架的发布收口；没有继续扩展 Pine、
Pyne，也没有合并主分支、推送远端或启用生产入口。

## 最终门禁

| 门禁 | 最终结果 |
| --- | --- |
| 完整后端套件 | PASS：`3866 passed, 0 failed, 0 errors`，7 个弃用类 warning，1643.94 s |
| 完整前端 `npm run check` | PASS：architecture、plugin architecture、typecheck、lint、3267 tests、34 desktop tests、production build 全部通过 |
| Python SDK 独立套件 | PASS：19 passed |
| Rust reference adapter 离线单测 | PASS：3 passed |
| Phase 9 真实构建/安装/回滚门禁 | PASS：完整后端套件已覆盖；锁定二进制可重复构建 |
| Python Host BAR + aggTrade lifecycle | PASS：1h soak 3600.125 s / 13068 循环 |
| Python 浏览器 lifecycle | PASS：4h soak 14400015 ms / 240 reload；console 0 |
| 百万 K 线 | PASS：1M 仅 scale flag；正式证据由 probe 管理，测试不再改写受控证据 |
| Checkpoint / fault injection | PASS |
| v6→v5→v4 schema rollback | PASS |
| Detached exact revert | PASS：回退 N2–N10 后与 N1 树完全一致；固定健康集 15 passed |
| `git diff --check main...candidate` | PASS |
| 发布 manifest 身份、artifact SHA-256 与默认关闭校验 | PASS |

全量后端结束后工作树仍然干净，关闭了此前百万 K 线测试改写
`docs/evidence/backtest-python-first-n8-1m-bar-20260815.json` 的副作用。
`reportHash` 绑定策略 revision 身份；独立新建 revision 时允许不同，但 decision/fill
结果保持稳定。正式性能证据只能由显式 probe 生成，普通 pytest 不再写入。

Windows `core.autocrlf=true` 下，工作树字节与规范 Git blob 可能只在 EOL 上不同。
发布 verifier 因此以 candidate/HEAD Git blob 校验 SHA-256，并由“工作树 clean +
candidate 后仅允许 evidence 路径”约束当前内容；回归测试覆盖 CRLF 工作树表示。
同时 `.gitattributes` 将 Python SDK、官方模板和 author schema 强制为 LF，避免
新 worktree 把严格 bundle 变成不可执行的 CRLF 文件。

## Phase 9 可重复构建收口

此前 2 个 error 不是 Rust 算法或依赖漂移，而是 Cargo/Rust 的本地 path crate
身份泄漏了 worktree 绝对路径：同一源码在不同 worktree 会产生不同 PE 哈希。

构建锁迁移到 `candlescope.aho-corasick-build-lock/2`，冻结
`windows-subst-drive-v1`：在 Windows 上把源码映射到固定 `Q:` 身份，构建完成后
释放映射；占用或映射失败时 fail-closed。两个不同 worktree 经固定身份构建得到
同一个二进制：

- runtime SHA-256：`0a2947046d05a9bed34f20adb091b59da9ac491e4a3de414fc204f6132d9061b`
- bundle SHA-256：`7c507284903053e9c45e4acb3766e34c101e70d247c62760c071a98ea7b9a67d`
- size：426496 bytes

历史 `phase9_contract_v1.json` 未改写；新增 v2 合同记录迁移和旧合同哈希。
没有删除测试、跳过真实构建或放宽 gate。

## 长时证据适用性

1h Host soak 与 4h 浏览器 soak 来自祖先提交 `13e8943d`。最终候选没有修改
Host lifecycle、soak 脚本或浏览器 soak 脚本；后续改动仅涉及 Phase 9 构建锁、
N10 发布身份/EOL 校验、证据、测试副作用和 `backtestFlags.ts` 空白行。最终候选
又完整通过后端门禁，前端 Git subtree 也未变化，因此保留这两项长时证据，不伪称
在 `443307d2` 上重新跑满
5 小时。最终候选与完成 `npm run check` 的候选具有完全相同的 frontend Git
subtree（`592ae8dea50cd20678a4c60de6c75dd8302c1fef`）。

## 只读复核

本次对 `main...443307d2` 的默认关闭、Python runner 隔离、artifact 身份、
candidate→evidence-only 约束、远端/本地主分支包含关系、回滚范围和 Phase 9
供应链锁做了单独只读复核，未发现新的发布阻断项。这是 Codex 本次内部复核，
不是第二位人工 reviewer 的签署。

## 回滚

```text
git revert --no-commit 52c108c1..443307d2
```

在独立 detached worktree 实际执行后，回滚树与 N1 `52c108c1` 完全一致，
基础 runtime、release flag、architecture、schema rollback、data-quality 共 15 项
健康检查全部通过。临时演练 worktree 已删除；主工作树未保留回滚改动。

## 保留限制

- Pine/Pyne 仍是受限兼容子集，本次按范围不继续完善。
- `BAR_APPROX` 仍是近似成交；aggTrade 不是 raw trade，也不提供 queue-exact 语义。
- `BACKTEST_MULTI_MARKET_ENABLED=0`；basket 仍是逐 symbol 独立账本。
- 回测结果不能直接触发 paper/live 委托。
- 当前结论授权的是“干净、未合并候选已验证”，不是合并、推送或生产启用授权。
