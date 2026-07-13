# CandleScope 前端 TypeScript 渐进迁移执行文档

> 状态：待执行
> 计划基线日期：2026-07-13
> 适用范围：`frontend/`
> 核心原则：渐进迁移，不全量重写；每个阶段独立验证、独立提交、独立回滚。

本文定义 CandleScope 前端从 JavaScript/JSX 迁移到 TypeScript/TSX 的完整执行路线。

迁移目标不是把现有代码“重新写一遍”，也不是借 TypeScript 之名同时重做架构。当前前端已经具备清晰的 `app -> features -> chart-adapter/shared` 边界、较完整的单元测试和浏览器 smoke。正确做法是在保持这些行为和边界不变的前提下，从低风险纯函数开始，逐步把类型约束向 API、WebSocket、图表、指标、绘图和 React 组合根推进。

当前架构事实以[前端架构](ARCHITECTURE_zh.md)为准。本文只负责迁移步骤、验证门、回滚条件和完成定义。

---

## 1. 迁移结论

采用以下方案：

- 新代码默认使用 TypeScript。
- 现有 JS/JSX 允许在迁移期继续运行。
- 不开一个长期并行的“TS 重写版”前端。
- 不一次性重命名整个目录。
- 不在类型迁移提交里顺手改变 UI、网络协议、缓存策略、调度顺序或图表语义。
- 生产源码、测试、构建和 smoke 始终保持可运行。

一句话：

> 保留当前前端，只替换它的类型表达方式；先收紧契约，再迁复杂实现。

---

## 2. 当前基线

以下是 2026-07-13 的仓库快照。正式执行 Phase T0 时必须重新统计并把结果写入文末“执行记录”，不能把本表当成永久事实。

| 项目 | 当前状态 |
|---|---|
| 框架 | React `^19.2.0` |
| 构建工具 | Vite `^7.3.1` |
| 图表库 | Lightweight Charts `^5.1.0` |
| `src` 中 `.js` | 271 个 |
| `src` 中 `.jsx` | 54 个 |
| `src` 中 `.ts/.tsx` | 0 个 |
| 生产 JS/JSX 文件 | 241 个 |
| 测试文件 | 84 个 |
| `src` 物理行数 | 约 6.6 万行，含空行、注释和测试 |
| TypeScript 编译器 | 未安装 |
| `tsconfig` | 不存在 |
| ESLint TS 支持 | 不存在，只检查 JS/JSX |
| 架构检查 | 只识别 `.js/.jsx` |
| 单元测试 | `node:test`，当前由裸 `node --test` 执行 |
| 浏览器验收 | `smoke`、`smoke:chart-types`、`smoke:export`、`smoke:release` |

当前最需要类型保护的区域：

- `services/api.js` 和 `services/indicatorApi.js` 直接消费 `response.json()`。
- K 线、指标和 watchlist WebSocket 以 `JSON.parse()` 后的动态对象驱动分支。
- `market-data` 同时处理秒、毫秒、范围、epoch、stale request 和窗口 revision。
- `chart-representation` 存在普通时间和自定义 ordinal axis time。
- `chart-adapter` 同时连接 Lightweight Charts 泛型、custom series、pane、viewport 和 drawing 坐标。
- drawing anchor 需要区分绝对 source time、`sourceOrdinal`、projection lineage 和迁移期 logical fallback。
- `SingleChartPanes.jsx`、`useIndicatorRuntime.js`、`drawingInteractionController.js` 是高耦合热点，必须后迁。

当前已有的有利条件：

- feature 所有权边界已经清楚。
- `check:architecture` 当前无 migration allowlist。
- 当前静态 import 图未发现循环依赖。
- 绝大多数复杂纯函数已有 `node:test` 覆盖。
- Vite 可以在同一项目中同时处理 JS、JSX、TS 和 TSX。

---

## 3. 目标

完成后应达到：

- `src` 中生产源码全部使用 `.ts/.tsx`。
- `strict: true` 下 `npm run typecheck` 通过。
- API、WebSocket、localStorage 的原始数据先按 `unknown` 处理，再经 parser/guard 进入业务层。
- K 线、时间单位、series identity、chart time、indicator payload、drawing anchor 等核心类型由明确 owner 持有。
- React runtime 公开接口稳定为 `{ view, actions, status, events? }`，而不是隐式大对象。
- Lightweight Charts 的类型只在 `chart-adapter` 内部直接出现。
- `SingleChartPanes` 的 props、imperative handle、refs 和 callbacks 有完整类型。
- 单元测试数量不低于 Phase T0 基线；新增 parser/guard 必须新增失败用例。
- `check:architecture`、typecheck、lint、test、build 和 release smoke 全部通过。
- 不保留永久 `.js` facade、无限期 allowlist 或无法解释的 `any`。

---

## 4. 非目标

本计划不负责：

- 重做 UI 视觉设计。
- 更换 React、Vite、Lightweight Charts 或状态管理方案。
- 把 `node:test` 整体换成 Vitest/Jest。
- 改变 FastAPI 路由、WebSocket 协议或数据库 schema。
- 重写 K 线加载、backfill、gap recovery、indicator cache 或 drawing persistence 语义。
- 在迁移时拆解 `SingleChartPanes`、`useIndicatorRuntime` 或 drawing controller。
- 为了“类型漂亮”删除当前必要的 runtime fallback。
- 把全部类型塞进一个全局 `types.ts`。
- 追求 100% 类型体操或让类型比业务代码更难理解。

如果迁移过程中发现真实业务 bug，应单独记录，在独立修复提交中处理；不能混进机械迁移提交。

---

## 5. 强制迁移原则

### 5.1 一次只迁一个可验证切片

一个提交应满足：

- 文件属于同一个 owner 或同一条依赖链。
- 后缀修改、类型声明和必要的 parser/guard 可以一起提交。
- 不混入无关格式化。
- 不混入行为重构。
- 提交结束时全局静态门通过。

禁止“把某个目录全部改成 `.ts`，再统一修错误”。

### 5.2 新 TS 文件从第一天就严格

- `strict: true` 从 Phase T1 开启。
- 迁移期使用 `allowJs: true`、`checkJs: false`。
- 不先对全仓开启 `checkJs: true`。
- 不为快速通过而把 `strict` 关掉。
- 不使用 `const enum`。
- registry/常量优先使用 `as const` 和字面量联合。
- 只作为类型使用的依赖必须使用 `import type`。

### 5.3 外部数据永远不是“已经有类型”

以下表达禁止作为最终实现：

```ts
const payload = await response.json() as KlineResponse;
const message = JSON.parse(event.data) as IndicatorMessage;
const settings = JSON.parse(raw) as Settings;
```

正确顺序：

```ts
const raw: unknown = await response.json();
const payload = parseKlineResponse(raw);
```

parser/guard 必须负责：

- 判断对象、数组和必需字段。
- 校验有限数值、整数、时间单位和范围顺序。
- 处理 snake_case/camelCase 兼容时只转换一次。
- 对未知 WebSocket message type 安全忽略并保留诊断。
- 对损坏 localStorage 使用默认值或兼容迁移，不能让页面启动崩溃。

高频 WebSocket 优先使用小型手写 guard，避免每个 tick 做昂贵的通用 schema 遍历。低频 REST/localStorage 若未来需要引入 schema 库，必须单独提交并测量 bundle 变化；Phase T1 不引入 schema 库。

### 5.4 类型按所有权放置

推荐结构：

```text
src/shared/
  mainChartTypes.ts
  timeTypes.ts
  marketIdentityTypes.ts

src/features/chart-session/
  chartSessionTypes.ts

src/features/market-data/
  marketDataTypes.ts
  klineContracts.ts

src/features/chart-representation/
  chartRepresentationTypes.ts

src/chart-adapter/
  chartAdapterTypes.ts

src/features/indicators/
  indicatorTypes.ts
  indicatorContracts.ts

src/features/drawings/
  drawingTypes.ts
  drawingContracts.ts
```

约束：

- 只在多个 feature 之间稳定共享的标量/身份类型才能进入 `shared`。
- feature 私有 payload、state、action 和 view model 留在 feature 内。
- `chart-adapter` 的 raw chart handles 不进入 feature 公共 contract。
- type-only import 仍然算架构依赖，不能借 `import type` 绕过边界。
- 不建立包罗万象的 `src/types.ts`。

### 5.5 危险标量要区分语义

优先定义并通过构造函数创建：

- `EpochSeconds`
- `EpochMilliseconds`
- `IntervalSeconds`
- `SeriesKey`
- `DatasetKey`
- `SymbolCode`
- `ExchangeId`
- `MarketType`

普通 `number` 无法区分秒和毫秒。仅写：

```ts
type EpochSeconds = number;
```

没有保护作用。应使用 branded type 或带字段名的对象，并由 parser/constructor 校验后生成。

不要过度 brand 所有数字。价格、成交量等在同一上下文中不会混淆时保持 `number`。

### 5.6 临时逃生口必须可删除

默认禁止：

- `@ts-ignore`
- `@ts-nocheck`
- 无说明的 `@ts-expect-error`
- `as unknown as SomeType`
- feature-wide `any`
- 永久 `.d.ts` 谎报 JS 模块形状

确实无法避免时，必须在文末 suppression ledger 记录文件、原因、保护测试和最迟删除 Phase。

### 5.7 保持 import 解析策略一致

当前大量源码、测试和 `.mjs` 脚本显式 import `*.js`。把源文件改名为 `.ts` 后，裸 Node ESM 不保证把 `foo.js` 映射到 `foo.ts`。

Phase T1 必须先用 canary 固定一种策略：

