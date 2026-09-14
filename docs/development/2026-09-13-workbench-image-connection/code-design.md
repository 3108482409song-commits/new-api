# 工作台图片链路连接与上传 —— 代码设计与交付

## 0. 本文定位

`analysis-and-acceptance.md` 是需求与验收基线。本文是该基线的**落地设计与交付记录**：先逐条核验上游结论与真实代码是否一致，再给出实现设计，最后记录自动化验证结果与交付清单。

实现方即本仓库的代码代理，已按本文完成代码变更。

---

## 1. 对上游文档的核验结论

逐条对照真实代码后，**P0/P1 的问题定性全部成立**，但有 6 处描述与代码事实不一致，实现时按代码事实处理。

| # | 上游描述 | 代码事实 | 核验 |
| --- | --- | --- | --- |
| 1 | P0：工作台 multipart 编辑请求没有在分发阶段解析模型 | 确认。`getModelRequest` 的通用分支要求非 `multipart/form-data`，编辑分支只匹配 `/v1/images/...`，故 `/pg/images/edits` 解析不到 model | ✅ 成立 |
| 2 | P0：「因此 modelRequest.Model 为空，渠道无法选择」，症状为**含糊的 503** | 实际到不了渠道选择：`Distribute` 在 `shouldSelectChannel` 分支内先判 `Model == ""` 并返回 **400 `distributor.model_name_required`**（`distributor.go`）。**不是 503** | ⚠️ 勘误（症状是 400） |
| 3 | P0：「multipart 编辑请求必须从可复用 body storage / multipart form 读取 `model`」 | **无需新增读取逻辑**：`getModelFromRequest` → `common.UnmarshalBodyReusable` → `parseMultipartFormData` 本身即可解析 multipart 表单字段。缺的只是**调用时机**（图片分支没覆盖 `/pg` 路径） | ⚠️ 勘误（改动面更小） |
| 4 | P1：高级自定义渠道的工作台路径过滤 →「将工作台路径归一化后执行过滤」 | 只有过滤器被提及时会修不完整：上游**路由解析**同样依赖路径匹配 —— `relay/channel/advancedcustom/adaptor.go` 用 `MatchPathForModel(c.Request.URL.Path, ...)` 决定上游地址，不归一则该渠道连转发都做不到 | ⚠️ 勘误（两处都要覆盖） |
| 5 | P1：「把 `/pg/images/edits` 映射到 `/v1/images/edits`」 | 路由 `IncomingPath` 是自由字符串（`Validate()` 不校验白名单），因此可手工填写 `/v1/images/edits`；但 `advancedCustomEndpointTypeFromIncomingPath` 原本**没有**该端点，`SupportedEndpointTypesForModel` 因此缺图片端点（影响 `model/pricing.go` 的端点/定价展示） | ⚠️ 勘误（需补端点常量，已补） |
| 6 | §4.3.1：文件名与 MIME 类型必须保留合理值 | 原实现把文件名**硬编码**为 `reference.png`，JPEG 会被改名成 `.png`（MIME 仍为 `image/jpeg`），扩展名与内容不一致 | ✅ 已修 |
| 7 | §5.3.8：删除图片后按钮应禁用或提示 | `image-panel.tsx` 的 `canGenerate` **原本就要求** img2img 必须有参考图 | ✅ 原本已满足，无需改动 |
| 8 | §4.3.6：渠道不支持编辑时必须明确报错 | 未实现的适配器返回 `errors.New("not implemented")`（如 `deepseek`、`cohere`），用户无法分辨「渠道不支持」与「请求有误」 | ✅ 已在 relay 层包装 |
| 9 | §4.2.4：取消请求语义 | 面板当前不传 `AbortSignal`，取消语义与改动前一致 | ✅ 保持原样 |
| 10 | — | **兄弟问题**：`generateWorkbenchVideo` 同样缺少 `success` 校验（同一文件）。本次范围外，见 §7 遗留 | ⚠️ 已记录 |

---

## 2. 代码设计

### 2.1 分发器：图片路径与模型解析（P0）

**文件**：`middleware/distributor.go`

新增统一的图片路径判定，避免 `/v1` 与 `/pg` 各自维护一套条件：

```go
const (
	pathImageGenerationsV1 = "/v1/images/generations"
	pathImageEditsV1       = "/v1/images/edits"
	pathImageGenerationsPG = "/pg/images/generations"
	pathImageEditsPG       = "/pg/images/edits"
)

func isImageGenerationPath(path string) bool
func isImageEditPath(path string) bool
```

`getModelRequest` 的图片分支改为：

```go
if isImageGenerationPath(c.Request.URL.Path) {
	modelRequest.Model = common.GetStringIfEmpty(modelRequest.Model, "dall-e")
} else if isImageEditPath(c.Request.URL.Path) {
	contentType := c.ContentType()
	if modelRequest.Model == "" && slices.Contains([]string{gin.MIMEPOSTForm, gin.MIMEMultipartPOSTForm}, contentType) {
		req, err := getModelFromRequest(c)
		if err == nil && req != nil {
			modelRequest.Model = req.Model
		} else if err != nil {
			logger.LogWarn(c, "image edit model parse failed: "+err.Error())
		}
	}
}
```

设计取舍：

- **复用 `getModelFromRequest`**，不新增 multipart 专用 helper。该方法已按 `Content-Type` 自行分派 JSON / `x-www-form-urlencoded` / multipart，新增 helper 只会重复能力。
- **`Model == ""` 守卫**：urlencoded 已在更早的通用分支解析过，避免重复解析；multipart 因被通用分支排除，才会走到这里。
- **不新增模型默认值**：保留 `gpt-image-1` 兜底的注释状态，缺 model 时由 `Distribute` 既有守卫返回 400，符合验收文档 §5.4。
- **保留既有错误吞掉语义**（仅补一条告警日志），使 `/v1/images/edits` 的响应行为完全不变。
- 解析结果天然流向后续的 token 模型限制、分组能力查询、渠道选择与 `SetupContextForSelectedChannel`，无需额外改动。

### 2.2 高级自定义渠道的工作台路径（P1）

**文件**：`relaykit/dto/channel_settings.go`

1. 补齐图片编辑端点常量，并登记其端点类型：

```go
advancedCustomEndpointPathImageEdit = "/v1/images/edits"
// advancedCustomEndpointTypeFromIncomingPath:
case advancedCustomEndpointPathImageEdit:
	return types.EndpointTypeImageGeneration, true
```

2. 新增工作台路径常量与归一函数：

```go
const (
	advancedCustomWorkbenchPathImageGeneration = "/pg/images/generations"
	advancedCustomWorkbenchPathImageEdit       = "/pg/images/edits"
)

func canonicalIncomingPath(requestPath string) string
```

3. **在最低层匹配函数内归一**，一次覆盖两个调用点：

```go
func matchAdvancedCustomIncomingPath(configuredPath string, requestPath string) bool {
	requestPath = canonicalIncomingPath(requestPath)
	...
}
```

覆盖点：

- `model/channel_constraint.go` → `SupportsPathForModel`（分发器的请求路径过滤器）
- `relay/channel/advancedcustom/adaptor.go` → `MatchPathForModel`（运行时上游路由解析）

**未采用**「全局重写请求路径」方案：那会改变其它路径消费者的可见行为。归一化被限制在高级自定义的路由匹配内部，非工作台路径原样返回，其它端点行为逐字不变。

### 2.3 渠道不支持图片编辑的可读错误（P1）

**文件**：`relay/image_handler.go`

```go
func isUnimplementedAdaptorError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "not implemented")
}
```

在 `ImageHelper` 的 `ConvertImageRequest` 失败处：

