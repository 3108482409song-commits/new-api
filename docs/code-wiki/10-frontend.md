# 10 前端（web/）

## 1. 技术栈

| 类别 | 技术 |
| --- | --- |
| 包管理 | Bun |
| 框架 | React 19 + TypeScript |
| 构建 | Rsbuild 2（`@rsbuild/plugin-react`、Tailwind、TanStack Router 插件），产物输出到 `web/dist` |
| 数据与请求 | @tanstack/react-query、axios、Zustand |
| 路由 | @tanstack/react-router（文件路由） |
| 表格与列表 | @tanstack/react-table、@tanstack/react-virtual |
| UI 与样式 | Base UI、Hugeicons、Tailwind CSS 4、clsx / class-variance-authority |
| 表单 | React Hook Form + Zod |
| 国际化 | i18next / react-i18next / i18next-browser-languagedetector |
| 图表 | @visactor/vchart、recharts |
| 测试 | Vitest + React Testing Library（可选）；lint/format 用 oxlint / oxfmt |

## 2. 构建与嵌入

- [rsbuild.config.ts](../../../web/rsbuild.config.ts)：入口 `src/main.tsx`，别名 `@ → src`，vendor 拆分（React / TanStack / UI primitives），产物到 `dist`。
- 后端通过 `//go:embed web/dist` 把**前端构建产物直接编译进 Go 二进制**（见 [main.go](../../../main.go#L43-L47)），单二进制即可提供控制台页面。

## 3. 目录结构（web/src/）

| 目录 | 职责 |
| --- | --- |
| `routes/` | TanStack Router 文件路由（`createFileRoute`）：`__root.tsx`、`route.tsx`；认证页（sign-in/sign-up/oauth/otp/forgot-password/reset）、错误页（401/403/404/500/503）、各功能页（chat `$chatId`/`$section` 等） |
| `features/<feature>/` | 功能模块（含 `components/`、`lib/`、`hooks/`、`api.ts`、`types.ts`、`constants.ts`） |
| `components/` | 通用组件（`ui/` 基础控件、`dialog`、`confirm-dialog`、`copy-button`、`data-table`、`empty-state` 等，198+ 个 tsx） |
| `stores/` | Zustand store：[auth-store.ts](../../../web/src/stores/auth-store.ts)、notification-store.ts、pricing-preferences-store.ts、system-config-store.ts |
| `hooks/` | 自定义 hooks（如 use-copy-to-clipboard） |
| `lib/` | 通用工具（axios `api` 实例、错误处理 `handleServerError`、request 封装） |
| `i18n/` | locale 文件与 `static-keys.ts`、同步脚本 |
| `styles/` | `index.css`、`theme.css`、`theme-presets.css`（Tailwind 4 主题与 CSS 变量） |
| `config/`、`context/`、`assets/` | 配置、React Context、静态资源 |

功能模块清单（features/）：about、auth、channels、chat、dashboard、errors、home、keys、legal、model-pricing、models、performance-metrics、playground、pricing、profile、rankings、redemption-codes、security、setup、subscriptions、system-info、system-settings、task-plugins、usage-logs、users、wallet。

## 4. 关键约定（摘自 web/AGENTS.md）

- **组件复用（强制）**：先检索 `src/components/` 与相关 `features/`，优先复用业务封装（如 `ConfirmDialog`、`CopyButton`、`DataTable`），再考虑 `ui/` 基础组件组合；新增替代实现必须说明能力缺口。
- **i18n**：组件内 `useTranslation()` 的 `t('key')`；翻译文件为扁平 JSON（en 为基准，key 为英文原文）；`bun run i18n:sync` 同步；支持语言：en、zh、zh-TW、fr、ru、ja、vi。
- **状态**：Zustand `create`，组件内用选择器订阅（`useAuthStore((s) => s.auth.user)`）；持久化读写 localStorage。
- **请求**：统一 `api` axios 实例（`withCredentials: true`、拦截器处理认证刷新与重试）；React Query 唯一 `queryKey`、`invalidateQueries`。
- **表单**：React Hook Form + Zod schema（`z.infer` 导出类型）。
- **路由**：`beforeLoad` 做认证与重定向；布局路由 + `_authenticated` 前缀；类型安全导航。
- **错误**：`handleServerError` 统一服务端错误提示；禁止把完整 axios 错误对象写入控制台。
- **测试**：模块专属 `__tests__/` 目录；行为断言优先；Bug 修复先写失败用例。
- **代码风格**：禁止 2 层以上嵌套三元；`bun run typecheck` 零错误、lint 零 error 是提交前提。

## 5. 脚本（package.json）

| 命令 | 用途 |
| --- | --- |
| `bun run dev` / `build` / `preview` | Rsbuild 开发/构建/预览 |
| `bun run typecheck` / `lint` / `lint:fix` | tsgo 类型检查 / oxlint |
| `bun run test` / `test:watch` | Vitest |
| `bun run i18n:sync` | i18n key 同步 |
| `bun run format` / `format:check` | oxfmt（保护头部注释） |
| `bun run knip` | 死代码检测 |

## 6. 与后端的协作

- 控制台页面调用 `/api/*` 管理接口；Playground 调用 `/pg/chat/completions`（带会话鉴权）。
- 用户自助接口（`/api/user/*`）由 `SetDashboardRouter` 提供（见 [03-router-middleware.md](03-router-middleware.md)）。
- 生产部署时前端构建由 CI/Docker 完成并嵌入二进制；开发时可 `bun run dev` 起 Rsbuild dev server 配合后端。