1. 首选保留现有 `.js` module specifier，由 `moduleResolution: "Bundler"`、Vite 和 `tsx` 解析到 TS 源文件。
2. 如果 canary 任一链路失败，只修改受影响 import 为 extensionless specifier。
3. 不把全仓 import 改成显式 `.ts`，也不依赖 `allowImportingTsExtensions`。
4. 不同时保留同名 `foo.js` facade 和 `foo.ts` 实现；临时 facade 只能带删除 Phase 和 architecture allowlist。
5. 每次 rename 后运行：

   ```powershell
   rg -n "被迁移文件名\.js" src scripts
   ```

   检查静态 import、dynamic import、Vite URL 和 smoke 脚本。

---

## 6. 通用验证门

除 Phase T0/T1 的工具链特殊步骤外，后续每个阶段至少运行：

```powershell
Set-Location H:\program\CandleScope\frontend
npm run check:architecture
npm run typecheck
npm run lint
npm test
npm run build
```

建议在 Phase T1 增加聚合脚本：

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "tsx --test",
    "check": "npm run check:architecture && npm run typecheck && npm run lint && npm test && npm run build"
  }
}
```

有运行环境时，根据改动范围追加：

```powershell
npm run smoke -- --url http://127.0.0.1:15173/
npm run smoke:chart-types
npm run smoke:export
npm run smoke:release
```

smoke 未执行时，执行记录必须写明未执行原因、所需环境和补跑条件，不能记为通过。

---

## 7. 阶段依赖总览

| Phase | 主题 | 风险 | 必须依赖 |
|---|---|---:|---|
| T0 | 冻结基线和迁移台账 | 低 | 无 |
| T1 | TS 工具链、ESLint、架构检查、mixed-mode canary | 高 | T0 |
| T2 | shared、utils、chart-session 契约 | 低 | T1 |
| T3 | market-data 内核和窗口/feed 类型 | 中 | T2 |
| T4 | HTTP、K 线 WebSocket 和 transport 边界 | 中 | T3 |
| T5 | chart-representation 纯投影引擎 | 中 | T2 |
| T6 | chart-adapter 和 Lightweight Charts 类型 | 高 | T5 |
| T7 | cache/watchlist/export/settings 等支撑内核 | 中 | T2-T4 |
| T8 | indicator core、API、WS 和 cache | 高 | T3-T6 |
| T9 | drawing core、persistence 和 primitives | 高 | T5-T6 |
| T10 | feature React runtimes/hooks | 高 | T7-T9 |
| T11 | feature UI 和普通组件 | 中 | T10 |
| T12 | `SingleChartPanes`、app 和入口 | 极高 | T6、T10、T11 |
| T13 | 测试迁移、严格度收口和 release 验收 | 高 | T12 |

T4 和 T5 在不冲突时可以并行开发，但合并顺序仍应保证每次主分支全局门通过。T6 之后再开始 drawings；T8/T9 之后再迁聚合 hooks。

---

## Phase T0：冻结基线和建立迁移台账

### 修复的问题

没有可比较的基线时，后续无法判断测试减少、bundle 变化、smoke 失败或类型 suppression 是否是迁移引入。

### 前置条件

- 工作区中的既有改动已确认归属。
- 不在脏工作区里把无关文件混入迁移提交。

### 目标

记录迁移开始前的真实状态，不修改生产行为。

### 任务

1. 在仓库根目录记录 Git 状态：

   ```powershell
   git status --short
   git branch --show-current
   git rev-parse HEAD
   ```

2. 进入 `frontend/`，使用 lockfile 安装：

   ```powershell
   Set-Location H:\program\CandleScope\frontend
   npm ci
   ```

3. 运行当前静态和测试基线：

   ```powershell
   npm run check:architecture
   npm run lint
   node --test
   npm run build
   ```

4. 统计文件：

   ```powershell
   $extensions = '.js', '.jsx', '.ts', '.tsx'
   Get-ChildItem .\src -Recurse -File |
     Where-Object { $extensions -contains $_.Extension } |
     Group-Object Extension |
     Sort-Object Name |
     Select-Object Name, Count
   ```

5. 记录测试文件数和实际 test count。最终验收不能低于该基线。
6. 搜索现有 suppression 和动态边界：

   ```powershell
   rg -n "@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|JSON\.parse|response\.json" src
   ```

7. 有后端和 Vite 环境时运行：

   ```powershell
   npm run smoke -- --url http://127.0.0.1:15173/
   npm run smoke:release
   ```

8. 把结果填入文末 Phase 执行记录，不修改正文中的历史计划。

### 验收

- 当前 commit、分支、文件数、测试数、build 结果均已记录。
- smoke 已通过，或明确记录未执行原因和补跑条件。
- 现有失败已区分为迁移前失败，不会被后续误算为迁移回归。

### 回滚

本 Phase 不应产生生产文件修改。若生成临时日志，不提交并删除。

### 不做

- 不安装 TypeScript。
- 不改后缀。
- 不修基线中发现的业务 bug。

---

## Phase T1：建立 TypeScript 工具链和 mixed-mode canary

### 修复的问题

当前没有 TypeScript 编译器、TS lint、TS 架构检查或 TS 测试运行链。直接 rename 会让 `node:test`、显式 `.js` import、smoke 脚本和 Vite URL 产生不确定解析。

### 前置条件

- T0 已完成并记录。
- 当前全局门达到 T0 记录的状态。

### 目标

让 JS、JSX、TS、TSX 在同一仓库中稳定共存，并通过一个真实 canary 证明：

- JS test -> TS source。
- TS source -> TS dependency。
- `.mjs` script -> TS source。
- Vite build -> TS source。

### 涉及文件

- `package.json`
- `package-lock.json`
- `eslint.config.js`
- `scripts/check-architecture.mjs`
- 新增 `tsconfig.json`
- 新增 `src/vite-env.d.ts`
- 新增临时 resolution canary fixture/test
- 首个真实迁移文件：`src/shared/mainChartTypes.js -> .ts`

### 任务

1. 安装直接 dev dependencies：

   ```powershell
   npm install --save-dev typescript typescript-eslint tsx @types/node
   ```

2. 新增 `tsconfig.json`，初始配置固定为：

   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "useDefineForClassFields": true,
       "lib": ["ES2022", "DOM", "DOM.Iterable"],
       "module": "ESNext",
       "moduleResolution": "Bundler",
       "moduleDetection": "force",
       "allowJs": true,
       "checkJs": false,
       "jsx": "react-jsx",
       "strict": true,
       "noEmit": true,
       "isolatedModules": true,
       "verbatimModuleSyntax": true,
       "resolveJsonModule": true,
       "skipLibCheck": true,
       "forceConsistentCasingInFileNames": true,
       "types": ["vite/client", "node"]
     },
     "include": ["src", "scripts/**/*.ts"],
     "exclude": ["dist", "node_modules"]
   }
   ```

3. 新增 `src/vite-env.d.ts`：

   ```ts
   /// <reference types="vite/client" />
   ```

4. 在 `package.json` 增加 `typecheck`、`test` 和 `check`：

   ```json
   {
     "scripts": {
       "typecheck": "tsc --noEmit -p tsconfig.json",
       "test": "tsx --test",
       "check": "npm run check:architecture && npm run typecheck && npm run lint && npm test && npm run build"
     }
   }
   ```

5. 把 `test:drawing` 改为通过 `tsx --test` 执行。
6. 搜索所有会直接/间接 import `src` 的 Node 入口：

   ```powershell
   rg -n "src/|src\\\\" scripts package.json
   ```

   `smoke.mjs`、chart type matrix 等入口改由 `tsx` 启动。没有 import TS 源码的纯 Node 脚本可以继续用 `node`。

7. 修改 ESLint flat config：

   - JS/JSX 保留当前规则。
   - TS/TSX 增加 `typescript-eslint` 的 `recommended` 配置。
   - 本阶段先不启用 type-aware lint。
   - TS/TSX 继续使用 React hooks 和 React refresh 规则。
   - `no-unused-vars` 对 TS 文件由 TypeScript ESLint 对应规则接管。

8. 修改 `scripts/check-architecture.mjs`：

   - `SOURCE_EXTENSIONS` 加入 `.ts/.tsx`。
   - `normalizeModulePath()` 识别 `.ts/.tsx/.mts/.cts`。
   - runtime 文件匹配改为兼容 `Runtime.ts/tsx`。
   - `src/app/App.jsx` 特判改为同时识别 `App.tsx`，最好比较无后缀 normalized path。
   - `strictRuntimeContractFiles` 改为无后缀路径，避免 rename 后绕过规则。
   - 所有原有规则必须对 TS/TSX 同样生效。

9. 新增 temporary resolution fixture：

   ```text
   scripts/type-migration-canary/
     leaf.ts
     entry.ts
     entry.test.js
   ```

   `entry.ts` 使用当前约定的 `.js` specifier import `leaf.ts`；JS test 再通过 `.js` specifier import `entry.ts`。它只验证解析，不包含业务逻辑，T13 删除。

10. 把 `src/shared/mainChartTypes.js` rename 为 `.ts`：

    - `MAIN_CHART_TYPES` 使用 `as const`。
    - 导出 `MainChartType` 字面量联合。
    - `normalizeMainChartType()` 接收 `unknown` 或 `string`，返回 `MainChartType`。
    - 不改变字符串值和 fallback。

11. 验证 `.mjs` script -> TS：

    ```powershell
    npx tsx -e "import('./scripts/chart-type-matrix.mjs').then(() => console.log('chart matrix import ok'))"
    ```

12. 运行完整 gate：

    ```powershell
    npm run check
    ```

13. 有运行环境时运行 `npm run smoke:chart-types`。
14. 把最终 import specifier 选择写入执行记录。canary 不通过时停止迁移，不允许带着解析问题进入 T2。

