# 04 控制器层（controller/）

控制器是 Gin 的 handler 集合，按领域划分（文件名即领域）。核心是中继控制器 [relay.go](../../controller/relay.go)。

## 1. 中继控制器（核心）

### Relay

[controller/relay.go](../../controller/relay.go#L73-L258) — 所有 `/v1` 类协议请求的统一入口 `Relay(c, relayFormat)`：

1. `helper.GetAndValidateRequest(c, relayFormat)` — 按协议解析 + 校验请求（413/400 映射）
2. `relaycommon.GenRelayInfo(c, relayFormat, request, ws)` — 生成全程贯通的 `RelayInfo`
3. 敏感词检查（`service.CheckSensitiveText`）→ token 估算（`service.EstimateRequestToken`）→ 定价（`helper.ModelPriceHelper`）
4. `service.PreConsumeBilling` 预扣费（免费模型跳过）；失败退款由 defer 保证（`relayInfo.Billing.Refund` + 违规费用 `ChargeViolationFeeIfNeeded`）
5. 重试循环（≤ `RetryTimes`）：`getChannel` 选渠道 → 还原请求体 → 按 `RelayFormat` 分派 handler → 出错时 `processChannelError`（自动禁用渠道、写错误日志）→ `shouldRetry` 决定是否换渠重试

按 `RelayMode` 分派的 handler：

| RelayMode | handler |
| --- | --- |
| ImagesGenerations/Edits | `relay.ImageHelper` |
| AudioSpeech/Translation/Transcription | `relay.AudioHelper` |
| Rerank | `relay.RerankHelper` |
| Embeddings | `relay.EmbeddingHelper` |
| Responses / ResponsesCompact | `relay.ResponsesHelper` |
| AlphaSearch | `relay.AlphaSearchHelper` |
| 其他（文本） | `relay.TextHelper` |

其他关键函数：`CountClaudeTokens`（Claude token 计数端点）、`RelayMidjourney`（/mj 分发）、`RelayTask` / `RelayTaskFetch`（任务提交/查询，含 `executeTaskSubmissionWith` 的提交-持久化-结算事务屏障）、`shouldRetry` / `processChannelError` / `shouldRetryTaskRelay`（重试与渠道错误处理策略）、`RelayNotFound` / `RelayNotImplemented`。

## 2. 控制器领域分类

### 2.1 用户与认证

| 文件 | 关键内容 |
| --- | --- |
| user.go | 用户 CRUD、用户详情、分组管理 |
| user_quota.go | 配额调整（管理员加/扣额度） |
| auth_session.go / login_verification.go / secure_verification.go | 登录、验证码、二次验证 |
| twofa.go / passkey.go / email_binding.go | TOTP、Passkey、邮箱绑定 |
| oauth.go / custom_oauth.go | OAuth/OIDC 登录回调、自定义 provider |
| authz.go / secure_verification.go | Casbin 角色授权接口、敏感操作二次验证（`security_*` 目前只存在于测试文件 `security_account_test.go`、`security_enrollment_test.go`） |

### 2.2 令牌与渠道

| 文件 | 关键内容 |
| --- | --- |
| token.go | 令牌（API Key）CRUD，含自动分组 |
| channel.go / channel-billing.go / channel-test.go / channel_upstream_update.go / channel_authz.go | 渠道管理、渠道测试、上游模型更新、渠道级授权 |
| model.go / model_sync.go / model_meta.go / model_pricing_config.go / missing_models.go | 模型列表、模型联动同步、元数据、定价配置 |
| ratio_config.go / ratio_sync.go / prefill_group.go | 计费比率配置与同步、预填充分组 |
| pricing.go / billing.go | 定价与账单接口 |

### 2.3 日志、统计与看板

| 文件 | 关键内容 |
| --- | --- |
| log.go | 请求日志查询 |
| usedata.go / usedata_flow.go / rankings.go | 用量统计、流量数据、排行榜 |
| system_info.go / performance.go / perf_metrics.go | 系统信息页、性能指标 |
| playground.go | 控制台 Playground 调试接口 |

### 2.4 计费与商业化

| 文件 | 关键内容 |
| --- | --- |
| topup.go 及 topup_stripe/creem/waffo* | 充值：支付回调与订单 |
| subscription.go 及 subscription_payment_* | 订阅计划与支付 |
| redemption.go | 兑换码 |
| payment_webhook_availability.go / payment_compliance.go | 支付 webhook 与合规 |
| codex_usage.go | Codex 用量 |

### 2.5 任务与插件

| 文件 | 关键内容 |
| --- | --- |
| task.go / task_plugin.go | 任务查询、任务插件 CRUD |
| task_plugin_debug.go | 插件调试 |
| plugin_protocol.go / plugin_protocol_limiter.go | 插件协议桥与限流 |
| system_task.go / system_task_handlers.go | 系统定时任务注册与 handler |
| video_proxy.go | 视频产物代理（任务产物经此代理回源，配合产物访问控制） |
| workbench.go | **Workbench 工作台**：`WorkbenchImage`（图像生成/编辑，`/pg/images/*`）与视频任务端点（`/pg/video/generations`，复用插件协议链）；含 `maxWorkbenchCaptureBytes` 限制回传体积 |

### 2.6 其他

- misc.go、setup.go、option.go（系统选项）、checkin.go（签到）、wechat.go（微信相关）、telegram.go（Telegram 通知）、uptime_kuma.go、vendor_meta.go、deployment.go、return_path.go 等。
- 审计与访问令牌：audit.go（审计内容模板与查询）、access_token.go（访问令牌管理，配合 `middleware.AccessTokenAudit`）。
- 媒体与分组辅助：image.go、midjourney.go（Midjourney 轮询汇总）、group.go（分组管理）、channel_affinity_cache.go（渠道亲和缓存）、revalidated_response.go（ETag 再校验响应头，`etagVersionPublicContent`）。

## 3. 约定

- 控制器只做 HTTP 编排（解析 → 调 service/model/relay → 序列化响应），业务规则下沉到 service 层。
- 错误统一用 `types.NewAPIError`（relaykit），最终按协议转成 OpenAI/Claude 错误格式。
- `controller/` 内含大量 `*_test.go`，覆盖令牌、渠道、计费、任务插件等关键路径（见 [13-runbook.md](13-runbook.md) 的测试章节）。