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
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ImagePanel } from '../image-panel'
import { VideoPanel } from '../video-panel'

// The image and video panels read the same `['workbench-models', group]` query
// entry. These tests pin the contract that makes sharing it safe: the entry
// caches the raw capability list and each panel narrows it locally. When the
// entry cached a panel-shaped list instead, the other panel's filter matched
// nothing and its model picker rendered empty.
const IMAGE_MODEL = 'gpt-image-1'
const VIDEO_MODEL = 'kling-v1'

const MODELS = [
  { name: IMAGE_MODEL, image: true, video: false },
  { name: VIDEO_MODEL, image: false, video: true, platform: 'kling' },
]

function mockWorkbenchApi() {
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url === '/api/user/self/groups') {
      return Promise.resolve({
        data: { success: true, data: { default: { desc: 'Default', ratio: 1 } } },
      })
    }
    if (url === '/api/workbench/models') {
      return Promise.resolve({ data: { success: true, data: MODELS } })
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

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/** Label shown by each selector trigger in the rendered panel, in DOM order. */
function selectorLabels(): string[] {
  return screen.getAllByRole('combobox').map((element) => element.textContent ?? '')
}

function expectSelectorToOffer(model: string) {
  return waitFor(() =>
    expect(selectorLabels()).toContainEqual(expect.stringContaining(model))
  )
}

function renderPanel(client: QueryClient, panel: ReactElement) {
  return render(<QueryClientProvider client={client}>{panel}</QueryClientProvider>)
}

afterEach(() => vi.restoreAllMocks())

it('still lists video models after the image panel warmed the shared query', async () => {
  mockWorkbenchApi()
  const client = newClient()

  const image = renderPanel(client, <ImagePanel active />)
  await expectSelectorToOffer(IMAGE_MODEL)
  image.unmount()

  renderPanel(client, <VideoPanel active />)
  await expectSelectorToOffer(VIDEO_MODEL)
})

it('still lists image models after the video panel warmed the shared query', async () => {
  mockWorkbenchApi()
  const client = newClient()

  const video = renderPanel(client, <VideoPanel active />)
  await expectSelectorToOffer(VIDEO_MODEL)
  video.unmount()

  renderPanel(client, <ImagePanel active />)
  await expectSelectorToOffer(IMAGE_MODEL)
})

it('serves both panels from one cached capability request', async () => {
  mockWorkbenchApi()
  const client = newClient()

  const image = renderPanel(client, <ImagePanel active />)
  await expectSelectorToOffer(IMAGE_MODEL)
  image.unmount()
  renderPanel(client, <VideoPanel active />)
  await expectSelectorToOffer(VIDEO_MODEL)

  const modelRequests = vi
    .mocked(api.get)
    .mock.calls.filter(([url]) => url === '/api/workbench/models')
  expect(modelRequests).toHaveLength(1)
})