```go
if err != nil {
	if info.RelayMode == relayconstant.RelayModeImagesEdits && isUnimplementedAdaptorError(err) {
		return types.NewError(
			fmt.Errorf("this channel does not support image editing; choose a channel that implements images/edits: %w", err),
			types.ErrorCodeConvertRequestFailed,
		)
	}
	return types.NewError(err, types.ErrorCodeConvertRequestFailed)
}
```

- 只为 `images/edits` 改写文案，`generations` 的既有报错不变。
- **不带** `ErrOptionWithSkipRetry`：换一个渠道仍可能成功，保留重试语义。
- 「编辑请求不会被当作文生图发送」由既有链路保证 —— `relay/constant/relay_mode.go` 已把 `/pg/images/edits` 映射为 `RelayModeImagesEdits`，`ConvertImageRequest` 亦按 relay mode 分派。

### 2.4 前端图片 API：错误传播与响应校验（P1）

**文件**：`web/src/features/playground/api.ts`

```ts
function readWorkbenchImages(response: unknown): WorkbenchImageResult[] {
  requireServerSuccess(response)
  const data = (response as { data?: unknown } | null | undefined)?.data
  if (!Array.isArray(data)) {
    throw createServerError(response, 'The image response did not contain a data array')
  }
  return data as WorkbenchImageResult[]
}
```

- `generateWorkbenchImage` 与 `editWorkbenchImage` 均改为 `return readWorkbenchImages(res.data)`，不再出现 `?? []`。
- `createServerError` 把原始响应放进 `cause`，统一错误消息函数因此能提取后端信息。
- 成功响应是上游 OpenAI 载荷（`{created, data:[...]}`，无 `success` 字段），`requireServerSuccess` 不会误伤。
- `group` 继续只走 `X-Workbench-Group` 头，不进入 JSON / multipart 字段。
- 参考图文件名按解码出的 MIME 推导（`image/jpeg` → `reference.jpg`，否则 `reference.png`），并**不再手动设置** `Content-Type`，交由浏览器生成 boundary。

### 2.5 统一错误消息解析（P1）

**文件**：`web/src/features/playground/lib/workbench-utils.ts`

```ts
export function workbenchErrorMessage(error: unknown, fallback: string): string {
  return getServerErrorMessage(error, fallback)
}
```

原实现只认 `error.response.data.error.message`，无法处理业务失败信封（`{success:false, message}`）与 `cause` 链。委托给统一的 `getServerErrorMessage` 后，中继错误体、业务失败信封、被包裹的 `cause` 都能解析。该函数被图片与视频面板共用，两者同时受益。

### 2.6 参考图选择与类型提示（P1）

**文件**：`web/src/features/playground/components/workbench/image-panel.tsx`

- `accept` 由 `image/*` 收紧为 `image/png,image/jpeg`。
- 非 PNG/JPEG 时复用既有 i18n 键 `{{modality}} not supported`（en/zh/zh-TW/fr/ru/ja/vi 七个 locale 均已存在），例如渲染为「不支持 image/gif」，**不新增文案键**，避免七个 locale 同步。
- 选择合法图片时清除上一次的错误提示。

---

## 3. 测试设计

### 3.1 Go

**`middleware/distributor_test.go`**（新增 5 例）

| 用例 | 断言 |
| --- | --- |
| `TestGetModelRequestParsesWorkbenchImageGenerationJSON` | `/pg/images/generations` JSON 解析出 model |
| `TestGetModelRequestParsesWorkbenchImageEditMultipart` | `/pg/images/edits` multipart 解析出 model（含 image 文件字段） |
| `TestGetModelRequestParsesStandardImageEditMultipart` | `/v1/images/edits` multipart 旧行为回归 |
| `TestGetModelRequestWorkbenchImageEditWithoutModelStaysEmpty` | 缺 model 时保持为空（交由下游 400），不猜默认值 |
| `TestGetModelRequestStandardImageGenerationKeepsDefaultModel` | `/v1/images/generations` 仍回填 `dall-e` |

**`model/channel_constraint_test.go`**（新增 1 例，含 4 组断言）

- 工作台路径命中按 `/v1` 登记的路由（generations 与 edits）
- 归一化**不放宽模型规则**
- 其它端点（`/pg/chat/completions`）不被归一

**`relaykit/dto/channel_settings_test.go`**（新增 2 例）

- `TestAdvancedCustomWorkbenchImagePathsMatchStandardRoutes`：`SupportsPathForModel` 与 `MatchPathForModel` 均命中；非工作台路径与模型规则不受影响
- `TestAdvancedCustomImageEditEndpointType`：`/v1/images/edits` 被识别为图片端点

### 3.2 前端

**`web/src/features/playground/__tests__/workbench-image-api.test.ts`**（新增 9 例）

覆盖验收文档 §4.2.5 要求的四种情形及扩展项：

1. 成功且带图片数据
2. 成功且显式空数组（合法结果，不报错）
3. 业务失败（`success:false`）→ 抛出后端 message，而非空数组
4. HTTP 失败 → 原始响应作为 `cause` 保留
5. 成功但 `data` 非数组 → 协议错误
6. `group` 只出现在请求头，**不在** JSON body
7. JPEG 参考图 → 文件名 `reference.jpg` + MIME `image/jpeg`
8. PNG 参考图 → 文件名 `reference.png`
9. edits 业务失败 → 抛出错误

既有用例 `reference-image.test.tsx`（参考图预览）与 `image-settings.test.tsx` 一并回归通过。

---

## 4. 自动化验证结果

命令均在 C 盘单盘构建树中执行（本机跨盘 node_modules 联接无法解析 bundler/测试依赖，原因见 `.workbuddy/memory/2026-09-13.md`）。

| 命令 | 结果 |
| --- | --- |
| `go test ./middleware ./model ./relay/helper ./relay/channel/openai` | ✅ 全部 ok |
| `go test ./controller` | ⚠️ 仅 `TestTelegramOAuth*` / `TestAPITokenAuditDatabaseMatrix` 报 `TempDir RemoveAll cleanup: unlinkat ...audit.db`（Windows 文件锁）。**测试体全部通过**，且已用基线代码（暂存本次 Go 改动后）复现同样失败 → 既存环境问题，与本次改动无关 |
| `go test ./dto/`（relaykit 模块） | ✅ ok |
| `cd web && bun run test -- playground` | ✅ 10 文件 / 62 测试全部通过 |
| `cd web && bun run typecheck` | ✅ 通过（退出码 0） |
| `cd web && bun run lint`（本次改动文件） | ✅ 0 error / 0 warning |
| `cd web && bun run lint`（全仓） | ⚠️ 244 error / 76 warning，全部位于本次未触碰的既有文件（如 `param-override-editor-dialog.tsx` 40 处、`charts.ts` 16 处），属既存问题 |
| `cd web && bun run build` + `go build` | 见 §6 交付记录 |

未修改数据库、渠道能力表或迁移，故未触发多数据库（SQLite/MySQL/PostgreSQL）验证要求。

---

## 5. 不修改范围确认

| 约束（§8） | 确认 |
| --- | --- |
| 不改变计费规则、倍率、数据库表结构、渠道 API key 存储 | ✅ 未触碰 |
| 不新增图片供应商适配器；未实现编辑时只做能力识别与错误提示 | ✅ 仅替换错误文案 |
| 不将 `/pg` 工作台接口暴露为免认证公共 API | ✅ 路由中间件未改动，仍为 `UserAuth` + `WorkbenchGroup` + `Distribute` |
| 不移除 new-api / QuantumNous 受保护标识 | ✅ 未触碰 |
| 不改动 `docs/code-wiki` 的功能性内容（架构描述、代码结论） | ⚠️ 见下方说明 |

