/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { api } from '@/lib/api'
import {
  createServerError,
  requireServerSuccess,
} from '@/lib/server-error-message'

import { API_ENDPOINTS, WORKBENCH_ENDPOINTS, WORKBENCH_GROUP_HEADER } from './constants'
import {
  decodeReferenceImage,
  referenceImageFileName,
} from './lib/reference-image'
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelOption,
  GroupOption,
  WorkbenchModel,
  WorkbenchEstimateResult,
  WorkbenchEstimatePayload,
  WorkbenchImageResult,
  WorkbenchTask,
  WorkbenchTaskPage,
} from './types'

/**
 * Send chat completion request (non-streaming)
 */
export async function sendChatCompletion(
  payload: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<ChatCompletionResponse> {
  const res = await api.post(API_ENDPOINTS.CHAT_COMPLETIONS, payload, {
    signal,
    skipErrorHandler: true,
  } as Record<string, unknown>)
  return res.data
}

/**
 * Get user available models
 */
export async function getUserModels(group: string): Promise<ModelOption[]> {
  const res = await api.get(API_ENDPOINTS.USER_MODELS, {
    params: { group },
  })
  const { data } = res
  requireServerSuccess(data)

  if (!data.success || !Array.isArray(data.data)) {
    return []
  }

  return data.data.map((model: string) => ({
    label: model,
    value: model,
  }))
}

/**
 * Get user groups
 */
export async function getUserGroups(): Promise<GroupOption[]> {
  const res = await api.get(API_ENDPOINTS.USER_GROUPS)
  const { data } = res
  requireServerSuccess(data)

  if (!data.success || !data.data) {
    return []
  }

  const groupData = data.data as Record<string, { desc: string; ratio: number }>

  // label is for button display (name only); desc is for dropdown content
  return Object.entries(groupData).map(([group, info]) => ({
    label: group,
    value: group,
    ratio: info.ratio,
    desc: info.desc,
  }))
}

// ── Workbench ─────────────────────────────────────────────────────────────

/**
 * Get user enabled models annotated with image / video capabilities.
 */
export async function getWorkbenchModels(group: string): Promise<WorkbenchModel[]> {
  const res = await api.get(WORKBENCH_ENDPOINTS.MODELS, { params: { group } })
  const { data } = res
  requireServerSuccess(data)
  if (!data.success || !Array.isArray(data.data)) {
    return []
  }
  return data.data as WorkbenchModel[]
}

/**
 * Display-only price estimate; never consumes quota.
 */
export async function estimateWorkbench(
  payload: WorkbenchEstimatePayload,
): Promise<WorkbenchEstimateResult> {
  const res = await api.post(WORKBENCH_ENDPOINTS.ESTIMATE, payload)
  const { data } = res
  requireServerSuccess(data)
  return data.data as WorkbenchEstimateResult
}

export interface WorkbenchImageGeneratePayload {
  group: string
  model: string
  prompt: string
  n: number
  size: string
  quality?: string
}

export interface WorkbenchImageEditPayload extends WorkbenchImageGeneratePayload {
  /** Reference images, most models accept exactly one. */
  images: string[]
}

function workbenchHeaders(group: string): Record<string, string> {
  return { [WORKBENCH_GROUP_HEADER]: group }
}

/**
 * Validate an image relay response. On success the relay returns the upstream
 * OpenAI payload (`{ created, data: [...] }`), which carries no `success` flag,
 * so `requireServerSuccess` passes it through. A business failure envelope
 * (`success: false`) throws with the payload kept as `cause`, so the shared
 * error-message helpers can surface the backend reason. A missing or non-array
 * `data` is a protocol error: it must never silently become an empty result,
 * which is what made channel/group/model failures look like "no images".
 */
function readWorkbenchImages(response: unknown): WorkbenchImageResult[] {
  requireServerSuccess(response)
  const data = (response as { data?: unknown } | null | undefined)?.data
  if (!Array.isArray(data)) {
    throw createServerError(
      response,
      'The image response did not contain a data array',
    )
  }
  return data as WorkbenchImageResult[]
}

/**
 * Synchronous OpenAI-compatible image generation through the session-auth
 * workbench relay. Returns the OpenAI image response `data` array.
 */
export async function generateWorkbenchImage(
  payload: WorkbenchImageGeneratePayload,
  signal?: AbortSignal,
): Promise<WorkbenchImageResult[]> {
  const res = await api.post(
    WORKBENCH_ENDPOINTS.IMAGE_GENERATIONS,
    {
      model: payload.model,
      prompt: payload.prompt,
      n: payload.n,
      size: payload.size,
      quality: payload.quality,
    },
    {
      headers: workbenchHeaders(payload.group),
      signal,
      skipErrorHandler: true,
    } as Record<string, unknown>,
  )
  return readWorkbenchImages(res.data)
}

function dataUrlToFile(
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
): File {
  // Copy into a plain ArrayBuffer: a Uint8Array view is not a BlobPart under
  // TypeScript's typed-array generics.
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new File([buffer], filename, { type: mimeType })
}

/** Reference-image edit via the multipart images/edits endpoint. */
export async function editWorkbenchImage(
  payload: WorkbenchImageEditPayload,
  signal?: AbortSignal,
): Promise<WorkbenchImageResult[]> {
  const form = new FormData()
  form.append('model', payload.model)
  form.append('prompt', payload.prompt)
  form.append('n', String(payload.n))
  form.append('size', payload.size)
  if (payload.quality) {
    form.append('quality', payload.quality)
  }
  // Validate the bytes, not just the declared MIME: a renamed or truncated file
  // must not reach the upstream. Every image is re-checked here, so a caller that
  // skipped the picker cannot smuggle one through either.
  //
  // Each image is a separate "image" part, which is the multipart form of a
  // multi-reference edit; the relay resolves the same set when it validates and
  // forwards them. Let the browser set the multipart Content-Type so the boundary
  // matches the body; the File carries the MIME and a filename with the matching
  // extension.
  for (const image of payload.images) {
    const reference = decodeReferenceImage(image)
    form.append(
      'image',
      dataUrlToFile(
        reference.bytes,
        reference.mimeType,
        referenceImageFileName(reference.mimeType),
      ),
    )
  }
  const res = await api.post(WORKBENCH_ENDPOINTS.IMAGE_EDITS, form, {
    headers: workbenchHeaders(payload.group),
    signal,
    skipErrorHandler: true,
  } as Record<string, unknown>)
  return readWorkbenchImages(res.data)
}

export interface WorkbenchVideoGeneratePayload {
  group: string
  model: string
  prompt: string
  mode: 'text_to_video' | 'first_tail_to_video' | 'reference_to_video'
  duration: number
  resolution: string
  aspect: string
  firstFrame?: string
  lastFrame?: string
  referenceImages?: string[]
}

export interface WorkbenchVideoGenerateResult {
  task_id: string
  status?: string
}

/**
 * Async video generation through the OpenAI video protocol (session auth).
 */
export async function generateWorkbenchVideo(
  payload: WorkbenchVideoGeneratePayload,
): Promise<WorkbenchVideoGenerateResult> {
  const body: Record<string, unknown> = {
    model: payload.model,
    prompt: payload.prompt,
    duration: payload.duration,
    resolution: payload.resolution,
    aspect_ratio: payload.aspect,
  }
  let images: string[] = []
  if (payload.mode === 'first_tail_to_video') {
    images = [payload.firstFrame, payload.lastFrame].filter(
      (image): image is string => Boolean(image),
    )
  } else if (payload.mode === 'reference_to_video') {
    images = payload.referenceImages ?? []
  }
  if (images.length > 0) body.images = images
  if (payload.mode === 'first_tail_to_video' && payload.firstFrame) {
    body.image = payload.firstFrame
  }
  const metadata: Record<string, unknown> = {}
  metadata.workbench_mode = payload.mode
  metadata.action = payload.mode
  if (payload.mode === 'first_tail_to_video' && payload.firstFrame) {
    metadata.first_frame_image = payload.firstFrame
    metadata.image = payload.firstFrame
  }
  if (payload.mode === 'first_tail_to_video' && payload.lastFrame) {
    metadata.last_frame_image = payload.lastFrame
    metadata.image_tail = payload.lastFrame
  }
  if (payload.referenceImages && payload.referenceImages.length > 0) {
    metadata.reference_images = payload.referenceImages
  }
  if (Object.keys(metadata).length > 0) {
    body.metadata = metadata
  }
  const res = await api.post(WORKBENCH_ENDPOINTS.VIDEO_GENERATIONS, body, {
    headers: workbenchHeaders(payload.group),
    skipErrorHandler: true,
  } as Record<string, unknown>)
  return res.data as WorkbenchVideoGenerateResult
}

/**
 * User's own tasks (workbench image/video history). Supports task_id and
 * status filters; the workbench additionally filters by action whitelist.
 */
export async function getUserWorkbenchTasks(params: {
  taskId?: string
  status?: string
  /**
   * Every status one filter stands for. The list groups several states under a
   * single filter ("running" covers NOT_START/SUBMITTED/QUEUED/IN_PROGRESS),
   * which a single-value status cannot express — and with the filtering done on
   * the server a page is complete instead of a slice of the matching rows.
   */
  statuses?: string[]
  actions?: string[]
  page?: number
  pageSize?: number
}): Promise<WorkbenchTaskPage> {
  const res = await api.get(WORKBENCH_ENDPOINTS.TASKS, {
    params: {
      task_id: params.taskId,
      status: params.status,
      statuses: params.statuses?.join(','),
      actions: params.actions?.join(','),
      // The dashboard pagination reader expects `p`, not `page`.
      p: params.page,
      page_size: params.pageSize,
    },
  })
  const { data } = res
  requireServerSuccess(data)
  const page = (data.data ?? {}) as WorkbenchTaskPage
  return {
    items: (page.items ?? []) as WorkbenchTask[],
    total: page.total ?? 0,
    page: page.page,
    page_size: page.page_size,
  }
}

/**
 * Load one generation together with its full result payload. List rows carry a
 * preview only, so the viewer asks for the single record it is about to display
 * rather than pulling every result on the page along with the list.
 */
export async function getWorkbenchTask(taskId: string): Promise<WorkbenchTask> {
  const res = await api.get(
    `${WORKBENCH_ENDPOINTS.TASKS}/${encodeURIComponent(taskId)}`
  )
  const task = requireServerSuccess(res.data).data as WorkbenchTask | undefined
  if (!task) {
    throw new Error('Task not found')
  }
  return task
}

/**
 * Remove one finished generation record from the caller's history. Quota is not
 * affected — the task row is only the display record. The backend refuses a task
 * that is still running and reports another user's task as missing, so the
 * caller only has to surface the message it returns.
 */
export async function deleteWorkbenchTask(taskId: string): Promise<void> {
  const res = await api.delete(
    `${WORKBENCH_ENDPOINTS.TASKS}/${encodeURIComponent(taskId)}`,
    { skipErrorHandler: true } as Record<string, unknown>,
  )
  requireServerSuccess(res.data)
}
