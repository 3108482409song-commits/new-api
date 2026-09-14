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
/**
 * Reference-image handling shared by the picker and the uploader. The browser
 * MIME type is caller-supplied and therefore spoofable, so every decoded data
 * URL is checked against the real file signature before it may be uploaded.
 */
export const SUPPORTED_REFERENCE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
])

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]

const DATA_URL_PATTERN = /^data:([^;,]+)?(?:;base64)?,(.*)$/s

export interface DecodedReferenceImage {
  mimeType: string
  bytes: Uint8Array
}

function signatureFor(mimeType: string): number[] | null {
  if (mimeType === 'image/png') {
    return PNG_SIGNATURE
  }
  if (mimeType === 'image/jpeg') {
    return JPEG_SIGNATURE
  }
  return null
}

/**
 * Decode a data URL and assert the bytes really are the image they claim to be.
 * Rejects an unsupported declared type, undecodable payloads, and content whose
 * signature does not match the declared MIME (a renamed or forged file).
 */
export function decodeReferenceImage(dataUrl: string): DecodedReferenceImage {
  const match = dataUrl.match(DATA_URL_PATTERN)
  if (!match) {
    throw new Error('Invalid image data')
  }
  const mimeType = (match[1] || '').toLowerCase()
  const signature = signatureFor(mimeType)
  if (!signature) {
    throw new Error(`${mimeType || 'unknown'} not supported`)
  }

  let bytes: Uint8Array
  try {
    bytes = dataUrl.includes(';base64,')
      ? Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[2]))
  } catch {
    throw new Error('Invalid image data')
  }

  if (
    bytes.length <= signature.length ||
    !signature.every((byte, index) => bytes[index] === byte)
  ) {
    throw new Error('The reference image content does not match its type')
  }
  return { mimeType, bytes }
}

/**
 * Reference-image filename whose extension matches the decoded MIME type.
 * Upstreams that look at the extension would otherwise receive a `.png` name
 * holding JPEG bytes.
 */
export function referenceImageFileName(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  return normalized === 'image/jpeg' || normalized === 'image/jpg'
    ? 'reference.jpg'
    : 'reference.png'
}
