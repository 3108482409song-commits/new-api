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
  decodeReferenceImage,
  referenceImageFileName,
  SUPPORTED_REFERENCE_IMAGE_TYPES,
} from '../reference-image'

// A real 1x1 PNG and a real minimal JPEG: the signature check must pass on bytes
// that truly are images.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const JPEG_DATA_URL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe('decodeReferenceImage', () => {
  it('decodes a real PNG and keeps its bytes', () => {
    const decoded = decodeReferenceImage(PNG_DATA_URL)
    expect(decoded.mimeType).toBe('image/png')
    expect(decoded.bytes.subarray(0, PNG_SIGNATURE.length)).toEqual(
      Uint8Array.from(PNG_SIGNATURE)
    )
  })

  it('decodes a real JPEG', () => {
    const decoded = decodeReferenceImage(JPEG_DATA_URL)
    expect(decoded.mimeType).toBe('image/jpeg')
    expect(decoded.bytes.subarray(0, 3)).toEqual(
      Uint8Array.from([0xff, 0xd8, 0xff])
    )
  })

  // A renamed file keeps its declared MIME from the picker, so only the bytes
  // can tell us it is not an image.
  it('rejects a renamed payload that lies about its type', () => {
    expect(() =>
      decodeReferenceImage('data:image/png;base64,cmVmZXJlbmNlLWJ5dGVz')
    ).toThrow(/does not match/)
  })

  it('rejects a type the workbench does not accept', () => {
    expect(() =>
      decodeReferenceImage('data:image/gif;base64,R0lGODlhAQABAAAAACw=')
    ).toThrow(/not supported/)
  })

  it('rejects a payload that is only a signature', () => {
    expect(() => decodeReferenceImage('data:image/png;base64,iVBORw0KGgo=')).toThrow(
      /does not match/
    )
  })

  it('rejects input that is not a data url', () => {
    expect(() => decodeReferenceImage('not-a-data-url')).toThrow(
      /Invalid image data/
    )
  })
})

describe('referenceImageFileName', () => {
  it('matches the extension to the MIME type', () => {
    expect(referenceImageFileName('image/jpeg')).toBe('reference.jpg')
    expect(referenceImageFileName('image/png')).toBe('reference.png')
  })
})

describe('SUPPORTED_REFERENCE_IMAGE_TYPES', () => {
  it('accepts PNG and JPEG only', () => {
    expect(SUPPORTED_REFERENCE_IMAGE_TYPES.has('image/png')).toBe(true)
    expect(SUPPORTED_REFERENCE_IMAGE_TYPES.has('image/jpeg')).toBe(true)
    expect(SUPPORTED_REFERENCE_IMAGE_TYPES.has('image/gif')).toBe(false)
  })
})