### 验收

- `npm run typecheck` 首次通过。
- 原有 JS/JSX 仍可运行。
- canary 四条解析链全部通过。
- `check:architecture` 对 `.ts/.tsx` 不会漏检。
- 单元测试不少于 T0 基线。
- Vite build 通过。
- chart type matrix 能读到迁移后的类型文件。

### 回滚

- 回退 `mainChartTypes.ts` 到 `.js`。
- 删除 canary、`tsconfig.json` 和 `vite-env.d.ts`。
- 回退 package/lockfile、ESLint 和 architecture checker。

### 不做

- 不全仓开启 `checkJs`。
- 不启用 type-aware lint。
- 不改大量 import 风格。
- 不迁第二个业务模块。
- 不通过 JS facade 掩盖 canary 失败。

---

## Phase T2：迁移 shared、utils 和 chart-session 契约

### 修复的问题

symbol、exchange、market type、interval、dataset key、visible range 和 session transition 在大量 feature 之间传递，目前主要靠字符串和对象 shape 约定。

### 前置条件

- T1 mixed-mode canary 全部通过。
- import specifier 规则已记录。

### 目标

建立低风险、可复用的身份和会话类型，为 market-data、watchlist、settings 和 App 提供稳定输入。

### 文件顺序

按以下顺序逐个迁移，每个小组单独提交：

1. `src/utils/intervals.js`
2. `src/utils/intervalTimeline.js`
3. `src/utils/symbolKey.js`
4. `src/utils/exportFilename.js`
5. `src/features/chart-session/chartDatasetKey.js`
6. `src/features/chart-session/chartSessionTransition.js`
7. `src/features/chart-session/intervalPolicy.js`
8. `src/features/chart-session/trackedIntervalsPolicy.js`
9. `src/features/chart-session/paneLayoutStorage.js`
10. `src/features/chart-session/visibleRangeStorage.js`
11. `src/features/chart-session/chartSessionModel.js`
12. 新增 `src/features/chart-session/chartSessionTypes.ts`

`mainChartTypes.ts` 已在 T1 完成。

### 核心类型

- `IntervalUnit`
- `IntervalString`
- `IntervalParts`
- `ExchangeId`
- `MarketType`
- `SymbolCode`
- `SymbolIdentity`
- `SeriesIdentity`
- `DatasetKey`
- `ChartSession`
- `ChartSessionTransition`
- `VisibleRangeSnapshot`

### 任务

1. 先给纯 parser 返回值加类型，不改 parser 宽容行为。
2. `normalizeIntervalValue()` 仍以 runtime validation 为准，不能因为参数标成 `IntervalString` 而跳过校验。
3. `symbolKey()` 和 `parseSymbolKey()` 固化同一 round-trip contract。
4. transition type 使用常量对象 + 字面量联合，不使用 TS enum。
5. `localStorage` 读取结果先作为 `unknown`：

   - user prefs 损坏时回退 `{}`。
   - visible range 字段逐个验证。
   - pane height 只接受有限正数。

6. storage key 和已存 JSON shape 保持不变。
7. 每迁一个文件，搜索显式 `.js` 引用并跑全局 typecheck。
8. 为非法 interval、损坏 prefs、错误 visible range 增加测试。

### 验证

```powershell
npx tsx --test src/features/chart-session/__tests__/chartDatasetKey.test.js
npx tsx --test src/features/chart-session/__tests__/trackedIntervals.test.js
npx tsx --test src/features/chart-session/__tests__/visibleRangeStorage.test.js
npx tsx --test src/utils/__tests__/exportFilename.test.js
npm run check
```

### 验收

- chart-session 的公开状态不再依赖隐式 object shape。
- interval 大小写语义不变，尤其 `M` 仍代表月。
- 旧 localStorage 可以读取。
- 不支持的 interval fallback 行为不变。
- 无新增 suppression。

### 回滚

按文件小组回退 rename 和类型，不删除或迁移用户 localStorage 数据。

### 不做

- 不迁 `useChartSession` 和 React hooks。
- 不修改 exchange capability 业务规则。
- 不更换 storage key。

---

## Phase T3：迁移 market-data 内核

### 修复的问题

K 线窗口、fetch plan、epoch、stale request、backfill completion 和 delta 依赖多个相似对象。秒/毫秒和 active/stale 语义一旦传错，JS 只能在运行时暴露。

### 前置条件

- T2 的 interval、series identity 和 session 类型可用。

### 目标

固化 market-data 内部纯模型和 feed contract，不改变调度、缓存或网络行为。

### 建议结构

```text
src/features/market-data/
  marketDataTypes.ts
  klineContracts.ts
```

核心类型：

- `KlineBar`
- `EpochSeconds`
- `EpochMilliseconds`
- `TimeRangeSec`
- `TimeRangeMs`
- `SeriesKey`
- `SeriesCoverage`
- `DataRevision`
- `WindowDelta` 判别联合
- `FetchPlan` 判别联合
- `KlineApi` interface
- `BackfillCompletedMessage`

### 文件顺序

1. `phase1WindowPolicy.js`
2. `rangeRuntime.js`
3. `chartDataRuntime.js`
4. `crosshairDisplayStore.js`
5. `indicatorRangeRuntime.js`
6. `marketDataEvents.js`
7. `marketDataView.js`
8. `window/windowDeltas.js`
9. `window/seriesWindowStore.js`
10. `window/windowRegistry.js`
11. `feed/fetchPlanner.js`
12. `feed/inflightRegistry.js`
13. `feed/seriesDataFeed.js`

`feed/klineApi` 和 `feed/klineStreamSubscription` 留到 T4。

### 任务

1. 从测试 fixture 归纳真实 `KlineBar` 字段，不凭印象新增必填字段。
2. 为秒、毫秒建立构造/转换函数，转换只发生在命名清晰的边界。
3. `normalizeRangeSec()` 返回 `TimeRangeSec | null`。
4. `SeriesWindowStore` 的 rows、coverage、revision 和 delta 全部类型化。
5. `WindowDelta` 用 `type` 字段做判别联合，switch 必须有 `never` exhaustiveness check。
6. `InflightRegistry` 的 key、promise result 和 abort path 明确类型。
7. `SeriesDataFeed` 先声明 `KlineApi` dependency interface，即使实际 implementation 仍来自 JS。
8. 保留并测试以下不变量：

   - epoch 变化后旧结果不能提交。
   - stale request 不覆盖 active series。
   - before-page completion 不重复释放 loading。
   - range 秒/毫秒转换位置不移动。
   - window budget 和 trim 顺序不变。

9. 只添加类型和测试；发现竞态 bug 时另开修复提交。

### 验证

```powershell
npx tsx --test src/features/market-data/__tests__/fetchPlanner.test.js
npx tsx --test src/features/market-data/__tests__/seriesWindowStore.test.js
npx tsx --test src/features/market-data/__tests__/windowRegistry.test.js
npx tsx --test src/features/market-data/__tests__/seriesDataFeed.test.js
npm run check
```

### 验收

- 秒/毫秒在函数签名中可区分。
- `SeriesDataFeed` 不再接收无 shape 的 api/callback object。
- 所有 stale/epoch 测试保持通过。
- K 线数量、加载顺序和缓存预算不变。

### 回滚

按 `window -> planner -> feed` 的反方向回退。不得保留半套 branded time 类型和普通 number 混用。

### 不做

- 不迁 HTTP 实现。
- 不改变 fetch 次数、重试、cooldown 或 backfill 策略。
- 不迁 React hooks。

---

## Phase T4：迁移 HTTP 和 K 线 WebSocket 边界

### 修复的问题

`response.json()` 和 `JSON.parse(event.data)` 当前直接把动态数据交给业务层。仅给返回值写一个 TS 类型会制造错误安全感。

### 前置条件

- T3 已定义 K 线、range 和 feed contract。

### 目标

让 transport 层只向业务层输出已验证、已标准化的对象。

### 涉及文件

- `src/services/apiConfig.js`
- `src/services/api.js`
- `src/features/market-data/feed/klineApi.js`
- `src/features/market-data/feed/klineStreamSubscription.js`
- 对应 services/market-data tests

`indicatorApi` 和 indicator WebSocket 在 T8；alerts/settings 专用 client 随 owner 在 T7/T10。

### 任务

1. 先迁 `apiConfig`，固定 HTTP/WS URL 类型和 optional env 输入。
2. 给 `ApiError`、request method、headers、body、signal 建立类型。
3. 底层 `request()` 返回 `Promise<unknown>`，不写欺骗性的 `<T>` 泛型。
4. 在 endpoint wrapper 中解析响应：

   - K 线 history/before/range/latest。
   - exchange list/capabilities，因为 T2 已有 TS consumer。
   - 已迁消费者依赖的 subscription response。

5. 尚未迁 owner 的 endpoint 可以暂时返回 `unknown`，但必须在 suppression ledger 标明最迟处理 Phase。
6. `parseKlineResponse()` 校验：

   - `data` 为数组。
   - time 为有限数值且单位符合 endpoint contract。
   - OHLC 为有限数值。
   - `has_more`、`next_end_ms`、`truncated` 等 metadata 类型正确。

7. `klineStreamSubscription`：

   - `JSON.parse()` 结果声明为 `unknown`。
   - 定义 control、status、backfill、kline message 判别联合。
   - 未知 type 不进入 callback。
   - 缺失 `msg.data` 或错误 tick shape 触发 parse diagnostic，不更新图表。

8. 保留 `"pong"` 快路径、reconnect、subscribe/unsubscribe 和 callback 顺序。
9. 增加无效 JSON、未知 type、缺字段、错误时间单位、abort 测试。
10. 搜索所有 Vite URL 形式的 `.js` 请求，迁移后实际跑一次对应测试。

