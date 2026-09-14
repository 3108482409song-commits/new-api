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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ImagePanel } from '../image-panel'

const GENERATED_IMAGE = 'https://example.com/generated.png'

const FINISHED_TASK = {
  id: 1,
  task_id: 'task-abcdef',
  platform: 'image',
  action: 'text2img',
  status: 'SUCCESS',
  progress: '100%',
  fail_reason: '',
  submit_time: 1700000000,
  start_time: 1700000000,
  finish_time: 1700000060,
  quota: 500000,
  group: 'default',
  properties: { input: 'a red fox', origin_model_name: 'gpt-image-2' },
  // The list ships a preview only; `data` arrives with the detail request.
  preview: 'https://example.com/history-thumb.jpg',
  data: {
    images: [{ url: 'https://example.com/history.png' }],
    size: '1024x1024',
    n: 1,
  },
}

function mockApi(options: { usePrice: boolean; tasks?: unknown[]; count?: number }) {
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url === '/api/user/self/groups') {
      return Promise.resolve({
        data: { success: true, data: { default: { desc: 'Default', ratio: 1 } } },
      })
    }
    if (url === '/api/workbench/models') {
      return Promise.resolve({
        data: { success: true, data: [{ name: 'gpt-image-2', image: true, video: false }] },
      })
    }
    if (url === '/api/task/self') {
      return Promise.resolve({
        data: { success: true, data: { items: options.tasks ?? [], total: 0 } },
      })
    }
    // Opening a record loads its full result: the list only carries a preview.
    if (typeof url === 'string' && url.startsWith('/api/task/self/')) {
      const opened = (options.tasks ?? [])[0]
      if (!opened) {
        return Promise.reject(new Error('Task not found'))
      }
      return Promise.resolve({ data: { success: true, data: opened } })
    }
    return Promise.reject(new Error(`Unexpected GET ${String(url)}`))
  })

  vi.spyOn(api, 'post').mockImplementation((url) => {
    if (url === '/api/workbench/estimate') {
      return Promise.resolve({
        data: {
          success: true,
          data: {
            quota: 500000,
            usd: 1,
            free_model: false,
            use_price: options.usePrice,
            estimate: true,
          },
        },
      })
    }
    if (url === '/pg/images/generations') {
      const count = options.count ?? 1
      const images =
        count === 1
          ? [{ url: GENERATED_IMAGE }]
          : Array.from({ length: count }, (_, index) => ({
              url: `${GENERATED_IMAGE}?i=${index}`,
            }))
      return Promise.resolve({ data: { created: 1, data: images } })
    }
    return Promise.reject(new Error(`Unexpected POST ${String(url)}`))
  })

  vi.spyOn(api, 'delete').mockResolvedValue({ data: { success: true, data: {} } })
}

function renderImagePanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ImagePanel active />
    </QueryClientProvider>
  )
}

async function generateOnce() {
  const user = userEvent.setup()
  renderImagePanel()
  await user.type(await screen.findByLabelText('Prompt'), 'a red fox')
  await user.click(screen.getByRole('button', { name: 'Generate' }))
  return user
}

afterEach(() => vi.restoreAllMocks())

// A configured per-call price is the exact amount for this request, so calling it
// an estimate understates what the console knows.
it('shows a configured price as the price', async () => {
  mockApi({ usePrice: true })
  renderImagePanel()

  expect(await screen.findByText(/Price:/)).toBeInTheDocument()
  expect(screen.queryByText(/Estimated price:/)).not.toBeInTheDocument()
})

// The price is already money, and the quota behind it is an internal unit that is
// never billed, so showing it alongside the price is noise.
it('shows only the money when the price is configured', async () => {
  mockApi({ usePrice: true })
  renderImagePanel()

  const price = await screen.findByText(/Price:/)
  expect(price).toHaveTextContent('Price: $1.0000')
  expect(price).not.toHaveTextContent('500,000')
  expect(price).not.toHaveTextContent('quota')
})

// A token-ratio pre-consume is only a guess, so that one keeps its label.
it('keeps calling a ratio pre-consume an estimate', async () => {
  mockApi({ usePrice: false })
  renderImagePanel()

  expect(await screen.findByText(/Estimated price:/)).toBeInTheDocument()
  expect(screen.queryByText(/Price:/)).not.toBeInTheDocument()
})

it('prints the model, time and status on the generated image', async () => {
  mockApi({ usePrice: true })
  await generateOnce()

  const figure = await screen.findByRole('figure')
  expect(within(figure).getByText(/gpt-image-2 · \d{2}-\d{2} \d{2}:\d{2}/)).toBeInTheDocument()
  expect(within(figure).getByText('Completed')).toBeInTheDocument()
  expect(within(figure).getByRole('img')).toHaveAttribute('src', GENERATED_IMAGE)
})

