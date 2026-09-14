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
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { TaskPanel } from '../task-panel'

const IMAGE_TASK = {
  id: 7,
  task_id: 'task-image-1',
  platform: 'image',
  action: 'text2img',
  status: 'SUCCESS',
  progress: '100%',
  fail_reason: '',
  submit_time: 1700000000,
  start_time: 1700000000,
  finish_time: 1700000060,
  // 20000 units at the default 500000 per USD, i.e. four cents.
  quota: 20000,
  group: 'default',
  properties: { input: 'a blue whale', origin_model_name: 'gpt-image-2' },
  preview: 'https://example.com/thumb.jpg',
}

type GetCall = { url: string; params?: Record<string, unknown> }

function mockApi(options: {
  items?: unknown[]
  total?: number
  detail?: unknown
}) {
  const calls: GetCall[] = []
  vi.spyOn(api, 'get').mockImplementation((url, config) => {
    const params = (config as { params?: Record<string, unknown> } | undefined)
      ?.params
    calls.push({ url: String(url), params })
    if (url === '/api/task/self') {
      return Promise.resolve({
        data: {
          success: true,
          data: { items: options.items ?? [], total: options.total ?? 0 },
        },
      })
    }
    if (typeof url === 'string' && url.startsWith('/api/task/self/')) {
      return Promise.resolve({
        data: { success: true, data: options.detail ?? null },
      })
    }
    return Promise.reject(new Error(`Unexpected GET ${String(url)}`))
  })
  return calls
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <TaskPanel active />
    </QueryClientProvider>
  )
}

function listCalls(calls: GetCall[]) {
  return calls.filter((call) => call.url === '/api/task/self')
}

afterEach(() => vi.restoreAllMocks())

// The list is paged on the server, so the request has to carry the page the
// operator is looking at and how many records one page holds.
it('asks the server for fifteen records of the first page', async () => {
  const calls = mockApi({ items: [IMAGE_TASK], total: 40 })
  renderPanel()

  expect(await screen.findByText('a blue whale')).toBeInTheDocument()
  const [first] = listCalls(calls)
  expect(first?.params?.p).toBe(1)
  expect(first?.params?.page_size).toBe(15)
  expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
})

it('walks to the next page through the server', async () => {
  const user = userEvent.setup()
  const calls = mockApi({ items: [IMAGE_TASK], total: 40 })
  renderPanel()

  await screen.findByText('a blue whale')
  await user.click(screen.getByRole('button', { name: 'Next page' }))

  await waitFor(() => {
    expect(listCalls(calls).some((call) => call.params?.p === 2)).toBe(true)
  })
})

// One filter stands for several statuses. Filtering them on the client would only
// ever see the current page, so every status has to travel to the server.
it('sends every status a filter stands for', async () => {
  const user = userEvent.setup()
  const calls = mockApi({ items: [IMAGE_TASK], total: 1 })
  renderPanel()

  await screen.findByText('a blue whale')
  await user.click(screen.getByRole('tab', { name: 'Running' }))

  await waitFor(() => {
    const running = listCalls(calls).find(
      (call) => call.params?.statuses !== undefined
    )
    expect(running?.params?.statuses).toBe(
      'NOT_START,SUBMITTED,QUEUED,IN_PROGRESS'
    )
  })
})

it('shows the preview the list carries as the row thumbnail', async () => {
  mockApi({ items: [IMAGE_TASK], total: 1 })
  const { container } = renderPanel()

  await screen.findByText('a blue whale')
  expect(
    container.querySelector('img[src="https://example.com/thumb.jpg"]')
  ).not.toBeNull()
})

// Quota is an internal unit that is never billed; the column reports what the
// call actually consumed, in the configured display currency.
it('reports the consumed amount as money, not as quota units', async () => {
  mockApi({ items: [IMAGE_TASK], total: 1 })
  renderPanel()

  expect(await screen.findByText('$0.04')).toBeInTheDocument()
  expect(screen.queryByText('20,000')).not.toBeInTheDocument()
})

// The list only carries a preview, so the full result has to be fetched for the
// one record being opened.
it('loads the full record when a row is opened', async () => {
  const user = userEvent.setup()
  const calls = mockApi({
    items: [IMAGE_TASK],
    total: 1,
    detail: {
      ...IMAGE_TASK,
      data: { images: [{ url: 'https://example.com/full.png' }], n: 1 },
    },
  })
  renderPanel()

  await user.click(await screen.findByText('a blue whale'))

  await waitFor(() => {
    expect(
      calls.some((call) => call.url === '/api/task/self/task-image-1')
    ).toBe(true)
  })
  expect(
    await screen.findByRole('img', { name: 'Generated image' })
  ).toHaveAttribute('src', 'https://example.com/full.png')
})
