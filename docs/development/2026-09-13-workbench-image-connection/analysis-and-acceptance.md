# 工作台图片链路连接与上传验收文档

## 1. 文档目的

本文只用于问题分析、实现设计和验收，不直接修改源码。代码由其他 AI 实现后，按本文逐项审核和验收。

本次目标：

1. 修复图片工作台与后端图片中继之间的连接问题，尤其是“新增渠道后无法生成图片”。
2. 确认文生图请求可以正常生成并展示结果。
3. 确认参考图生请求可以正确上传 PNG/JPEG，并由后端转发到支持的上游。
4. 失败时必须显示可操作的后端错误，而不是静默显示空结果。

## 2. 已确认的请求链路

### 2.1 文生图

```text
ImagePanel
  -> POST /api/workbench/models?group=...
  -> POST /api/workbench/estimate
  -> POST /pg/images/generations
       X-Workbench-Group: <selected group>
       JSON: model, prompt, n, size, quality
  -> UserAuth
  -> WorkbenchGroup
  -> Distribute
  -> controller.WorkbenchImage
  -> controller.Relay(RelayFormatOpenAIImage)
  -> relay.ImageHelper
  -> selected channel adaptor
  -> OpenAI image response
```

### 2.2 参考图生

```text
ImagePanel
  -> FileReader.readAsDataURL
  -> dataUrlToFile
  -> POST /pg/images/edits
       X-Workbench-Group: <selected group>
       multipart/form-data: model, prompt, n, size, quality, image
  -> UserAuth
  -> WorkbenchGroup
  -> Distribute
  -> controller.WorkbenchImage
  -> controller.Relay(RelayFormatOpenAIImage)
  -> GetAndValidOpenAIImageRequest
  -> relay.ImageHelper
  -> selected channel adaptor
  -> OpenAI image response
```

## 3. 已确认问题与根因

### P0：工作台 multipart 编辑请求没有在分发阶段解析模型

文件：`middleware/distributor.go`。

当前图片模型解析分支只匹配 `/v1/images/generations` 和 `/v1/images/edits`。工作台使用 `/pg/images/generations` 和 `/pg/images/edits`。文生图是 JSON，会在更早的通用 JSON 分支读取 `model`；参考图生是 multipart，会跳过通用分支，随后又不满足 `/v1/images/edits`，因此 `modelRequest.Model` 为空，渠道无法选择。

实现要求：

- 图片路径判断必须同时覆盖 `/v1/images/generations`、`/v1/images/edits`、`/pg/images/generations`、`/pg/images/edits`，或抽取统一的图片路径判断函数。
- multipart 编辑请求必须从可复用 body storage / multipart form 读取 `model`，不能依赖已经被消费的原始 request body。
- 缺失模型时返回明确的 400，而不是进入随机渠道选择后返回含糊的 503。
- 修复后保持 `/v1` 标准 API 的既有行为不变。

### P1：前端生成失败可能被转换成空结果

文件：`web/src/features/playground/api.ts`。

`generateWorkbenchImage` 和 `editWorkbenchImage` 使用 `skipErrorHandler: true`，但没有调用 `requireServerSuccess`，且直接读取 `res.data?.data ?? []`。后端业务失败响应可能因此变成空数组，用户看到“没有生成结果”，无法判断是渠道、分组、模型还是上传失败。

实现要求：

- 两个函数都必须检查统一 API 响应的 `success` 字段。
- `success === false` 时抛出包含后端 `message/error` 的错误，交由 `ImagePanel.onError` 和 `workbenchErrorMessage` 展示。
- 成功响应必须校验 `data` 是数组；类型不符时按协议错误处理，不静默转为空数组。
- 保留 AbortError/取消请求的现有处理语义。

### P1：高级自定义渠道的工作台路径过滤

文件：`model/channel_constraint.go`、高级自定义渠道配置。

分发器给所有请求添加实际请求路径过滤：工作台路径是 `/pg/images/...`。高级自定义渠道的路由配置通常登记 `/v1/images/...`，其 `SupportsPathForModel` 可能按精确路径拒绝 `/pg/...`，即使该渠道本身支持图片协议也不会被选中。

实现要求（二选一，必须有测试证明）：

- 将工作台路径归一化为对应的标准 OpenAI 图片路径后再执行高级自定义路径过滤；或
- 在高级自定义路径匹配中明确把 `/pg/images/generations` 映射到 `/v1/images/generations`、把 `/pg/images/edits` 映射到 `/v1/images/edits`。

