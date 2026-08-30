# dsh-subagent-contract

DeepSeek Harness 子代理的确定性、运行后契约检查器。

这是独立社区项目，不由 DeepSeek 维护，也未获得 DeepSeek 官方背书或支持。

验证器读取 `dsh-eval` 引入的公开运行产物结构，在 Harness 进程结束后重新读取父、
子会话日志，保留各自 header，验证被聚合指标抹平的跨会话关系；它不复制评测框架。

> **开发预览：**验证器与确定性 fixture 已可工作；有资源边界的持久 SDK 实验也已在
> `0.1.2-alpha.2` 上完成真实四场景 4/4，四个场景都在第一次尝试通过。runner 仍是只随源码提供的
> 实验路径；积累重复稳定性数据并完成 Linux 全量真实矩阵前，不发布 npm。`dsh-eval@0.3.0` 路线还有两个独立问题：tarball
> 遗漏运行时模块；一次性 headless 又会在后台生命周期结算前退出。

[English](README.md)

## 它解决什么问题

父任务最终文本看起来正确，并不能证明多代理记录正确。真实风险包括：子会话指向
错误父级、深度异常、拒绝启动后留下“幽灵子会话”、续聊落到另一个会话、完成通知
记到错误子代理名下，或把子代理主动 `report` 与运行时结算通知混成一类。

本工具把这些问题变成稳定的错误码、结构化报告和可复现证据，适合作为版本 Canary
或官方讨论中的最小复现附件。

## 当前开发验证

需要 Node.js 22.19+ 或 24+：

```sh
npm install
npm test
npm run check
npm run pack:check
```

如果维护者已经通过修复后的源码 checkout 生成运行产物，可以直接调用离线 CLI；
验证过程不会调用模型：

```sh
node bin/dsh-subagent-contract.js verify artifacts/subagent-run.json
node bin/dsh-subagent-contract.js verify artifacts/subagent-run.json --format json
```

上游运行器重新发布后，正确入口应是 `dsh --profile eval run ...`；当前 Harness 并不
支持 `dsh eval run ...` 这个别名。仅重新发包仍不能可靠覆盖两个后台场景；运行时必须
一直存活到子代理结算完成。

当前持久化证明位于 [`experiments/sdk-runner`](experiments/sdk-runner/README.md)：它固定
预发布 SDK client，在隔离 home 中运行原样四场景，并生成验证器可读的多会话产物。
它仍是实验，不是正式安装入口。

runner 会记录每次尝试的结构摘要；只有离线验证器仅报告明确的
`S00_SCENARIO_NOT_EXERCISED` 模型遵从性缺口时，才允许最多三次隔离尝试。生命周期、权限、
trace、token 上限、清理、兼容性或契约失败都会立即终止，不能被后续重试“洗绿”。仓库内的
Windows 证据四个场景都只运行了一次，没有使用重试。

`dsh-eval` 为每个 trial 创建隔离的 `DSH_HOME`，Provider 凭据因此必须来自启动进程
环境。仅保存在日常 Web Profile 的密钥不会进入 trial home。切勿把密钥写入 benchmark
或提交到仓库的产物。实验会移除继承的 `DEEPSEEK_BASE_URL`，固定到 DeepSeek 公共端点，
并检查每个父、子请求的持久化 header 均不超过 4,096 输出 token。

离线验证器本身跨平台。上游运行器目前还存在 Windows `.cmd` 启动易用性问题，因此
这里不发布未经完整验证的 shell wrapper 方案。

真实运行会调用模型，四场景可能持续数分钟并产生费用。隔离 home 与原始会话日志会
保留作为证据，其中包含 prompt 和模型输出，不会自动删除；产物中的 `tracePaths` 是
绝对路径，不搬迁对应日志就不能跨机器直接使用。

未来 CI 的稳定输出形式为：

```sh
npx dsh-subagent-contract verify artifacts/subagent-run.json --format json
```

## v0.1 的七条契约

| ID | 契约 | 验证内容 |
| --- | --- | --- |
| `C01` | 父子图 | 唯一根、会话 id 唯一、父级可解析、深度递增、无环。 |
| `C02` | 自有 descriptor | 只检查 fork seed 之后的自有事件；每个子会话恰有一个 descriptor，并在首个请求前出现。 |
| `C03` | 准入数量 | 每次调用恰有一个结果。前台错误可能发生在孩子创建前或创建后；后台错误表示准入被拒绝。所有孩子都必须能归因。 |
| `C04` | 前台结果 | 完成且成功时父结果等于孩子最终输出；未完成错误必须保留部分输出；完成却返回错误时标为无法定论。 |
| `C05` | 续聊身份与顺序 | 后台返回 id 指向同一个可续聊会话；成功的 `send_message` 按顺序进入，来源是直接父级。 |
| `C06` | 结算来源 | 每条系统通知都能解析到正确的直接可续聊孩子；固定 Canary 还检查提示中要求的结算边界。 |
| `C07` | report 来源 | 孩子主动发出的 `report` 与结算通知保持两条不同来源的记录；二者顺序只由固定 report 用例约束。 |

