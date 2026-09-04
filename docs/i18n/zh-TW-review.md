# 繁體中文（台灣）覆核紀錄

- Locale：`zh-TW`
- 別名：`zh-Hant-TW`（僅此；`zh-HK` / `zh-MO` / 未限定 `zh-Hant` 不映射）
- `dateTimeLocale` / `numberLocale`：`zh-TW`
- `direction`：`ltr`
- `nativeLabel`：繁體中文
- 術語表：`docs/i18n/zh-TW-glossary.md`
- 最終狀態：**ENGINEERING_COMPLETE / UI_QA_COMPLETE / NATIVE_REVIEW_REQUIRED**

機械簡繁轉換與 AI 翻譯均不視為母語覆核。詞典完整、測試通過或截圖通過都不能替代熟悉台灣交易軟體用語的母語者覆核。

## 覆蓋率（四層分開計算）

| 層次 | 結果 |
| --- | --- |
| 技術鍵覆蓋率 | 4116 / 4116（與當前 `zh-CN` 參考詞典一致；結束時重新讀取，不是任務開始快照） |
| 運行時功能覆蓋率 | Host 註冊、normalize、持久化、多視窗 storage 同步、document/CSS、Intl、工作區內建名、外掛 locale 傳遞均有 shipped-function 測試 |
| 界面驗收覆蓋率 | 有截圖與 lang/title 讀回的入口見下表；Market Scanner／Pyne 沙箱因本機未安裝這些外掛（官方 bootstrap 不支援此 host platform）標記 **unavailable** |
| 母語覆核覆蓋率 | **0**。標記 NATIVE_REVIEW_REQUIRED |

## 詞典計數

| 項目 | 數量 |
| --- | --- |
| 主詞典實際鍵數 | 4116 |
| 已翻譯鍵數 | 4116 |
| 缺失鍵數 | 0 |
| 插值變數檢查 | `check:i18n` 通過（佔位符與參考詞典一致） |
| plural 檢查 | `Intl.PluralRules("zh-TW")` 僅 `other`；未要求無意義的 `one`/`few`；參考詞典既有 `.one` 鍵仍完整翻譯 |
| 已自動轉換 | 4116（OpenCC `s2twp` 初稿） |
| 已人工／工程逐項套用術語表 | 全量覆寫規則 + 抽樣與真實 UI 對照 |
| 已由母語者覆核 | 0 |

開始時參考詞典為 4113 鍵；任務期間為資料來源標籤新增 3 鍵（`research.source.currentChart` / `importedLibrary` / `completedResult`），結束時以 4116 為準。

## 主程式覆核狀態

| 區域 | 工程 | UI | 母語 |
| --- | --- | --- | --- |
| 應用外殼、標題、狀態列、週期、載入／斷線 | 完成 | 完成（即時看盤截圖） | 未覆核 |
| 自選、盤口、成交、資金費／外掛錯誤鉻 | 完成 | 完成（即時看盤；後端 500 為環境） | 未覆核 |
| 設定中心、外觀、語言選擇器「繁體中文」 | 完成 | 完成 | 未覆核 |
| 圖表選單／指標／繪圖／Tooltip | 完成（詞典） | 部分（主圖工具列可見；完整選單未逐一點開） | 未覆核 |
| 資料工作台、手動歷史、策略研究 | 完成 | 完成（工作台／策略截圖；已修正「當前圖表」簡體殘留） | 未覆核 |
| K 線回放、訓練大廳 | 完成 | 完成 | 未覆核 |
| 回測／高階研究 | 完成 | 完成（API 不可用為環境） | 未覆核 |
| 多圖工作區 | 完成 | 完成（`workspace-zh-TW.png`：圖表工作區／預設工作區／單圖／左右雙圖） | 未覆核 |
| 匯出／預覽 | 完成 | 完成（`export-zh-TW.png`：截圖匯出／匯出預覽；`lang=zh-TW`） | 未覆核 |
| Electron 桌面入口 | 完成 | 完成（`electron-zh-TW.png`；CDP `lang=zh-TW`，標題「CandleScope - 開源看盤軟體」，含「K 線回放」） | 未覆核 |

## 內建外掛覆核狀態

| 外掛 | zh-TW 資源 | 工程測試 | 真實 UI | 母語 |
| --- | --- | --- | --- | --- |
| Host 外掛中心 | Host 詞典 | 單元測試 | 完成（`plugins-zh-TW.png`：外掛中心／平臺已啟用／0 已安裝外掛） | 未覆核 |
| Market Scanner | manifest + `_CONTRACT_LOCALIZATIONS` | pytest 5 passed | **unavailable**：catalog `plugins: []`；startup `FIRST_PARTY_PLUGIN_BOOTSTRAP_FAILED`（pinned bundle does not support this host platform） | 未覆核 |
| Pyne Workbench | manifest、命令／設定、沙箱 `app.js` | `test_zh_tw_resources.py` + `plugin-locale.test.mjs`；完整 pytest 需 `pyne-runtime` 0.3 | **unavailable**（同上，未安裝 in-product 外掛，無沙箱頁可開） | 未覆核 |
| pine-compat / pyne runtime | 無使用者可見 localizations | 不在本次翻譯範圍 | — | — |

