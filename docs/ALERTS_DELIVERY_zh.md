# CandleScope 警报投递边界

## 默认行为

本地价格/指标警报默认只注册 `in_app`、`browser` 和 `sound`。Webhook 默认关闭；未配置完整安全策略时，即使规则请求启用 Webhook，后端也会拒绝保存。

启用 Webhook 至少需要：

```dotenv
ALERT_WEBHOOK_ENABLED=1
ALERT_WEBHOOK_SECRET=<高熵随机密钥>
ALERT_WEBHOOK_ALLOWED_HOSTS=hooks.example.com
```

完整配置示例见 `backend/.env.alerts.example`。

## 投递语义

- 触发事件先写入警报历史，再将 Webhook 写入 SQLite Outbox。
- Outbox worker 独立于实时行情运行时启动；行情初始化失败不会阻止已有待投递记录恢复。
- Outbox 记录进入可投递状态后才唤醒后台 worker。
- 进程在请求中途退出时，下一次启动会恢复 `staged` / `processing` 记录。
- `408`、`425`、`429`、`5xx` 和网络错误按有上限的指数退避重试；其他 `4xx` 直接进入死信。
- 当前保证是“至少一次”，接收端应按 `X-CandleScope-Delivery` 幂等去重。
- 2xx 才视为送达；不跟随重定向，也不把响应正文写入历史或日志。

## 请求与签名

请求体是稳定排序的 UTF-8 JSON，并携带：

- `X-CandleScope-Delivery`: 持久化 delivery id。
- `X-CandleScope-Timestamp`: Unix 秒。
- `X-CandleScope-Signature`: `sha256=<hex>`。

签名输入为：

```text
HMAC_SHA256(secret, timestamp + "." + raw_request_body)
```

接收端应验证时间窗口、HMAC，并用 delivery id 去重。

## 网络安全边界

- 目标主机必须精确出现在 `ALERT_WEBHOOK_ALLOWED_HOSTS`。
- 默认只接受 HTTPS。
- 默认拒绝解析到回环、私网、链路本地、保留地址或其他非公网地址的目标。
- 禁止 URL 用户名/密码和 fragment。
- 禁止 HTTP 重定向和环境代理继承。

只有在明确需要本机开发接收器时，才同时开启 `ALERT_WEBHOOK_ALLOW_HTTP=1` 与 `ALERT_WEBHOOK_ALLOW_PRIVATE_NETWORK=1`，并仍然使用精确主机白名单。

## 耐久性门禁

快速重启/重试门禁：

```powershell
python backend/scripts/soak_alerts_delivery.py `
  --cycles 1000 `
  --restart-every 25 `
  --crash-every 100 `
  --retain-delivered 100 `
  --sample-every-seconds 5 `
  --report output/alerts-delivery-soak-quick.json
```

快速门禁故意只保留 100 条已送达 Outbox 记录，最终通过条件使用 SQLite
中的累计计数；因此它会实际覆盖 retention，而不会把正常清理误报成丢失。

正式 24 小时门禁必须从已提交的干净 HEAD 启动，并把状态与报告写到仓库外、
按 Git SHA 隔离的 release-evidence 目录：

```powershell
$sha = (git rev-parse HEAD).Trim()
$evidence = "H:\program\CandleScope-alerts-release-evidence\$sha\alerts"
New-Item -ItemType Directory -Force -Path $evidence | Out-Null

python backend/scripts/soak_alerts_delivery.py `
  --duration-seconds 86400 `
  --restart-every 25 `
  --crash-every 100 `
  --sample-every-seconds 30 `
  --require-clean-head `
  --state-dir "$evidence\state" `
  --report "$evidence\alerts-delivery-soak-24h.json"
```

该脚本不会访问外网；它使用生产 Facade、SQLite Outbox、worker 生命周期、历史回执与退避调度，并注入可重试的确定性失败。
每次 `--crash-every` 会轮换制造 `staged`、已 claim 的 `processing`、已排期的
`retrying`，子进程随后通过 `os._exit` 异常退出，父进程再用生产 worker 恢复。

报告在运行中周期性原子更新，包含 Git SHA/脏工作树状态、累计投递/尝试/重试/
死信计数、队列峰值、异常恢复次数、SQLite 文件大小以及进程 RSS 趋势。
只有最终 `status=passed`、`passed=true` 和进程退出码 `0` 同时成立才算通过；
`status=running` 只表示门禁尚在执行。
