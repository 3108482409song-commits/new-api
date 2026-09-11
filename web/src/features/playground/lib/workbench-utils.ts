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
import {
  WORKBENCH_ACTION_WHITELIST,
  WORKBENCH_IMAGE_ACTIONS,
  WORKBENCH_RUNNING_STATUSES,
} from '../constants'
import type { TaskStatus, WorkbenchImageResult, WorkbenchTask } from '../types'

export function getImageSource(image: WorkbenchImageResult): string | null {
  if (image.url) {
    return image.url
  }
  if (image.b64_json) {
    return image.b64_json.startsWith('data:') ? image.b64_json : `data:image/png;base64,${image.b64_json}`
  }
  return null
}

export function isWorkbenchTask(task: WorkbenchTask): boolean {
  return (WORKBENCH_ACTION_WHITELIST as readonly string[]).includes(task.action)
}

export function isImageTask(task: WorkbenchTask): boolean {
  return (WORKBENCH_IMAGE_ACTIONS as readonly string[]).includes(task.action)
}

export function isRunningStatus(status: TaskStatus): boolean {
  return (WORKBENCH_RUNNING_STATUSES as readonly string[]).includes(status)
}

export function isVideoStatusTerminal(status: TaskStatus): boolean {
  return status === 'SUCCESS' || status === 'FAILURE'
}

export function workbenchErrorMessage(error: unknown, fallback: string): string {
  const candidate = error as {
    response?: { data?: { error?: { message?: string } } }
    message?: string
  }
  return candidate?.response?.data?.error?.message ?? candidate?.message ?? fallback
}

export function formatQuota(quota: number): string {
  if (quota === 0) {
    return '0'
  }
  return new Intl.NumberFormat('en-US').format(quota)
}
