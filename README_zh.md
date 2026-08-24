<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/brand/candlescope-lockup-on-dark.svg" />
    <img src="frontend/public/brand/candlescope-lockup.svg" width="500" alt="CandleScope" />
  </picture>
</p>

# CandleScope

<p align="center">
  CandleScope 是一套本地运行的加密市场分析与行情回放工作台。
</p>

<p align="center">
  实时图表 · 订单流 · 多图联动 · 行情回放 · 可编程指标
</p>

<p align="center">
  <a href="README.md">English</a>
  · <a href="#产品">产品</a>
  · <a href="#快速开始">快速开始</a>
  · <a href="#文档">文档</a>
</p>

<!-- Hero 图片：docs/assets/readme/hero-live-workspace.png -->

## 产品

### 实时市场

查看 Binance 与 OKX 的现货和永续市场。在数据可用时，将实时图表、盘口、逐笔成交、
订单流和合约信息放在一起。

<!-- 产品图片：docs/assets/readme/live-order-flow.png -->

### 多图工作区

在保存的工作区里比较不同市场和周期。商品、周期、十字线、可视范围、绘图和指标
可以按需联动。

<!-- 产品图片：docs/assets/readme/multi-chart-workspace.png -->

### 行情回放

使用同步市场、共享模拟账户和可恢复的训练记录，在历史行情中练习，并在结束后
复盘或从任意节点重新开始。

<!-- 产品图片：docs/assets/readme/replay-training.png -->

### 指标与脚本

使用内置指标，或者通过 Pyne 编写本地指标。其他运行时可以通过插件系统接入。

<!-- 产品图片：docs/assets/readme/pyne-indicator.png -->

### 本地回测

在本地数据上测试固定的策略版本，查看交易、权益、回撤、参数，以及每份结果所用的
测试假设。

本地回测目前是可选 Beta，默认不开启。

<!-- 产品图片：docs/assets/readme/backtest-research.png -->

## 快速开始

需要 Python 3.11 或更高版本、Node.js 20 或更高版本，以及 npm 10 或更高版本。
推荐使用 Python 3.12。

启动后端：

Linux 或 macOS：

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
./dev-server.sh
```

Windows PowerShell：

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\dev-server.ps1
```

在另一个终端启动前端：

```bash
cd frontend
npm install
npm run dev
```

浏览器打开 [http://127.0.0.1:15173/](http://127.0.0.1:15173/)。API 地址是
`http://127.0.0.1:18080/`。

## 当前边界

- 行情回放只使用模拟委托，不会向真实交易所发送订单。
- 高级市场视图取决于当前交易所和市场是否提供所需数据。
- 标准工作区最多支持四张图；更高容量的布局需要手动开启。
- 当前首方 Pyne 与 Pine 插件包面向 Windows 和 CPython 3.12；Pine 兼容只覆盖
  明确支持的子集。
- 浏览器版本支持 Windows、Linux 和 macOS；可选桌面壳目前面向 Windows。

## 文档

| 主题 | 文档 |
|---|---|
| 前端 | [前端架构](frontend/ARCHITECTURE_zh.md) |
| API | [API 参考](API.md) |
| 行情数据与存储 | [Data Engine 指南](backend/app/data_engine/README_zh.md) |
| 行情回放 | [回放训练产品契约](docs/KLINE_REPLAY_TRAINING_PRODUCT_CONTRACT_zh.md) |
| 本地回测 | [本地 Beta 指南](docs/BACKTEST_PYTHON_LOCAL_BETA_GUIDE_zh.md) |
| 插件 | [插件开发与运行时指南](docs/PLUGIN_PLATFORM_AUTHOR_RUNTIME_GUIDE_zh.md) |
| 离线数据 | [本地离线模式](docs/local-offline-mode.md) |
| 警报 | [警报投递指南](docs/ALERTS_DELIVERY_zh.md) |

## 开发

后端检查：

```bash
cd backend
python -m compileall app tests -q
python -m pytest -q
```

前端检查：

```bash
cd frontend
npm run typecheck
npm run lint
npm test
npm run build
```

## 许可证

CandleScope 采用 [GNU GPL-3.0](LICENSE) 许可证。