缺少 zh-TW 時回退到外掛預設文案：由 Host 測試夾具（僅有 `zh-CN` 的 command）證明 `zh-TW` 使用英文預設標題 `Scan`，不用 Host 詞典頂替。兩個內建外掛本身都有 zh-TW，沒有故意漏翻。

## 界面截圖與驗收

證據目錄（本機 scratch，非 git）：

- `live-zh-TW.png`：即時看盤。`lang=zh-TW`，`dir=ltr`，標題「CandleScope - 開源看盤軟體」，「K 線回放／自選／盤口／正在載入」。技術 ID `BTCUSDT`、`1H`、`BINANCE` 未翻譯。
- `settings-zh-TW.png`：設定。語言選擇器顯示並選中「繁體中文」。側欄「設定／外觀顯示／網路連線／交易所／資料管理／外掛與擴充套件」。
- `live-zh-CN-after-switch.png` / `live-zh-TW-after-switch.png`：同一文件不重新載入，storage 同步 `zh-CN` ↔ `zh-TW`；標題在簡體「开源看盘软件」與繁體「開源看盤軟體」之間切換。
- `replay-zh-TW.png`：訓練存檔大廳。協議錯誤碼 `REPLAY_V2_PROTOCOL_ERROR` 保持原文。
- `workbench-zh-TW.png` / `strategy-zh-TW.png`：資料來源「當前圖表／本地資料庫／完成結果」。
- `backtest-zh-TW.png`：高階研究；`BACKTEST_API_UNAVAILABLE` 保持錯誤碼。
- `plugins-zh-TW.png`：設定 → 外掛與擴充套件。讀回含「外掛中心」「平臺已啟用」「0 已安裝外掛」。
- `workspace-zh-TW.png`：圖表工作區面板。「預設工作區」「單圖／左右雙圖／上下雙圖／四圖」。
- `export-zh-TW.png`：截圖匯出與匯出預覽。`lang=zh-TW`，文案含「截圖匯出」。
- `electron-zh-TW.png`：Electron 桌面窗。CDP 讀回 `lang=zh-TW`、`dir=ltr`、繁體標題、「K 線回放」。

兩次以上獨立 Host 啟動均得到 `document.documentElement.lang === "zh-TW"`、`dir=ltr`、繁體標題，且含「K 線回放」。

沒有 `scanner-zh-TW.png` / `pyne-zh-TW.png`：那些入口在本機 catalog 為空，不能冒充已打開外掛畫面。

## 已知限制

- 無台灣交易用語母語覆核。
- Market Scanner 與 Pyne Workbench **畫面**不可用：backend 已啟動，但 `GET /api/v2/plugins/catalog` 回傳 `plugins: []`，startup log 為 `FIRST_PARTY_PLUGIN_BOOTSTRAP_FAILED`（pinned official plugin bundle does not support this host platform）。Host 外掛中心已驗。
- 後端缺少 `exchange_calendars`，部分行情 API 500；不影響 locale 切換與 Host 鉻文案。
- 研究資料抽屜在窄視窗與側欄同時打開時有擁擠／重疊，不限 zh-TW。
- `researchDataSourceModel` 裡能力說明仍有部分硬編碼中文（既有問題）；來源標籤已改走 Host 詞典。
- 完整 `npm run check` 在 macOS 上於 `drawing-controlled-cdp.test.mjs` 失敗：`native-launcher-parent-invalid`（Windows PowerShell 父行程指紋，與本任務無關）。`check:i18n`、typecheck、lint、其餘 3560 項測試、desktop 測試與 production build 通過。
- Pyne Workbench 完整 pytest 需要相鄰未發布的 `pyne-runtime` 0.3；本環境沒有該套件。

## 爭議術語（見術語表）

- 倉位／持倉，不用「部位」替換
- 訂單／委託保留來源區分，不用「委託單」統一
- 回放不用「重播」
- 盈虧不用「損益」；止盈／止損不用「停利／停損」
- 外掛不用「插件」

## 尚未檢查／未母語覆核的功能區域

完整繪圖工具列、指標編輯器內部、警報規則逐步精靈。Market Scanner 結果表與 Pyne 沙箱需在已安裝這些外掛的 Host 上再開一次。
