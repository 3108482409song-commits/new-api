# 01 项目概览与整体架构

## 1. 项目定位

new-api 是一个基于 Go 的 AI API 网关与资产管理平台，源自 One API 的分叉。它在 40+ 上游 AI 厂商（OpenAI、Claude、Gemini、Azure、AWS Bedrock、通义、文心、智谱、Kling、Midjourney、Suno 等）之上提供统一 API，同时内置：

- 用户、令牌（API Key）、分组与渠道管理
- 基于配额（quota）的计费：预扣费（pre-consume）→ 结算（settle）→ 差额补扣/返还
- 请求转发、协议转换（OpenAI / Claude / Gemini / Responses / 任务协议）
- 模型价格表达式系统（分阶梯/动态计费）
- 日志记录、用量统计、数据看板、排行榜
- 充值（Stripe/Creem/ePay/Waffo）、订阅、兑换码
- 认证：会话 + 令牌 + JWT、OAuth/OIDC、WebAuthn/Passkey、TOTP、Casbin 授权
- 异步任务（文生图/文生视频/音乐）提交、轮询与结算，通过内嵌 JavaScript 插件扩展

## 2. 技术栈总览

| 层 | 技术 |
| --- | --- |
| 后端 | Go 1.25.1、Gin、GORM v2、Casbin v2、go-redis v8、go-i18n v2、Sobek（JS 引擎） |
| 前端 | React 19 + TypeScript、Rsbuild 2、TanStack Router/Query/Table/Virtual、Zustand、Base UI、Tailwind CSS 4、i18next |
| 数据库 | 主库：SQLite / MySQL / PostgreSQL；日志库：另支持 ClickHouse |
| 缓存 | Redis（可选）、进程内缓存（channel/定价/令牌） |
| 桌面 | Electron 外壳 |
| 前端包管理 | Bun |

## 3. 顶层目录结构

```
new-api/
├── main.go            # 程序入口：资源初始化 + 路由注册 + HTTP 服务
├── common/            # 通用工具：配置/环境变量、JSON、配额数学、Redis、加密、限流
├── constant/          # 常量：渠道类型(1..61)、上下文键、任务平台枚举等
├── controller/        # HTTP 控制器层（Gin handlers）
├── dto/               # 业务 DTO：任务、渠道约束、Midjourney、Suno、插件协议等
├── i18n/              # 后端 i18n（go-i18n/v2，en/zh）
├── logger/            # 日志封装（文件滚动 + 控制台）
├── middleware/        # Gin 中间件：鉴权、分发、限流、缓存、审计、i18n 等
├── model/             # 数据模型与数据访问（GORM）、渠道/定价缓存、多库兼容
├── oauth/             # 自定义 OAuth provider 加载
├── pkg/               # 独立子包：billingexpr / cachex / ionet / jsplugin / perf_metrics
├── plugins/           # 任务插件（JavaScript），plugins/tasks/ 为内置插件
├── relay/             # 上游中继核心：adaptor、各协议 handler、helper、common
│   └── channel/       # 每个上游厂商一个 adaptor 目录
├── relaykit/          # 独立 Go module：协议 DTO 与转换库（go.mod 独立）
├── router/            # 路由注册
├── service/           # 业务服务层：计费、选渠道、tokenizer、authz、系统任务
│   ├── authz/         # Casbin 授权
│   └── passkey/       # WebAuthn Passkey 服务
├── setting/           # 设置与定价：billing_setting、ratio_setting、operation_setting 等
├── types/             # 核心类型：PriceData、Set、RwMap、TaskArtifact
├── web/               # React 前端（Rsbuild 构建 → web/dist 被 Go embed）
├── electron/          # Electron 桌面封装
├── e2e/               # 端到端测试
└── bin/               # 二进制输出目录
```

## 4. 分层架构

```text
┌──────────────────────────────────────────────────────────────┐
│                        HTTP 客户端                            │
│        (OpenAI SDK / Claude SDK / 控制台浏览器 / SSR)          │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  router/         路由注册（/api、/v1、/mj、/task、/pg、web 静态）│
│  middleware/     请求编排：TokenAuth → RateLimit → Distribute   │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  controller/     HTTP 入口：Relay / 令牌 / 用户 / 渠道 / 日志等  │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  service/        业务逻辑：选渠道、计费预扣/结算、敏感词、统计    │
│  relay/          协议转换与上游转发：Adaptor 接口 + 各协议 handler│
│  model/          数据访问：GORM + 缓存（渠道/定价/令牌）         │
│  setting/        定价与运行设置（表达式计费、比率）              │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  上游 AI 厂商（OpenAI/Claude/Gemini/…） · DB · Redis · JS 插件  │
└──────────────────────────────────────────────────────────────┘
```

## 5. 一次请求的完整链路（以 `/v1/chat/completions` 为例）

1. **路由**：[relay-router.go](../../../router/relay-router.go) 将 `/v1` 分组挂上 `TokenAuth` → `ModelRequestRateLimit` → `Distribute`，最终进入 `controller.Relay(c, RelayFormatOpenAI)`。
2. **校验**：[controller/relay.go](../../../controller/relay.go#L73-L258) 中 `helper.GetAndValidateRequest` 按协议解析并校验请求（含 max_tokens 等计费乘数边界）。
3. **RelayInfo 生成**：`relaycommon.GenRelayInfo` 整合令牌、用户、分组、模型映射等信息，形成贯穿全程的上下文对象。
4. **敏感词 + 计费估算**：`service.CheckSensitiveText` 检查提示词；`service.EstimateRequestToken` 估算 token；`helper.ModelPriceHelper` 计算价格（含分组比率、模型比率、OtherRatios）。
5. **预扣费**：`service.PreConsumeBilling` 原子扣除配额，返回 `relayInfo.Billing`（`BillingSettler`）。
6. **渠道选择**：`service.CacheGetRandomSatisfiedChannel` 从内存缓存中按分组/模型/优先级/权重选出可用渠道。
7. **上游转发**：`relay.GetAdaptor(apiType)` 获取渠道 adaptor → `DoRequest` 转发 → `DoResponse` 处理响应/流式转换，同时解析 usage。
8. **结算**：handler 内 `Billing.Settle`（`service.SettleBilling`）按实际用量结算差额（补扣/返还），并写日志 `model.RecordConsumeLog`。
9. **失败重试**：渠道错误时自动换渠道重试（`RetryTimes` 次），必要时自动禁用（ban）故障渠道。

任务类请求（`/v1/video/*`、`/mj/submit/*` 等）走另一条链：提交 → 建 Task 记录并预扣费 → 后台 `service.StartSystemTaskRunner` 周期轮询上游 → 终态时按 `AdjustBillingOnComplete` 结算差额。

## 6. 多实例拓扑

- 环境变量 `NODE_TYPE=slave` 区分从节点；默认为主节点（`IsMasterNode=true`）。
- 渠道缓存、定价缓存由各节点自行同步（`model.SyncChannelCache`、`model.SyncOptions`）。
- Casbin 授权策略通过 `authz.StartPolicySync` 周期重载，保证多节点权限一致。
- 系统定时任务（渠道测试、上游模型刷新、异步任务轮询）通过数据库租约（`model.SystemTask`）实现多 master 去重。
- 前端静态资源仅主节点提供；从节点可设 `FRONTEND_BASE_URL` 把页面重定向到主节点（见 [router/main.go](../../../router/main.go#L15-L41)）。