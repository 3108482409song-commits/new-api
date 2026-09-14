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
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ImagePanel } from '../image-panel'

// Choosing a reference image must replace the upload button with a preview of
// that image; otherwise the reference edit mode looks like it silently ignored
// the picker.
//
// How many images the panel accepts is not decided here: it is whatever the
// models endpoint published for the selected model, so these tests drive it the
// way the server does instead of asserting a hardcoded client-side rule.
const SINGLE_IMAGE_MODEL = { name: 'gpt-image-1', image: true, video: false }
const MULTI_IMAGE_MODEL = {
  name: 'gpt-image-2',
  image: true,
  video: false,
  max_reference_images: 4,
}
const NARROW_IMAGE_MODEL = {
  name: 'narrow-image',
  image: false,
  video: false,
  max_reference_images: 1,
}

function mockApi(models = [SINGLE_IMAGE_MODEL, MULTI_IMAGE_MODEL]) {
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url === '/api/user/self/groups') {
      return Promise.resolve({
        data: { success: true, data: { default: { desc: 'Default', ratio: 1 } } },
      })
    }
    if (url === '/api/workbench/models') {
      return Promise.resolve({ data: { success: true, data: models } })
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
    if (url === '/pg/images/edits') {
      return Promise.resolve({
        data: { created: 1, data: [{ url: 'https://cdn/1.png' }] },
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

// A real 1x1 PNG: the picker now validates the decoded bytes, so a placeholder
// string would be rejected before the preview appears.
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
])

/**
 * The same PNG signature with a distinct tail, so every picked file is a
 * different image. Two identical files are one reference image by design, which
 * would make a multi-image assertion vacuous.
 */
function pngMarked(marker: number): Uint8Array {
  const bytes = new Uint8Array(PNG_BYTES.length + 4)
  bytes.set(PNG_BYTES)
  bytes.set([marker, marker, marker, marker], PNG_BYTES.length)
  return bytes
}

function chooseReferenceFiles(
  names: string[],
  bytes?: Uint8Array,
  type = 'image/png'
) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) {
    throw new Error('the reference image picker is not rendered')
  }
  const files = names.map((name, index) => {
    const content = bytes ?? pngMarked(index + 1)
    // Copy into a plain ArrayBuffer: a Uint8Array view is not a BlobPart under
    // TypeScript's typed-array generics.
    const buffer = new ArrayBuffer(content.byteLength)
    new Uint8Array(buffer).set(content)
    return new File([buffer], name, { type })
  })
  fireEvent.change(input, { target: { files } })
}

async function selectModel(name: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('combobox', { name: 'Model' }))
  await user.click(await screen.findByRole('option', { name }))
}

afterEach(() => vi.restoreAllMocks())

it('shows the picked reference image instead of the upload button', async () => {
  mockApi()
  renderImagePanel()
  await screen.findAllByRole('combobox')

  switchToReferenceEdit()
  expect(screen.getByText('Upload reference image')).toBeInTheDocument()
  expect(screen.queryByAltText('Reference image')).not.toBeInTheDocument()

  chooseReferenceFiles(['reference.png'])

  await waitFor(() =>
    expect(screen.getByAltText('Reference image')).toBeInTheDocument()
  )
  expect(screen.queryByText('Upload reference image')).not.toBeInTheDocument()
})

// A renamed or truncated file must not stay selected, otherwise it would be
// submitted as the reference image.
it('keeps a reference image whose bytes are not an image out of the form', async () => {
  mockApi()
  renderImagePanel()
  await screen.findAllByRole('combobox')

  switchToReferenceEdit()
  chooseReferenceFiles(
    ['reference.png'],
    new TextEncoder().encode('this is plain text, not an image')
  )

  await waitFor(() =>
    expect(
      screen.getByText('Failed to read the reference image')
    ).toBeInTheDocument()
  )
  expect(screen.queryByAltText('Reference image')).not.toBeInTheDocument()
  expect(screen.getByText('Upload reference image')).toBeInTheDocument()
})

// ── 参考图数量 ─────────────────────────────────────────────────────────────
// 上限由服务端发布，面板只负责显示与执行它。这里同时守住「显示的数字」与
// 「实际提交的图片」两者一致。