### 验证

```powershell
npx tsx --test src/services/__tests__/subscriptionApiPolicy.test.js
npx tsx --test src/features/market-data/__tests__/seriesDataFeed.test.js
npm run check
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:15173/
```

### 验收

- raw REST/WS payload 不会无验证进入 market-data。
- `ApiError` 的 status/detail/url 行为不变。
- AbortError 不被包装成错误 payload。
- 无效 WS message 不导致 socket 崩溃或图表更新。
- 正常 K 线加载和 realtime 更新 smoke 通过。

### 回滚

优先回退 endpoint parser 与后缀，不改变后端协议。若 parser 过严导致合法 payload 被拒绝，应先保存 fixture，再单独修 parser。

### 不做

- 不生成全量 OpenAPI client。
- 不引入 schema 库。
- 不改变 endpoint URL 或参数名。

---

## Phase T5：迁移 chart-representation 纯投影引擎

### 修复的问题

普通 K 线时间和 Renko/Kagi/Point & Figure/Line Break 的 ordinal axis time、projection metadata、tail state 目前靠手写 shape 和 JSDoc 维持。

### 前置条件

- T2 的 chart type 和时间标量可用。
- T3 的 `KlineBar` 可用。

### 目标

建立投影引擎的 source row、display row、lineage 和 projector contract，为 chart-adapter/drawings 提供稳定输入。

### 文件顺序

先 types 和 leaf：

1. 新增 `chartRepresentationTypes.ts`
2. `priceTick.js`
3. `projectors/projectorData.js`
4. `axisTime.js`
5. 各 projection options
6. `projectors/identityProjector.js`
7. `projectors/heikinAshiProjector.js`
8. `projectors/renkoProjector.js`
9. `projectors/pointFigureProjector.js`
10. `projectors/kagiProjector.js`
11. `projectors/lineBreakProjector.js`
12. `projectorFactory.js`
13. `chartTypeRegistry.js`
14. `drawingLineageIndex.js`
15. `derivedAuxiliaryProjection.js`
16. `projectionViewportPolicy.js`
17. `surfaceViewportState.js`
18. `projectionStore.js`
19. `index.js`

### 核心类型

- `OrdinalAxisTime`
- `AxisTime`
- `ProjectionMetadata`
- `ProjectionConfig`
- `ProjectionResult`
- `SourceBar`
- `DisplayRow`
- `Projector<TState, TConfig>`
- `ProjectionTailState`
- `SourceTimeRange`

### 任务

1. `isOrdinalAxisTime()` 保持为 runtime guard。
2. `AxisTime` 联合不得把 ordinal object 简化成 `number`。
3. `sourceTime` 和 `sourceOrdinal` 明确用途；projection-local `order` 不能被当成持久化身份。
4. projector interface 明确 full rebuild、incremental update、provisional tail 和 reset。
5. 每个 projector 的 config 用判别类型或独立 interface。
6. registry 使用 `satisfies` 检查 descriptor，不改变运行时对象。
7. `ProjectionStore` 的 stateful tail、1:N source emission 和 repeated timestamp 测试必须保持。
8. 避免为了类型方便 clone 大数组或改变 hot path。

### 验证

```powershell
npm test
npm run check
```

重点确认 `src/features/chart-representation/__tests__/` 下全部测试仍被发现，测试数不低于 T0。

### 验收

- Axis time 的普通/ordinal 分支可穷尽。
- projector 输入输出和 state 不再是隐式 object。
- projection lineage 仍能跨 rebuild 定位 drawing anchor。
- 无性能路径行为改动。

### 回滚

按 `ProjectionStore -> projectors -> types` 逆序回退。

### 不做

- 不修改图表显示算法。
- 不调整 Renko/Kagi 参数默认值。
- 不改变 viewport 恢复策略。

---

## Phase T6：迁移 chart-adapter

### 修复的问题

`chart-adapter` 是 Lightweight Charts 与 CandleScope 自定义 axis/series/drawing 的唯一边界，也是类型迁移中第三方泛型摩擦最大的区域。

### 前置条件

- T5 的 `AxisTime`、display row 和 projector 类型稳定。

### 目标

利用 Lightweight Charts 自带声明，明确 chart、series、pane、time scale、custom series、viewport 和 drawing coordinate contract。

### 建议结构

```text
src/chart-adapter/
  chartAdapterTypes.ts
```

核心类型：

- `ChartTime`
- `ChartSurfaceHandle`
- `ChartSurfaceView`
- `ChartSurfaceActionName`
- `MainSeriesHandle`
- `IndicatorSeriesHandle`
- `PaneHandle`
- `CoordinateSnapshot`
- `CoordinateContext`
- `DrawingLineageIndex`

### 文件顺序

1. `chartTime.js`
2. `chartSurfaceContract.js`
3. `chartSeriesData.js`
4. `mainSeriesModel.js`
5. custom series：`highLowSeries`、`kagiSeries`、`pointFigureSeries`
6. renderers：bar color、bgcolor、marker、overlay、projection
7. `paneManager.js`
8. `viewportController.js`
9. `futureTimeAxis.js`
10. `ordinalHorzScaleBehavior.js`
11. `lightweightChartSurface.js`
12. `seriesLifecycle.js`
13. `seriesDeltaRenderer.js`
14. `chartPaneLifecycle.js`
15. `chartInstanceBridge.js`
16. `coordinateBridge.js`
17. `useChartSurfaceRuntime.js`

### 任务

1. 从库声明导入官方类型，不复制一套本地宽松声明。
2. custom ordinal horizontal scale 的泛型适配集中在 adapter 内。
3. 无法表达的第三方泛型只允许在最小 adapter 函数中局部 cast，并记录 ledger。
4. `callChartSurface(methodName, ...)` 改为 key/parameter/return 映射，错误方法名在编译期失败。
5. refs 全部显式包含 `null`，不使用非空断言掩盖 lifecycle。
6. coordinate conversion 继续区分：

   - 绝对 source time。
   - ordinal source lineage。
   - projection-local order。
   - 仅迁移期 fallback logical。

7. future drawing anchor 继续持久化绝对 source time，不能恢复旧的相对 logical/bar offset 语义。
8. 不为类型而增加全量 `setData()` 或破坏 delta renderer。
9. 每迁一个 renderer 运行对应 test；`coordinateBridge` 最后迁。

### 验证

```powershell
npm test
npm run check
npm run smoke:chart-types
```

drawing 坐标交叉验证：

```powershell
npx tsx --test src/features/drawings/__tests__/coordinateBridge.test.js
```

### 验收

- raw Lightweight Charts import 仍只存在于 `chart-adapter`。
- 15 种主图类型 smoke 通过。
- viewport、pane height、series lifecycle、未来时间轴行为不变。
- custom ordinal axis 没有用 `any` 整体绕过。
- future anchor 仍为绝对 source time。

### 回滚

以 renderer/manager/bridge 为单位回退，不能留下同时存在的两套 chart handle 类型。

### 不做

- 不升级 Lightweight Charts。
- 不重构 `SingleChartPanes`。
- 不改变渲染策略或性能预算。

---

## Phase T7：迁移支撑 feature kernels

### 修复的问题

cache、watchlist、export、settings、symbol-search 和 alerts 的纯 store/policy/model 较分散，但风险低于 indicator/drawing，可用于继续扩大类型覆盖。

### 前置条件

- T2 shared/session 类型稳定。
- T4 transport 基础可用。

### 目标

迁移非 React 的小型 feature kernels，并把各自 localStorage/API boundary 收紧。

### 执行切片

每一行独立提交：

| 切片 | 文件 |
|---|---|
| cache-gc | `cacheAccessRuntime`、`cacheDiagnostics`、`cacheRegistry`、`browserPressure`、`cachePolicy`、`cacheTrim`、`autoGcPolicy` |
| runtime performance | `runtime/performance/perfMarks`、`runtime/performance/windowBudgetAssert` |
| watchlist | `watchlistStore`、`watchlistSubscriptionPolicy`、`subscriptionApiPolicy`、`watchlistStorage` |
| watchlist full cache | `watchlistFullCachePolicy`、`watchlistFullCacheResolver`、`watchlistFullCacheStore` |
| export | `exportOptionsStore`、`exportService` |
| settings pure | `settingsActionTypes`、`settingsPanelViewModel`、`settingsTabRegistry` |
| symbol search | `symbolSearchFilter`、`symbolFavoritesStore` |
| alerts | `alertRuleModel`、`alertsClient`、`alertsApi` |

### 核心类型

- `CacheDiagnostics`
- `GcPlan` / `GcAction`
- `PerformanceMarkName` / `WindowBudgetResult`
- `WatchlistItem`
- `WatchlistGroup`
- `SubscriptionTier`
- `WarmCacheRow`
- `ExportOptions`
- `SettingsCategory`
- `SymbolSearchItem`
- `AlertRule` / `AlertExpression`

### 任务

1. 先迁 parser/store，再迁 policy/model。
2. localStorage 读取一律按 `unknown` 验证。
3. 旧 watchlist、favorites、export prefs 和 settings key 不变。
4. reducer/action 使用判别联合。
5. 删除/启用 subscription 的 request/response 明确类型。
6. `cacheTrim` 跨 feature 调用只依赖稳定公开 contract。
7. alerts expression tree 使用递归类型，但 parser 必须防错误递归 shape。
8. 每个切片完成后跑该目录测试和全局 `npm run check`。

### 验证

```powershell
npm test
npm run check
```

涉及 export 后：

```powershell
npm run smoke:export
```

### 验收

