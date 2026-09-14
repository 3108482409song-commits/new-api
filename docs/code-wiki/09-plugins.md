# 09 插件系统与计费表达式（pkg/ + plugins/）

## 1. JavaScript 插件运行时（pkg/jsplugin/）

用 Grafana Sobek（Go 实现的 JS 引擎）执行插件，插件本身是 JavaScript（ES 模块）。

| 文件 | 职责 |
| --- | --- |
| [engine.go](../../pkg/jsplugin/engine.go) | Sobek Runtime 封装：执行脚本、模块绑定、`Export`/`HasExport` 读取声明式导出（如 `meta`） |
| [registry.go](../../pkg/jsplugin/registry.go) | 插件元模型与注册表：`Key`、`Version`、`APIVersion`、`FetchMode`、`Protocols`、`Routes` 等字段 |
| [cli.go](../../pkg/jsplugin/cli.go) | `RunCLI`：`new-api plugin lint` / `new-api plugin test --fixture` 本地开发验证 |
| [utils.go](../../pkg/jsplugin/utils.go) | 通过 `runtime.Set` 向 JS 暴露宿主能力：`utils`（unixNow、jwtSignHS256、hmacSHA256、base64、uuid、volcSignV4）与 `console.log` |

插件同时支持两种形态：

- **数据库插件**（`model.TaskPlugin`）：在控制台上传/编辑 JS 源码并绑定渠道与模型，`controller.SyncTaskPlugins` 周期同步到内存注册表。
- **内建任务插件**（`plugins/tasks/`）：随二进制分发，每个平台一个 `plugin.js`，共 10 个：
  `alibaba`、`doubao`、`google`、`hailuo`、`jimeng`、`kling`、`sora`、`sunoapi`、`vertex-ai`、`vidu`。
  平台 → 插件的映射表在 `relay/relay_adaptor.go` 的 `taskPluginKeys`（如 `ChannelTypeAli → alibaba`、`ChannelTypeVolcEngine → doubao`、`ChannelTypeGemini → google`、`ChannelTypeMiniMax → hailuo`）。

### 1.1 插件 JS 约定（以 plugins/tasks/kling/plugin.js 为例）

- `export const meta` — 插件元信息（key/version/协议/路由）
- 构建请求、解析提交响应、实现轮询回调
- `parseTaskResult` 输出统一任务结果：`status` / `reason` / `url` / `completionTokens` / `totalTokens`（供宿主计费结算）

### 1.2 插件协议与路由

- `controller/plugin_protocol.go` + `router/task-plugin-protocol-router.go`：插件声明的端点（`Routes`）由宿主生成，命中的请求进入"生成固定"（generation-pinned）协议桥，见 `controller.RelayTaskPluginEndpoint`。
- `service/task_plugin_view.go`：构建插件视图（view model），供原生提交展示回调（`Route.Render`）。
- `middleware/task_plugin.go` / `task_plugin_model.go`：插件路由与插件-模型绑定中间件。

## 2. 其他 pkg/ 子包

| 包 | 职责 |
| --- | --- |
| [pkg/billingexpr](../../pkg/billingexpr/) | **计费表达式系统**：用于内置模型定价与阶梯计费。设计文档在 [expr.md](../../pkg/billingexpr/expr.md)（改计费表达式前必读）：表达式语言、token 归一化、配额换算、表达式版本化；`QuotaRound` 等委托 `common.QuotaRound` |
| [pkg/cachex](../../pkg/cachex/) | 轻量缓存工具 |
| [pkg/ionet](../../pkg/ionet/) | 网络容量管理（IO.NET 渠道支持，见 docs/ionet-client.md） |
| [pkg/perf_metrics](../../pkg/perf_metrics/) | 中继性能指标采集（`RecordRelaySample`）与看板数据 |

## 3. 计费表达式要点（billingexpr）

- **用途**：用统一表达式语言描述模型价格（USD/百万 token），支持输入/输出不同价、上下文长度阶梯、缓存命中折扣等，替代旧的比例表。
- **内置价格**：[setting/billing_setting/builtin_billing.go](../../setting/billing_setting/builtin_billing.go) 用自包含表达式定义，真实美元计价；管理员自定义定价优先于内置价。
- **安全**：表达式求值结果同样经 `common.QuotaRound` / `QuotaFromDecimal` 饱和转换，杜绝溢出负数扣费。
- 新增/修改任何阶梯计费逻辑前必须先读 [expr.md](../../pkg/billingexpr/expr.md)。

## 4. plugins/ 根目录测试

[plugins/](../../plugins/) 下的 `*_test.go` 对内置插件的协议转换与响应解析做 Go 侧回归测试：

- `builtin_plugins_test.go` — 内置插件集合的汇总校验（元信息、可编译性）。
- `<平台>_responses_test.go` — 按平台逐个覆盖：`alibaba`、`doubao`、`google`、`hailuo`、`jimeng`、`kling`、`sora`、`sunoapi`、`vertex-ai`、`vidu`。
- 其他专项：`alibaba_wan3_test.go`、`veo_poll_test.go`（轮询）、`video_responses_test_helpers_test.go`（共享断言工具）。