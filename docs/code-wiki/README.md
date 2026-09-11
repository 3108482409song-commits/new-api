# new-api Code Wiki

本目录是 new-api 仓库的结构化代码百科（Code Wiki），覆盖项目整体架构、主要模块职责、关键类与函数、依赖关系与运行方式。面向需要快速理解代码组织、定位功能实现或接手开发的读者。

> 文档基于当前仓库代码生成。版本号见根目录 `VERSION` 文件。前端与后端目录内另有各自的 `AGENTS.md` 开发规范（`AGENTS.md`、`web/AGENTS.md`），本文档与其互补：AGENTS.md 讲"怎么写"，Code Wiki 讲"是什么、在哪、怎么跑"。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [01-project-overview.md](01-project-overview.md) | 项目定位、技术栈、顶层目录结构、整体分层架构、一次 API 请求的完整链路 |
| [02-bootstrap.md](02-bootstrap.md) | `main.go` 启动流程、后台 goroutine 全景、`common/` 通用库、`logger/`、`i18n/`、`oauth/` |
| [03-router-middleware.md](03-router-middleware.md) | 路由注册体系（API/Dashboard/Relay/Task/Plugin/Web）、全部中间件清单与职责 |
| [04-controller.md](04-controller.md) | 控制器层按领域分类，核心 handler（Relay/渠道/令牌/用户/日志等）说明 |
| [05-model-database.md](05-model-database.md) | GORM 数据模型清单、多数据库（SQLite/MySQL/PostgreSQL/ClickHouse）兼容机制、渠道缓存与定价缓存 |
| [06-service.md](06-service.md) | 业务服务层：渠道选择、计费（预扣/结算/差额）、tokenizer、Casbin 授权、系统任务运行器 |
| [07-relay.md](07-relay.md) | 上游中继层：Adaptor/TaskAdaptor 接口、各协议 handler、helper 工具、渠道 adaptor 清单、计费调用链 |
| [08-relaykit.md](08-relaykit.md) | 独立 Go 模块 `relaykit/`：协议 DTO、格式转换、与主模块的依赖边界 |
| [09-plugins.md](09-plugins.md) | JavaScript 插件系统：Sobek 运行时、插件 API、内置任务插件、插件协议 |
| [10-frontend.md](10-frontend.md) | React 前端：技术栈、目录结构、路由、状态管理、i18n、构建与嵌入 |
| [11-electron-e2e.md](11-electron-e2e.md) | Electron 桌面端封装与 e2e 端到端测试 |
| [12-dependencies.md](12-dependencies.md) | 模块间依赖关系图、Go 核心依赖、前端核心依赖 |
| [13-runbook.md](13-runbook.md) | 运行方式：本地构建、Docker、关键环境变量、测试、`new-api plugin` CLI |

## 速览

- **语言**：Go 1.25.1（后端）+ TypeScript/React 19（前端）
- **框架**：Gin（HTTP）、GORM v2（ORM）、Casbin（授权）、Sobek（JS 插件运行时）
- **数据库**：主库支持 SQLite / MySQL ≥5.7.8 / PostgreSQL ≥9.6；日志库额外支持 ClickHouse
- **缓存**：Redis（可选）+ 进程内存缓存（渠道缓存、定价缓存、令牌缓存）
- **核心业务**：聚合 60+ 上游 AI 厂商渠道，统一暴露 OpenAI/Claude/Gemini 等多协议 API，并提供计费、配额、用户/令牌管理、数据看板与任务（文生图/文生视频/音乐）轮询