// The prompt belongs in the history list; printing it over the result covers the
// picture it describes.
it('never prints the prompt on the result itself', async () => {
  mockApi({ usePrice: true })
  await generateOnce()

  const figure = await screen.findByRole('figure')
  expect(within(figure).queryByText('a red fox')).not.toBeInTheDocument()
})

it('offers a download on the generated image', async () => {
  mockApi({ usePrice: true })
  await generateOnce()

  const figure = await screen.findByRole('figure')
  const download = within(figure).getByRole('link', { name: 'Download' })
  expect(download).toHaveAttribute('href', GENERATED_IMAGE)
  expect(download).toHaveAttribute('download')
})

// Saved files are named after what they are and when they were made, so a
// download never arrives as an opaque id or a data-URL blob.
it('names a saved image creation-<timestamp>', async () => {
  mockApi({ usePrice: true })
  await generateOnce()

  const figure = await screen.findByRole('figure')
  expect(within(figure).getByRole('link', { name: 'Download' })).toHaveAttribute(
    'download',
    expect.stringMatching(/^creation-\d{8}-\d{6}\.png$/)
  )
})

// Several images from one request share a timestamp, so their names have to be
// numbered or the browser would save them as "file", "file (1)", "file (2)".
it('numbers the saved names when one request returns several images', async () => {
  mockApi({ usePrice: true, count: 3 })
  await generateOnce()

  const names = (await screen.findAllByRole('link', { name: 'Download' })).map(
    (link) => link.getAttribute('download')
  )
  expect(names).toHaveLength(3)
  expect(names[0]).toMatch(/^creation-\d{8}-\d{6}-1\.png$/)
  expect(names[1]).toMatch(/-2\.png$/)
  expect(names[2]).toMatch(/-3\.png$/)
})

// A remote link carries no mime type, so the extension comes from its path.
it('takes the extension from a linked image path', async () => {
  const user = userEvent.setup()
  mockApi({
    usePrice: true,
    tasks: [
      {
        ...FINISHED_TASK,
        data: { images: [{ url: 'https://example.com/history.jpeg' }], n: 1 },
      },
    ],
  })
  renderImagePanel()

  await user.click(await screen.findByText('a red fox'))

  const figure = await screen.findByRole('figure')
  expect(within(figure).getByRole('link', { name: 'Download' })).toHaveAttribute(
    'download',
    expect.stringMatching(/^creation-\d{8}-\d{6}\.jpg$/)
  )
})

it('lists a generation with its prompt, model and timestamp', async () => {
  mockApi({ usePrice: true, tasks: [FINISHED_TASK] })
  renderImagePanel()

  expect(await screen.findByText('a red fox')).toBeInTheDocument()
  expect(
    screen.getByText(/gpt-image-2 · \d{2}-\d{2} \d{2}:\d{2}/)
  ).toBeInTheDocument()
})

// The row shows the small preview the list carries, not the full result: a page
// of original images would be tens of megabytes.
it('shows the row preview as the history thumbnail', async () => {
  mockApi({ usePrice: true, tasks: [FINISHED_TASK] })
  renderImagePanel()

  const thumbnail = await screen.findByAltText('a red fox')
  expect(thumbnail).toHaveAttribute('src', 'https://example.com/history-thumb.jpg')
})

it('shows the selected history entry in the viewer', async () => {
  const user = userEvent.setup()
  mockApi({ usePrice: true, tasks: [FINISHED_TASK] })
  renderImagePanel()

  await user.click(await screen.findByText('a red fox'))

  const figure = await screen.findByRole('figure')
  expect(within(figure).getByRole('img')).toHaveAttribute(
    'src',
    'https://example.com/history.png'
  )
})

it('deletes a finished record from its row', async () => {
  const user = userEvent.setup()
  mockApi({ usePrice: true, tasks: [FINISHED_TASK] })
  renderImagePanel()

  await user.click(await screen.findByRole('button', { name: 'Delete' }))

  await waitFor(() =>
    expect(vi.mocked(api.delete)).toHaveBeenCalledWith(
      '/api/task/self/task-abcdef',
      expect.anything()
    )
  )
})

// Deleting a running record would hide the upstream job that still has to be
// collected, so the backend refuses it and the control is not offered.
it('does not offer a delete while a record is still running', async () => {
  mockApi({
    usePrice: true,
    tasks: [{ ...FINISHED_TASK, status: 'IN_PROGRESS', data: null }],
  })
  renderImagePanel()

  await screen.findByText('a red fox')
  expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
})
