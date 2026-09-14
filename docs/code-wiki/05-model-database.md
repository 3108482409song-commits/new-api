# 05 数据模型与数据库（model/）

## 1. 多数据库支持

[model/main.go](../../model/main.go) 是数据库访问的底座：

- `chooseDB()` 按环境变量决定主库/日志库引擎：PostgreSQL（`*SQL_DSN` 以 `postgres://` 开头）、MySQL（`mysql://`）、ClickHouse（仅日志库）、默认 SQLite（`SQLITE_PATH`）。
- `InitDB()` 初始化主库连接池、设置 GORM 配置（含 MySQL utf8mb4、命名策略），并通过 `AutoMigrate` 建表；`InitLogDB()` 初始化日志库（`LOG_SQL_DSN` 为空时复用主库）。
- 跨库兼容辅助（同一文件）：
  - `commonGroupCol` / `commonKeyCol` — 保留字列名（`group`、`key`）按方言加引号
  - `commonTrueVal` / `commonFalseVal` — 布尔值方言化
  - `common.UsingMainDatabase(...)` / `common.UsingLogDatabase(...)` — 分库分支
- [locking.go](../../model/locking.go)：`lockForUpdate(tx)` — 行锁标准化（MySQL/PostgreSQL `FOR UPDATE`，SQLite 跳过）。
- [migration_dialector.go](../../model/migration_dialector.go)：迁移方言处理（SQLite 用 `ADD COLUMN` 等模式）。
- 约束：所有代码必须同时兼容 SQLite、MySQL ≥5.7.8、PostgreSQL ≥9.6，日志库额外支持 ClickHouse。

## 2. 核心数据模型（GORM struct）

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| `User` | user.go | 用户（含分组、配额、状态、角色）；相关：user_cache.go（内存缓存）、user_quota_adjustment.go |
| `Token` | token.go | API 令牌（Key 哈希存储、分组、额度、过期）；token_cache.go（内存缓存）、token_migration.go |
| `Channel` | channel.go | 上游渠道（类型、BaseURL、密钥、权重、状态、模型映射、参数覆盖）；channel_cache.go（渠道缓存核心） |
| `Ability` | ability.go | 渠道模型能力清单（渠道 × 模型 × 优先级/权重） |
| `ChannelConstraint` | channel_constraint.go | 渠道约束（过滤条件、supports-retry 等） |
| `Log` | log.go | 消费/请求日志（含 `other` JSON 列、`admin_info` 嵌套）；log_format_test 等 |
| `Option` | option.go | 系统选项（Key-Value，控制台设置持久化）；frontend_option_migration.go 做旧选项迁移 |
| `Pricing` | pricing.go | 动态定价缓存（GetPricing / InvalidatePricingCache）；pricing_default.go 缺省定价 |
| `Redemption` | redemption.go | 兑换码 |
| `TopUp` | topup.go | 充值订单 |
| `Subscription` | subscription.go | 订阅（周期重置逻辑见 service） |
| `Task` | task.go | 异步任务（文生图/视频/音乐；状态机、PrivateData、配额、轮询上下文） |
| `TaskPlugin` | task_plugin.go | 插件定义（绑定渠道/模型，JS 源码） |
| `SystemTask` | system_task.go | 系统定时任务（DB 租约、运行历史） |
| `UserSession` | user_session.go | 用户会话（服务端会话管理） |
| `TwoFA` / `TwoFAEnrollment` / `Passkey` | twofa.go、twofa_enrollment.go、passkey.go | TOTP 与 WebAuthn 凭据 |
| `CasbinRule` | casbin_rule.go | Casbin 策略表 |
| `CustomOAuthProvider` | custom_oauth_provider.go | 自定义 OAuth provider |
| `EmailBinding` | email_binding.go | 邮箱绑定验证 |
| `CheckIn` | checkin.go | 签到记录 |
| `AuthFlow` | auth_flow.go | 登录流程状态（多步认证） |
| `AccountSecurity` | account_security.go | 账户安全事件 |
| `AuditLog` | audit_log.go | 审计日志；audit_other.go 为审计上下文 |
| `ModelMeta` / `ModelPricingConfig` | model_meta.go、model_pricing_config.go | 模型元数据、模型定价配置 |
| `Redemption` / `PrefillGroup` | redemption.go、prefill_group.go | 兑换码、预填充分组 |
| `SystemInstance` | system_instance.go | 运行实例上报（多节点可见性） |
| `PerfMetric` | perf_metric.go | 性能指标落库 |
| `Usedata` | usedata.go | 看板聚合数据；usedata_flow.go 流量 |
| `VendorMeta` | vendor_meta.go | 供应商元数据 |

## 3. 渠道缓存（channel_cache.go）

网关高并发的关键：

- `InitChannelCache()`：启动时全量载入渠道 + Ability，按“分组-模型”构建可用渠道列表（含优先级排序、权重、Advanced Custom 配置）。
- `SyncChannelCache(syncFrequency)`：周期重载，保证渠道变更自动生效。
- `FixAbility()`：能力表修复（panic 恢复重试的兜底，见 main.go）。

## 4. 定价缓存（pricing.go / pricing_default.go）

- `GetPricing()` 提供按模型/渠道/分组解析后的价格数据（`PriceData`），带并发锁与定期刷新（`pricing_refresh.go`）。
- 内置模型价格由 [billing_setting/builtin_billing.go](../../setting/billing_setting/builtin_billing.go) 以**自包含计费表达式**定义（USD/百万 token，支持上下文长度阶梯与缓存类别），表达式系统详见 [09-plugins.md](09-plugins.md) 第 3 节与 `pkg/billingexpr/expr.md`。

## 5. 其他要点

- `model/utils.go`：分页、通用查询辅助。
- `model/setup.go`：`CheckSetup()` 首次启动引导（创建 admin、默认配置）。
- `model/errors.go`：错误码常量。
- `gorm_logger.go`：GORM SQL 日志适配（Debug 模式）。