# 02 启动流程与通用基础设施

## 1. main.go 启动流程

入口：[main.go](../../main.go)

### 1.1 CLI 分派

`os.Args[1] == "plugin"` 时直接进入 `jsplugin.RunCLI`（插件 lint/test 子命令），不启动 HTTP 服务；否则走正常启动。

### 1.2 InitResources() 初始化顺序

1. `godotenv.Load(".env")` — 加载可选 `.env`
2. `common.InitEnv()` — 解析全部环境变量与命令行参数（见 [common/init.go](../../common/init.go)）
3. `logger.SetupLogger()` — 初始化日志（控制台 + 按天滚动文件，见 [logger/logger.go](../../logger/logger.go)）
4. `ratio_setting.InitRatioSettings()` — 初始化分组/模型计费比率
5. `service.InitHttpClient()` — 构造上游转发的共享 HTTP Client（超时/连接池参数来自 `RELAY_*` 环境变量）
6. `service.InitTokenEncoders()` — 初始化 tiktoken tokenizer 编码器缓存
7. `model.InitDB()` — 主数据库（SQLite/MySQL/PostgreSQL），AutoMigrate 建表
8. `authz.Init(model.DB)` — Casbin 授权初始化
9. `model.InitPasswordEncryption()` — 可选（`PASSWORD_LOGIN_ENCRYPTION_ENABLED`）
10. `model.CheckSetup()` + `model.InitOptionMap()` — 启动配置与系统选项（含前端选项迁移）
11. `common.CleanupOldCacheFiles()` — 清理磁盘缓存
12. `model.InitLogDB()` — 日志数据库（可独立配置，支持 ClickHouse）
13. `common.InitRedisClient()` — Redis（可选）
14. `perfmetrics.Init()`、`common.StartSystemMonitor()` — 性能指标与系统监控
15. `i18n.Init()` + `i18n.SetUserLangLoader(model.GetUserLanguage)` — 后端 i18n
16. `oauth.LoadCustomProviders()` — 从数据库加载自定义 OAuth provider
17. `service.StartAuthArtifactCleanup()` — 认证产物清理任务

### 1.3 后台 goroutine 全景

| 任务 | 触发条件 | 职责 |
| --- | --- | --- |
| `model.InitChannelCache` / `SyncChannelCache` | `MEMORY_CACHE_ENABLED` | 渠道缓存初始化与周期同步（间隔 `SYNC_FREQUENCY`） |
| `model.GetPricing()` | 启动时 | 预热定价缓存 |
| `model.SyncOptions` | 常驻 | 周期热更新系统选项 |
| `controller.SyncTaskPlugins` | 常驻 | 同步数据库中的任务插件 |
| `authz.StartPolicySync` | 常驻 | Casbin 策略周期重载（多节点一致） |
| `model.UpdateQuotaData` | 常驻 | 更新数据看板（用量排行榜等） |
| `controller.AutomaticallyUpdateChannels` | `CHANNEL_UPDATE_FREQUENCY` | 自动更新渠道上游模型列表 |
| `service.StartCodexCredentialAutoRefreshTask` | 常驻 | Codex 凭证自动刷新（每 10 分钟检查） |
| `service.StartSubscriptionQuotaResetTask` | 常驻 | 订阅配额周期重置（日/周/月/自定义） |
| `service.StartSystemInstanceReporter` | 常驻 | 上报本实例状态（多实例部署可见性） |
| `controller.RegisterScheduledSystemTasks` + `service.StartSystemTaskRunner` | 常驻 | 注册并运行定时系统任务（渠道测试、上游模型刷新、异步任务轮询），DB 租约去重 |
| `model.InitBatchUpdater` | `BATCH_UPDATE_ENABLED=true` | 批量更新 |
| pprof + `common.Monitor` | `ENABLE_PPROF=true` | 端口 8005 提供 pprof |
| `common.StartPyroScope` | 常驻 | Pyroscope 持续剖析 |

### 1.4 HTTP 服务与优雅退出

- `gin.New()` + 全局中间件：`CustomRecovery`（panic 兜底）→ `RequestId` → `Version` → `I18n` → 日志。
- 前端产物通过 `//go:embed web/dist` 编译进二进制，`InjectUmamiAnalytics` / `InjectGoogleAnalytics` 在启动时向 index.html 注入统计脚本。
- 监听 `PORT` 环境变量或 `--port` 参数指定端口。
- SIGINT/SIGTERM 触发 `srv.Shutdown`（超时 `SHUTDOWN_TIMEOUT_SECONDS`，默认 120s，给 SSE 流留出收尾时间）；退出前若启用数据看板缓存则 `model.SaveQuotaDataCache()` 落库。