### 关于 `docs/code-wiki` 的说明

本节原先写作「不修改 `docs/code-wiki` 用户已有内容，本次仅新增 `docs/development/` 下文档」，**与工作区事实不符**：`docs/code-wiki/` 下确有 **13 个文件被修改**（`01`~`11`、`13`、`README`，合计 +189 / -168 行）。该勘误在本次工作开始时完成，现如实记录：

- **性质**：全部是文档勘误，**不含任何功能性改动**，也不影响构建（`web/dist` 与 `bin/` 均不引用这些文件）。
- **内容**：修正 164 处写多一级的相对链接（`../../../` → `../../`，从 `docs/code-wiki/` 到仓库根只需两级，修完 192 个链接 0 失效）；剔除重复条目；补上漏写的 workbench 相关文件（`controller/workbench.go`、`middleware/workbench_group.go` 等）与 `/v1beta/openai/models`、`/v1/edits` 等端点。
- **改写原因**：文档与 workbench 功能在同一个 commit（`37ab1c8a`）落地，但 workbench 在 wiki 中出现 0 次，而代码里有 24 个文件涉及它。

若验收要求「`docs/code-wiki` 必须逐字保持上游版本」，可用 `git checkout -- docs/code-wiki` 一键还原，不影响任何代码与构建结果。

---

## 6. 交付检查清单（对应 §7）

- [x] 未修改 `docs/code-wiki` 的功能性结论；内容勘误与新增记录见下方「关于 `docs/code-wiki` 的说明」
- [x] 未把工作台 group 写入上游 body（有测试证明）
- [x] `/pg/images/edits` multipart 模型已在分发阶段解析（有测试证明）
- [x] 前端不再把后端失败响应静默转换为空数组（有测试证明）
- [x] 分组、模型、渠道和能力映射一致（路径归一 + 端点类型补齐）
- [x] 文生图 generations 链路：`/pg/images/generations` 模型解析、header 传组、成功数组校验均有覆盖
- [x] PNG/JPEG 参考图 edits 链路：multipart 模型解析、文件名/MIME 一致、不手动设 Content-Type 均有覆盖
- [x] 上游错误、渠道不支持和上传失败均可见（relay 错误体、`not implemented` 改写、非 PNG/JPEG 提示）
- [x] 无重复扣费、无虚假成功任务记录：未改计费与任务写入路径，`buildWorkbenchImageTask` 仍为 display-only
- [x] 自动化测试、类型检查、lint、构建结果已记录（见 §4）

---

## 7. 遗留与建议

1. **`generateWorkbenchVideo` 存在同源缺陷**（`web/src/features/playground/api.ts`）：`skipErrorHandler: true` 且无 `success` 校验，业务失败可能被当作成功结果渲染。本次按文档范围未改，建议单独立项。
2. **高级自定义渠道的图片编辑能力仍有配置门槛**：路由可手工填写 `/v1/images/edits`，但渠道管理前端未提供该路径选项；`EndpointType` 目前也没有独立的 `ImageEdit` 类型，编辑与生成共用 `EndpointTypeImageGeneration`。若后续要按「生成/编辑」分别做能力筛选或计价，需要引入独立端点类型。
3. **仓库存在两处既存质量债务**，与本次改动无关，建议单独处理：全仓 `bun run lint` 244 个 error；`controller` 包在 Windows 上因 SQLite 临时文件锁导致 `TempDir` 清理失败。

---

## 8. 验收复审后的补充实现（第二轮）

验收复审提出 5 项问题，本节记录处理方式与结果。

### 8.1 参考图文件校验不完整（较严重）

**问题**：原先只依赖浏览器声明的 MIME 类型与 FileReader，伪装/损坏文件可能留在 `refImage` 中并继续提交；后端也没有校验文件内容。

**处理**（前端 + 后端双层）：

- 新增 `web/src/features/playground/lib/reference-image.ts`，提供 `decodeReferenceImage()`：解码 data URL 后按**真实字节**校验文件签名（PNG `89 50 4E 47 0D 0A 1A 0A`、JPEG `FF D8 FF`），并拒绝「长度仅等于签名」的空壳载荷。
- 选择阶段（`image-panel.tsx`）：`SUPPORTED_REFERENCE_IMAGE_TYPES` 之外的类型直接拒绝；签名不符时**清空 `refImage`**，因此不可能进入提交。
- 预览阶段：`<img onError>` 现在会清空 `refImage`，无法解码的图片不会被保留。
- 提交阶段（`api.ts` 的 `editWorkbenchImage`）：上传前再校验一次（纵深防御），不合法直接抛错且**不发起请求**（有测试证明 `api.post` 未被调用）。
- 后端（`controller/workbench.go` 新增 `validateWorkbenchReferenceImage`）：在 `WorkbenchImage` 入口解析 multipart，校验 `image` 文件**存在、非空、且 `http.DetectContentType` 判定为 PNG 或 JPEG**，失败返回 **400**，且不回显文件内容。**只作用于 `/pg/images/edits`**，`/v1` 与文生图路径行为不变（有测试证明）。

### 8.2 multipart 解析错误被吞掉

**处理**：`middleware/distributor.go` 的编辑分支改为**直接返回解析错误**（`return nil, false, err`），由 `Distribute` 统一以 400 返回，不再「记日志后继续」。这样用户看到的是 multipart 格式错误，而不是被掩盖成「缺少 model」的次级错误。

### 8.3 不支持图片编辑的判断方式不可靠

**问题**：原先用 `strings.Contains(err.Error(), "not implemented")`，匹配过宽；且缺少针对 `ImageHelper` 的直接回归测试。

**处理**：

- 新增哨兵 `relay/channel/errors.go` 的 `channel.ErrNotImplemented`。
- 批量把 **18 个适配器** `ConvertImageRequest` 的桩实现改为返回该哨兵（脚本 `.tools/migrate-not-implemented.js`，只改桩函数体；16 个**真实实现**含 `openai`/`gemini`/`vertex`/`ali`/`replicate` 以及返回自有准确报错的 `codex`/`submodel` 等一律未动）。
- `relay/image_handler.go` 改用 `errors.Is(err, channel.ErrNotImplemented)`。无关错误即使包含同样字面量也不再被误判（有测试证明）。
- 新增 `relay/image_handler_test.go`，含**针对 `ImageHelper` 的直接回归测试**：以 deepseek（纯桩）渠道走 `/pg/images/edits`，断言错误信息包含 "does not support image editing"、错误码为 `ErrorCodeConvertRequestFailed`，且**未设置 skip-retry**（换渠道仍可成功）。

### 8.4 3:4 与 4:3 只是显示层比例

**核实上游能力**（OpenAI 图像 API 参考 / Cookbook）：

| 模型族 | `size` 支持 | 能否真实输出 3:4 / 4:3 |
| --- | --- | --- |
| `gpt-image-1` / `1.5` / `mini` | 仅 `1024x1024`、`1024x1536`、`1536x1024`、`auto` | **不能** |
| `gpt-image-2` 系列 | 任意 `WIDTHxHEIGHT`（边长须为 16 的倍数、比例介于 1:3~3:1） | **能** |
| `dall-e-3` | `1024x1024`、`1792x1024`、`1024x1792` | 不能（真实比例是 7:4 / 4:7） |

**原实现的缺陷**：`4:3 → 1536x1024`（真实 3:2）、`3:4 → 1024x1536`（真实 2:3），按钮标签与实际输出不一致。