- 损坏 storage 不阻止应用启动。
- watchlist tier、warm cache、GC 和 export 默认值不变。
- alerts payload 与现有后端契约一致。
- 各切片可以独立 revert。

### 回滚

按切片回退，不改 storage key，不主动清理用户数据。

### 不做

- 不迁 React runtime/UI。
- 不改变 GC 阈值、watchlist 订阅语义或 export 视觉结果。

---

## Phase T8：迁移 indicator core、API 和 WebSocket

### 修复的问题

indicator definition、schema、line/marker/fill/hline/bgcolor、range intent、revision、cache 和 WS message 是当前最复杂的数据族之一。

### 前置条件

- T3 的 K 线/range 类型稳定。
- T4 的 transport 规则已固定。
- T6 的 chart adapter 输出类型可用。

### 目标

让 indicator core 从输入到 cache/output 都使用可穷尽的类型；raw payload 不下沉到 reducer 或 chart projection。

### 建议结构

```text
src/features/indicators/
  indicatorTypes.ts
  indicatorContracts.ts
```

### 文件顺序

1. `indicatorRangeCoverage.js`
2. `indicatorRangePlanning.js`
3. `indicatorRangeBatcher.js`
4. `indicatorRangeScheduler.js`
5. `indicatorComputeRuntime.js`
6. `indicatorPayloadRuntime.js`
7. `indicatorOutputReducer.js`
8. `indicatorPaneProjection.js`
9. `indicatorResultCacheStore.js`
10. `services/indicatorApi.js`
11. `indicatorWsRuntime.js`
12. `src/editor/pyneLanguage.js`
13. `src/editor/pyneTheme.js`

React controllers/hooks 留到 T10。

### 核心类型

- `IndicatorDefinition`
- `IndicatorParameterSchema`
- `IndicatorLine`
- `IndicatorMarker`
- `IndicatorFill`
- `IndicatorHLine`
- `IndicatorBgColor`
- `IndicatorOutput` 判别联合
- `IndicatorRangeIntent`
- `IndicatorCoverage`
- `IndicatorRevision`
- `IndicatorSnapshotMessage`
- `IndicatorPatchMessage`
- `IndicatorReplaceRangeMessage`

### 任务

1. 从现有 normalizer 和 tests 归纳 payload，不把所有字段变成 optional。
2. `normalizeIndicatorPayload()` 接收 `unknown`。
3. range/revision snake_case 和 camelCase 兼容只在 parser 中处理。
4. reducer switch 使用 `never` 做穷尽检查。
5. cache key context 明确 symbol/exchange/market/interval/script/security mode。
6. `indicatorApi.request()` 返回 unknown，由各 endpoint parse。
7. `indicatorWsRuntime.parseIndicatorWsMessage()` 不再只做 `JSON.parse()`；返回 typed success/failure。
8. sequence gap、history invalid、dirty range 和 cache invalidation 语义保持。
9. malformed snapshot/patch/replace_range 增加失败测试。
10. 禁止把 `Record<string, any>` 作为最终 indicator payload。
11. editor 文件直接复用 Monaco 暴露的类型，不复制一套 editor API 声明。
12. 保持 Pyne completion、hover、tokenizer、theme 和 lazy editor 加载行为不变。

### 验证

```powershell
npm test
npm run check
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:15173/ --overlay-heavy
```

### 验收

- raw indicator JSON 不进入 reducer/cache/projection。
- output kind 可穷尽。
- revision/range/sequence 行为与迁移前一致。
- overlay-heavy smoke 通过。
- 不通过大范围 `any` 绕开 Pyne/custom indicator shape。

### 回滚

按 `WS/API -> cache/reducer -> types` 逆序回退。

### 不做

- 不改变 indicator 计算算法。
- 不调整 cache 窗口、重算范围或 WS 重连策略。
- 不迁 `useIndicatorRuntime`。

---

## Phase T9：迁移 drawing core、persistence 和 primitives

### 修复的问题

drawing 工具、anchor、primitive options、drag/resize、persistence 和 custom chart lineage 存在多种相近 shape；JSDoc 已出现描述差异。

### 前置条件

- T5/T6 的 axis time、coordinate 和 chart surface 类型稳定。

### 目标

建立统一 drawing domain model，并保持旧绘图 JSON 兼容。

### 建议结构

```text
src/features/drawings/
  drawingTypes.ts
  drawingContracts.ts
```

### 本 Phase 只迁非 React core

按顺序：

1. `drawingCapabilities.js`
2. `drawingModel.js`
3. `freehandStrokeModel.js`
4. `drawingMoveBatch.js`
5. `drawingPersistence.js`
6. `drawingCreationController.js`
7. `drawingDragResizeController.js`
8. `drawingEraseController.js`
9. `drawingHoverController.js`
10. `drawingSnapController.js`
11. `drawingPrimitiveFactory.js`
12. `drawingEngineLoader.js`
13. `primitives/coordinateUtils.js`
14. `primitives/*Primitive.js`
15. `services/drawingStorage.js`

含 React hook/ref 的 interaction、pointer、keyboard、selection、text edit、tool state 和 `useDrawing*` 留到 T10。

### 核心类型

- `DrawingToolId`
- `DrawingKind`
- `ScreenPoint`
- `DrawingDataPoint`
- `SourceTimeAnchor`
- `OrdinalLineageAnchor`
- `LegacyLogicalAnchor`
- `DrawingAnchor`
- `SavedDrawing` 判别联合
- `DrawingPrimitive` interface
- 各 primitive options

### 任务

1. 以当前 persistence sanitizer 为真实契约来源。
2. 明确：

   - 普通图表持久化绝对 `time`。
   - synthetic chart 可附带 `sourceOrdinal/sourceProjection/sourceProjectionConfig`。
   - `order` 永不持久化。
   - `logical` 仅作为旧数据/失败 fallback，不是新 future anchor 格式。

3. `SavedDrawing` 按 kind 建立判别联合。
4. primitive factory 的输入输出使用同一 union。
5. 每个 primitive constructor options 显式类型化。
6. localStorage parser 保留 schema version 和旧 fixture。
7. 不用 `instanceof` 作为持久化数据验证。
8. 迁移 freehand 时保持点压缩、采样和渲染性能。
9. 增加损坏 anchor、未知 kind、旧 logical payload、synthetic lineage fixture。

### 验证

```powershell
npm run test:drawing
npm test
npm run check
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:15173/ --drawing-check
```

### 验收

- 旧绘图全部可读。
- 新 future anchor 仍持久化绝对 source time。
- synthetic drawing lineage 跨 representation rebuild 保持。
- freehand/line/text/position/fibonacci 等 primitive 行为不变。
- drawing-check smoke 通过。

### 回滚

不迁移或删除 localStorage 数据。代码回退后旧版仍必须能读取迁移期间保存的兼容格式；如做不到，禁止合并。

### 不做

- 不重做 drawing UX。
- 不拆 `drawingInteractionController`。
- 不改变 snap、drag、resize 或 future anchor 语义。

---

## Phase T10：迁移 feature React runtimes/hooks

### 修复的问题

纯 core 类型建立后，React hooks 仍通过大 options object、refs 和 callbacks 传递隐式契约。

### 前置条件

- 所属 feature core 已迁移。
- 外部 boundary 已有 typed parser。

### 目标

让每个 feature runtime 的输入、返回值、effects、refs 和 callbacks 有稳定类型，保持 `{ view, actions, status, events? }` contract。

### 固定内部顺序

每个 feature 按以下顺序迁：

1. store/parser
2. leaf runtime
3. controller
4. aggregate hook
5. lazy loader/host

禁止一次性 rename 整个 feature。

### 文件清单

chart-session：

- `customIntervalStore`
- `exchangeCatalogRuntime`
- `intervalNoticeRuntime`
- `useChartSession`

market-data：

- `useChartBackgroundPrefetch`
- `useChartDataRuntime`
- `useChartInitialLoad`
- `useChartLoadMoreLeft`
- `useKlineStreamRuntime`
- `useMarketDataRuntime`
- `useSessionTransitionReset`

cache/watchlist：

- `useFrontendAutoGcRuntime`
- `watchlistSubscriptionRuntime`
- `useWatchlistRuntime`
- `useWatchlistFullCacheRuntime`

indicators：

- `activeIndicatorStore`
- `indicatorComputeController`
- `indicatorStreamController`
- `useIndicatorCatalogRuntime`
- `usePyneSecurityPolicy`
- `useIndicatorRuntime`，本组最后

drawings：

- `drawingInteractionController`
- `drawingKeyboardController`
- `drawingPointerController`
- `drawingSelectionController`
- `drawingTextEditController`
- `drawingToolState`
- `useDrawingPersistenceLifecycle`
- `useDrawingRuntime`
- `DrawingEngineHost.tsx`

export/settings/symbol-search：

- `exportPreviewRuntime`、`useExportRuntime`
- settings 各 `*Runtime`、`chartAppearanceSettings`、`priceScalePrefsRuntime`、`services/databaseToolsApi`、`useSettingsRuntime`
- `symbolCatalogRuntime`、`useSymbolSearchRuntime`

### 任务

1. 为每个 hook 定义 options 和 return type。
2. refs 明确 `null`，timer 使用 `ReturnType<typeof setTimeout>`。
3. effect cleanup 明确返回 `void | (() => void)`。
4. WebSocket、AbortController、ResizeObserver 等 browser handle 不用 Node 类型替代。
5. runtime public contract 只暴露稳定 view/actions/status/events。
6. callback 参数使用 owner 类型，不复制匿名 object。
7. `useIndicatorRuntime`、`drawingInteractionController` 最后迁，只加类型不拆分。
8. React state 初始 `null` 时显式 union，禁止用非空断言。
9. 每完成一个 aggregate hook，跑该 feature tests 和对应 smoke。

