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
import { describe, expect, it } from 'vitest'

import {
  formatQuota,
  getImageSource,
  isImageTask,
  isRunningStatus,
  isVideoStatusTerminal,
  isWorkbenchTask,
  workbenchErrorMessage,
} from '../workbench-utils'
import type { WorkbenchTask } from '../../types'

function task(overrides: Partial<WorkbenchTask> = {}): WorkbenchTask {
  return {
    id: 1,
    task_id: 'task-1',
    platform: 'image',
    action: 'text2img',
    status: 'SUCCESS',
    progress: '100%',
    fail_reason: '',
    submit_time: 1_700_000_000,
    start_time: 1_700_000_000,
    finish_time: 1_700_000_000,
    quota: 0,
    group: 'default',
    ...overrides,
  }
}

describe('isWorkbenchTask', () => {
  it('accepts every action the workbench itself creates', () => {
    for (const action of [
      'text2img',
      'img2img',
      'text_to_video',
      'image_to_video',
      'first_tail_to_video',
      'reference_to_video',
    ]) {
      expect(isWorkbenchTask(task({ action }))).toBe(true)
    }
  })

  it('rejects task actions owned by other features', () => {
    for (const action of ['imagine', 'blend', 'remix', 'generate']) {
      expect(isWorkbenchTask(task({ action }))).toBe(false)
    }
  })
})

describe('isImageTask', () => {
  it('separates synchronous image records from video records', () => {
    expect(isImageTask(task({ action: 'text2img' }))).toBe(true)
    expect(isImageTask(task({ action: 'img2img' }))).toBe(true)
    expect(isImageTask(task({ action: 'text_to_video' }))).toBe(false)
    expect(isImageTask(task({ action: 'first_tail_to_video' }))).toBe(false)
  })
})

describe('isRunningStatus', () => {
  it.each(['NOT_START', 'SUBMITTED', 'QUEUED', 'IN_PROGRESS'] as const)(
    'treats %s as in flight',
    (status) => {
      expect(isRunningStatus(status)).toBe(true)
    }
  )

  it.each(['SUCCESS', 'FAILURE', 'UNKNOWN'] as const)(
    'treats %s as settled',
    (status) => {
      expect(isRunningStatus(status)).toBe(false)
    }
  )
})

describe('isVideoStatusTerminal', () => {
  it('only stops polling on a settled status', () => {
    expect(isVideoStatusTerminal('SUCCESS')).toBe(true)
    expect(isVideoStatusTerminal('FAILURE')).toBe(true)
    expect(isVideoStatusTerminal('UNKNOWN')).toBe(false)
    expect(isVideoStatusTerminal('QUEUED')).toBe(false)
  })

  it.each([
    ['NOT_START', false],
    ['SUBMITTED', false],
    ['QUEUED', false],
    ['IN_PROGRESS', false],
    ['SUCCESS', true],
    ['FAILURE', true],
    ['UNKNOWN', false],
  ] as const)('reports %s as terminal=%s', (status, terminal) => {
    expect(isVideoStatusTerminal(status)).toBe(terminal)
  })
})

describe('getImageSource', () => {
  it('prefers a hosted url', () => {
    expect(getImageSource({ url: 'https://example.com/a.png' })).toBe('https://example.com/a.png')
  })

  it('completes a bare base64 payload into a data url', () => {
    expect(getImageSource({ b64_json: 'QUJD' })).toBe('data:image/png;base64,QUJD')
  })

  it('passes through a payload that is already a data url', () => {
    const dataUrl = 'data:image/webp;base64,QUJD'
    expect(getImageSource({ b64_json: dataUrl })).toBe(dataUrl)
  })

  it('returns null when the record carries no image', () => {
    expect(getImageSource({ revised_prompt: 'p' })).toBeNull()
  })
})

describe('workbenchErrorMessage', () => {
  it('prefers the upstream message over the fallback', () => {
    const error = { response: { data: { error: { message: 'upstream refused' } } } }
    expect(workbenchErrorMessage(error, 'fallback')).toBe('upstream refused')
  })

  it('falls back to the error message, then to the caller fallback', () => {
    expect(workbenchErrorMessage(new Error('network down'), 'fallback')).toBe('network down')
    expect(workbenchErrorMessage(undefined, 'fallback')).toBe('fallback')
  })
})

describe('formatQuota', () => {
  it('groups large quota amounts and keeps zero bare', () => {
    expect(formatQuota(0)).toBe('0')
    expect(formatQuota(1234567)).toBe('1,234,567')
  })
})