it('shows how many reference images are attached against the model limit', async () => {
  mockApi()
  renderImagePanel()
  await screen.findAllByRole('combobox')
  await selectModel('gpt-image-2')

  switchToReferenceEdit()

  // The limit is visible before it is reached, not only once it is hit.
  expect(await screen.findByText('0/4')).toBeInTheDocument()

  chooseReferenceFiles(['a.png', 'b.png'])

  await waitFor(() => expect(screen.getByText('2/4')).toBeInTheDocument())
})

it('sends every attached image when generating', async () => {
  mockApi()
  renderImagePanel()
  await screen.findAllByRole('combobox')
  await selectModel('gpt-image-2')

  switchToReferenceEdit()
  chooseReferenceFiles(['a.png', 'b.png', 'c.png'])
  await waitFor(() => expect(screen.getByText('3/4')).toBeInTheDocument())

  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('Prompt'), 'a red fox')
  await user.click(screen.getByRole('button', { name: 'Generate' }))

  await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalled())
  const call = vi
    .mocked(api.post)
    .mock.calls.find(([url]) => url === '/pg/images/edits')
  const form = call?.[1] as FormData
  expect(form.getAll('image')).toHaveLength(3)
})

// A batch one over the limit is refused as a whole: silently adding the first
// four would leave the panel showing a set the operator never chose.
it('rejects a batch that would exceed the model limit instead of truncating it', async () => {
  mockApi()
  renderImagePanel()
  await screen.findAllByRole('combobox')
  await selectModel('gpt-image-2')

  switchToReferenceEdit()
  await screen.findByText('0/4')

  chooseReferenceFiles(['a.png', 'b.png', 'c.png', 'd.png', 'e.png'])

  await waitFor(() =>
    expect(screen.getByText('At most 4 reference images')).toBeInTheDocument()
  )
  expect(screen.getByText('0/4')).toBeInTheDocument()
  expect(screen.getByText('Upload reference image')).toBeInTheDocument()
})

it('stops offering the picker once the limit is reached', async () => {
  mockApi()
  renderImagePanel()
  await screen.findAllByRole('combobox')
  await selectModel('gpt-image-2')

  switchToReferenceEdit()
  await screen.findByText('0/4')

  chooseReferenceFiles(['a.png', 'b.png', 'c.png', 'd.png'])

  await waitFor(() => expect(screen.getByText('4/4')).toBeInTheDocument())
  expect(screen.queryByText('Upload reference image')).not.toBeInTheDocument()
})

it('removes one reference image from its thumbnail', async () => {
  mockApi()
  renderImagePanel()
  await screen.findAllByRole('combobox')
  await selectModel('gpt-image-2')

  switchToReferenceEdit()
  chooseReferenceFiles(['a.png', 'b.png'])
  await waitFor(() => expect(screen.getByText('2/4')).toBeInTheDocument())

  const user = userEvent.setup()
  await user.click(screen.getAllByLabelText('Remove')[0])

  expect(await screen.findByText('1/4')).toBeInTheDocument()
  expect(screen.getByText('Upload reference image')).toBeInTheDocument()
})

// Switching to a model with a smaller limit must not leave more images attached
// than the server will accept: the submit would fail with no visible cause.
it('drops the images the newly selected model cannot accept', async () => {
  mockApi([MULTI_IMAGE_MODEL, NARROW_IMAGE_MODEL])
  renderImagePanel()
  await screen.findAllByRole('combobox')

  switchToReferenceEdit()
  chooseReferenceFiles(['a.png', 'b.png', 'c.png'])
  await waitFor(() => expect(screen.getByText('3/4')).toBeInTheDocument())

  await selectModel('narrow-image')

  expect(await screen.findByText('1/1')).toBeInTheDocument()
  expect(screen.getByText('At most 1 reference images')).toBeInTheDocument()
})

// A model with no published limit keeps the original single-image form instead of
// being given a cap the server does not enforce.
it('keeps the single-image form when no limit is published', async () => {
  mockApi([SINGLE_IMAGE_MODEL])
  renderImagePanel()
  await screen.findAllByRole('combobox')

  switchToReferenceEdit()
  expect(screen.queryByText(/\d\/\d/)).not.toBeInTheDocument()

  chooseReferenceFiles(['a.png'])
  await waitFor(() =>
    expect(screen.getByAltText('Reference image')).toBeInTheDocument()
  )
  expect(screen.queryByText('Upload reference image')).not.toBeInTheDocument()
})