### 验证

```powershell
npm test
npm run check
```

按 feature 追加：

```powershell
npm run smoke -- --url http://127.0.0.1:15173/
npm run smoke -- --url http://127.0.0.1:15173/ --overlay-heavy
npm run smoke -- --url http://127.0.0.1:15173/ --drawing-check
```

### 验收

- aggregate hook 不返回隐式匿名大对象。
- callback/ref/timer nullability 明确。
- interval/symbol 快速切换不新增 stale closure 或 effect 重订阅。
- 所有 runtime 行为和 smoke 与迁移前一致。

### 回滚

按 feature 回退，不能让同一 public contract 同时存在两套互不一致的类型。

### 不做

- 不拆大型 hooks。
- 不优化依赖数组。
- 不改变 effect 生命周期，除非另有 bugfix 提交。

---

## Phase T11：迁移 feature UI 和普通组件

### 修复的问题

普通组件仍缺少 Props、event、ref 和 lazy import 类型，但它们依赖的 runtime contract 在 T10 后已经稳定。

### 前置条件

- 对应 runtime 已迁移。

### 目标

迁移除 `SingleChartPanes` 外的 feature UI、settings panels、app shell 子组件和普通 components。

### 文件顺序

每个 feature 使用：

1. leaf UI
2. panel body
3. panel shell
4. lazy wrapper

主要切片：

- indicators：`IndicatorEditor.tsx`、`IndicatorPanel.tsx`
- drawings：`DrawingToolbar.tsx` 及 drawing 子组件
- export：`ExportPreviewPanel.tsx`、`ExportPanel.tsx`
- watchlist：`WatchlistSidebar.tsx`
- symbol search：`SymbolSearch.tsx`、`SymbolSearchModal.tsx`
- settings：`SettingsPanelHost`、各 panels、`SettingsModalStyles`、`SettingsModal`
- alerts：panel/editor UI
- `src/components/drawing/*`、`src/components/settings/*` 和 `src/components/alerts/AlertsPanel.jsx`
- compatibility wrappers：`DrawingToolbar.jsx`、`DrawingEngineHost.jsx`、`SymbolSearch.jsx`、`SymbolSearchModal.jsx`
- ordinary components：`IntervalSelector.jsx`、`TextEditOverlay.jsx`、`TextFormatBar.jsx`，以及 `src/components` 中除 `SingleChartPanes` 和 `singleChartPaneLifecycle` 外尚未迁移的文件
- app leaf：`TopBar`、`StatusBar`、`LazyFeatureSurfaces`、`ChartWorkspace`、`lazySurfaceLoaders`

### 任务

1. 每个 component 定义具名 Props type。
2. 可复用 native props 使用 `ComponentPropsWithoutRef`，不重复抄 DOM 属性。
3. callback 返回值明确，不把 `Function` 当类型。
4. form event、pointer event、keyboard event 使用 React 对应事件类型。
5. imperative refs 使用 `forwardRef`/handle contract，不暴露 raw chart instance。
6. lazy import 保持 default export 和 chunk 边界。
7. style object 只在确有必要时使用 `CSSProperties`。
8. `children` 不是自动存在，确实支持时显式声明。
9. 组件 rename 后验证 dynamic import 和 smoke 脚本路径。

### 验证

```powershell
npm test
npm run check
npm run smoke:export
```

有完整环境时再跑：

```powershell
npm run smoke:release
```

### 验收

- 普通 UI 组件 Props 不再隐式。
- lazy surfaces 可以打开。
- export、settings、watchlist、indicator、drawing UI 行为不变。
- vendor/lazy chunk 结构没有意外合并成首屏大包。

### 回滚

按 feature UI 切片回退；不回退已稳定的 core 类型。

### 不做

- 不重设计组件 API。
- 不移动目录。
- 不改 CSS 和布局。

---

## Phase T12：迁移 `SingleChartPanes`、app 和入口

### 修复的问题

最大组件和组合根汇集了几乎所有 feature contract。过早迁移会产生大量 `any`；所有下游稳定后再迁可以让编译器真正检查整条链路。

### 前置条件

- T2-T11 全部完成。
- feature public contracts 稳定。
- 全局 suppression ledger 已接近清零。

### 目标

完成生产源码最后一段 TS/TSX 迁移，不改变图表生命周期和 App 装配。

### 文件顺序

1. 为 `ChartSurfaceHandle` 和 `SingleChartPanesProps` 补齐最终定义。
2. `components/singleChartPaneLifecycle.js -> .ts`
3. `components/SingleChartPanes.jsx -> .tsx`
4. `app/view-models/* -> .ts`
5. `app/appShellViewModel.js -> .ts`
6. `app/AppProviders.jsx -> .tsx`
7. `app/AppShell.jsx -> .tsx`
8. `app/App.jsx -> .tsx`
9. `src/App.jsx -> .tsx`
10. `src/main.jsx -> .tsx`
11. 其余 re-export wrapper 最后迁移。

### 任务

1. 先写 `SingleChartPanesProps`，覆盖当前全部 props，再 rename 文件。
2. 按区域组织 Props type：

   - session/chart type
   - bars/market-data
   - indicators/panes
   - drawings
   - viewport/price scale
   - export
   - callbacks

3. `chartRef`、series refs、pane refs 和 imperative methods 使用 T6 contract。
4. 不用 `Record<string, any>` 包住 props。
5. view-model builder 的输入和输出分别具名。
6. App 中每个 feature runtime contract 只传给合法 consumer。
7. `AppProviders` error boundary 的 state/error 类型完整。
8. `main.tsx` 按当前入口行为处理 root element 的 nullability；若要改变启动失败策略，另开 bugfix，不混入迁移提交。
9. 不在本 Phase 拆 `SingleChartPanes`，即使类型暴露出它过大。
10. 编译错误若揭示真实 contract 冲突，先修 owner type；不要在 App 层 cast。

### 验证

```powershell
npm run check
npm run smoke:release
```

额外检查：

```powershell
rg --files src -g "*.js" -g "*.jsx"
```

此时只允许尚未迁移的测试文件；生产文件应为 0。

### 验收

- `SingleChartPanesProps` 无整体 `any`。
- chart refs 和 methods 编译期可检查。
- App 只装配 feature。
- 所有生产 JS/JSX 已迁移。
- release smoke 全部通过。

### 回滚

`main/App -> view-models -> SingleChartPanes` 逆序回退。若 `SingleChartPanes` 无法在不改变 lifecycle 的前提下通过类型检查，停止并拆为新的前置迁移 Phase，不能强 cast 合并。

### 不做

- 不拆组件。
- 不改变 chart effect 顺序。
- 不改变 props 语义。
- 不做性能优化。

---

## Phase T13：迁移测试、收紧配置并完成 release 验收

### 修复的问题

生产源码迁完后仍可能存在 JS tests、临时 canary、宽松配置和迁移期 suppression。没有最后收口，项目会长期停在 mixed mode。

### 前置条件

- T12 完成且 release smoke 通过。

### 目标

结束 mixed mode，删除临时设施，建立长期 TypeScript gate。

### 任务

1. 按 owner 分批把 `src/**/__tests__/*.test.js` 迁到 `.test.ts`，有 JSX 才用 `.tsx`。
2. test fixture 使用生产类型，避免重新声明宽松 shape。
3. mock 必须满足 interface；确实只 mock 一部分时使用明确的 test helper，不做全局 cast。
4. 删除 `scripts/type-migration-canary/`。
5. `tsconfig`：

   - `allowJs: false`
   - `checkJs` 删除
   - `include` 只覆盖 TS/TSX 和需要的声明
   - 分批评估开启 `noUncheckedIndexedAccess`
   - 分批评估开启 `exactOptionalPropertyTypes`

6. ESLint 切换到 `recommendedTypeChecked`，JS/MJS config/scripts 使用 disable-type-checked override。
7. 清理：

   ```powershell
   rg -n "@ts-ignore|@ts-nocheck|@ts-expect-error|as unknown as|\bany\b" src
   ```

8. 删除临时 `.d.ts`、facade、allowlist 和无用 JSDoc typedef。
9. 更新 `scripts/check-architecture.mjs` 的最终扩展规则和测试。
10. 更新 README/architecture 的验证命令，把 `typecheck` 放入永久 gate。
11. 运行完整 release 验收并记录 bundle/chunk 差异。

### 验证

```powershell
npm run check:architecture
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke:release
```

最终文件检查：

```powershell
rg --files src -g "*.js" -g "*.jsx"
```

预期输出为空。

### 验收

- `src` 生产和测试均无 JS/JSX。
- `allowJs: false`。
- type-aware lint 通过。
- 测试数不低于 T0，新增 parser 失败用例存在。
- suppression ledger 清零，或仅保留有明确第三方原因和删除条件的项目。
- release smoke、drawing、overlay、export、15 chart types 全部通过。

### 回滚

严格选项一次只开一个并独立提交。某个严格选项失败时只回退该选项，不回退已经完成的 TS 文件。

### 不做

- 不强制把 `scripts/*.mjs`、`eslint.config.js`、`vite.config.js` 全改 TS。
- 不因测试类型麻烦而减少测试发现范围。

---

## 8. 每次文件迁移的标准操作

每迁一个文件或小组，固定执行：

1. 阅读 owner README、当前测试和所有 importers。
2. 记录当前导出 API。
3. rename `.js -> .ts` 或 `.jsx -> .tsx`。
4. 先给公开输入/输出加类型。
5. 再给内部 state/ref/callback 加类型。
6. raw external data 改为 `unknown` 并通过 parser。
7. 搜索旧后缀引用：

   ```powershell
   rg -n "文件名\.js" src scripts
   ```

