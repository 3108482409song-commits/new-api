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
  aspectRatioOf,
  imageAspectOptions,
  sizeForAspect,
} from '../workbench-options'

describe('aspectRatioOf', () => {
  it('reduces a pixel size to its real ratio', () => {
    expect(aspectRatioOf('1024x1024')).toBe('1:1')
    expect(aspectRatioOf('1536x1024')).toBe('3:2')
    expect(aspectRatioOf('1024x1536')).toBe('2:3')
    expect(aspectRatioOf('1152x1536')).toBe('3:4')
    expect(aspectRatioOf('1536x1152')).toBe('4:3')
    expect(aspectRatioOf('1792x1024')).toBe('7:4')
  })

  it('rejects sizes it cannot reduce', () => {
    expect(aspectRatioOf('auto')).toBeNull()
    expect(aspectRatioOf('0x100')).toBeNull()
  })
})

describe('imageAspectOptions', () => {
  // The ratio is a promise about the output. gpt-image-1 only accepts
  // 1024x1024 / 1536x1024 / 1024x1536, so 3:4 and 4:3 must not be offered —
  // presenting them would map 3:4 onto 1024x1536, which is really 2:3.
  it('offers only the ratios gpt-image-1 can really output', () => {
    const options = imageAspectOptions('gpt-image-1')
    expect(options.map((option) => option.value)).toEqual(['1:1', '3:2', '2:3'])
    expect(options.map((option) => option.value)).not.toContain('3:4')
    expect(options.map((option) => option.value)).not.toContain('4:3')
  })

  it('offers true 3:4 and 4:3 for the arbitrary-resolution gpt-image-2 family', () => {
    const options = imageAspectOptions('gpt-image-2')
    expect(options.map((option) => option.value)).toEqual([
      '1:1',
      '3:2',
      '2:3',
      '4:3',
      '3:4',
      '16:9',
      '9:16',
    ])
    expect(options.find((option) => option.value === '3:4')?.size).toBe(
      '1152x1536'
    )
    expect(options.find((option) => option.value === '4:3')?.size).toBe(
      '1536x1152'
    )
  })

  it('labels dall-e-3 with the ratios its own sizes really have', () => {
    expect(imageAspectOptions('dall-e-3').map((option) => option.value)).toEqual(
      ['1:1', '7:4', '4:7']
    )
  })

  it('maps each offered ratio onto its advertised size', () => {
    expect(sizeForAspect('gpt-image-2', '3:4')).toBe('1152x1536')
    expect(sizeForAspect('gpt-image-2', '4:3')).toBe('1536x1152')
    expect(sizeForAspect('gpt-image-1', '3:4')).toBe('')
  })
})
