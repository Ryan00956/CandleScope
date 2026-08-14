# Backtest 发布与回滚手册

状态：功能已在 `codex/backtest-foundation` 实现并通过自动门禁；**生产 flags 保持 0**。
本手册不授权 merge、push 或打开入口。

## 运行时紧急停用

1. 停止创建新 Study/Run；
2. 将 `BACKTEST_ENABLED` 及全部子 flags 设为 `0`；
3. 重启后确认 `/api/v1/backtests` 未注册；
4. 确认 live / local / replay / plugin 基本健康；
5. 保留故障 Run、日志和 `backtest.db`，不要立即删除。

## 代码回滚

```powershell
git revert --no-commit <release-commit>
```

禁止用 `git reset --hard` 清掉用户工作区。回滚后重跑：

```powershell
Set-Location backend
python -m pytest tests/backtest_contract tests/test_backtest_control_plane.py tests/test_trade_tape.py -q
```

## 未在本环境执行的项

- 1h/4h soak
- 完整浏览器验收
- 百万级成交 soak
- 独立 detached worktree 的 exact revert 演练

这些必须在发布候选 SHA 上另行取证，不能把“已实现”写成“已启用/已推送”。