完整规则见 [`docs/CONTRACTS.md`](docs/CONTRACTS.md)。

## 兼容与隐私边界

- v0.1 的支持承诺仅覆盖“完整运行原样随包提供的四用例基准”：
  `foreground-success`、`two-admissions`、`continuable-fifo` 和
  `continuable-report`。四个固定 case 都必须存在并提供完整 `tracePaths`；部分、导入或
  自定义产物不能得到完整的受支持结论。
- 识别 `dsh-eval` 0.3.0 中观察到的公开产物形状，不导入私有源码模块；这不代表损坏的
  0.3.0 npm tarball 可作为运行器使用。
- 同时读取纯 JSONL 与 Harness 默认的多帧 Zstandard 日志。
- 支持 descriptor v2（实测 rc.7 与 npm rc.2），以及 2026-08-31 本地
  `0.1.2-alpha.1` 源码修订 `caec78de20` 和持久 `0.1.2-alpha.2` SDK 矩阵产生的
  descriptor v3。遇到未知版本返回退出码 `2`，不会靠猜测给出“通过”。
- 尊重 `header.seedLength`，不会把 fork 继承的祖先 descriptor 当成当前子级的重复项。
- 结构化诊断不包含提示词、模型回复、工具参数、原始 trial error 或子代理 description；
  CLI 层输入／读取错误仍可能带操作系统路径，分享前应检查。
- 运行产物只按可信本地文件处理。加载器拒绝远程／设备路径，并限制 trace 数量、压缩输入
  与解压输出；普通本地绝对 `tracePaths` 仍会使用当前用户本身拥有的文件权限。
- 不修改 Harness 配置或会话。`init` 仅创建用户指定的基准文件，且拒绝覆盖。

真实 trace 探针与本地验证均在 Windows 完成。仓库已配置 Windows Node.js 24 与 Linux
Node.js 22/24 的三组 verifier，以及 Windows/Linux 两组 SDK 初始化 smoke；首次推送后
必须看到五组检查全部通过，才会作发布声明。

报告中的 `source.kind` 只是描述，不是来源认证：`sdk-runner-claim` 来自产物自报字段，
`dsh-eval-compatible` 仅表示结构兼容。公开的证据哈希同样属于维护者自证，并非第三方签名。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 所有可验证契约通过。 |
| `1` | 发现至少一条行为契约违例。 |
| `2` | 输入或 descriptor 版本不兼容，无法可靠判断。 |

JSON 输出遵循 [`schemas/report.schema.json`](schemas/report.schema.json)。

## 明确不做的事情

- 正式验证器包不运行 Harness case、不管理密钥、不评最终答案、不统计 token 或费用；
  当前由独立 SDK 实验提供持久四场景 runner。
- 不复制官方进程内 `subagent/start` / `subagent/end` invariant；本工具检查进程退出后的
  持久化证据。
- 不再发明 YAML 断言语言、重试器、baseline gate 或 LLM judge。
- 固定基准首先是 Canary。模型存在非确定性，在积累特定 Profile 的稳定数据前，不应直接
  作为阻断发布的硬门禁。

## 真实证据

解析器和契约已通过确定性 fixture，并实际验证 rc.7、npm rc.2、本地
`0.1.2-alpha.1` 与完整持久 `0.1.2-alpha.2` SDK 矩阵。后者四场景全部 exercised、
验证器退出 `0`；11 个持久化请求 header 都带有 4,096-token 上限；从最早持久会话创建到
产物写入的派生区间为 49.533 秒。含自证哈希的脱敏结构摘要见
[`evidence/alpha2-sdk-summary.json`](evidence/alpha2-sdk-summary.json)。证据边界与复现过程见
[`docs/RESEARCH_EVIDENCE.md`](docs/RESEARCH_EVIDENCE.md)。

## 开发

```sh
npm test
npm run check
npm run pack:check
```

项目没有运行时依赖。新增诊断必须同时添加脱敏、确定性的 fixture。

## 许可证

MIT。多帧 Zstandard 容器读取逻辑参考了 MIT 许可的 `dsh-eval-harness`；详情见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