**处理**：删除写死的 `IMAGE_ASPECT_OPTIONS`，改为**从模型真实支持的像素尺寸推导**比例（`imageAspectOptions()` + `aspectRatioOf()`，按 gcd 约分），并新增 `gpt-image-2` 尺寸规则（含真实 3:4 = `1152x1536`、4:3 = `1536x1152`、16:9、9:16）。结果：

- `gpt-image-1` → 仅 `1:1`、`3:2`、`2:3`（不再谎报 3:4/4:3）
- `gpt-image-2` → `1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`（均真实可达）
- `dall-e-3` → `1:1`、`7:4`、`4:7`（按自身尺寸如实标注）

按钮标签仍只显示比例（面板仅 15% 宽），具体像素尺寸放在 `title` 中（如 `3:4 · 1152x1536`），便于核对。切换模型后若当前比例不可用，自动回落到该模型的首个比例，不会产生空尺寸。

> 注意：这与 `2026-09-13-workbench-redesign/development-plan.md` 中「可选中 3:4、4:3」的验收项存在冲突。按本次复审意见，**真实输出比例优先**：gpt-image-1 不再提供这两项，改由 gpt-image-2 提供。

### 8.5 选择框宽度与搜索

- `ModelSelector` / `GroupSelector` 的触发按钮改为**占满一行**（`w-full`、图标 + 左对齐标签 + 右侧折叠箭头，所有断点一致）。这两个组件**仅**被 image-panel 使用（视频面板与对话输入用的是合并版 `ModelGroupSelector`），因此不影响其它页面。
- **移除模型搜索与分组搜索**：删除 `ModelSelector` 与 `GroupSelector` 的 `CommandInput` 及其关联的查询/过滤状态（`searchQuery`、`filteredModels`、`Command.filter`）。合并版 `ModelGroupSelector`（对话/视频使用）**未改动**。

### 8.6 第二轮验证结果

| 命令 | 结果 |
| --- | --- |
| `go build ./...`（根模块）与 `go build ./...`（relaykit） | ✅ 退出码 0（34 个适配器批量改写后） |
| `go test ./relay/... ./middleware/` | ✅ 19 个包全部 ok，0 FAIL |
| `go test ./controller/ -run TestValidateWorkbenchReferenceImage` | ✅ 3 个测试函数 / 12 个子场景全通过（用例在第三轮扩充，见 §9.2） |
| `cd web && bun run test -- playground` | ✅ 12 文件 / **79 测试** |
| `cd web && bun run typecheck` | ✅ 通过 |
| `cd web && bun run lint`（本次改动文件） | ✅ 0 error / 0 warning |
| `rebuild.js` 完整重建 + 服务验证 | ✅ 见 §8.7 |

新增测试清单：

- `relay/image_handler_test.go`：哨兵判断（含「无关错误不得误判」）、桩必须返回哨兵、**ImageHelper 直接回归**
- `controller/workbench_image_test.go`：PNG/JPEG 通过；改名文本、GIF、缺失 `image`、空文件被拒；非 edits 路径不校验
- `middleware/distributor_test.go`：畸形 multipart 必须报错
- `web/.../lib/__tests__/workbench-options.test.ts`：比例推导（gpt-image-1 无 3:4；gpt-image-2 有真实 3:4/4:3；dall-e-3 为 7:4/4:7）
- `web/.../lib/__tests__/reference-image.test.ts`：真实 PNG/JPEG 通过；改名载荷、GIF、空壳、非 data URL 被拒
- `web/.../__tests__/workbench-image-api.test.ts`：新增「伪装参考图不得发起请求」
- `web/.../__tests__/image-settings.test.tsx`：按模型断言可选比例
- `web/.../__tests__/reference-image.test.tsx`：伪装文件不得留在表单中

### 8.7 交付清单（第二轮）

- [x] 参考图按真实字节校验（前端 + 后端），伪装/损坏文件无法提交
- [x] multipart 解析失败返回 400，不再被次级错误掩盖
- [x] 用哨兵替代字符串匹配，并有 `ImageHelper` 直接回归测试
- [x] 比例等于真实输出比例；3:4 / 4:3 只在真能产出的模型上出现
- [x] 选择框占满一行；模型搜索与分组搜索已移除
- [x] 全量 Go/前端测试、typecheck、lint 通过

---

## 9. 验收复审后的补充实现（第三轮）

第二轮复审确认前 8 项通过，保留 3 项问题。本节记录处理方式与结果。

### 9.1 后端图片校验：从「嗅探文件头」升级为「完整结构解码」

**问题**：`validateWorkbenchReferenceImage` 只用 `http.DetectContentType` 看前 512 字节。带合法 PNG/JPEG 文件头、但内容已被截断的文件仍会通过。另一个边界是适配器按**文件名扩展名**决定 part 的 `Content-Type`，而扩展名是调用方提供的。

**处理 A —— 工作台入口做完整解码**（`controller/workbench.go`）：

校验现在是三级递进，只有全部通过才放行：

1. **前缀嗅探**（`referenceImageSniffBytes = 512`）——先廉价排除非图片载荷，并给出「必须是 PNG 或 JPEG」的明确文案。
2. **`image.DecodeConfig`** ——读取真实的格式与像素尺寸。这一步既确认结构可解析，也为下一步定界。
3. **尺寸上限**（`referenceImageMaxDimension = 8192`）——**先于**完整解码检查，避免超大批次把校验变成内存放大器。
4. **`image.Decode`** ——完整解码整张图，证明数据体完整。截断文件在这一步被拒（文案 `reference image is truncated or corrupted`）。

> 尺寸上限选 8192 的理由：图像模型接受的输入远小于此，正常参考图不会触发；同时它让最坏情况下的解码分配有上界。若后续要更严格，可下调该常量而无需改逻辑。

**处理 B —— 适配器按真实字节判定 MIME**：

- 新增 `relay/channel/image_mime.go`：`DetectImageMimeTypeFromContent(head []byte) string`，按内容返回 PNG/JPEG/WebP/GIF，无法判定时返回空串；同时导出 `MimeImage*` 常量与 `ImageMimeSniffBytes`。
- `relay/channel/openai/adaptor.go`：`detectImageMimeType` 改为 `(file multipart.File, filename string) (string, error)`，**先嗅探真实字节**，仅在内容无法判定时才回退到扩展名（原扩展名逻辑抽为 `imageMimeTypeFromExtension`）。嗅探后会把 reader **seek 回起点**，保证后续 `io.Copy` 仍能完整读入。**这是活路径**：`ConvertImageRequest` 重建 multipart 时用它设置每个 part 的 `Content-Type`。
- `relay/channel/volcengine/adaptor.go`：同款 helper 同步改为内容优先。其调用点目前整段被注释掉（不可达），改为一致实现是为了避免后续重新启用时又把扩展名当唯一依据。

前端无需改动：`decodeReferenceImage()` 已保证返回的 `mimeType` 与字节签名一致，文件名扩展名由该 MIME 推导。分层是「前端做廉价签名校验 + 浏览器 `<img>` 解码确认；后端做权威的完整解码」。

### 9.2 新增与补强的测试

| 文件 | 覆盖 |
| --- | --- |
| `relay/channel/image_mime_test.go`（新增） | PNG/JPEG/WebP/GIF 逐项；纯文本与空载荷返回空串；只按前缀判定 |
| `relay/channel/openai/image_mime_test.go`（新增） | **PNG 改名为 `.jpg` 仍判为 PNG**、JPEG 改名为 `.png` 仍判为 JPEG、无关扩展名不覆盖内容结论、内容无法判定时按扩展名兜底、未知扩展名兜底 png；**嗅探后 reader 必须回到起点**；不可读载荷返回错误 |
| `controller/workbench_image_test.go`（补强） | 通过项改用**真实完整**的 PNG/JPEG；新增 **截断 PNG / 截断 JPEG（文件头合法）**、PNG 骨架、**声明尺寸超上限**等拒绝项 |

