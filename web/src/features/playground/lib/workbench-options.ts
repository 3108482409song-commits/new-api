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
import type { VideoMode } from '../types'

export interface ImageSizeOption {
  value: string
  label: string
}

interface ImageModelSizeRule {
  prefix: string
  sizes: ImageSizeOption[]
  quality?: ImageSizeOption[]
}

// Sizes follow the official OpenAI image API (dall-e / gpt-image family).
// Unknown models fall back to a neutral square/landscape/portrait set.
const IMAGE_MODEL_SIZE_RULES: ImageModelSizeRule[] = [
  {
    // gpt-image-2 accepts arbitrary WIDTHxHEIGHT (both edges divisible by 16,
    // ratio within 1:3..3:1), so it is the only OpenAI family that can actually
    // output 3:4 and 4:3. Checked before the generic gpt-image rule.
    prefix: 'gpt-image-2',
    sizes: [
      { value: '1024x1024', label: '1024x1024' }, // 1:1
      { value: '1536x1024', label: '1536x1024' }, // 3:2
      { value: '1024x1536', label: '1024x1536' }, // 2:3
      { value: '1536x1152', label: '1536x1152' }, // 4:3
      { value: '1152x1536', label: '1152x1536' }, // 3:4
      { value: '1536x864', label: '1536x864' }, // 16:9
      { value: '864x1536', label: '864x1536' }, // 9:16
    ],
    quality: [
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  },
  {
    prefix: 'dall-e-2',
    sizes: [
      { value: '256x256', label: '256x256' },
      { value: '512x512', label: '512x512' },
      { value: '1024x1024', label: '1024x1024' },
    ],
  },
  {
    prefix: 'dall-e-3',
    sizes: [
      { value: '1024x1024', label: '1024x1024' },
      { value: '1792x1024', label: '1792x1024' },
      { value: '1024x1792', label: '1024x1792' },
    ],
    quality: [
      { value: 'standard', label: 'Standard' },
      { value: 'hd', label: 'HD' },
    ],
  },
  {
    // gpt-image-1 / 1.5 / mini only accept these three sizes plus "auto": they
    // genuinely cannot produce 3:4 or 4:3, so those ratios are never offered.
    prefix: 'gpt-image',
    sizes: [
      { value: '1024x1024', label: '1024x1024' },
      { value: '1536x1024', label: '1536x1024' },
      { value: '1024x1536', label: '1024x1536' },
    ],
    quality: [
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  },
]

const FALLBACK_IMAGE_SIZES: ImageSizeOption[] = [
  { value: '1024x1024', label: '1024x1024' },
  { value: '1280x720', label: '1280x720' },
  { value: '720x1280', label: '720x1280' },
]

export function imageSizesForModel(model: string): ImageSizeOption[] {
  const lower = model.toLowerCase()
  for (const rule of IMAGE_MODEL_SIZE_RULES) {
    if (lower.startsWith(rule.prefix)) {
      return rule.sizes
    }
  }
  return FALLBACK_IMAGE_SIZES
}

export function imageQualityForModel(model: string): ImageSizeOption[] {
  const lower = model.toLowerCase()
  for (const rule of IMAGE_MODEL_SIZE_RULES) {
    if (lower.startsWith(rule.prefix) && rule.quality) {
      return rule.quality
    }
  }
  return []
}

export interface AspectOption {
  /** Reduced aspect ratio derived from `size`, e.g. "3:2". */
  value: string
  /** The concrete pixel size this ratio maps onto. */
  size: string
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = a
  let right = b
  while (right !== 0) {
    const remainder = left % right
    left = right
    right = remainder
  }
  return left
}

/** Reduced ratio of a `WIDTHxHEIGHT` size, e.g. "1536x1024" -> "3:2". */
export function aspectRatioOf(size: string): string | null {
  const match = size.match(/^(\d+)x(\d+)$/)
  if (!match) {
    return null
  }
  const width = Number(match[1])
  const height = Number(match[2])
  if (width <= 0 || height <= 0) {
    return null
  }
  const divisor = greatestCommonDivisor(width, height)
  return `${width / divisor}:${height / divisor}`
}

/**
 * Aspect buttons for a model, derived from the pixel sizes it actually
 * supports. The label is the ratio of the size that will really be requested,
 * so a model that cannot output a ratio never offers it: gpt-image-1 offers
 * 1:1 / 3:2 / 2:3 only, while the arbitrary-resolution gpt-image-2 family also
 * offers true 4:3 / 3:4 / 16:9 / 9:16.
 */
export function imageAspectOptions(model: string): AspectOption[] {
  const seen = new Set<string>()
  const options: AspectOption[] = []
  for (const size of imageSizesForModel(model)) {
    const ratio = aspectRatioOf(size.value)
    if (!ratio || seen.has(ratio)) {
      continue
    }
    seen.add(ratio)
    options.push({ value: ratio, size: size.value })
  }
  return options
}

export function sizeForAspect(model: string, aspect: string): string {
  return (
    imageAspectOptions(model).find((option) => option.value === aspect)?.size ??
    ''
  )
}

export type QualityChoice = 'auto' | 'low' | 'medium' | 'high'

export const QUALITY_CHOICES: QualityChoice[] = ['auto', 'low', 'medium', 'high']

// Maps the four workbench quality buttons onto provider-specific quality
// values. Auto omits the parameter entirely.
export function qualityValueForChoice(model: string, choice: QualityChoice): string | undefined {
  if (choice === 'auto') {
    return undefined
  }
  const lower = model.toLowerCase()
  if (lower.startsWith('gpt-image')) {
    if (choice === 'low' || choice === 'medium' || choice === 'high') {
      return choice
    }
    return undefined
  }
  if (lower.startsWith('dall-e-3')) {
    return choice === 'high' ? 'hd' : 'standard'
  }
  return undefined
}

export interface VideoModeOption {
  value: VideoMode
  /** 0 = none (text-to-video), 1 = first frame, 2 = first + last frame, 'multi' = reference images */
  refs: 0 | 1 | 2 | 'multi'
}

export interface VideoPlatformOption {
  key: string
  modes: VideoModeOption[]
  resolutions: { value: string; label: string }[]
  durations: number[]
  ratios: { value: string; label: string }[]
}

// Data-driven parameter table. Start small (Kling / Hailuo / Vidu); add a new
// platform entry here to expose more models in the workbench, then tune per
// model later without touching component code.
export const VIDEO_PLATFORM_OPTIONS: Record<string, VideoPlatformOption> = {
  kling: {
    key: 'kling',
    modes: [
      { value: 'text_to_video', refs: 0 },
      { value: 'first_tail_to_video', refs: 2 },
      { value: 'reference_to_video', refs: 'multi' },
    ],
    resolutions: [
      { value: 'std', label: 'std (720P)' },
      { value: 'pro', label: 'pro (1080P)' },
      { value: '4k', label: '4K' },
    ],
    durations: [5, 10],
    ratios: [
      { value: '16:9', label: '16:9' },
      { value: '9:16', label: '9:16' },
      { value: '1:1', label: '1:1' },
    ],
  },
  hailuo: {
    key: 'hailuo',
    modes: [
      { value: 'text_to_video', refs: 0 },
      { value: 'first_tail_to_video', refs: 2 },
      { value: 'reference_to_video', refs: 'multi' },
    ],
    resolutions: [
      { value: '512P', label: '512P' },
      { value: '768P', label: '768P' },
      { value: '1080P', label: '1080P' },
      { value: '2K', label: '2K' },
    ],
    durations: [5, 6, 10],
    ratios: [
      { value: '21:9', label: '21:9' },
      { value: '16:9', label: '16:9' },
      { value: '4:3', label: '4:3' },
      { value: '1:1', label: '1:1' },
      { value: '3:4', label: '3:4' },
      { value: '9:16', label: '9:16' },
    ],
  },
  vidu: {
    key: 'vidu',
    modes: [
      { value: 'text_to_video', refs: 0 },
      { value: 'first_tail_to_video', refs: 2 },
      { value: 'reference_to_video', refs: 1 },
    ],
    resolutions: [
      { value: '360p', label: '360p' },
      { value: '540p', label: '540p' },
      { value: '720p', label: '720p' },
      { value: '1080p', label: '1080p' },
    ],
    durations: [4, 8],
    ratios: [
      { value: '16:9', label: '16:9' },
      { value: '9:16', label: '9:16' },
      { value: '1:1', label: '1:1' },
    ],
  },
}

export function videoPlatformOptions(platform?: string): VideoPlatformOption | undefined {
  if (!platform) {
    return undefined
  }
  return VIDEO_PLATFORM_OPTIONS[platform]
}
