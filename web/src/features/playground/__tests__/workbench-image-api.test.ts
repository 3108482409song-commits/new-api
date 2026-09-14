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
import { describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { editWorkbenchImage, generateWorkbenchImage } from '../api'
import { WORKBENCH_ENDPOINTS, WORKBENCH_GROUP_HEADER } from '../constants'

const GENERATE_PAYLOAD = {
  group: 'vip',
  model: 'gpt-image-1',
  prompt: 'a red apple',
  n: 1,
  size: '1024x1024',
}

// Real 1x1 PNG / minimal JPEG payloads: the uploader validates the decoded
// bytes, so a signature-only or renamed payload would be rejected.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const JPEG_DATA_URL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

/** api.post is typed against axios; these tests only care about the payload. */
function mockPostOnce(respond: () => unknown) {
  return vi
    .spyOn(api, 'post')
    .mockImplementation((() => Promise.resolve(respond())) as never)
}

describe('generateWorkbenchImage', () => {
  it('returns the resolved image array', async () => {
    mockPostOnce(() => ({
      data: { created: 1, data: [{ url: 'https://cdn/1.png' }] },
    }))

    await expect(generateWorkbenchImage(GENERATE_PAYLOAD)).resolves.toEqual([
      { url: 'https://cdn/1.png' },
    ])
  })

  it('treats an explicit empty array as a valid result', async () => {
    mockPostOnce(() => ({ data: { created: 1, data: [] } }))

    await expect(generateWorkbenchImage(GENERATE_PAYLOAD)).resolves.toEqual([])
  })

  it('sends the group as a header and never inside the JSON body', async () => {
    const spy = mockPostOnce(() => ({ data: { data: [] } }))

    await generateWorkbenchImage(GENERATE_PAYLOAD)

    const [url, body, config] = spy.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { headers: Record<string, string> },
    ]
    expect(url).toBe(WORKBENCH_ENDPOINTS.IMAGE_GENERATIONS)
    expect(config.headers[WORKBENCH_GROUP_HEADER]).toBe('vip')
    expect(body).not.toHaveProperty('group')
  })

  // A business failure must not degrade into "no images generated": that hides
  // whether the channel, the group, the model or the request was at fault.
  it('surfaces a business failure instead of returning an empty result', async () => {
    mockPostOnce(() => ({
      data: { success: false, message: 'no available channel for group vip' },
    }))

    await expect(generateWorkbenchImage(GENERATE_PAYLOAD)).rejects.toThrow(
      'no available channel for group vip',
    )
  })

  it('keeps the raw relay error response on an HTTP failure', async () => {
    vi.spyOn(api, 'post').mockImplementation(
      (() =>
        Promise.reject({
          response: {
            status: 400,
            data: { error: { message: 'model is required' } },
          },
        })) as never,
    )

    await expect(
      generateWorkbenchImage(GENERATE_PAYLOAD),
    ).rejects.toMatchObject({
      response: { data: { error: { message: 'model is required' } } },
    })
  })

  it('rejects a success payload whose data is not an array', async () => {
    mockPostOnce(() => ({ data: { success: true } }))

    await expect(generateWorkbenchImage(GENERATE_PAYLOAD)).rejects.toThrow(
      /data array/,
    )
  })
})

describe('editWorkbenchImage', () => {
  it('uploads the reference image with a filename matching its MIME type', async () => {
    const spy = mockPostOnce(() => ({ data: { data: [{ b64_json: 'AAAA' }] } }))

    await editWorkbenchImage({
      ...GENERATE_PAYLOAD,
      images: [JPEG_DATA_URL],
    })

    const [url, body, config] = spy.mock.calls[0] as unknown as [
      string,
      FormData,
      { headers: Record<string, string> },
    ]
    expect(url).toBe(WORKBENCH_ENDPOINTS.IMAGE_EDITS)
    expect(body).toBeInstanceOf(FormData)

    const file = body.get('image') as File
    expect(file.name).toBe('reference.jpg')
    expect(file.type).toBe('image/jpeg')
    expect(body.get('model')).toBe('gpt-image-1')
    expect(body.get('size')).toBe('1024x1024')

    // The browser must generate the multipart boundary, so Content-Type stays unset.
    expect(config.headers).not.toHaveProperty('Content-Type')
    expect(config.headers[WORKBENCH_GROUP_HEADER]).toBe('vip')
  })

  // Each reference image is its own "image" part, which is the multipart form the
  // relay resolves, validates and forwards for a multi-reference edit. Sending one
  // part would silently drop the rest.
  it('uploads every reference image as its own part', async () => {
    const spy = mockPostOnce(() => ({ data: { data: [] } }))

    await editWorkbenchImage({
      ...GENERATE_PAYLOAD,
      images: [PNG_DATA_URL, JPEG_DATA_URL, PNG_DATA_URL],
    })

    const [, body] = spy.mock.calls[0] as unknown as [string, FormData]
    const files = body.getAll('image') as File[]
    expect(files).toHaveLength(3)
    expect(files.map((file) => file.name)).toEqual([
      'reference.png',
      'reference.jpg',
      'reference.png',
    ])
  })

  it('keeps a PNG reference named .png', async () => {
    const spy = mockPostOnce(() => ({ data: { data: [] } }))

    await editWorkbenchImage({
      ...GENERATE_PAYLOAD,
      images: [PNG_DATA_URL],
    })

    const [, body] = spy.mock.calls[0] as unknown as [string, FormData]
    const file = body.get('image') as File
    expect(file.name).toBe('reference.png')
    expect(file.type).toBe('image/png')
  })

  it('surfaces a business failure instead of returning an empty result', async () => {
    mockPostOnce(() => ({
      data: {
        success: false,
        message: 'this channel does not support image editing',
      },
    }))

    await expect(
      editWorkbenchImage({ ...GENERATE_PAYLOAD, images: [PNG_DATA_URL] }),
    ).rejects.toThrow('this channel does not support image editing')
  })

  // A renamed file must never reach the upstream, on top of the picker's check.
  it('refuses to upload a reference image whose bytes are not an image', async () => {
    const spy = mockPostOnce(() => ({ data: { data: [] } }))

    await expect(
      editWorkbenchImage({
        ...GENERATE_PAYLOAD,
        images: ['data:image/png;base64,cmVmZXJlbmNlLWJ5dGVz'],
      }),
    ).rejects.toThrow(/does not match/)
    expect(spy).not.toHaveBeenCalled()
  })

  // One bad entry must not let the request through with the others: the caller
  // asked for a specific set, and sending a subset would be silently different.
  it('refuses the whole request when a later reference image is unusable', async () => {
    const spy = mockPostOnce(() => ({ data: { data: [] } }))

    await expect(
      editWorkbenchImage({
        ...GENERATE_PAYLOAD,
        images: [PNG_DATA_URL, 'data:image/png;base64,cmVmZXJlbmNlLWJ5dGVz'],
      }),
    ).rejects.toThrow(/does not match/)
    expect(spy).not.toHaveBeenCalled()
  })
})
