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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { Playground } from '../index'

// The workbench keeps every tab panel mounted, so work in progress survives a
// detour to another tab. Unmounting a panel discards the prompt, the uploaded
// reference frames and the rendered result with it.
const IMAGE_PROMPT = 'Describe the image you want to generate...'
const VIDEO_PROMPT = 'Describe the video you want to generate'

function mockPlaygroundApi() {
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url === '/api/user/models') {
      return Promise.resolve({ data: { success: true, data: ['gpt-image-1'] } })
    }
    if (url === '/api/user/self/groups') {
      return Promise.resolve({
        data: { success: true, data: { default: { desc: 'Default', ratio: 1 } } },
      })
    }
    if (url === '/api/workbench/models') {
      return Promise.resolve({
        data: {
          success: true,
          data: [
            { name: 'gpt-image-1', image: true, video: false },
            { name: 'kling-v1', image: false, video: true, platform: 'kling' },
          ],
        },
      })
    }
    if (url === '/api/task/self') {
      return Promise.resolve({ data: { success: true, data: { items: [], total: 0 } } })
    }
    return Promise.reject(new Error(`Unexpected GET ${String(url)}`))
  })
  vi.spyOn(api, 'post').mockImplementation((url) => {
    if (url === '/api/workbench/estimate') {
      return Promise.resolve({
        data: {
          success: true,
          data: { quota: 1000, usd: 0.002, free_model: false, estimate: true },
        },
      })
    }
    return Promise.reject(new Error(`Unexpected POST ${String(url)}`))
  })
}

function renderPlayground() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Playground />
    </QueryClientProvider>
  )
}

afterEach(() => vi.restoreAllMocks())

it.each([
  ['Image', IMAGE_PROMPT],
  ['Video', VIDEO_PROMPT],
])(
  'keeps in-progress %s input when the user visits another tab',
  async (tab, placeholder) => {
    mockPlaygroundApi()
    const user = userEvent.setup()
    renderPlayground()

    await user.click(screen.getByRole('tab', { name: tab }))
    const prompt = await screen.findByPlaceholderText(placeholder)
    // These fields live inside a resizable panel, where userEvent cannot drive
    // focus in jsdom; the change event exercises the same controlled-state path.
    fireEvent.change(prompt, { target: { value: 'a red fox' } })
    expect(prompt).toHaveValue('a red fox')

    await user.click(screen.getByRole('tab', { name: 'Task list' }))
    await user.click(screen.getByRole('tab', { name: tab }))

    expect(screen.getByPlaceholderText(placeholder)).toHaveValue('a red fox')
  }
)