8. 运行针对性测试。
9. 运行 `npm run typecheck`。
10. 运行 `npm run check`。
11. 涉及 UI/transport/chart 时跑对应 smoke。
12. 检查 diff：

    ```powershell
    git diff --check
    git diff --stat
    git diff
    ```

13. 确认 diff 没有行为重写后再提交。
14. 在文末追加执行记录和 suppression 变化。

---

## 9. 推荐提交顺序

建议每条至少一个独立 commit，较大 Phase 可拆多个 PR：

1. `build(frontend): add mixed TypeScript toolchain`
2. `refactor(frontend): type shared market identities`
3. `refactor(frontend): migrate chart session contracts`
4. `refactor(frontend): type market data windows and feed`
5. `refactor(frontend): validate market transport payloads`
6. `refactor(frontend): type chart representation engine`
7. `refactor(frontend): type chart adapter contracts`
8. `refactor(frontend): migrate support feature kernels`
9. `refactor(frontend): type indicator core and transport`
10. `refactor(frontend): type drawing core and persistence`
11. `refactor(frontend): migrate feature runtimes`
12. `refactor(frontend): migrate feature ui`
13. `refactor(frontend): migrate chart workspace and app root`
14. `test(frontend): migrate tests to TypeScript`
15. `build(frontend): enforce strict TypeScript gates`
16. `docs(frontend): complete TypeScript migration record`

不要把全部迁移压成一个 commit。

---

## 10. 风险矩阵

| 风险 | 具体表现 | 对策 |
|---|---|---|
| Node ESM 无法解析 rename | JS test 或 `.mjs` script 仍请求 `foo.js` | T1 `tsx` + 四链路 canary；不过即停止 |
| Vite build 通过但没有 typecheck | TS 类型错误进入构建 | 永久独立 `tsc --noEmit` gate |
| 类型断言制造假安全 | `response.json() as T` | raw data 必须 `unknown -> parser` |
| 秒/毫秒仍混用 | 都写成普通 `number` | branded type/命名对象 + 边界转换 |
| custom chart time 被简化 | ordinal object 被当时间戳 | 保留 `AxisTime` 联合和 lineage |
| 第三方泛型扩散 | 全项目出现 library handles/any | 只在 `chart-adapter` 局部适配 |
| localStorage 兼容破坏 | 老用户启动失败或绘图丢失 | 旧 fixture + parser fallback，不改 key |
| TS 改变 React lifecycle | effect/ref/callback 为过类型而重写 | hooks 后迁，只加类型，不改依赖数组 |
| 巨型组件被迫 cast | `SingleChartPanes` 出现大面积 any | 下游先迁；先写 Props；冲突回 owner 修 |
| 测试数量悄悄减少 | `.test.ts` 未被 runner 发现 | `tsx --test`；每阶段对比 T0 test count |
| bundle 变大 | schema/helper 被打进 hot chunk | 首期手写 guard；新增依赖需单独测 bundle |
| 迁移永远停在 mixed mode | allowJs/facade/suppression 长期存在 | T13 明确清零 gate 和删除条件 |

---

## 11. 停止条件

出现以下任一情况时，停止当前 Phase，不继续扩大 rename：

- T1 canary 任一解析链失败。
- 单元测试发现数低于 T0，但原因不明。
- 需要通过 feature-wide `any` 才能 typecheck。
- 需要修改后端协议才能完成一个纯前端 rename。
- 需要改变 K 线请求顺序、indicator range、drawing anchor 或 chart lifecycle。
- localStorage 旧 fixture 无法读取。
- chart type/drawing/overlay smoke 出现行为差异。
- architecture checker 因 `.ts/.tsx` 漏检边界。
- 一个 Phase 需要大量永久 facade 或 allowlist。
- build 通过但 typecheck/lint/test 未通过。

停止后应：

1. 保存最小复现。
2. 判断是工具链、真实 bug、错误现有契约还是迁移范围过大。
3. 回退当前未完成切片。
4. 必要时把 Phase 再拆小。
5. 不用 cast 把问题推到后续阶段。

---

## 12. 回滚策略

- 每个 Phase 独立 commit/PR。
- rename 和 import 调整必须在同一提交。
- parser 变严格前先保存真实合法 payload fixture。
- 不做不可逆 localStorage migration。
- 不删除旧字段，除非读取路径已兼容且有测试。
- 严格编译选项一次只启用一个。
- smoke 失败优先 revert 当前切片，不回退已验证的前置类型。
- 禁止使用 `git reset --hard` 清理包含其他人的工作区。

---

## 13. 最终完成定义

迁移完成必须同时满足：

- [ ] `src` 中 `.js/.jsx` 为 0。
- [ ] `allowJs: false`。
- [ ] `strict: true`。
- [ ] `npm run check:architecture` 通过。
- [ ] `npm run typecheck` 通过。
- [ ] `npm run lint` 通过。
- [ ] `npm test` 通过，测试数不低于 T0。
- [ ] `npm run build` 通过。
- [ ] `npm run smoke:release` 通过。
- [ ] API/WS/localStorage raw payload 均从 `unknown` 开始。
- [ ] 秒/毫秒、AxisTime、indicator output、drawing anchor 有明确类型。
- [ ] Lightweight Charts raw handles 不越出 `chart-adapter`。
- [ ] `SingleChartPanesProps` 和 feature runtime contracts 完整。
- [ ] 无 `@ts-ignore`、`@ts-nocheck`。
- [ ] 无永久 JS facade。
- [ ] architecture allowlist 为 0，或每项都有明确短期删除条件。
- [ ] suppression ledger 清零。
- [ ] 文档执行记录与真实 commit/验证结果一致。

只有“文件后缀都变了”不算完成。

---

## 14. 执行记录

执行时只追加本节，不回写计划正文。

### Phase 状态

| Phase | 状态 | Commit/PR | typecheck | unit tests | build | smoke | 备注 |
|---|---|---|---|---|---|---|---|
| T0 | 已完成 | `45c901c` | N/A（T1 建立） | 702/702 通过 | 通过 | basic/release 通过 | 2026-07-13；迁移前基线已冻结 |
| T1 | 已完成 | `45c901c` | 通过 | 703/703 通过 | 通过 | chart-types 通过 | mixed-mode 五条解析链全部验证；新增 suppression 0 |
| T2 | 已完成 | `741b5d1` | 通过 | 719/719 通过 | 通过 | basic/release 通过 | 12 个生产模块迁为 TS；新增 suppression 0 |
| T3 | 已完成 | 未提交（当前工作区） | 通过 | 720/720 通过 | 通过 | basic/release 通过 | 15 个 market-data TS 模块；1 个 T4 删除的局部 adapter cast |
| T4 | 待执行 |  |  |  |  |  |  |
| T5 | 待执行 |  |  |  |  |  |  |
| T6 | 待执行 |  |  |  |  |  |  |
| T7 | 待执行 |  |  |  |  |  |  |
| T8 | 待执行 |  |  |  |  |  |  |
| T9 | 待执行 |  |  |  |  |  |  |
| T10 | 待执行 |  |  |  |  |  |  |
| T11 | 待执行 |  |  |  |  |  |  |
| T12 | 待执行 |  |  |  |  |  |  |
| T13 | 待执行 |  |  |  |  |  |  |

### T0 基线记录

| 项目 | 结果 |
|---|---|
| 记录时间 | 2026-07-13，Asia/Shanghai |
| Branch | `main` |
| Commit | `5c407def6df5c431b71507716619151954b55aab` |
| 工作区归属 | `README.md`、`ARCHITECTURE_zh.md` 和本执行文档均为已确认的 TypeScript 迁移文档改动；没有混入未知改动 |
| Node / npm | Node `v22.14.0`；npm `10.9.2` |
| `npm ci` | 通过；停止占用 `esbuild.exe` 的本项目 Vite 进程后重试成功，安装 167 packages |
| npm audit 基线 | 7 项：3 low、3 moderate、1 high；T0 不执行自动修复 |
| JS 文件数 | 271 |
| JSX 文件数 | 54 |
| TS 文件数 | 0 |
| TSX 文件数 | 0 |
| Test files | 84 |
| Test count | 702；pass 702、fail 0、skipped 0、todo 0 |
| Architecture check | 通过；0 migration allowlist entries active |
| Lint | 通过 |
| Build | 通过；Vite 7.3.1，289 modules transformed；入口 JS 401.34 kB / gzip 118.95 kB |
| Basic smoke | 通过；1500 bars、connected/live；failures 0、warnings 0、exceptions 0 |
| Release smoke | 通过；chart type matrix、export matrix、drawing check、overlay-heavy 全部通过；failures 0、warnings 0、exceptions 0 |
| 迁移前已知 gate 失败 | 无；npm audit advisory 单独作为依赖风险基线记录 |

### T0 动态边界与 suppression 清单

| 类别 | 出现次数 | 文件数 | 备注 |
|---|---:|---:|---|
| `@ts-ignore` | 0 | 0 | 无 |
| `@ts-nocheck` | 0 | 0 | 无 |
| `@ts-expect-error` | 0 | 0 | 无 |
| `eslint-disable` | 2 | 2 | 见下方精确位置 |
| `JSON.parse` | 25 | 20 | 生产代码 18 次/17 文件；测试 7 次/3 文件 |
| `response.json` | 6 | 3 | 全部位于 service transport 边界 |

现有 ESLint suppression：

- `src/components/TextFormatBar.jsx:90`：`react-hooks/exhaustive-deps`
- `src/features/drawings/drawingInteractionController.js:1424`：`react-hooks/immutability`

生产代码中的 `JSON.parse` 边界：