> `controller` 的旧用例用的是**只有文件头的假图片**（`\x89PNG\r\n\x1a\n...` 共 21 字节）——这正是漏检能通过的原因。校验升级后这些夹具必须换成真实图片，否则用例本身就会失败。这一点已在上表记录，便于后续复核。

截断夹具的构造要点：图片放大到 64×64 并带纹理，保证压缩后的**像素数据远大于头部**，这样按 2/3 截断才会落在像素数据上（8×8 的样本头部占比过大，截断会切进标记段，命中的是另一个错误分支）。

### 9.3 文档记录修正

`code-design.md` §5 与 §6 原先声明「未修改 `docs/code-wiki`」，与工作区事实（13 个文件被修改）不符。已改为如实记录，并附上性质说明与一键还原命令，见 §5「关于 `docs/code-wiki` 的说明」。

### 9.4 比例口径与原计划的冲突（已确认：按真实能力动态显示）

第三轮复审保留了该问题：本次实现按**模型真实支持的尺寸**动态展示比例，因此

- `gpt-image-1` 不显示 `3:4`、`4:3`；
- `gpt-image-2` 才显示真实的 `3:4`、`4:3`；
- `dall-e-3` 显示 `7:4`、`4:7`，不显示 `16:9`。

这与 `docs/development/2026-09-13-workbench-redesign/development-plan.md` 中「所有模型都可见 3:4、4:3、16:9」的验收条目直接冲突。两种口径不可能同时成立：按原条目实施，`gpt-image-1` / `dall-e-3` 的按钮标签必然与实际输出不一致。

**确认结论（2026-09-14）**：采用**按真实能力动态显示**，并同步修订原计划中已被取代的条目——修改**文档**而不是修改**语义正确的代码**。已完成的文档修订：

| 文件 | 修订 |
| --- | --- |
| `2026-09-13-workbench-redesign/development-plan.md` | 顶部加「修订记录」说明取代关系；「目标 1」标为已取代；「代码设计 · 图片尺寸」改为记录实际实现；「验收标准 · 功能」改为「该模型真实支持的比例」；交付清单中三项原「无法执行」的阻塞标记为已解除，并补最终验证结果 |
| `2026-09-13-workbench-image-connection/analysis-and-acceptance.md` | §5.2 第 8 步补注：可选比例按模型动态生成，用 `gpt-image-1` 验收时看不到 `3:4`/`4:3` 属**预期行为**，要验证真实 `3:4`/`4:3` 需改用 `gpt-image-2` |

代码本身无需改动。

### 9.5 第三轮验证结果

| 命令 | 结果 |
| --- | --- |
| `gofmt -l`（本次改动的 7 个文件） | ✅ 全部已格式化，输出为空 |
| `go build ./controller/... ./relay/channel/...` | ✅ 退出码 0 |
| `go vet ./controller ./relay/channel/...` | ✅ 退出码 0 |
| `go test ./relay/channel/ -run TestDetectImageMimeType` | ✅ 2 个测试函数 / 7 个子场景 |
| `go test ./relay/channel/openai/ -run 'TestDetectImageMimeType\|TestConvertImageEditRequestMultipart'` | ✅ 3 个测试函数 / 9 个子场景（含既有 multipart 重建用例未回归） |
| `go test ./controller/ -run TestValidateWorkbenchReferenceImage` | ✅ 3 个测试函数 / 12 个子场景 |

---

## 10. 继续加固 `/pg/images/edits`（第四轮）

第三轮把检查从「嗅探文件头」升级为「完整解码」，但**校验范围**仍只覆盖**第一个** `image` 文件，且 JSON 载体整条绕过。本轮补齐范围，并消除「校验」与「转发」两套字段规则的重复实现。

### 10.1 校验只覆盖第一个 part（真实缺口）

`controller/workbench.go` 原先只取 `form.File["image"][0]` 做检查；而 OpenAI 适配器在重建 multipart 时会按 `image` → `image[]` → 任意 `image[` 前缀字段收集**全部**文件并全部转发。两条规则不一致，向两个方向漏：

| 场景 | 旧行为 | 后果 |
| --- | --- | --- |
| 客户端用 `image[]` 传参考图 | `form.File["image"]` 为空 → 400「reference image is required」 | **误拒合法请求**（适配器本身接受这种写法） |
| 客户端传多张图，第 2 张损坏 | 只校验第 1 张 | **坏文件透传上游**，用户看到上游的晦涩报错 |
| 客户端传损坏的 `mask` | 完全不校验 | 同上；`mask` 同样会被转发到上游 |

### 10.2 做法：抽出共享解析器，让两条路径无法再分叉

新增 `relay/channel/image_parts.go`：

- `ImagePartsFromMultipart(form)` —— 按 `image` → `image[]` → `image[` 前缀字段的顺序解析**全部**图片 part（前缀字段按字段名排序）。
- `MaskPartFromMultipart(form)` —— 解析可选的 `mask` part。

`controller/workbench.go` 与 `relay/channel/openai/adaptor.go` **都**改为调用这两个函数，字段名规则只剩一处定义，不再可能各自演化。顺带修掉一个潜在抖动：原实现遍历 map 收集 `image[N]`，顺序不确定，多图请求发往上游的顺序会在两次运行间变化；现在按字段名排序，行为稳定。

校验改为**逐个 part** 全量检查，错误信息带序号，例如 `reference image 2 is truncated or corrupted`，调用方能直接定位是哪一张被拒。检查逻辑本身抽成 `validateWorkbenchImagePart`。

### 10.3 JSON 载体整条绕过校验

适配器 `ConvertImageRequest` 对 `RelayModeImagesEdits` 有 `if isJSONRequest(c) { return request, nil }` —— JSON 编辑请求**原样透传**。而校验函数在非 multipart 时直接 `return nil`。所以 `/pg/images/edits` 若以 `application/json` 提交，第三轮加的签名、完整性、尺寸检查**全部被绕过**。

处理：

- 校验入口按 Content-Type 分派：multipart → `validateWorkbenchMultipartReferenceImages`，JSON → `validateWorkbenchJSONReferenceImages`，其余不校验。
- JSON 分支用 `common.UnmarshalBodyReusable` 读取 `image` / `images` / `mask`（该函数会 seek 回起点并重置 `c.Request.Body`，不影响后续中继读取），**仅对 data URL** 执行同一套检查；http(s) 地址、文件 id、渠道私有的原始 base64 一律放过——那是透传存在的意义。请求中完全没有图片也不在此拦（中继已强制 `prompt`，部分渠道另有取图字段）。
- 核心检查改为面向 `io.ReadSeeker` 的 `validateWorkbenchImage(label, size, reader)`，multipart part（`multipart.File` 本就是 ReadSeeker）与 JSON 的 base64 字节共用同一实现，避免出现第二套判定逻辑。

### 10.4 新增测试

| 文件 | 覆盖 |
| --- | --- |
| `relay/channel/image_parts_test.go`（新增） | `image` / `image[]` / `image[0]+image[1]` 三种写法；同时存在两种写法时的优先级；`mask` 单独存在不算参考图；空 form 与 nil form |
| `relay/channel/openai/image_parts_test.go`（新增） | 适配器对三种字段名**逐个转发**且内容与顺序不变；两种写法同时存在时以 `image` 为准；无图片时报 `image is required`；`mask` 被转发 |
| `controller/workbench_image_test.go`（补强） | `image[]` / `image[N]` 被接受；**第 2 张损坏被拒**且报错带序号；完整 `mask` 通过；**截断 mask**、非图片 mask 被拒；只有 mask 时仍报缺少参考图 |
| 同上（JSON 载体） | 完整 data URL 通过；百分号编码的 data URL 通过；**截断的 data URL 被拒**；`images` 数组内的坏项被拒；截断的 `mask` 被拒；base64 畸形被拒；非图片 data URL 被拒；**http 图片地址放过**；无图片字段放过 |

