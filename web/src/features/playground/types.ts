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
// Message types
export type MessageRole = 'user' | 'assistant' | 'system'

export type MessageStatus = 'loading' | 'streaming' | 'complete' | 'error'

export type PlaygroundMessageLayoutMode = 'alternating' | 'left'

export interface MessageVersion {
  id: string
  content: string
}

export interface Message {
  key: string
  from: MessageRole
  versions: MessageVersion[]
  createdAt?: number
  startedAt?: number
  completedAt?: number
  durationMs?: number
  sources?: { href: string; title: string }[]
  reasoning?: {
    content: string
    duration: number
    startedAt?: number
    completedAt?: number
    durationMs?: number
  }
  isReasoningStreaming?: boolean
  isReasoningComplete?: boolean
  isContentComplete?: boolean
  status?: MessageStatus
  errorCode?: string | null
}

// API payload types
export interface ChatCompletionMessage {
  role: MessageRole
  content: string | ContentPart[]
}

export interface ContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: {
    url: string
  }
}

export interface ChatCompletionRequest {
  model: string
  group?: string
  messages: ChatCompletionMessage[]
  stream: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  frequency_penalty?: number
  presence_penalty?: number
  seed?: number
}

export interface ChatCompletionChunk {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: MessageRole
      content?: string
      reasoning_content?: string
    }
    finish_reason: string | null
  }>
}

export interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: MessageRole
      content: string
      reasoning_content?: string
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// Configuration types
export interface PlaygroundConfig {
  model: string
  group: string
  temperature: number
  top_p: number
  max_tokens: number
  frequency_penalty: number
  presence_penalty: number
  seed: number | null
  stream: boolean
}

export interface ParameterEnabled {
  temperature: boolean
  top_p: boolean
  max_tokens: boolean
  frequency_penalty: boolean
  presence_penalty: boolean
  seed: boolean
}

// Model and group options
export interface ModelOption {
  label: string
  value: string
}

export interface GroupOption {
  label: string
  value: string
  ratio: number
  desc?: string
}

// ── Workbench (image / video / task list) ────────────────────────────────

export interface WorkbenchModel {
  name: string
  image: boolean
  video: boolean
  platform?: string
}

export interface WorkbenchEstimateResult {
  quota: number
  usd: number
  free_model: boolean
  estimate: boolean
}

export type WorkbenchEstimatePayload =
  | {
      type: 'image'
      group: string
      model: string
      n: number
      size: string
      quality?: string
    }
  | {
      type: 'video'
      group: string
      model: string
      mode: VideoMode
      duration: number
      resolution: string
      aspect: string
      /** Number of reference images; the API field is snake_case. */
      ref_images: number
    }

export type VideoMode = 'text_to_video' | 'first_tail_to_video' | 'reference_to_video'

export type TaskStatus =
  | 'NOT_START'
  | 'SUBMITTED'
  | 'QUEUED'
  | 'IN_PROGRESS'
  | 'FAILURE'
  | 'SUCCESS'
  | 'UNKNOWN'

export interface WorkbenchImageResult {
  url?: string
  b64_json?: string
  revised_prompt?: string
}

export interface WorkbenchTask {
  id: number
  task_id: string
  platform: string
  action: string
  status: TaskStatus
  progress: string
  fail_reason: string
  result_url?: string
  submit_time: number
  start_time: number
  finish_time: number
  quota: number
  group: string
  properties?: {
    input?: string
    origin_model_name?: string
    upstream_model_name?: string
  }
  data?: {
    images?: WorkbenchImageResult[]
    size?: string
    n?: number
  } | null
}

export interface WorkbenchTaskPage {
  items: WorkbenchTask[]
  total: number
  page?: number
  page_size?: number
}