- cache/session：`autoGcPolicy`、`chartSessionModel`、`customIntervalStore`、`paneLayoutStorage`、`visibleRangeStorage`
- drawings/indicators：`drawingPersistence`、`drawingToolState`、`activeIndicatorStore`、`indicatorResultCacheStore`、`indicatorWsRuntime`
- data/settings/search：`klineStreamSubscription`、`chartAppearanceSettings`、`symbolFavoritesStore`
- watchlist/performance：`useWatchlistFullCacheRuntime`、`watchlistStore`（2 次）、`watchlistSubscriptionRuntime`、`perfMarks`

测试中的 `JSON.parse` 位于 `drawingPersistence.test.js`（3 次）、`seriesDataFeed.test.js`（3 次）和 `indicatorApi.test.js`（1 次）。`response.json` 位于 `alertsApi.js`、`api.js` 和 `indicatorApi.js`，各 2 次。后续 Phase 应在各 owner parser/transport 切片中收紧这些边界，不在 T0 修改行为。

### Import 解析决策

| 项目 | 结果 |
|---|---|
| `.js` specifier -> `.ts` source | 通过；现有 consumer 和 canary 均可解析 `mainChartTypes.ts` / `entry.ts` |
| JS test -> TS source | 通过；`entry.test.js` 通过 `.js` specifier 加载 `entry.ts` |
| TS source -> TS dependency | 通过；`entry.ts` 通过 `./leaf.js` 加载 `leaf.ts` |
| `.mjs` script -> TS source | 通过；`chart-type-matrix.mjs` 加载 `mainChartTypes.ts`，`npx tsx -e` 实测成功 |
| Vite build -> TS source | 通过；289 modules transformed |
| 最终 specifier 规则 | rename 时保留既有 specifier；需要由 Node/tsx 执行的相对 runtime import 使用 `.js` specifier 指向 `.ts` source；禁止 runtime import 写 `.ts` 后缀；既有 Vite-only extensionless import 不在迁移时批量改写 |

### T1 工具链与验证记录

| 项目 | 结果 |
|---|---|
| TypeScript | `6.0.3` |
| typescript-eslint | `8.63.0` |
| tsx | `4.23.1` |
| `@types/node` | `26.1.1` |
| 初始模式 | `strict: true`、`allowJs: true`、`checkJs: false`、`noEmit: true`、`moduleResolution: Bundler` |
| 首个生产 TS 文件 | `src/shared/mainChartTypes.ts`；保留 runtime `Object.freeze`，新增 `MainChartType` 字面量联合 |
| Architecture 正向门 | 通过；0 migration allowlist entries active |
| Architecture 负向门 | 通过；临时 TS shared→feature import 和 TSX feature Runtime JSX 均被拦截，样本已删除 |
| Architecture 附带修复 | import 提取器补齐 `import "module"` 副作用导入；否则该形式会绕过依赖规则 |
| Canary | 1/1 通过；JS test → TS entry → TS leaf |
| 完整测试 | 703/703 通过；T0 的 702 个测试全部保留，新增 1 个 canary |
| Build | 通过；入口 JS 401.39 kB / gzip 118.93 kB，较 T0 无实质增长 |
| Chart type smoke | 通过；15 种类型、持久化和恢复均通过；failures/warnings/exceptions 为 0 |
| 已知测试噪声 | 两个既有 Vite middleware 测试并发时会提示 HMR 端口 24678 占用；已用原 `node --test` 独立复现，不是 tsx 回归 |
| 新增 suppression | 0 |

### T2 shared、utils 和 chart-session 验证记录

| 项目 | 结果 |
|---|---|
| 起始 Commit | `45c901c` |
| 完成 Commit | `741b5d1` |
| 生产模块 | 迁移 11 个既有 JS 文件并新增 `chartSessionTypes.ts`，合计 12 个 TS 模块 |
| 核心类型 | `IntervalUnit`、`IntervalString`、`SymbolIdentity`、`ChartSession`、`ChartSessionTransition`、`DatasetKey`、`VisibleRangeSnapshot`、`PaneHeights` |
| Interval 兼容 | `m` 和 `M` 保持大小写语义；非法值 fail closed；`1M` 月周期 timeline 逻辑不变 |
| Symbol key 兼容 | Binance 继续使用两段 key；OKX/其他交易所使用三段 key；parse/build round-trip 通过 |
| User prefs 边界 | `JSON.parse` 结果从 `unknown` 验证；损坏、`null` 或数组回退 `{}`；非法 interval 回退 `1h` |
| Pane storage 边界 | 只读取/写入有限正数数组；storage key 不变 |
| Visible range 边界 | 非 object JSON fail closed；复合 identity key 不变；旧 interval-only key 继续可读 |
| 定向测试 | 40/40 通过；覆盖 utils、session transition、interval fallback 和三类 storage |
| 完整测试 | 719/719 通过；较 T1 新增 16 个测试，无原测试丢失 |
| Architecture / typecheck / lint | 全部通过；0 migration allowlist entries active |
| Build | 通过；289 modules transformed |
| Basic smoke | 通过；1501 bars、connected/live；failures/warnings/exceptions 为 0 |
| Release smoke | 通过；chart type、export、drawing、overlay-heavy 全部通过；failures/warnings/exceptions 为 0 |
| 运行环境旁路 | 首次 release smoke 在经历批量 rename 的旧 Vite 进程上出现空白页；模块探测确认解析正常，干净重启后 basic/release 均通过；未修改业务代码规避该环境状态 |
| 新增 `any` / TS suppression | 0 |

### T3 market-data 内核验证记录

| 项目 | 结果 |
|---|---|
| 起始 Commit | `741b5d1` |
| 生产模块 | 按计划迁移 13 个既有 JS 文件，并新增 `marketDataTypes.ts`、`klineContracts.ts`，合计 15 个 TS 模块；`klineApi.js` 和 `klineStreamSubscription.js` 保留给 T4 |
| 时间 contract | `EpochSeconds`、`EpochMilliseconds` 使用 branded number；秒/毫秒只通过 `secondsToMilliseconds()`、`millisecondsToSeconds()` 等命名边界转换；`normalizeRangeSec()` 返回 `TimeRangeSec \| null` |
| K 线与 series contract | 从现有 fixture 固化 `KlineBar` 的 `time` 和可选 OHLCV 字段；新增 `MarketSeries`、`SeriesKey`、`SeriesCoverage`、`DataRevision`、`KlineApi`、`BackfillCompletedMessage` |
| Window contract | `WindowDelta` 为 `type` 判别联合；delta 类型 switch 包含 `never` exhaustiveness check；rows、coverage、revision、segment 和 time index 全部类型化 |
| Fetch/feed contract | `FetchPlan` 为 `range` / `before` / `history` 判别联合；`InflightRegistry.run()` 保留泛型 promise result；`SeriesDataFeed` 的 API、callback、commit mode、pending page 和 result shape 全部显式化 |
| 行为不变量 | epoch 前进后旧结果标记 stale 且不提交；inactive series 只合并 cache；before-page completion attempts 有上限；重复 backfill completion 只释放一次 loading；window trim 继续保留最新 bars；range 分页 cursor 顺序不变 |
| 定向测试 | 54/54 通过；覆盖 planner、window store/registry、inflight、epoch/stale/active、before-page/backfill、gap 和 range runtime |
| 完整测试 | 720/720 通过；较 T2 新增 1 个重复 backfill completion 竞态保护测试，无原测试丢失 |
| Architecture / typecheck / lint | 全部通过；0 migration allowlist entries active；新增 `any` 和 TS directive suppression 均为 0 |
| Build | 通过；Vite 7.3.1，291 modules transformed；HTTP/WS transport 行为未改 |
| Basic smoke | 通过；1500 bars、connected/live；failures/warnings/exceptions 为 0 |
| Release smoke | 通过；chart type、export、drawing、overlay-heavy 全部通过；failures/warnings/exceptions 为 0 |
| 验证工具附带修复 | architecture JSX 文本检查跳过无法承载 JSX 的 `.ts`，避免泛型误报；export matrix 已独立验证预览和下载字节后，将被替换预览的 `blob:` URL 晚到 `ERR_FILE_NOT_FOUND` 归类为取消事件，真实 API、页面异常和导出失败仍会使 smoke 失败 |
| 临时逃生口 | `SeriesDataFeed` 对仍属 T4 的 JS `KlineStreamSubscription` 使用 1 个最小 constructor adapter cast；已登记 ledger，T4 迁移 owner 后删除 |

### Suppression ledger

| ID | 文件 | suppression/cast | 原因 | 保护测试 | 最迟删除 Phase | 状态 |
|---|---|---|---|---|---|---|
| T3-CAST-01 | `src/features/market-data/feed/seriesDataFeed.ts` | `KlineStreamSubscription as unknown as constructor` | 尚未迁移的 JS constructor 把默认空 intervals 推断为 `never[]`；adapter 只包住 T4 transport owner 边界 | `seriesDataFeed.test.js` subscribeBars；release smoke | T4 | 活跃 |

### 行为问题旁路记录

迁移中发现但不在类型提交里修复的问题记录在这里：

| ID | 发现 Phase | 现象 | 最小复现 | 后续 issue/commit | 状态 |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## 15. 参考资料

- [Vite TypeScript 支持与“只转译、不 typecheck”说明](https://vite.dev/guide/features)
- [TypeScript 从 JavaScript 渐进迁移指南](https://www.typescriptlang.org/docs/handbook/migrating-from-javascript.html)
- [TypeScript moduleResolution 选择指南](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options)
- [typescript-eslint flat config](https://typescript-eslint.io/getting-started/)
- [tsx 对 Node test runner 的 TypeScript 支持](https://tsx.is/node-enhancement)
