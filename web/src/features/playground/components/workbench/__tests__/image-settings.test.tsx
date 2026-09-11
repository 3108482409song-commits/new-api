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
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ImagePanel } from '../image-panel'

// The generation settings drive both the request and the quoted price, so the
// control set is a contract: the size selector must expose every aspect the
// workbench supports, the dense option groups stay three per row, and the image
// count must stay inside the range the billing validators accept.
const ASPECTS = ['1:1', '3:2', '2:3', '16:9', '9:16']
const MAX_IMAGE_COUNT = '10'

function mockImageApi() {
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
          data: [{ name: 'gpt-image-1', image: true, video: false }],
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

function renderImagePanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ImagePanel active />
    </QueryClientProvider>
  )
}

afterEach(() => vi.restoreAllMocks())

it('offers landscape and portrait sizes alongside the square ones', async () => {
  mockImageApi()
  renderImagePanel()

  const sizeGroup = await screen.findByLabelText('Image size')
  for (const aspect of ASPECTS) {
    expect(within(sizeGroup).getByText(aspect)).toBeInTheDocument()
  }
})

it('labels the size selector as an image size, not a canvas size', async () => {
  mockImageApi()
  renderImagePanel()

  expect(await screen.findByLabelText('Image size')).toBeInTheDocument()
})

it('lays the size and quality choices out three per row', async () => {
  mockImageApi()
  renderImagePanel()

  expect(await screen.findByLabelText('Image size')).toHaveClass('grid-cols-3')
  expect(screen.getByLabelText('Quality')).toHaveClass('grid-cols-3')
})

it('steps the image count between its bounds', async () => {
  mockImageApi()
  const user = userEvent.setup()
  renderImagePanel()

  const count = await screen.findByLabelText('Image count')
  const decrease = screen.getByRole('button', { name: 'Decrease' })
  const increase = screen.getByRole('button', { name: 'Increase' })

  expect(count).toHaveValue('1')
  expect(decrease).toBeDisabled()

  await user.click(increase)
  expect(count).toHaveValue('2')

  for (let step = 0; step < 8; step++) {
    await user.click(increase)
  }
  expect(count).toHaveValue(MAX_IMAGE_COUNT)
  expect(increase).toBeDisabled()

  await user.click(decrease)
  expect(count).toHaveValue('9')
})

it('accepts a manually retyped image count and clamps it on commit', async () => {
  mockImageApi()
  renderImagePanel()

  const count = await screen.findByLabelText('Image count')

  // Clearing must be possible while editing, otherwise the value cannot be
  // selected and replaced.
  fireEvent.change(count, { target: { value: '' } })
  expect(count).toHaveValue('')

  fireEvent.change(count, { target: { value: '7' } })
  fireEvent.blur(count)
  expect(count).toHaveValue('7')

  fireEvent.change(count, { target: { value: '99' } })
  fireEvent.blur(count)
  expect(count).toHaveValue(MAX_IMAGE_COUNT)

  fireEvent.change(count, { target: { value: '0' } })
  fireEvent.blur(count)
  expect(count).toHaveValue('1')
})

it('shows no native number spinner beside the image count', async () => {
  mockImageApi()
  renderImagePanel()

  await screen.findByLabelText('Image count')
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
})
