# 13 运行方式（Runbook）

## 1. 本地构建与运行

### 1.1 后端

```bash
# 直接运行（首次启动引导创建管理员账号）
go run .

# 编译二进制（前端未构建时仅 API 可用）
go build -o bin/new-api .

# 指定端口
go run . --port 3000        # 或环境变量 PORT=3000
```

### 1.2 前端（嵌入产物）

```bash
cd web
bun install
bun run build               # 产物到 web/dist，随后重新 go build 会嵌入
bun run dev                 # 开发模式（Rsbuild dev server，配后端跨域）
```

> 单二进制发布必须**先构建前端再编译 Go**（`//go:embed web/dist` 在编译期嵌入）。Dockerfile 已编排这一顺序。

### 1.3 relaykit 独立校验

```bash
cd relaykit && GOWORK=off go build ./...
```

## 2. Docker 部署（推荐）

```bash
git clone https://github.com/QuantumNous/new-api.git
cd new-api
# 按需编辑 docker-compose.yml（端口、SQL/Redis 配置）
docker compose up -d
```

镜像：`ghcr.io/Calcium-Ion/new-api`（GHCR）/ `CalciumIon/new-api`（Docker Hub）；`Dockerfile` 多阶段构建无需本地 Go/Node 环境。

## 3. 首次启动引导

- `model.CheckSetup()`：读取/写入 `Setup` 记录判断系统是否已初始化；未初始化时（`constant.Setup=false`）首次访问控制台会进入**引导页创建 root 管理员**（注册写入 `User` 表后建立 Setup 记录），随后才能登录使用。
- 默认 SQLite（`data/one-api.db` 或 `SQLITE_PATH` 指定）；生产建议 MySQL/PostgreSQL（`SQL_DSN`）。
- 控制台入口：`http://<host>:<port>/`（主节点）；API 文档见 `docs/openapi/`。

## 4. 关键环境变量

> 完整清单与默认值以 [common/init.go](../../../common/init.go)、[common/constants.go](../../../common/constants.go)、README 为准，下表为常用分类精选。

### 4.1 数据库与缓存

| 变量 | 说明 |
| --- | --- |
| `SQL_DSN` | 主库连接串（`mysql://`、`postgres://`；缺省 SQLite） |
| `SQLITE_PATH` | SQLite 文件路径 |
| `LOG_SQL_DSN` | 日志库连接串（支持 ClickHouse；缺省复用主库） |
| `REDIS_CONN_STRING` | Redis（并发限流、分布式缓存） |
| `MEMORY_CACHE_ENABLED` | 内存缓存（渠道/定价/令牌） |
| `SYNC_FREQUENCY` | 缓存同步周期（秒，默认 60） |

### 4.2 服务与安全

| 变量 | 说明 |
| --- | --- |
| `PORT` | HTTP 端口 |
| `SESSION_SECRET` / `CRYPTO_SECRET` | 会话签名 / 敏感数据加密密钥 |
| `NODE_TYPE=slave` | 从节点模式（不提供前端、执行部分任务需另行确认） |
| `FRONTEND_BASE_URL` | 从节点把前端请求 301 重定向到此地址 |
| `DEBUG=true` | 调试日志 |
| `ENABLE_PPROF=true` | 端口 8005 暴露 pprof |

### 4.3 中继

| 变量 | 说明 |
| --- | --- |
| `RELAY_TIMEOUT` / `RELAY_IDLE_CONN_TIMEOUT` / `RELAY_RESPONSE_HEADER_TIMEOUT` | 上游请求超时与连接池 |
| `STREAMING_TIMEOUT` | 流式总超时（默认 300s） |
| `MAX_REQUEST_BODY_MB` | 请求体上限（默认 128MB，超限 413） |
| `CHANNEL_UPDATE_FREQUENCY` | 渠道上游模型自动刷新周期（秒） |
| `UPDATE_TASK=true` | 任务轮询开关 |

### 4.4 限流

| 变量 | 说明 |
| --- | --- |
| `GLOBAL_API_RATE_LIMIT_ENABLE/NUM/DURATION` | 全局 API 限流（默认 360 次/180s） |
| `GLOBAL_WEB_RATE_LIMIT_*` | 全局 Web 限流（默认 120 次/180s） |
| `CRITICAL_RATE_LIMIT_*` | 关键接口（登录/注册等）限流 |
| `SEARCH_RATE_LIMIT_*` | 搜索接口限流 |

## 5. 测试

```bash
# 后端单元/回归测试（根模块）
go test ./...

# 前端
cd web && bun run test

# 插件 JS 本地验证
go run . plugin lint <path>
go run . plugin test --fixture <path> <fixture>
```

- 后端口径：`controller/`、`service/`、`relay/`、`common/quota_math_test.go`、`relay/helper/openai_image_request_test.go` 等保护计费安全不变量与协议契约。
- **数据库变更门槛**：涉及 ORM/模型/迁移的改动必须在真实的 SQLite + MySQL(≥5.7.8) + PostgreSQL(≥9.6) 三个引擎上验证（含全新库与旧版本升级库各一次、迁移幂等性），并在交付说明中记录版本与结果。
- **relaykit 变更**：必须通过 `cd relaykit && GOWORK=off go build ./...`。
- e2e 黑盒测试见 [11-electron-e2e.md](11-electron-e2e.md)。

## 6. 日志与排障

| 项 | 位置 |
| --- | --- |
| 运行日志 | `logs/oneapi-YYYYMMDDHHMMSS.log`（按天滚动），含请求级 RequestId 关联 |
| 错误日志（可选） | `ERROR_LOG_ENABLED=true` 时中继错误入库（Admin 日志页） |
| pprof | `ENABLE_PPROF=true` 后访问 `:8005` |
| Pyroscope | 按 `PYROSCOPE_*` 配置上报 |
| 前端构建查看 | `bun run preview` 或直接部署后由二进制提供服务 |

## 7. 常见问题定位路径

| 现象 | 排查 |
| --- | --- |
| 接口 404 | 确认路径是否在 [relay-router.go](../../../router/relay-router.go) 注册（如文件类接口明确未实现） |
| 上游报错/渠道不可用 | 日志中的 `channel error (channel #id, status code)` + 管理后台渠道测试（controller/channel-test.go） |
| 计费异常/负扣费 | 核对 `common/quota_math.go` 饱和审计日志（quota_saturation）与请求日志 `admin_info` |
| 多实例权限不一致 | 确认 `authz.StartPolicySync` 正常（周期重载，间隔 `SYNC_FREQUENCY`） |
| 任务不轮询 | 检查 `UPDATE_TASK`、系统日志中 system task runner 租约与 `TASK_POLL_MAX_FAILURES` |