不能简单放宽所有路径过滤，否则会让配置了特定入站路径的高级自定义渠道接收不支持的请求。

### P1：新增渠道不等于工作台可用渠道

工作台模型列表来自 `service.GetGroupsEnabledModels`，再通过 `common.IsImageGenerationModel` 标注图片模型。渠道必须同时满足：

- 渠道状态为启用；
- 渠道 `Group` 包含当前工作台分组；
- 渠道模型名已写入 `channels.models`，并已生成启用的 `abilities`；
- 模型名被图片模型识别（例如 `dall-e-3`、`gpt-image-1`、`flux-*` 或 `imagen-*`）；
- 渠道适配器实现图片生成；参考图生还必须实现图片编辑和 multipart 转发；
- 分组权限允许当前用户使用该分组；
- 若为高级自定义渠道，入站路由配置覆盖对应图片路径和模型规则。

因此，管理端“随便添加渠道”后模型不出现在工作台或没有可用渠道，属于配置/能力链路问题，不能仅靠前端显示修复。

## 4. 给实现 AI 的详细设计

### 4.1 分发器模型解析

1. 在 `getModelRequest` 的图片分支覆盖 `/pg` 和 `/v1` 两类路径。
2. 文生图 JSON 继续使用可复用 body storage 解析。
3. 编辑 multipart 使用 `getModelFromRequest` 或等价的 `ParseMultipartFormReusable`，读取 `model` 字段后恢复 request body/storage 游标。
4. 解析结果必须进入 `modelRequest.Model`，再执行 token 模型限制、分组能力查询、渠道选择和 `SetupContextForSelectedChannel`。
5. 增加单元测试：
   - `/pg/images/generations` JSON 能解析模型；
   - `/pg/images/edits` multipart 能解析模型；
   - 缺失模型返回明确错误；
   - `/v1/images/edits` 旧行为回归通过。

### 4.2 前端 API 错误处理

1. 生成和编辑请求保留 `X-Workbench-Group`，不得把 group 写入上游 JSON/multipart 字段。
2. 调用 `requireServerSuccess`；错误对象必须保留原始响应作为 `cause`，以便统一错误消息函数提取后端信息。
3. 成功时要求响应结构为 `{ data: ImageData[] }`，返回 `data` 数组。
4. `ImagePanel` 的 `onError` 应显示渠道/分组/模型/上传失败信息，不能只显示通用“无图片”。
5. 增加前端测试覆盖：HTTP 业务失败、HTTP 4xx/5xx、成功空数组、成功带图片数据四种情况。

### 4.3 参考图上传与适配器

1. 浏览器端允许 PNG、JPEG，读取为 Data URL 后转为 `File`；文件名和 MIME 类型必须保留合理值。
2. 不要手动设置 multipart `Content-Type`，让浏览器生成 boundary。
3. 请求字段至少包含 `model`、`prompt`、`n`、`size`、可选 `quality` 和 `image` 文件。
4. 后端 `GetAndValidOpenAIImageRequest` 必须解析字段并保留 `MultipartForm.File["image"]`。
5. OpenAI 兼容适配器必须把图片文件重新写入新的 multipart body，并设置新的 boundary；文件内容、文件名、MIME 类型不可丢失。
6. 目标渠道若未实现 `ConvertImageRequest` 或不支持编辑，必须返回明确的“不支持图片编辑”错误，并且前端显示该错误；不能把编辑请求当作文生图发送。
7. 多图/数组字段、mask 字段属于兼容性扩展；本次至少保证单个 `image` 字段稳定工作。

### 4.4 渠道配置检查

实现或验收工具应能按以下顺序诊断：

```text
用户分组权限
 -> 分组启用模型
 -> abilities(group, model, channel_id, enabled)
 -> channel.status
 -> request-path filter
 -> channel adaptor image capability
 -> upstream URL/header/body
```

诊断信息不得输出 API key、Cookie、图片内容或可用认证 token。

## 5. 手工验收方案

### 5.1 测试准备

准备一个真实可用的 OpenAI 兼容图片上游，创建渠道并确认：

- 渠道启用；
- 模型填写为上游实际支持的图片模型；
- 渠道分组与当前用户可选分组一致；
- 渠道测试接口成功；
- 若使用高级自定义渠道，配置图片 generations/edits 入站路由及模型规则。

