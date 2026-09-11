# 12 依赖关系

## 1. 模块间依赖图（后端 Go）

```text
main.go
  ├─ router/        ← controller/ + middleware/ + relay/（注册 handler 引用）
  ├─ controller/    ← service/ + model/ + relay/ + relaykit/ + pkg/jsplugin/
  ├─ middleware/    ← service/ + model/（分发/鉴权/限流）
  ├─ service/       ← model/ + relay/common/ + relaykit/ + common/ + constant/ + pkg/billingexpr
  ├─ relay/         ← relay/channel/*、relay/common、relay/helper、relaykit/、pkg/billingexpr、model
  │    └─ channel/* ← relay/common + relaykit/dto + model（渠道元数据读取）
  ├─ model/         ← common/ + setting/（定价/选项持久化）+ relaykit?(无，保持隔离)
  ├─ setting/       ← pkg/billingexpr + common/
  ├─ pkg/jsplugin   ← 独立（Sobek），被 main.go / controller / service 引用
  ├─ common/        ← 纯工具（被所有层引用）
  └─ relaykit/      ← 独立 Go module，只能被引用，不能反向依赖（replace 本地链接）
```

关键依赖方向约束：

- `relaykit` 是叶子模块：任何 relaykit → 主模块的 import 都是违规。
- `service → relay` 的循环通过 main.go 注入的工厂函数打破（`service.GetTaskAdaptorFunc = relay.GetTaskAdaptor`）。
- JSON 编解码分两条链路：主模块 `common/json.go`；relaykit 内 `kitutil/json.go`（relaykit/relayconvert/kitutil）。

## 2. Go 核心依赖（go.mod 精选）

| 依赖 | 用途 |
| --- | --- |
| gin-gonic/gin + gin-contrib/* | HTTP 框架、CORS、gzip、静态资源 |
| gorm.io/gorm + driver/{mysql,postgres,clickhouse} + glebarez/sqlite | ORM 与四种数据库驱动 |
| casbin/casbin/v2 | RBAC/ABAC 授权 |
| go-redis/redis/v8 | Redis 缓存/分布式限流 |
| grafana/sobek | JavaScript 插件运行时 |
| nicksnyder/go-i18n/v2 | 后端 i18n |
| golang-jwt/jwt/v5、go-webauthn/webauthn、pquerna/otp、coreos/go-oidc/v3 | 认证组件（JWT/Passkey/TOTP/OIDC） |
| shopspring/decimal | 计费精度（decimal 运算） |
| tidwall/gjson + sjson | JSON 快速读写 |
| tiktoken-go/tokenizer | token 计数 |
| aws/aws-sdk-go-v2 (+bedrockruntime) | AWS Bedrock |
| stripe/stripe-go/v81、Calcium-Ion/go-epay、waffo 系列 | 支付 |
| samber/lo、samber/hot、bytedance/gopkg | 集合工具、热更新、协程池 |
| expr-lang/expr | 计费表达式求值 |
| grafana/pyroscope-go | 持续剖析 |
| 音频/视频解析（go-audio/*、gomedia、abema/go-mp4、mewkiz/flac…） | 媒体时长/编码解析 |
| github.com/QuantumNous/new-api/relaykit | 本地独立模块（replace） |

## 3. 前端核心依赖（web/package.json 精选）

- React 19、React Router 由 @tanstack/react-router 替代（tanstack 全家桶：router/query/table/virtual）
- Base UI + Tailwind CSS 4 + Hugeicons + class-variance-authority（UI 体系）
- Zustand、axios、react-hook-form + Zod、i18next、dayjs、@visactor/vchart、recharts
- 开发链：Rsbuild、oxlint/oxfmt、vitest、@testing-library、shadcn CLI（组件调研）、knip（死代码）

## 4. 外部集成面

| 集成 | 位置 |
| --- | --- |
| 40+ 上游 AI 厂商 | relay/channel/*（请求转发，无 SDK，纯 HTTP） |
| 支付（Stripe/Creem/ePay/Waffo Pancake） | controller/topup*、subscription_payment*、service/epay.go、waffo_pancake.go |
| 邮件（SMTP，含 NTLM/OAuth） | common/email*.go |
| 分析（Umami / Google Analytics） | main.go `InjectUmamiAnalytics` / `InjectGoogleAnalytics` |
| 剖析（Pyroscope / pprof） | common/pyro.go、common/pprof.go |
| 自签名/企业 CA | `TLS_INSECURE_SKIP_VERIFY` / 系统证书 |