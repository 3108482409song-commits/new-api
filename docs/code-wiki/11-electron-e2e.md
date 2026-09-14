# 11 Electron 桌面端与 e2e 测试

## 1. Electron 桌面端（electron/）

`electron/` 是桌面外壳：把单二进制网关（或远程实例）包装成桌面应用。

- 独立性：有自己的 `package.json` 与构建链，不参与 `web/` 的 Rsbuild 构建。
- 与后端配合方式：以 Electron 主进程管理子进程/远程连接，渲染层复用控制台页面（web 构建产物），属于"外壳 + 页面"模式。
- 具体打包与发布脚本以 `electron/package.json` 为准。

## 2. e2e 端到端测试（e2e/）

- 用途：对网关的对外 HTTP 契约做黑盒验证（登录、令牌、渠道、中继等关键链路）。
- 运行方式：需先有可用的后端实例（或测试环境配置），以 `e2e/` 目录内定义的用例与脚本为准执行。
- 与单元/回归测试的分工：`controller` / `service` / `relay` 内的 `*_test.go` 负责白盒回归（见 [13-runbook.md](13-runbook.md)），e2e 负责跨组件契约。

## 3. CI 与发布

- `.github/` 内为 issue/PR 模板与 workflows（构建、测试、镜像发布）。
- Docker 镜像：[Dockerfile](../../Dockerfile) 多阶段构建（前端构建 → Go 编译 → 运行镜像），`docker-compose.yml` 提供一键编排（含 SQLite/Redis 组合）。
- 前端 `scripts/` 下有格式保护（受保护头部注释）与版权检查脚本（`format-with-protected-headers.mjs`、`add-copyright.mjs`），发布前经 `bun run format:check` / `copyright:check` 校验。