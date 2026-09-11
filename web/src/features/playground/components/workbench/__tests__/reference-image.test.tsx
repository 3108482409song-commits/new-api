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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ImagePanel } from '../image-panel'

// Choosing a reference image must replace the upload button with a preview of
// that image; otherwise the reference edit mode looks like it silently ignored
// the picker.
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

function switchToReferenceEdit() {
  fireEvent.click(screen.getByText('Reference image edit'))
}

function chooseReferenceFile(name: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) {
    throw new Error('the reference image picker is not rendered')
  }
  const file = new File(['reference-bytes'], name, { type: 'image/png' })
  fireEvent.change(input, { target: { files: [file] } })
}

afterEach(() => vi.restoreAllMocks())

it('shows the picked reference image instead of the upload button', async () => {
  mockApi()
  renderImagePanel()
  await screen.findAllByRole('combobox')

  switchToReferenceEdit()
  expect(screen.getByText('Upload reference image')).toBeInTheDocument()
  expect(screen.queryByAltText('Reference image')).not.toBeInTheDocument()

  chooseReferenceFile('reference.png')

  await waitFor(() =>
    expect(screen.getByAltText('Reference image')).toBeInTheDocument()
  )
  expect(screen.queryByText('Upload reference image')).not.toBeInTheDocument()
})