## 2. common/ 通用库

| 文件 | 职责 |
| --- | --- |
| [env.go](../../common/env.go) | `GetEnvOrDefault*` 系列环境变量读取辅助 |
| [init.go](../../common/init.go) | `InitEnv()`：解析全部运行参数（环境变量 + CLI flag）；`constMaxRequestBodyMB` 等常量的落点 |
| [constants.go](../../common/constants.go) | 版本号、请求上下文键（`RequestIdKey` 等）、重试次数等全局常量 |
| [quota_math.go](../../common/quota_math.go) | **配额数学单一入口**：`QuotaFromFloat*`（截断）、`QuotaRound*`（四舍五入）、`QuotaFromDecimal*`，均带防溢出夹取（clamp）与 `*Checked` 审计变体；`WalletQuotaFromDecimalStrict`（JS 安全边界 `MaxWalletQuota`） |
| [json.go](../../common/json.go) | JSON 编解码包装：`Marshal` / `Unmarshal` / `UnmarshalJsonStr` / `DecodeJson` / `GetJsonType`——业务代码统一经此（主模块内禁止直接调用 `encoding/json`） |
| [redis.go](../../common/redis.go) | Redis 客户端初始化与访问封装 |
| [rate-limit.go](../../common/rate-limit.go) | 基于 Redis/内存的令牌桶限流实现 |
| [crypto.go](../../common/crypto.go)、[password_crypto.go](../../common/password_crypto.go) | 敏感信息加解密、密码哈希 |
| [ssrf_protection.go](../../common/ssrf_protection.go) | SSRF 防护（对内网地址的 URL 校验） |
| [email.go](../../common/email.go) 等 | SMTP 邮件发送（含 NTLM/OAuth 认证） |
| [gopool.go](../../common/gopool.go)、[go-channel.go](../../common/go-channel.go) | 协程池与通道工具 |
| [system_monitor.go](../../common/system_monitor.go) | 系统指标采集（gopsutil） |
| [pyro.go](../../common/pyro.go)、[pprof.go](../../common/pprof.go) | Pyroscope / pprof 集成 |

## 3. logger/

[logger/logger.go](../../logger/logger.go)：`SetupLogger()` 初始化控制台与按天滚动的文件输出（`logs/oneapi-YYYYMMDDHHMMSS.log`）；提供 `LogInfo/LogWarn/LogError/FatalLog`，支持错误堆栈与消息裁剪。

## 4. i18n/

后端 i18n：[i18n/](../../i18n/) 使用 `nicksnyder/go-i18n/v2`，语言 en/zh；`Init()` 加载消息文件，`SetUserLangLoader` 按用户偏好懒加载语言包。

## 5. oauth/

[oauth/](../../oauth/)：`LoadCustomProviders()` 从数据库读取管理员配置的自定义 OAuth/OIDC provider（`model.CustomOAuthProvider`），注册进登录流程（配合 `coreos/go-oidc`）。

## 6. setting/ 概览

| 子包 | 职责 |
| --- | --- |
| [billing_setting](../../setting/billing_setting/) | 内置模型定价（`builtin_billing.go`，表达式形式，真实 USD/百万 token）、计费配置 |
| [ratio_setting](../../setting/ratio_setting/) | 分组/模型计费比率设定与动态刷新 |
| [operation_setting](../../setting/operation_setting/) | 运行参数：重试状态码策略等 |
| [model_setting](../../setting/model_setting/) | 模型自定义设置（别名、能力位） |
| [performance_setting](../../setting/performance_setting/) / [perf_metrics_setting](../../setting/perf_metrics_setting/) | 系统性能保护与指标采集设置 |
| [reasoning](../../setting/reasoning/) | 推理能力标记 |
| [system_setting](../../setting/system_setting/) | 系统级设置（敏感词、支付等开关） |
| [task_pricing_setting](../../setting/task_pricing_setting/) | 任务平台定价补丁 |
| [console_setting](../../setting/console_setting/) | 控制台设置 |
| [config](../../setting/config/) | 配置常量 |

> 除子包外，`setting/` 根目录还有若干跨域设置：`auto_group.go`（自动分组）、`chat.go`、`midjourney.go`、`rate_limit.go`、`sensitive.go`、`task_plugin.go`、`user_usable_group.go`，以及支付相关 `payment_stripe.go` / `payment_creem.go` / `payment_waffo.go` / `payment_waffo_pancake.go`。

## 7. types/

[types/](../../types/)：`PriceData`（价格数据，含 `AddOtherRatio` 安全校验、`OtherRatios()`）、`Set`（字符串集合）、`RwMap`（并发 map）、`TaskArtifact`（任务产物）。