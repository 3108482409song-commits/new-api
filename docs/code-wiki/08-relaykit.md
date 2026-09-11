# 08 独立模块 relaykit/

`relaykit/` 是独立的 Go module（自有 `go.mod`），通过根模块 go.mod 的 `replace github.com/QuantumNous/new-api/relaykit => ./relaykit` 链接。定位：**协议 DTO 与转换库**——把"各上游协议之间的请求/响应格式转换"做成与宿主解耦的纯函数库，供主模块与渠道 adaptor 复用。

## 1. 依赖边界（强制）

- relaykit **禁止** import 根 `new-api` 模块的任何包，也不依赖根模块配置。
- 改动 relaykit 必须单独验证：`cd relaykit && GOWORK=off go build ./...`（根模块编译通过不代表 relaykit 独立可编译）。
- 传输（HTTP）、认证、数据库、计费都留在宿主；relaykit 只做 DTO 与转换。

## 2. 包结构

| 包 | 职责 |
| --- | --- |
| `relaykit/types` | 协议无关的基础类型：[relay_format.go](../../../relaykit/types/relay_format.go) 的 `RelayFormat` 枚举（openai、claude、gemini、openai_responses、task、mj_proxy、embedding、image、audio、rerank…）；`NewAPIError`、`TaskCountMeta`、`ChannelError`、`RequestMeta`、`FileData` 等 |
| `relaykit/dto` | 各协议的请求/响应结构体：`GeneralOpenAIRequest`、`ClaudeRequest`、`GeminiChatRequest`、`OpenAIResponsesRequest`、`ImageRequest`、`AudioRequest`、`EmbeddingRequest`、`RerankRequest`、`ChannelSettings` 等。可选标量字段遵循指针 + `omitempty` 规则（保留显式零值） |
| `relaykit/relayconvert` | 转换实现：[convmeta](../../../relaykit/relayconvert/convmeta)（转换元数据，如 `ClaudeConvertInfo`）、reasoning（推理意图）、kitutil（工具，含独立 JSON 包装 `kitutil/json.go`）、internal（内部实现）、testdata |
| `relaykit/reasonmap` | 推理级别/思考内容的映射表 |

## 3. 与主模块的呼应

- 主模块 [relay/common](../../../relay/common/) 的 `RelayInfo` 通过类型别名复用 relaykit 类型（如 `type ClaudeConvertInfo = convmeta.ClaudeConvertInfo`）。
- `common/json.go` 是主模块的 JSON 包装；relaykit 内对应使用 `kitutil.*`（relaykit 自带的 JSON 工具），两者互不依赖。
- `types.NewAPIError` 在中继错误处理中作为统一错误载体，按协议转成 OpenAI/Claude 错误响应（见 [controller/relay.go](../../../controller/relay.go) 的 defer 错误处理）。

## 4. 为什么独立

- 协议转换是高复用、低依赖的纯逻辑，独立成 module 后可供宿主测试、第三方工具与未来组件直接引用。
- 通过 `replace` 本地链接，主仓库内改动即时生效；发布时可用真实版本号替换 replace。