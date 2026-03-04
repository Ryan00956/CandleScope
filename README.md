# CandleScope 📊

一个专为交易者设计的开源、高性能看盘软件。第一版 MVP（最小可行性产品）已经跑通。

## 🚀 快速开始

项目分为后端 (Python/FastAPI) 和前端 (React/Vite)。

### 1. 启动后端 (Backend)
后端负责从币安 (Binance) 抓取 K 线数据并提供接口。

```bash
cd backend
# 安装依赖
pip install -r requirements.txt
# 启动服务
uvicorn app.main:app --reload
```
默认运行在: `http://localhost:8000`
API 文档: `http://localhost:8000/docs`

### 2. 启动前端 (Frontend)
前端使用 TradingView 官方的 Lightweight Charts 库进行绘图。

```bash
cd frontend
# 安装依赖
npm install
# 启动开发服务器
npm run dev
```
默认运行在: `http://localhost:5173`

## 🛠️ 当前功能
- **实时数据展示**: 支持 BTC/USDT 的 1m 到 1M 全周期 K 线。
- **专业级图表**: 使用 Lightweight Charts v5，支持蜡烛图和成交量。
- **自动降级模式**: 如果由于网络原因无法连接币安 API，系统会自动切换到 **模拟数据模式** 供演示使用。
- **响应式设计**: 自动适配窗口大小。

## 📂 项目结构
- `/backend`: FastAPI 应用，包含数据抓取逻辑。
- `/frontend`: React 应用，包含 UI 和图表逻辑。

---
*CandleScope - 让看盘更简单。*