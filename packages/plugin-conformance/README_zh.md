# CandleScope Plugin Conformance Suite

这里保存 Plugin Platform v2 的语言无关验收注册表。它不提供新的运行时，也不改变协议；它把已经冻结的 JSONL transcript、manifest probe 和负向测试登记为一份可机读事实源。

## 单一事实源

Python、Java 与 TypeScript SDK 必须读取同一个文件：

`packages/candlescope-plugin-sdk/tests/fixtures/hello_command_transcript_v2.json`

不能把它复制到各 SDK 后单独修改期望值。各参考运行时可以有自己的业务 transcript，但必须在 `suite.json` 中登记文件摘要、结果摘要、manifest probe 和必须覆盖的生命周期 method。

## 运行

```powershell
backend\.venv\Scripts\python.exe packages\plugin-conformance\check.py
backend\.venv\Scripts\python.exe packages\plugin-conformance\check.py --run-python-cases
```

第一条验证注册表、严格 JSON、文件摘要、协议边界、manifest probe、SDK 消费路径和覆盖清单。第二条还会真实执行清单所指向的 Python/Host 负向测试。Java、TypeScript、Rust/WASM 和参考插件的真实 transcript 由 Phase 11 GA 编排器分别运行，不能用本检查替代。

## 修改规则

协议、transcript 或期望摘要发生变化时，必须先审查兼容性，再在同一个变更中更新生成器、所有 SDK、manifest probe、测试和本注册表。仅修改 `suite.json` 以绕过失败不构成有效升级。
