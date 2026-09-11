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
import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ImagePanel } from '../image-panel'
import { VideoPanel } from '../video-panel'

// Both settings sidebars hold a fixed share of the workspace on desktop, so
// neither may be draggable and the divider must not be a live handle — a handle
// there would offer a resize that cannot happen and a not-allowed cursor. The
// width itself is set with percentage strings on purpose (a bare number means
// PIXELS to react-resizable-panels) but can only be measured with real layout,
// so it stays a visual check.
function mockApi() {
  vi.spyOn(api, 'get').mockImplementation((url) => {
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

function renderPanel(panel: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{panel}</QueryClientProvider>)
}

function renderedPanels(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-panel]')]
}

afterEach(() => vi.restoreAllMocks())

it.each([
  ['image', <ImagePanel active />],
  ['video', <VideoPanel active />],
])('%s sidebars are both locked', async (_name, panel) => {
  mockApi()
  renderPanel(panel)
  await screen.findAllByRole('combobox')

  const panels = renderedPanels()
  expect(panels).toHaveLength(3)
  expect(panels[0]).toHaveAttribute('data-disabled')
  expect(panels[2]).toHaveAttribute('data-disabled')
})

it.each([
  ['image', <ImagePanel active />],
  ['video', <VideoPanel active />],
])('%s panels expose no draggable divider on desktop', async (_name, panel) => {
  mockApi()
  renderPanel(panel)
  await screen.findAllByRole('combobox')

  expect(document.querySelectorAll('[data-slot="resizable-handle"]')).toHaveLength(0)
})
