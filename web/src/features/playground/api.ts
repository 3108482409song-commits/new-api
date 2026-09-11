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
import { requireServerSuccess } from '@/lib/server-error-message'

import { API_ENDPOINTS, WORKBENCH_ENDPOINTS, WORKBENCH_GROUP_HEADER } from './constants'
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
  image: string
}

function workbenchHeaders(group: string): Record<string, string> {
  return { [WORKBENCH_GROUP_HEADER]: group }
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
  return (res.data?.data ?? []) as WorkbenchImageResult[]
}

function dataUrlToFile(dataUrl: string, filename: string): File {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s)
  if (!match) {
    throw new Error('Invalid image data')
  }
  const mimeType = match[1] || 'image/png'
  const encoded = match[2]
  const bytes = dataUrl.includes(';base64,')
    ? Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(encoded))
  return new File([bytes], filename, { type: mimeType })
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
  form.append('image', dataUrlToFile(payload.image, 'reference.png'), 'reference.png')
  const res = await api.post(WORKBENCH_ENDPOINTS.IMAGE_EDITS, form, {
    headers: workbenchHeaders(payload.group),
    signal,
    skipErrorHandler: true,
  } as Record<string, unknown>)
  return (res.data?.data ?? []) as WorkbenchImageResult[]
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
  actions?: string[]
  page?: number
  pageSize?: number
}): Promise<WorkbenchTaskPage> {
  const res = await api.get(WORKBENCH_ENDPOINTS.TASKS, {
    params: {
      task_id: params.taskId,
      status: params.status,
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
