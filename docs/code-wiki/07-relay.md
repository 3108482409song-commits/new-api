# 07 上游中继层（relay/）

中继层是网关把统一协议请求转换并转发到 40+ 上游厂商的地方，目录结构：

```
relay/
├── relay_adaptor.go         # GetAdaptor：apiType → Adaptor 工厂
├── relay_task.go            # 异步任务提交核心（RelayTaskSubmit 等）
├── *_handler.go             # 各协议 handler（Text/Audio/Image/Embedding/Rerank/Responses/Claude/Gemini/MJProxy/WebSocket…）
├── channel/                 # 每个上游厂商一个 adaptor 包（40 个目录）
│   └── task/                # 异步任务与 JS 插件共用的 Go adaptor（只有 jsplugin/ 与 taskcommon/，平台差异在 JS 插件侧）
├── common/                  # RelayInfo、计费结算器、流式工具、请求转换
├── common_handler/          # 可复用 handler（当前仅 rerank.go）
├── helper/                  # 请求校验、模型映射、定价、流式扫描
└── constant/                # RelayMode 常量等
```

## 1. Adaptor 接口（channel/adapter.go）

[Adaptor](../../relay/channel/adapter.go#L17-L34) 是"请求-响应型"渠道的统一契约，由 `relay_adaptor.go` 的 `GetAdaptor(apiType)` 按渠道类型工厂化实例化：

| 方法 | 职责 |
| --- | --- |
| `Init(info *RelayInfo)` | 初始化（是否流式等） |
| `GetRequestURL` | 构造上游 URL（含模型名、协议路径） |
| `SetupRequestHeader` | 上游鉴权头 |
| `ConvertOpenAIRequest` / `ConvertClaudeRequest` / `ConvertGeminiRequest` / `ConvertOpenAIResponsesRequest` | 协议转换（OpenAI/Claude/Gemini/Responses → 上游格式） |
| `ConvertRerankRequest` / `ConvertEmbeddingRequest` / `ConvertAudioRequest` / `ConvertImageRequest` | 专用端点转换（多数渠道直接复用 OpenAI 格式） |
| `DoRequest` | 发出上游请求 |
| `DoResponse` | 处理上游响应/流式，返回 usage |
| `GetModelList` / `GetChannelName` | 元信息 |

[TaskAdaptor](../../relay/channel/adapter.go#L36-L81) 是异步任务平台（Kling/Jimeng/Hailuo/Suno/Sora/VertexAI/Vidu/Doubao/Alibaba/Google 等）的契约，额外包含：

- `ValidateRequestAndSetAction` — 请求校验并设置动作
- 计费钩子：`EstimateBilling`（按请求参数产出 OtherRatios 预扣）、`AdjustBillingOnSubmit`（提交响应修正）、`AdjustBillingOnComplete`（终态实际配额差额结算）
- 提交：`BuildRequestURL/Header/Body` + `DoRequest` + `ParseResponse`（返回 `TaskSubmitResponse`）
- 轮询：`FetchTask` + `ParseTaskResult`（返回统一 `TaskInfo`）

> **实现方式**：Go 侧只有**一个**任务 adaptor 实现 `relay/channel/task/jsplugin/`（外加共享工具 `taskcommon/`），各平台的差异通过 `relay_adaptor.go` 的 `taskPluginKeys` 映射到对应的 **JS 插件**（`plugins/tasks/<key>/plugin.js`）实现。`GetTaskAdaptor(platform)` 由该映射解析插件，因此"新增一个任务平台"通常是加一个 JS 插件而非新增 Go 包。详见 [09-plugins.md](09-plugins.md)。

## 2. 渠道 adaptor 清单（relay/channel/）

| 目录 | 上游 |
| --- | --- |
| openai | OpenAI（另被多数 OpenAI 兼容渠道继承复用） |
| claude / gemini / vertex / aws | Anthropic / Google（含 Vertex）/ AWS Bedrock |
| azure（见 constant 渠道类型 3，实现在 openai 包内扩展）/ cloudflare | Microsoft Azure / Cloudflare |
| ali / baidu / baidu_v2 / zhipu / zhipu_4v / xunfei / ai360 / tencent / moonshot / deepseek / minimax / lingyiwanwu / volcengine / mokaai / jina / siliconflow / cohere / mistral / xai / perplexity / openrouter / ollama / xinference / coze / dify / palm / replicate / sub2api / submodel / newapi / jimeng | 国内与开源/聚合平台 |
| task（channel/task/）| 异步任务的 Go 侧唯一实现：`jsplugin/`（按平台加载 JS 插件）+ `taskcommon/`（共享工具） |
| advancedcustom | Advanced Custom（用户自定义适配配置） |
| codex | Codex（凭据刷新见 service） |

渠道类型常量在 [constant/channel.go](../../constant/channel.go)（`ChannelTypeOpenAI=1` … `ChannelTypeTaskPlugin=61`）。

## 3. 各协议 handler（relay/ 根目录）

| 文件 | 职责 |
| --- | --- |
| [compatible_handler.go](../../relay/compatible_handler.go) | `TextHelper`：OpenAI 兼容文本请求主流程（`controller.Relay` 的默认分支）——请求深拷贝、`web_search` 上下文透传、转换 → 转发 → 流式回写 → usage 核算 → 结算 |
| claude_handler.go / gemini_handler.go | `ClaudeHelper` / `GeminiHelper` / `GeminiEmbeddingHandler`（Claude 与 Chat 的流式互转、Gemini 批量 embedding 等） |
| image_handler.go / audio_handler.go / embedding_handler.go / rerank_handler.go | 对应端点处理 |
| responses_handler.go（+ chat_completions_via_responses.go） | OpenAI Responses 协议；Chat→Responses 兼容模式 |
| alpha_search_handler.go | Codex Alpha Search |
| mjproxy_handler.go | Midjourney 代理（submit/notify/task/image-seed/swap-face） |
| websocket.go | Realtime WebSocket 双向代理 |
| relay_task.go | 任务提交（`RelayTaskSubmit`）：平台识别、渠道锁定与 key 轮换、OtherRatios 提取与安全钳制、`TaskSubmitResult` 产出 |
| plugin_protocol.go | 插件协议桥（生成固定端点） |
| relay_adaptor.go | `GetAdaptor(apiType)` 工厂 + JS 插件 adaptor 路由 |
| convert_request_error.go | 上游 4xx/5xx 归类与可重试判定 |
| compatible_handler.go / param_override_error.go | 兼容处理与参数覆盖错误 |

## 4. relay/common/

| 文件 | 关键类型/函数 | 职责 |
| --- | --- | --- |
| [relay_info.go](../../relay/common/relay_info.go) | `RelayInfo`、`GenRelayInfo` | **中继上下文核心结构**：令牌/用户/分组/模型映射/价格数据/渠道元信息/流式状态/计费会话，贯穿校验→转发→结算全链 |
| [billing.go](../../relay/common/billing.go) | `BillingSettler` 接口 | 计费会话抽象：`Settle` / `Refund` / `NeedsRefund` / `GetPreConsumedQuota` / `Reserve` |
| [relay_utils.go](../../relay/common/relay_utils.go) | usage 校验、配额饱和处理 | 上游 usage 解析与超额防护 |
| [stream_status.go](../../relay/common/stream_status.go) | 流式状态机 | SSE 流状态跟踪（首包时间、结束判定） |
| [tool_usage.go](../../relay/common/tool_usage.go) | 工具调用用量 | 内置工具计费 |
| [override.go](../../relay/common/override.go) / request_conversion.go / outbound_body.go | 参数覆盖、请求体转换 | 渠道级参数/头部覆盖的应用 |

## 5. relay/helper/

| 文件 | 关键函数 | 职责 |
| --- | --- | --- |
| [valid_request.go](../../relay/helper/valid_request.go) | `GetAndValidateRequest` | 按 `RelayFormat` 分发并校验请求（OpenAI/Gemini/Claude/Responses/Image/Embedding/Rerank/Audio），内含 `maxTokensLimit` 等计费乘数边界 |
| [price.go](../../relay/helper/price.go) | `ModelPriceHelper` | 模型定价解析（内置表达式/自定义定价/免费模型），产出 `PriceData` 与预扣配额 |
| [model_mapped.go](../../relay/helper/model_mapped.go) | 模型映射 | 用户请求模型名 → 渠道实际模型名（支持前缀/通配/自定义映射） |
| [billing_expr_request.go](../../relay/helper/billing_expr_request.go) | 表达式计费请求 | 从请求中提取表达式变量求值 |
| [stream_scanner.go](../../relay/helper/stream_scanner.go) | 流扫描 | 上游流增量解析（性能边界 `STREAM_SCANNER_MAX_BUFFER_MB`） |
| [stream_result.go](../../relay/helper/stream_result.go) | 流结果处理 | usage/首包/结束时序 |
| [model_modifier.go](../../relay/helper/model_modifier.go) / reasoning_suffix.go | 模型名修饰、推理后缀 | 模型名改写与推理意图注入 |
| [common.go](../../relay/helper/common.go) | 通用辅助 | 渠道信息读取、错误包装 |

## 6. 计费调用链

```text
controller.Relay
  └─ helper.ModelPriceHelper ────────→ PriceData（模型价×分组/模型比率×OtherRatios）
  └─ service.PreConsumeBilling ──────→ relayInfo.Billing（BillingSettler，已预扣额度）
  └─ relay.TextHelper 等
       └─ adaptor.DoResponse 返回 usage
       └─ Billing.Settle ───────────→ service.SettleBilling（差额补扣/返还 + 日志 + 订阅通知）

controller.RelayTask（异步任务）
  └─ relay.RelayTaskSubmit ── EstimateBilling / AdjustBillingOnSubmit
  └─ 持久化 Task 前 Billing.Reserve（防插入失败不可退款）
  └─ service.SettleBilling + model.RecordConsumeLog
  └─ 后台轮询（service.RunTaskPollingOnce）
       └─ ParseTaskResult → AdjustBillingOnComplete → 终态差额结算
```

配额饱和（clamp）审计与违规费用贯穿其中（见 [06-service.md](06-service.md)）。