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
import { useTranslation } from 'react-i18next'

import { getImageSource } from '../../lib/workbench-utils'
import type { WorkbenchImageResult } from '../../types'

export function ImageResultGrid({ images }: { images: WorkbenchImageResult[] }) {
  const { t } = useTranslation()
  return (
    <div className='mx-auto grid w-full max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2'>
      {images.map((image) => {
        const src = getImageSource(image)
        if (!src) {
          return null
        }
        return (
          <figure key={src} className='overflow-hidden rounded-lg border'>
            <img
              alt={image.revised_prompt || t('Generated image')}
              className='size-auto max-h-96 w-full object-contain'
              src={src}
            />
            {image.revised_prompt ? (
              <figcaption className='truncate px-2 py-1 text-xs text-muted-foreground'>
                {image.revised_prompt}
              </figcaption>
            ) : null}
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