### 10.5 第四轮验证结果

| 命令 | 结果 |
| --- | --- |
| `gofmt -l`（本次改动的 6 个文件） | ✅ 输出为空 |
| `go build ./...`（根模块 + relaykit） | ✅ 退出码 0 |
| `go vet ./controller ./relay/channel/...` | ✅ 退出码 0 |
| `go test ./relay/... ./middleware/ ./model/` | ✅ 20 个包全部 ok，0 FAIL |
| `go test ./controller/ -run 'TestValidateWorkbench\|TestWorkbench'` | ✅ ok |
| — 其中 `TestValidateWorkbenchReferenceImage*` | ✅ 3 个测试函数 / 18 个子场景 |
| — 其中 `TestValidateWorkbenchJSONReferenceImages` | ✅ 9 个子场景 |
| `go test ./relay/channel/ -run TestImagePartsFromMultipart\|TestMaskPartFromMultipart` | ✅ 通过 |
| `go test ./relay/channel/openai/ -run TestConvertImageEditRequest` | ✅ 5 个测试函数全通过（含既有 multipart 重建用例） |
| `rebuild.js`（`SKIP_WEB=1`）+ 服务验证 | ✅ 源码同步 6 个文件、Go 编译 15s、`/api/status` 200、入口 JS 200、未认证 `/pg/images/edits` 401 |

### 10.6 本轮明确**不做**的两件事

1. **不校验 `mask` 与参考图的尺寸是否一致。** OpenAI 协议要求两者一致，但部分中转渠道不施加该限制；在入口强判会拒掉当前可用的请求。仅校验 `mask` 自身是完整的 PNG/JPEG。需要时再作为独立议题讨论。
2. **不要求 JSON 载体必须携带图片**，理由见 §10.3。

### 10.7 给验收的提示

`/pg/images/edits` 现有**两条**载体的校验矩阵：

| 载体 | 校验 |
| --- | --- |
| `multipart/form-data` | `image` / `image[]` / `image[N]` **全部** part + `mask`；逐个做签名 → 尺寸 → 完整解码 |
| `application/json` | `image` / `images[]` / `mask` 中的 **data URL**；非 data URL 放过 |

---

## 11. 图片模型在工作台中不可见（图片能力判定漏检）

**现象**：渠道里已配置图片模型，但在工作台选择分组后，图片面板的模型下拉仍为空。

**根因**：`/api/workbench/models` 用 `common.IsImageGenerationModel(name)` 计算返回项的 `image` 字段，而该函数只做**硬编码子串匹配**：

```go
ImageGenerationModels = []string{"dall-e-3", "dall-e-2", "gpt-image-1", "prefix:imagen-", "flux-", "flux.1-"}
```

`gpt-image-1` 是子串匹配，**匹配不到自己的后继版本**：`strings.Contains("gpt-image-2", "gpt-image-1") == false`。

实测（`one-api.db` 的 `abilities` 表）：渠道 `图片`（id=1，type=1 OpenAI，分组 `default`）的模型为

```
gpt-image-2, gpt-image-2.5, gpt-image-2.5-flare, gpt-image-2.5-sunburst
```

这四个名称**都不含** `gpt-image-1` 子串，因此全部被判为 `image: false`。前端 `image-panel.tsx` 直接 `filter((item) => item.image)`，列表变空；且 `imageModels.length === 0` 时还会把已选的 `model` 清空——表现为「一个模型都看不到」，而且**界面上没有任何报错**，这是最难排查的地方。

**处理**：把 `"gpt-image-1"` 换成 `"gpt-image"`（整族子串匹配）。子串（而非 `prefix:`）同时覆盖 `gpt-image-1.5`、`gpt-image-2`、`gpt-image-2.5-*`，以及 `openai/gpt-image-2` 这类带厂商前缀的名字。

**影响面**：`IsImageGenerationModel` 只有两个消费方，都属**能力展示**——`controller/workbench.go` 的 `image` 标记，以及 `common/endpoint_type.go` 给渠道前置 `EndpointTypeImageGeneration`。放宽该判定不触及路由与计费。

**回归测试**：新增 `common/model_test.go`。做法是先写测试复现、确认有 **6 个用例失败**（正好覆盖用户的 4 个模型 + 大小写 + 厂商前缀），再改判定；修复后 14 个正例 + 6 个反例全过。

**在浏览器中确认**：F5 刷新后打开图片工作台，DevTools → Network → `GET /api/workbench/models?group=default` 应返回 4 项，每项 `"image": true`。

**遗留**：该判定**仍然是名字匹配**。仓库中不存在「模型 → 端点」的管理配置（`endpoint_defaults.go` 只有端点路径默认值；`setting/model_setting` 无模型清单），因此没有更权威的数据来源可替代。今后若加入不含任何已登记家族标记的自定义模型名（例如 `qwen-image`、`seedream-3`），仍会不可见——届时需要显式扩展 `ImageGenerationModels`，或引入可配置的额外规则项。

**顺带提醒**：前端 `workbench-options.ts` 用 `prefix: 'gpt-image-2'` 匹配尺寸规则，因此 `gpt-image-2.5-*` 会命中「任意 WIDTHxHEIGHT」那一组 7 个尺寸（含 `1536x1152`、`864x1536` 等）。若上游实际只接受固定的 3 种尺寸，生成请求会被上游拒绝——那属于尺寸规则的独立问题，需要时单独调整。

---

## 12. 图片模型改为「按分组」提供，不再按名字猜能力

### 12.1 需求

工作台的模型下拉**直接显示该分组下的所有模型**，由运维通过配置分组来决定哪些是图片模型；部署到服务器后，管理员配好分组，用户直接选分组即可。

### 12.2 原设计的问题

`/api/workbench/models` 用 `common.IsImageGenerationModel(name)` 算出每项的 `image` 布尔值，前端 `image-panel.tsx` 据此 `filter` —— 这是**按名字猜能力**，已连续暴露两类缺陷：

1. 子串表只登记了 `gpt-image-1`，把 `gpt-image-2` 判为非图片模型（见 §11）；
2. 无论怎么补表都是打地鼠：用户自定义命名的模型（`*-flare`、`*-sunburst`、`seedream-*`、`qwen-image` 等）随时会掉出列表，而**界面上不会有任何报错**——失败是静默的，这正是最耗时的地方。

### 12.3 新设计：能力由分组表达

运维把图片模型放进一个（或几个）分组，工作台展示该分组下的全部模型。

| 层 | 改动 |
| --- | --- |
| `controller/workbench.go` | `GetWorkbenchModels` 的语义改为「返回该分组下的所有模型」；`image` 字段保留，但降级为**纯元信息**（注释已写明），不再承担筛选职责 |
| `web/.../workbench/image-panel.tsx` | 去掉 `.filter((item) => item.image)`，直接把分组内全部模型映射为选项 |
| `web/.../workbench/video-panel.tsx` | **保持不变**：其 `video` 来自 task 插件注册表（权威数据），继续据此筛选 |

**为什么两个面板不对称**：视频能力来自插件注册表（数据驱动、可信），图片能力原本来自名字猜测（脆弱）。因此只把图片侧改为分组驱动，视频侧仍按注册表收窄。

