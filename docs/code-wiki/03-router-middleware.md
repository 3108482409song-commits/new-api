# 03 路由与中间件

## 1. 路由注册体系

入口：[router/main.go](../../router/main.go#L15-L41) 的 `SetRouter`，将全部子路由挂到同一个 `gin.Engine`：

| 注册函数 | 文件 | 内容 |
| --- | --- | --- |
| `SetApiRouter` | [api-router.go](../../router/api-router.go) | `/api` 管理 API（用户/令牌/渠道/日志等，供控制台调用） |
| `SetDashboardRouter` | [dashboard.go](../../router/dashboard.go) | 用户自助控制台（`/api/user/*`、用量、兑换等） |
| `SetRelayRouter` | [relay-router.go](../../router/relay-router.go) | `/v1`、`/v1beta`、`/mj`、`/pg` AI 网关核心路由 |
| `SetTaskPluginProtocolRouter` | task-plugin-protocol-router.go | 任务插件协议桥（生成固定端点） |
| `SetVideoRouter` | video-router.go | OpenAI 视频任务协议路由 |
| `SetTaskRouter` | task-router.go | 任务提交/查询（通用任务 API） |
| `SetPluginRouter` | plugin-router.go | 插件路由分发（返回 `pluginDispatcher`） |
| `SetWebRouter` | web-router.go | 前端静态资源（embed 的 `web/dist`），含 gzip/缓存/限流 |

若设置了 `FRONTEND_BASE_URL`（且非主节点），则 `NoRoute` 处理器将页面请求 301 重定向到该地址。

### 1.1 中继路由细节（/v1）

[relay-router.go](../../router/relay-router.go) 全局先挂 `CORS`、`DecompressRequestMiddleware`、`BodyStorageCleanup`、`StatsMiddleware`；`/v1` 分组挂 `RouteTag("relay")` → `SystemPerformanceCheck` → `TokenAuth` → `ModelRequestRateLimit` → `Distribute`，然后按协议分发到 `controller.Relay`：

- `/v1/models`、`/v1/models/:model` — 模型列表（按请求头区分 OpenAI/Anthropic/Gemini 风格返回）
- `/v1beta/models`、`/v1beta/openai/models` — Gemini 原生 / Gemini 兼容 OpenAI 风格的模型列表
- `/pg/chat/completions` — Playground（`UserAuth` + `Distribute`）
- `/pg/images/generations`、`/pg/images/edits` — **Workbench 图像生成**（`UserAuth` + `WorkbenchGroup` + `Distribute` → `controller.WorkbenchImage`）
- `/pg/video/generations` — **Workbench 视频生成**（会话鉴权复用插件协议链：`PinTaskPluginEndpoint` → `TaskPluginEndpointOnly(ModelRequestRateLimit)` → `PrepareTaskPluginEndpoint` → `Distribute` → `controller.RelayTaskPluginEndpoint`）
- WebSocket：`GET /v1/realtime` → `RelayFormatOpenAIRealtime`
- `/v1/messages`（Claude）、`/v1/completions`、`/v1/chat/completions`、`/v1/embeddings`、`/v1/edits`、`/v1/images/generations`、`/v1/images/edits`、`/v1/audio/*`、`/v1/rerank`、`/v1/engines/:model/embeddings`、`/v1/models/*path`（Gemini）、`/v1/moderations`、`/v1/alpha/search`、`/v1/responses/compact`
- `/v1/files*`、`/v1/fine-tunes*`、`/v1/images/variations` — 显式未实现，统一返回 `controller.RelayNotImplemented`
- `/mj/*`、`/:mode/mj/*` — Midjourney 代理（submit/task/fetch/image-seed 等，独立于 TokenAuth 体系）
- `/v1beta/models/*path` — Gemini 原生 API 路径

## 2. 中间件清单（middleware/）

### 2.1 认证与鉴权

| 文件 | 职责 |
| --- | --- |
| [auth.go](../../middleware/auth.go) | `UserAuth` / `AdminAuth` / `RootAuth`：会话登录态校验、角色检查、审计 |
| [auth_origin.go](../../middleware/auth_origin.go) | 来源（Origin）校验 |
| [turnstile-check.go](../../middleware/turnstile-check.go) | Cloudflare Turnstile 人机验证 |

### 2.2 令牌与分发（中继链核心）

| 文件 | 职责 |
| --- | --- |
| [distributor.go](../../middleware/distributor.go) | `Distribute()`：请求级渠道预选——根据模型、分组、令牌约束、Pin 等预筛渠道，写入上下文；无可用渠道时直接报错 |
| [workbench_group.go](../../middleware/workbench_group.go) | `WorkbenchGroup()`：Workbench 场景从 `X-Workbench-Group` 请求头解析分组（替代令牌分组来源），供 `/pg/images/*`、`/pg/video/*` 使用 |
| [model-rate-limit.go](../../middleware/model-rate-limit.go) | `ModelRequestRateLimit()`：模型级请求限流 |
| [rate-limit.go](../../middleware/rate-limit.go) | 通用限流中间件（被用于全局 API/Web 限流、邮箱验证限流等） |
| [email-verification-rate-limit.go](../../middleware/email-verification-rate-limit.go) | 邮箱验证码发送限流 |

### 2.3 HTTP 基础设施

| 文件 | 职责 |
| --- | --- |
| [cors.go](../../middleware/cors.go) | CORS 处理 |
| [gzip.go](../../middleware/gzip.go) | gzip 压缩（SSE 场景下的兼容处理，见 main.go 注释） |
| [request-id.go](../../middleware/request-id.go) | 为请求生成 RequestId（用于日志/错误关联） |
| [i18n.go](../../middleware/i18n.go) | 设置请求语言（配合后端 go-i18n） |
| [logger.go](../../middleware/logger.go) | `SetUpLogger`：统一请求日志 |
| [recover.go](../../middleware/recover.go) | panic 恢复 |
| [body_cleanup.go](../../middleware/body_cleanup.go) | `BodyStorageCleanup`：请求体暂存与清理 |
| [request_body_limit.go](../../middleware/request_body_limit.go) | 请求体大小限制（413） |
| [trusted_proxies.go](../../middleware/trusted_proxies.go) | `ConfigureTrustedProxies`：可信代理解析（反向代理部署下正确取客户端 IP） |
| [stats.go](../../middleware/stats.go) | `StatsMiddleware`：请求统计 |
| [performance.go](../../middleware/performance.go) | `SystemPerformanceCheck`：系统负载保护（过载拒绝） |
| [header_nav.go](../../middleware/header_nav.go) | 导航头部处理 |

### 2.4 业务中间件

| 文件 | 职责 |
| --- | --- |
| [cache.go](../../middleware/cache.go) | 响应缓存 |
| [disable-cache.go](../../middleware/disable-cache.go) | 禁用缓存响应头 |
| [audit.go](../../middleware/audit.go) | 审计日志（认证事件） |
| [secure_verification.go](../../middleware/secure_verification.go) | 敏感操作二次验证 |
| [task_plugin.go](../../middleware/task_plugin.go)、[task_plugin_model.go](../../middleware/task_plugin_model.go) | 任务插件路由/模型绑定与上下文；含插件协议端点三段中间件 `PinTaskPluginEndpoint()`（锁定端点）、`TaskPluginEndpointOnly()`（只放行端点请求并包裹内层限流）、`PrepareTaskPluginEndpoint()`（准备上下文） |
| [task_artifact_access.go](../../middleware/task_artifact_access.go) | 任务产物访问控制 |
| [utils.go](../../middleware/utils.go) | 上下文辅助函数 |

## 3. 关键设计点

- **中继请求体复用**：请求体被 `BodyStorageCleanup` 暂存（磁盘/内存），重试换渠道时用 `io.NopCloser(bodyStorage)` 还原，因此 `controller.Relay` 的重试循环不需要客户端重发。
- **渠道预选与实选分离**：`Distribute` 只筛出候选集合并写入上下文，真正的渠道选择在 `controller.getChannel → service.CacheGetRandomSatisfiedChannel`（见 [06-service.md](06-service.md)），保证每次重试能退回并换渠道。
- **限流分层**：全局 API 限流（`GLOBAL_API_RATE_LIMIT_*`）、全局 Web 限流（`GLOBAL_WEB_RATE_LIMIT_*`）、关键接口限流（`CRITICAL_RATE_LIMIT_*`）、搜索接口限流、模型级限流、邮箱验证限流。