浏览器打开图片工作台，选择该分组和模型。浏览器 Network 面板保留请求、响应状态、请求头和 multipart 字段摘要，不记录密钥。

### 5.2 文生图验收

1. `GET /api/workbench/models?group=<group>` 返回 2xx，目标模型 `image=true`。
2. `POST /api/workbench/estimate` 返回成功估价。
3. 输入非空 prompt，选择 `1:1`，点击生成。
4. `POST /pg/images/generations` 返回 2xx；请求头包含正确的 `X-Workbench-Group`。
5. 请求 JSON 包含 `model`、`prompt`、`n`、`size`；`group` 不应进入 JSON body。
6. 返回 `data` 至少包含一个 `url` 或 `b64_json`，前端结果区显示图片。
7. 最近任务列表出现成功任务，且只发生一次实际扣费；不能因工作台任务记录再次结算而重复扣费。
8. 切换比例后分别验证请求尺寸映射和估价刷新。**注意（2026-09-14 修订）**：可选比例**按所选模型真实支持的尺寸动态生成**，不再是固定的全量列表——`gpt-image-1` 只有 `1:1 / 3:2 / 2:3`，`gpt-image-2` 才是七种全量，`dall-e-3` 为 `1:1 / 7:4 / 4:7`。若用 `gpt-image-1` 验收，**页面上不会出现 `3:4` / `4:3`（这是预期行为，不是缺陷）**；要验证真实 `3:4`/`4:3` 请改用 `gpt-image-2` 系列模型。依据见 `code-design.md` §8.4 与 §9.4。

### 5.3 参考图生验收

1. 切换“参考图编辑”模式。
2. 选择一张 PNG，再选择一张 JPEG，均能显示预览。
3. 点击生成，确认 `POST /pg/images/edits`。
4. 请求 `Content-Type` 为带 boundary 的 `multipart/form-data`。
5. multipart 中存在 `image` 文件，文件内容大小与选择文件一致，字段包含 `model`、`prompt`、`n`、`size`。
6. 后端成功选择渠道，向上游发送 multipart；上游返回图片数据。
7. 工作台显示结果，并生成 `img2img` 成功任务。
8. 删除图片后点击生成，按钮应禁用或显示“需要上传参考图”，不能发送无 image 请求。

### 5.4 失败场景验收

- 未启用渠道：显示明确的无可用渠道错误。
- 模型未加入分组：模型列表不应出现，或提交时返回明确模型/分组错误。
- `/pg/images/edits` 缺少 model：返回 400，错误指出 model 缺失。
- 上游 401/403/429/5xx：前端显示后端可读错误，不显示空成功结果。
- 上游不支持 edits：显示不支持参考图编辑，不回退到 generations。
- 上传损坏文件/非图片：前端或后端拒绝，错误可见。
- 取消请求：不误报生成失败，不写入虚假的成功任务。

## 6. 自动化验证要求

实现完成后至少运行：

```text
go test ./middleware ./model ./relay/helper ./relay/channel/openai ./controller
cd web && bun run test -- <workbench/API tests>
cd web && bun run typecheck
cd web && bun run lint
cd web && bun run build
```

若修改数据库、渠道能力表或迁移，必须额外按项目规则使用真实 SQLite、MySQL、PostgreSQL 验证新库和升级库，并记录版本、命令和结果。本次设计默认不要求数据库结构变更。

## 7. 审核清单

- [ ] 未修改 `docs/code-wiki` 用户已有内容。
- [ ] 未把工作台 group 写入上游 body。
- [ ] `/pg/images/edits` multipart 模型已在分发阶段解析。
- [ ] 前端不再把后端失败响应静默转换为空数组。
- [ ] 分组、模型、渠道和能力映射一致。
- [ ] 文生图 generations 链路通过。
- [ ] PNG/JPEG 参考图 edits 链路通过。
- [ ] 上游错误、渠道不支持和上传失败均可见。
- [ ] 无重复扣费、无虚假任务成功记录。
- [ ] 自动化测试、类型检查、lint、构建结果已记录。

## 8. 不修改范围

- 不改变计费规则、倍率、数据库表结构或渠道 API key 存储方式。
- 不新增图片供应商适配器；供应商未实现图片编辑时只做能力识别和错误提示。
- 不将 `/pg` 工作台接口暴露为无需会话认证的公共 API。
- 不移除 new-api 或 QuantumNous 的受保护标识。
