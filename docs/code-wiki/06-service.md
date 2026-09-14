# 06 业务服务层（service/）

service 层承载网关的核心业务规则：渠道选择、计费、tokenizer、授权、系统任务。它依赖 model（数据）与 relay/common（中继上下文），不直接依赖 controller。

## 1. 渠道选择

| 文件 | 关键函数 | 职责 |
| --- | --- | --- |
| [channel_select.go](../../service/channel_select.go) | `CacheGetRandomSatisfiedChannel(retryParam)` | 从渠道缓存中选择满足条件的渠道（按优先级+权重随机）；支持重试时排除已失败渠道 |
| [channel.go](../../service/channel.go) | 渠道测试、禁用逻辑辅助 | `DisableChannel` 等 |
| [channel_affinity.go](../../service/channel_affinity.go) | 渠道亲和 | 渠道亲和模板与用量缓存（引导故障转移） |

## 2. 计费核心（预扣 → 结算 → 差额）

| 文件 | 关键函数 | 职责 |
| --- | --- | --- |
| [billing.go](../../service/billing.go) | `PreConsumeBilling` / `SettleBilling` | **会话式计费主线**：预扣费（配额原子扣减）→ 完成时按实际用量结算 → 差额补扣/返还 → 订阅配额通知；兼容旧路径 |
| [billing_session.go](../../service/billing_session.go) | BillingSettler 会话实现 | 维护"已预扣额度"状态，提供 Reserve/Refund/NeedsRefund 语义 |
| [billing_usage.go](../../service/billing_usage.go) | usage → 配额换算 | 实际用量核算 |
| [quota.go](../../service/quota.go) | `PreConsumeTokenQuota` / `PostConsumeQuota` | 底层配额原子操作与调整（用户/订阅/令牌三种来源），含通知触发 |
| [tiered_settle.go](../../service/tiered_settle.go) | 阶梯计费结算 | 按 Token 阶梯分段核算（阶梯快照 `TieredBillingSnapshot`） |
| [task_billing.go](../../service/task_billing.go) | 任务计费 | 任务提交/完成时的结算与差额处理 |
| [log_info_generate.go](../../service/log_info_generate.go) | `attachQuotaSaturation` | 配额饱和（clamp）审计标记写入日志 `other.admin_info.quota_saturation` 并告警 |
| [violation_fee.go](../../service/violation_fee.go) | 违规费用 | 敏感词/违规请求的罚款处理 |
| [text_quota.go](../../service/text_quota.go) | 文本配额 | 文本类请求配额核算辅助 |

**安全不变量**（全链路必须遵守）：

- 所有配额运算必须经 `common/quota_math.go` 的换算助手（禁止裸 `int(...)` 转换），溢出/NaN 一律饱和夹取（clamp）并审计（`*Checked` 变体 + `attachQuotaSaturation`），绝不产生负扣费。
- 用户可控的计费乘数（图片 `n`、视频 `seconds`、`max_tokens` 等）必须在上游校验层封顶（`dto.MaxImageN`、`relaycommon.MaxTaskDurationSeconds`、`maxTokensLimit`）。
- 多倍数比率统一经 `PriceData.AddOtherRatio` 校验（拒绝非正/NaN/Inf）。

## 3. Token 计数与估算

| 文件 | 职责 |
| --- | --- |
| [tokenizer.go](../../service/tokenizer.go) | `InitTokenEncoders`：初始化 tiktoken 编码器并按模型缓存 |
| [token_estimator.go](../../service/token_estimator.go) | `EstimateRequestToken`：请求 token 估算（含图片/音频等媒体 token 换算） |
| [token_counter.go](../../service/token_counter.go) | 精确 token 计数 |

## 4. 敏感词与内容检查

| 文件 | 职责 |
| --- | --- |
| [sensitive.go](../../service/sensitive.go) | `CheckSensitiveText`：敏感词检测（Aho-Corasick，[anknown/ahocorasick]） |
| [notify-limit.go](../../service/notify-limit.go) | 通知发送限流 |
| [user_notify.go](../../service/user_notify.go) | 用户通知（邮件等） |

## 5. 授权（service/authz/）

[enforcer.go](../../service/authz/enforcer.go)：

- `Init(db)` 构建 Casbin enforcer（模型 + GORM adapter 从 `CasbinRule` 表加载策略）
- `StartPolicySync(interval)` 周期重载策略，保证多节点部署下权限变更传播
- `GetEnforcer()` 供中间件/控制器做权限判定

[adapter.go](../../service/authz/adapter.go) 实现 Casbin 的 `LoadPolicy/SavePolicy/AddPolicy/RemovePolicy`，将策略读写到数据库。

## 6. 系统任务与轮询

| 文件 | 职责 |
| --- | --- |
| [system_task.go](../../service/system_task.go) | `StartSystemTaskRunner`：系统定时任务运行器（基于 DB 租约的 master 去重 + 运行历史） |
| [task_polling.go](../../service/task_polling.go) | `RunTaskPollingOnce`：异步任务轮询（Midjourney/Suno/视频），经 `GetTaskAdaptorFunc` 工厂获取 adaptor（main.go 中注入，打破 service→relay 循环依赖） |
| [task.go](../../service/task.go) | 任务通用逻辑 |
| [task_artifact_store.go](../../service/task_artifact_store.go)、[task_artifact_access.go](../../service/task_artifact_access.go) | 任务产物存储与访问控制 |
| [subscription_reset_task.go](../../service/subscription_reset_task.go) | 订阅配额周期重置 |
| [codex_credential_refresh*.go](../../service/codex_credential_refresh.go) | Codex 凭证自动刷新 |
| [system_instance.go](../../service/system_instance.go) | 实例状态上报 |

## 7. 其他服务

- [http_client.go](../../service/http_client.go)（及 http_transport_*.go）：上游请求 HTTP Client 构造与传输策略（分片连接池、代理策略）
- [convert.go](../../service/convert.go) / request_converter.go / response_converter.go：请求/响应通用转换
- [image.go](../../service/image.go)、[audio.go](../../service/audio.go)、[file_decoder.go](../../service/file_decoder.go)、[file_service.go](../../service/file_service.go)：多媒体处理
- [epay.go](../../service/epay.go)、[waffo_pancake.go](../../service/waffo_pancake.go)、[webhook.go](../../service/webhook.go)：支付集成
- [rankings.go](../../service/rankings.go)：排行榜聚合
- [auth_token.go](../../service/auth_token.go)、[auth_session.go](../../service/auth_session.go)、[account_security.go](../../service/account_security.go)、[security_verification.go](../../service/security_verification.go)：认证体系服务
- [passkey/](../../service/passkey/)：WebAuthn Passkey 服务
- [str.go](../../service/str.go)、[usage_helpr.go](../../service/usage_helpr.go)、[error.go](../../service/error.go)、[download.go](../../service/download.go)：工具
- [return_path.go](../../service/return_path.go)：响应路径处理（插件返回值路由）