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
import dayjs from 'dayjs'
import { Download } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { getImageSource, isRunningStatus } from '../../lib/workbench-utils'
import type { TaskStatus, WorkbenchImageResult } from '../../types'

/**
 * What the viewer knows about the images it is showing. A freshly generated
 * result has no task row yet, so `createdAt` is optional and the status defaults
 * to finished.
 */
export interface ImageResultMeta {
  model?: string
  /** Unix seconds. */
  createdAt?: number
  status?: TaskStatus
}

/** Shared chrome for the two absolutely positioned overlay labels. */
const OVERLAY_CHIP =
  'rounded bg-black/60 px-2 py-0.5 text-xs font-medium text-white'

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * Extension for a saved file. A data URL states its own type, which is the only
 * trustworthy source; for a remote link the path is the best available guess and
 * anything unrecognised falls back to png.
 */
function downloadExtension(src: string): string {
  const mime = src.match(/^data:(image\/[a-z0-9.+-]+)/i)?.[1]?.toLowerCase()
  if (mime !== undefined && EXTENSION_BY_MIME[mime] !== undefined) {
    return EXTENSION_BY_MIME[mime]
  }
  const path = src.split(/[?#]/)[0] ?? ''
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (extension === 'jpeg') {
    return 'jpg'
  }
  return /^(png|jpg|webp|gif)$/.test(extension) ? extension : 'png'
}

/**
 * Name a saved image after what it is and when it was made, so a download never
 * arrives as an opaque id or a data-URL blob. Several images from one request
 * share a timestamp, so they are numbered to keep the names distinct.
 */
function downloadFileName(
  src: string,
  timestamp: number,
  index: number,
  total: number,
): string {
  const stamp = dayjs.unix(timestamp).format('YYYYMMDD-HHmmss')
  const ordinal = total > 1 ? `-${index + 1}` : ''
  return `creation-${stamp}${ordinal}.${downloadExtension(src)}`
}

function ResultOverlay({
  meta,
  timestamp,
}: {
  meta?: ImageResultMeta
  timestamp: number
}) {
  const { t } = useTranslation()

  let status = t('Completed')
  if (meta?.status) {
    if (isRunningStatus(meta.status)) {
      status = t('Generating...')
    } else if (meta.status === 'FAILURE') {
      status = t('Failure')
    }
  }

  return (
    // The overlay is decoration: it must never swallow a click meant for the
    // image or the download button underneath it.
    <figcaption className='pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3'>
      <span className={`${OVERLAY_CHIP} truncate`}>
        {meta?.model ? `${meta.model} · ` : ''}
        {dayjs.unix(timestamp).format('MM-DD HH:mm')}
      </span>
      <span className={`${OVERLAY_CHIP} shrink-0`}>{status}</span>
    </figcaption>
  )
}

/**
 * Renders generated images with the model, timestamp and status on the image
 * itself, so the result reads without any surrounding text.
 *
 * `fill` makes each image take an equal share of the parent's height on the
 * neutral backdrop — that is the workbench center panel. Without it the images
 * keep their natural size in a two-column grid, which is what the compact task
 * detail view wants.
 *
 * The prompt is deliberately not rendered here: it belongs in the history list,
 * where it does not cover the picture.
 */
export function ImageResultGrid({
  images,
  meta,
  fill = false,
}: {
  images: WorkbenchImageResult[]
  meta?: ImageResultMeta
  fill?: boolean
}) {
  const { t } = useTranslation()

  // A result shown without a task row has no creation time of its own; freezing
  // the fallback keeps a re-render from renaming a file that is about to be saved.
  const fallbackTimestamp = useRef(Math.floor(Date.now() / 1000))
  const timestamp = meta?.createdAt ?? fallbackTimestamp.current

  const containerClass = fill
    ? 'flex h-full w-full flex-col gap-3'
    : 'mx-auto grid w-full max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2'
  const figureClass = fill ? 'min-h-56 min-w-0 flex-1' : ''
  const imageClass = fill
    ? 'size-full object-contain'
    : 'size-auto max-h-96 w-full object-contain'

  return (
    <div className={containerClass}>
      {images.map((image, index) => {
        const src = getImageSource(image)
        if (!src) {
          return null
        }
        return (
          <figure
            key={src}
            className={`group bg-muted relative flex overflow-hidden rounded-lg border ${figureClass}`}
          >
            <img
              alt={image.revised_prompt || t('Generated image')}
              className={imageClass}
              src={src}
            />
            <ResultOverlay meta={meta} timestamp={timestamp} />
            <a
              aria-label={t('Download')}
              className='bg-background/90 text-foreground hover:bg-background focus-visible:opacity-100 absolute right-3 bottom-3 rounded-md p-2 opacity-0 shadow transition-opacity group-hover:opacity-100'
              download={downloadFileName(src, timestamp, index, images.length)}
              href={src}
              title={t('Download')}
            >
              <Download size={16} />
            </a>
          </figure>
        )
      })}
    </div>
  )
}

export function VideoResult({ url }: { url: string }) {
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video className='mx-auto max-h-[min(70vh,40rem)] w-full max-w-4xl rounded-lg border' controls src={url} />
  )
}