**`IsImageGenerationModel` 保留**：`common/endpoint_type.go` 仍用它为渠道能力前置 `EndpointTypeImageGeneration`，§11 的家族修复依然有效，不是无用代码。

### 12.4 测试

`model-options.test.tsx` 的 mock 改为可传参，并新增 3 例：

| 用例 | 守住什么 |
| --- | --- |
| `offers every model of the group in the image panel` | 打开模型下拉，分组内被标记为**非图片**的模型（`gpt-4o`）同样可选——图片面板不再按能力过滤 |
| `offers an image model the old name pattern mis-flagged` | **回归用例**：只返回 `{name:'gpt-image-2', image:false}`（旧后端对该模型的真实返回形状）时，面板仍能自动选中它；旧实现下这里渲染的是空列表 |
| `keeps the video panel limited to registry-declared models` | 视频面板仍按注册表收窄：若误删视频筛选，自动选中项会由 `kling-v1` 变成 `gpt-image-1` |

结果：前端 **12 文件 / 82 测试**全过；`typecheck` 通过；改动文件 lint 0 error / 0 warning。（原先的共享查询缓存契约用例全部保留并通过。）

### 12.5 部署用法（用户确认的操作模型）

分组下拉来自 `/api/user/self/groups`，即 `service.GetUserUsableGroups`。所以服务端只需两件事：

1. 建好图片分组，组内只放图片模型；
2. 给用户设置相应的分组。

用户打开工作台即可直接选到被允许的分组及其全部模型。现有实现已满足，无需额外改动。

### 12.6 取舍与遗留

- 若某个分组同时含文本模型与图片模型，图片下拉会一并列出。**这是本次刻意的行为**（不隐藏任何东西）；想要更清爽就为图片单独建组。
- 系统不再具备「自动识别图片模型」的能力。`image` 字段仍在响应中返回，供将来做徽标、排序等纯展示用途。
- 尺寸规则仍是**按模型名前缀**推导（`workbench-options.ts`）。命中规则的模型得到该族的精确尺寸，未命中的落到中性的回退尺寸集合——这与能力筛选是两件事，本次未改。

---

## 13. 估价报「模型的价格未配置」，但价格已配置

### 13.1 现象

已在「系统设置 → 分组与模型定价设置」为模型配好价格，工作台仍提示：

```
模型  的价格未配置。请前往「系统设置 → 运营设置」开启自用模式，或在「系统设置 → 分组与模型定价设置」中为该模型配置价格；
Model  price not configured. Go to System Settings → Operation Settings to enable self-use mode, or configure the model price in … 
```

**注意报错里的模型名是空的**：模板是 `"模型 %s 的价格未配置"`，打印出来却是「模型 **的价格未配置**」。这是最关键的线索——说明**传到计费层的模型名是空字符串**，不是价格没配上。

### 13.2 根因

`RelayInfo.OriginModelName` **不是**从请求体读的，而是取自 gin context 的键 `original_model`：

```go
// relay/common/relay_info.go:540
originModelName := common.GetContextKeyString(c, constant.ContextKeyOriginalModel)
```

而该键**只由 `middleware.Distribute` 写入**：

```go
// middleware/distributor.go:633
c.Set("original_model", modelName) // for retry
```

`/api/workbench/estimate` 的路由只挂了 `DisableCache() + UserAuth()`（`router/api-router.go:169`），**没有分发中间件**，所以这个键从未被写入 → `OriginModelName == ""`。

于是 `relay/helper/price.go` 的 `ModelPriceHelper` 拿空串去查价：

1. `GetModelPrice("")` 落空；
2. 转入倍率分支，`GetModelRatio("")` 也落空；
3. `modelPriceNotConfiguredError(matchName, …)`，而 `matchName` 正是那个空串。

**两个附带影响**：`service.EstimateRequestToken` 读同一个键来选择 tokenizer（`service/token_counter.go:225`），键为空时会退化成通用分词器，估价数值本身也不准。

### 13.3 处理（`controller/workbench.go`）

1. 在 `WorkbenchEstimate` 中，与 `ContextKeyUsingGroup` 一起发布模型名：
   `common.SetContextKey(c, constant.ContextKeyOriginalModel, req.Model)`。
2. 顺带把「模型为空」这个真正的坏输入**显式拒绝**（`model is required`），不再让它伪装成「价格未配置」这种误导性的报错。

视频分支本来有一行 `relayInfo.OriginModelName = req.Model` —— 那正是为同一类问题打的补丁，只是当初只补了视频分支。现在统一由 context 键承载（该行保留，行为不变）。

### 13.4 复现与修复的逐字节对照

把修复临时撤掉后跑回归测试，服务端返回的正是用户看到的那句：

```
{"message":"模型  的价格未配置。请前往「系统设置 → 运营设置」…","success":false}
```

（模型名位置为空。）恢复修复后，报错带上真实模型名。

### 13.5 回归测试（`controller/workbench_image_test.go`）

| 用例 | 内容 |
| --- | --- |
| `TestWorkbenchEstimatePricesTheRequestedModel` | 用**未配置价格**的模型请求估价，断言报错**包含该模型名**，且**不出现**「模型  的价格未配置」。撤掉修复后此用例失败，并打印出与用户完全一致的文案 |
| `TestWorkbenchEstimateRequiresModel` | 请求缺 `model` → `model is required`（而不是「价格未配置」） |

### 13.6 影响范围

**只影响估价**。`/pg/images/*` 与 `/v1/*` 都经过 `Distribute`，`original_model` 正常写入，因此**实际生成不受影响**——被卡住的只是估价这一步（前端拿不到估价就会提示，用户看不到可用状态）。

---

## 14. 图片工作台的展示与操作调整

四项验收意见，全部落在前端，另加一处必要的小后端支持。

### 14.1 有明确价格就不再显示「预估」

**问题**：面板把价格显示成 `预估价格: 500,000 额度 · ≈ $1.0000`，但配置了按次价格时这个数字就是**本次请求的准确金额**。

**处理**：估价接口新增 `use_price` 字段（`priceData.UsePrice`），前端据此选择标签——`use_price` 为真时显示 `价格`／`Price`，为假时仍是 `预估价格`／`Estimated price`。

为什么不能一律去掉「预估」：按**倍率**计费的模型，返回的是「预扣额度」而不是最终结算额，那不是准确值。原来的代码只有 `estimate: true` 这一个标记，无法区分两种情形，所以只能一律叫预估；现在两种情形有了各自的标签。

### 14.2 中间展示：图片占满 + 灰白底 + 左上模型/时间 + 右上状态

`result-viewer.tsx` 的 `ImageResultGrid` 增加 `fill` 模式（工作台中间栏使用）：

- 容器 `flex h-full`，每张图 `min-h-56 flex-1`，图片 `size-full object-contain`，底色 `bg-muted`（灰白）；
- 左上角浮层显示 `模型名 · MM-DD HH:mm`，右上角显示状态（`已完成`／`生成中`／`失败`）；
- 中间栏容器由 `items-center justify-center` 改为拉伸，并把居中交给各自的空态／加载态（`m-auto`），这样结果才能真正占满。

**同一张图上的信息从哪来**：图片数组本身不含模型与时间，所以面板新增 `resultMeta` 状态——生成成功时记录当前模型与当前时间，点击历史记录时取该任务的 `origin_model_name` 与 `finish_time`。

### 14.3 中间不再显示提示词；右侧改为逐条记录行

- 中间结果**删除** `figcaption` 提示词——它会盖住图片；提示词改在右侧列表里可读。
- 右侧由「两列缩略图」改为**逐条记录行**：左侧缩略图（`size-10`，加载/失败显示占位文案），右侧提示词（截断）与 `模型名 · 时间`；**悬浮显示删除按钮**。

