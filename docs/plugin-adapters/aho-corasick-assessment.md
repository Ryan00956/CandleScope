# BurntSushi/aho-corasick CandleScope 接入评估

> 状态：`ASSESSMENT_ONLY_NOT_EXECUTABLE`
>
> 本报告只读取固定 GitHub API 元数据；没有 clone、下载 Release asset、运行 workflow、
> install script、构建脚本或二进制。报告不是安装授权，也不是 Marketplace 审核。

## 1. 固定身份

| 字段 | 值 |
| --- | --- |
| Repository | `https://github.com/BurntSushi/aho-corasick` |
| 请求 pin | `tag:1.1.4` |
| Commit | `17f8b32e3b7c845ef3c5429b823804f552f14ec9` |
| Tree | `4b6ad335b05185e2d7be6d675502c7de6126d5fb` |
| Commit signature | `True` |
| Assessment SHA-256 | `sha256:c2944ab10b1920ad6729fa6bf546e0516e781c30515e594c0f1daada8b37fb5d` |

默认分支只作为观察元数据，不作为依赖 pin。

## 2. Release 与资产

Release 状态：`not-published`。助手未下载任何资产。

| Asset | Size | GitHub SHA-256 | URL |
| --- | ---: | --- | --- |
| 无 GitHub Release asset | 0 | 未提供 | - |

没有 GitHub SHA-256 的资产必须由贡献者独立下载、计算摘要并人工写入 source lock；
assessment 不会替贡献者确认它。

## 3. 许可证与包元数据

| 项目 | 值 |
| --- | --- |
| License status | `detected` |
| SPDX | `NOASSERTION` |
| License content SHA-256 | `sha256:7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c` |
| 初步项目类型 | `library-or-cli` |
| 建议模板 | `native-cli` |

| Package metadata | Blob SHA | Content SHA-256 | Projection |
| --- | --- | --- | --- |
| Cargo.toml | `dbfa7a9cfdfa00164c4ffba94697672d8c07ae4a` | `sha256:05304eb8b8821d48c0c4d2e991b9ed0f1a0b68cb70afb8881b81c4c317969663` | `{"license":"Unlicense OR MIT","name":"aho-corasick","rust-version":"1.60.0","version":"1.1.4"}` |

## 4. 人工兼容评估（必须填写）

- [ ] 公共 API 与 breaking-change 策略已审查；
- [ ] 输入输出已映射到 CandleScope schema；
- [ ] 网络、文件、数据库、环境变量、密钥、GPU、线程和子进程已逐项声明；
- [ ] OS/arch/native library 支持范围已核实；
- [ ] 冷启动、热调用、内存、输出、取消和实例隔离已有证据；
- [ ] 所有直接与传递依赖许可证已审核；
- [ ] 上游制品、Adapter 制品和 build receipt 摘要已独立确认；
- [ ] golden corpus、conformance、fresh install/check/update/rollback 已完成；
- [ ] Marketplace 沙箱资格已单独验证；否则只声明 `trusted-local`。

## 5. 当前决定

`assessment-only`：不得 build、install 或 execute。下一步是人工审核并完成
`candlescope.adapter-source-lock/1`；scaffold 的 pending lock 不具备执行资格。