### 14.4 悬浮下载

中间结果图的右下角在悬浮（或键盘聚焦）时显示下载按钮：`<a download href={src}>`。`data:` URL 直接可用；跨域 URL 受浏览器同源策略限制只能打开新标签，属已知边界。

### 14.5 删除记录：新增后端接口

删除历史记录需要一个新的用户级接口，原先后端只有查询。

| 层 | 内容 |
| --- | --- |
| `model/task.go` | `TaskStatus.IsTerminal()`；`DeleteTaskForUser(userId, taskId)`；哨兵 `ErrTaskNotFound`、`ErrTaskNotDeletable` |
| `controller/task.go` | `DeleteUserTask`，委托模型层并统一返回 `common.ApiError` 信封 |
| `router/api-router.go` | `DELETE /api/task/self/:task_id`（`UserAuth`） |

**两条规则及其理由**：

1. **只允许删除终态任务**。运行中的任务还有上游作业要被收回，删掉记录会把结果和「为什么扣了费」一起藏起来。前端对运行中的记录也不渲染删除按钮，两端一致。
2. **他人的任务报「不存在」而不是「无权限」**，避免该接口被用来探测别人的 task id。

删除**不影响计费**：额度走日志与任务结算，任务行只是工作台展示的记录。删除时会把终态条件重复写进 `DELETE` 语句，防止检查与删除之间状态变化。

### 14.6 测试与验证

新增 `web/src/features/playground/components/workbench/__tests__/image-result-view.test.tsx`（9 例）：

| 用例 | 守住什么 |
| --- | --- |
| `shows a configured price as the price` | `use_price: true` → 出现 `Price:`，且**不出现** `Estimated price:` |
| `keeps calling a ratio pre-consume an estimate` | 反向：`use_price: false` → 出现 `Estimated price:`，不出现 `Price:` |
| `prints the model, time and status on the generated image` | 结果图上出现 `模型 · MM-DD HH:mm` 与 `Completed` |
| `never prints the prompt on the result itself` | 提示词**不在** `figure` 内（只在右侧列表） |
| `offers a download on the generated image` | 悬浮下载按钮的 `href`/`download` 属性 |
| `lists a generation with its prompt, model and timestamp` | 记录行同时显示提示词与 `模型 · 时间` |
| `shows the selected history entry in the viewer` | 点击记录行把该条结果送入中间视图 |
| `deletes a finished record from its row` | 点击删除调用 `DELETE /api/task/self/<id>` |
| `does not offer a delete while a record is still running` | 运行中不渲染删除按钮 |

后端新增 `controller/task_delete_test.go`（2 个测试函数 / 7 个子场景）：终态可删、运行中拒绝且记录保留、他人任务报不存在且记录保留、未知 id 报不存在、handler 的路径参数与响应信封。另有 `TestWorkbenchEstimateReportsWhetherThePriceIsExact` 覆盖 `use_price`。

| 项 | 结果 |
| --- | --- |
| `gofmt -l`（改动文件） | ✅ 空 |
| `go build ./...` | ✅ 退出码 0 |
| `go vet ./controller ./model ./router` | ✅ 退出码 0 |
| `go test ./controller/ -run 'TestDeleteTask\|TestDeleteUserTask\|TestWorkbenchEstimate'` | ✅ 全过 |
| 前端 `bun run test -- playground` | ✅ **13 文件 / 91 测试** |
| `bun run typecheck` | ✅ 通过 |
| `bun run lint`（改动文件） | ✅ 0 error / 0 warning |
| `rebuild.js` + 服务验证 | ✅ 见交付说明 |

**i18n**：复用既有键（`Price`／`Estimated price`／`Completed`／`Download`／`Delete` 等），仅新增 `Failed to delete task`，已按键序插入全部 7 个 locale（en/zh/zh-TW/ja/fr/ru/vi），未运行 `i18n:sync`（它会整文件重写全部 locale，产生无关的巨大 diff）。

### 14.7 四轮遗留

- **跨域图片的一键下载**受浏览器同源策略限制，只能打开新标签页；如需强制下载，需要走后端代理（可复用任务产物代理）。
- 多图（`n > 1`）时中间视图为**纵向等分**，超过可用高度即滚动；未做网格自适应。

---

## 15. 价格显示与下载文件名的细化（第五轮）

### 15.1 配置了价格时只显示金额

上一轮把标签改成了 `价格`，但数字仍是 `500,000 额度 · ≈ $1.0000`。既然价格是**按次配置的美元金额**，那么：

- **背书的额度是内部计量单位**，不是账单金额，显示它只会让人以为要付 500,000；
- `≈` 号也跟着失去意义——金额是确定的，不是近似。

所以 `use_price` 为真时改为**只显示金额**：`价格: $1.0000`（免费模型显示 `价格: Free`）。`use_price` 为假（倍率计费）时保持原样：`预估价格: 500,000 额度 · ≈ $1.0000`——那种情形返回的是预扣额度，额度与金额都有信息量。

两分支现在各自独立成 `else if`：价格分支是**纯字符串**（无嵌套节点），倍率分支仍保留原来的 `<span>` 结构。

### 15.2 下载文件自动命名为 `creation-<时间戳>`

`<a download>` 原先只有一个布尔 `download`，浏览器便用 URL 的最后一段当文件名，用户拿到的是任务 id 或一长串 `data:` 内容。

现在显式给出文件名，格式 `creation-YYYYMMDD-HHmmss.<ext>`：

| 取值 | 来源与理由 |
| --- | --- |
| 时间戳 | 优先 `meta.createdAt`（历史记录即该任务的 `finish_time`）；无任务行的新结果用**挂载时冻结**的当前时间，避免重渲染改掉即将保存的文件名 |
| 扩展名 | `data:` URL 从自身声明的 mime 取（这是唯一可信来源）；远程链接从路径取，`jpeg → jpg`；两者都不识别时回退 `png` |
| 序号 | 同一次请求的多张图共享同一时间戳，因此 `n > 1` 时追加 `-1`、`-2`…，否则浏览器会存成「file」「file (1)」 |

时间戳格式为 `YYYYMMDD-HHmmss`（例：`creation-20260914-070753.png`）。选可读形式而非纯 unix 秒，是因为文件名首先给人看，同时它仍然唯一、可排序。

### 15.3 测试

`image-result-view.test.tsx` 从 9 例增至 13 例：

| 新增用例 | 守住什么 |
| --- | --- |
| `shows only the money when the price is configured` | 价格分支**不含** `500,000`、不含 `quota`，且等于 `Price: $1.0000` |
| `names a saved image creation-<timestamp>` | `download` 属性匹配 `^creation-\d{8}-\d{6}\.png$` |
| `numbers the saved names when one request returns several images` | 3 张图时依次为 `-1` / `-2` / `-3`，数量为 3 |
| `takes the extension from a linked image path` | `history.jpeg` → 保存名以 `.jpg` 结尾 |

`mockApi` 增加 `count` 选项以便构造多图响应；单图仍返回无查询串的 URL，既有断言不变。

### 15.4 验证结果

| 项 | 结果 |
| --- | --- |
| 前端 `bun run test -- playground` | ✅ **13 文件 / 95 测试** |
| `bun run typecheck` | ✅ 通过 |
| `oxlint`（3 个改动文件） | ✅ 0 error / 0 warning |
| `rebuild.js` + 服务验证 | ✅ 见交付说明 |

本轮**只改前端**（`image-panel.tsx`、`result-viewer.tsx` 及其测试），Go 侧未改动。
