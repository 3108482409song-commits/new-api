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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ImagePlusIcon, Minus, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/error-state'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useMediaQuery } from '@/hooks'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  editWorkbenchImage,
  estimateWorkbench,
  generateWorkbenchImage,
  getUserGroups,
  getUserWorkbenchTasks,
  getWorkbenchModels,
} from '../../api'
import { DEFAULT_GROUP } from '../../constants'
import {
  IMAGE_ASPECT_OPTIONS,
  QUALITY_CHOICES,
  qualityValueForChoice,
  sizeForAspect,
  type QualityChoice,
} from '../../lib/workbench-options'
import {
  formatQuota,
  getImageSource,
  isImageTask,
  isWorkbenchTask,
  isRunningStatus,
  workbenchErrorMessage,
} from '../../lib/workbench-utils'
import { ModelGroupSelector } from '@/components/model-group-selector'
import type { ModelOption, WorkbenchImageResult } from '../../types'
import { ImageResultGrid } from './result-viewer'

type ImageMode = 'text2img' | 'img2img'

// Quality names the provider-side parameter value itself, so the labels stay in
// English instead of being localised away from what the API expects.
const QUALITY_LABELS: Record<QualityChoice, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

const MAX_IMAGE_COUNT = 10

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)))
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsDataURL(file)
  })
}

export function ImagePanel({ active = true }: { active?: boolean }) {
  const { t } = useTranslation()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const queryClient = useQueryClient()
  const [group, setGroup] = useState<string>(DEFAULT_GROUP)
  const [model, setModel] = useState('')
  const [mode, setMode] = useState<ImageMode>('text2img')
  const [prompt, setPrompt] = useState('')
  const [n, setN] = useState(1)
  // While the count field is being edited it holds raw text, so the value can be
  // cleared and retyped; it is parsed and clamped on blur.
  const [countDraft, setCountDraft] = useState<string | null>(null)
  const [aspect, setAspect] = useState('1:1')
  const [qualityChoice, setQualityChoice] = useState<QualityChoice>('auto')
  const [refImage, setRefImage] = useState<string | null>(null)
  const [result, setResult] = useState<WorkbenchImageResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const groupsQuery = useQuery({
    queryKey: ['workbench-groups'],
    queryFn: getUserGroups,
    staleTime: 5 * 60 * 1000,
    enabled: active,
  })

  // The video panel queries the same models with the same key, so both must
  // cache the raw WorkbenchModel[] and narrow it per panel instead.
  const modelsQuery = useQuery({
    queryKey: ['workbench-models', group],
    queryFn: () => getWorkbenchModels(group),
    staleTime: 60 * 1000,
    enabled: active,
  })
  const imageModels: ModelOption[] = useMemo(
    () =>
      (modelsQuery.data ?? [])
        .filter((item) => item.image)
        .map((item) => ({ label: item.name, value: item.name })),
    [modelsQuery.data],
  )

  useEffect(() => {
    if (imageModels.length === 0) {
      if (model) {
        setModel('')
      }
      return
    }

    if (!imageModels.some((item) => item.value === model)) {
      setModel(imageModels[0].value)
    }
  }, [imageModels, model])

  const size = sizeForAspect(model, aspect)
  const quality = qualityValueForChoice(model, qualityChoice)

  const estimateEnabled = Boolean(model && size)
  const estimateQuery = useQuery({
    queryKey: ['workbench-estimate', 'image', group, model, n, size, quality ?? 'auto'],
    queryFn: () =>
      estimateWorkbench({
        type: 'image',
        group,
        model,
        n,
        size,
        quality,
      }),
    enabled: active && estimateEnabled,
  })

  const recentQuery = useQuery({
    queryKey: ['workbench-recent-images'],
    queryFn: async () => {
      const page = await getUserWorkbenchTasks({
        actions: ['text2img', 'img2img'],
        page: 1,
        pageSize: 8,
      })
      return page.items.filter((task) => isWorkbenchTask(task) && isImageTask(task))
    },
    enabled: active,
    refetchInterval: (query) => {
      const running = (query.state.data ?? []).some((task) =>
        ['SUBMITTED', 'QUEUED', 'IN_PROGRESS', 'NOT_START'].includes(task.status),
      )
      return running ? 3000 : false
    },
  })

  const generate = useMutation({
    mutationFn: async () => {
      setError(null)
      if (mode === 'img2img') {
        if (!refImage) {
          throw new Error(t('Upload a reference image'))
        }
        return editWorkbenchImage({
          group,
          model,
          prompt,
          n,
          size,
          quality,
          image: refImage,
        })
      }
      return generateWorkbenchImage({
        group,
        model,
        prompt,
        n,
        size,
        quality,
      })
    },
    onSuccess: (images) => {
      setResult(images)
      void queryClient.invalidateQueries({ queryKey: ['workbench-recent-images'] })
      void queryClient.invalidateQueries({ queryKey: ['workbench-tasks'] })
    },
    onError: (generateError) => {
      setError(workbenchErrorMessage(generateError, t('Failed to generate image')))
    },
  })

  const onUploadReference = async (file: File | null) => {
    if (!file) {
      return
    }
    try {
      setRefImage(await readFileAsDataUrl(file))
    } catch {
      setError(t('Failed to read the reference image'))
    }
  }

  const canGenerate =
    Boolean(model && prompt.trim() && size) &&
    (mode !== 'img2img' || Boolean(refImage)) &&
    !generate.isPending
  const estimate = estimateQuery.data

  let priceNode
  if (!estimateEnabled) {
    priceNode = t('Select a model and size to see the price')
  } else if (estimate) {
    priceNode = (
      <span>
        {t('Estimated price')}: {formatQuota(estimate.quota)} {t('quota')}
        {estimate.free_model ? ` · ${t('Free')}` : ` · ≈ $${estimate.usd.toFixed(4)}`}
      </span>
    )
  } else {
    priceNode = t('Estimating...')
  }

  let centerContent
  if (generate.isPending) {
    centerContent = (
      <div className='flex flex-col items-center gap-2 text-muted-foreground'>
        <Spinner className='size-8' />
        <span>{t('Generating...')}</span>
      </div>
    )
  } else if (result && result.length > 0) {
    centerContent = <ImageResultGrid images={result} />
  } else {
    centerContent = (
      <Empty>
        <EmptyTitle>{t('No images yet')}</EmptyTitle>
        <EmptyDescription>{t('Enter a prompt and click Generate')}</EmptyDescription>
      </Empty>
    )
  }

  let recentContent
  if (recentQuery.isPending && !recentQuery.data) {
    recentContent = <span className='text-sm text-muted-foreground'>{t('Loading...')}</span>
  } else if (recentQuery.isError) {
    recentContent = (
      <ErrorState
        className='min-h-0 py-4'
        description={t('Failed to load')}
        onRetry={() => void recentQuery.refetch()}
      />
    )
  } else if (recentQuery.data && recentQuery.data.length > 0) {
    recentContent = (
      <div className='grid grid-cols-2 gap-2'>
        {recentQuery.data.map((task) => {
          const firstImage = task.data?.images?.[0]
          const src = firstImage ? getImageSource(firstImage) : null
          return (
            <button
              key={task.task_id}
              className='overflow-hidden rounded-lg border bg-transparent p-0'
              title={task.properties?.input}
              type='button'
              onClick={() => setResult(task.data?.images ?? [])}
            >
              {src ? (
                <img
                  alt={task.properties?.input ?? ''}
                  className='size-full object-cover'
                  src={src}
                />
              ) : (
                <span className='flex aspect-square items-center justify-center bg-muted px-2 text-center text-xs text-muted-foreground'>
                  {isRunningStatus(task.status) ? t('Generating...') : t('Failure')}
                </span>
              )}
            </button>
          )
        })}
      </div>
    )
  } else {
    recentContent = <p className='text-sm text-muted-foreground'>{t('No generations yet')}</p>
  }

  // Both sidebars are locked on desktop, so a live handle could only offer a
  // resize that cannot happen (and a not-allowed cursor over the divider).
  const columnDivider = isMobile ? (
    <ResizableHandle />
  ) : (
    <div aria-hidden='true' className='bg-border w-px shrink-0' />
  )

  return (
    <ResizablePanelGroup
      // --radius drives every rounded-* token; the app default (1rem) makes the
      // dense settings controls look over-rounded, so the workspace shrinks it.
      className='min-h-0 flex-1 [--radius:0.5rem]'
      orientation={isMobile ? 'vertical' : 'horizontal'}
    >
      {/* Left: generation settings — a fixed 15% column on desktop. Sizes are
          percentage strings on purpose: a bare number means pixels here. */}
      <ResizablePanel
        className='min-w-0'
        defaultSize={isMobile ? '42%' : '15%'}
        disabled={!isMobile}
        maxSize={isMobile ? undefined : '15%'}
        minSize={isMobile ? '30%' : '15%'}
      >
        <div className='flex h-full min-w-0 flex-col gap-4 overflow-y-auto p-4'>
          <h2 className='text-base font-semibold'>{t('Generation settings')}</h2>
          <ModelGroupSelector
            className='w-full max-w-full'
            disabled={groupsQuery.isLoading || modelsQuery.isLoading}
            groups={groupsQuery.data ?? []}
            models={imageModels}
            onGroupChange={(value) => {
              setGroup(value)
              setModel('')
            }}
            onModelChange={setModel}
            selectedGroup={group}
            selectedModel={model}
          />

          <div className='space-y-2'>
            <Label>{t('Creation mode')}</Label>
            <ToggleGroup
              aria-label={t('Creation mode')}
              className='w-full'
              value={[mode]}
              variant='outline'
              onValueChange={(values) => {
                if (values.length > 0) {
                  setMode(values[0] as ImageMode)
                }
              }}
            >
              <ToggleGroupItem className='flex-1 justify-center' value='text2img'>
                {t('Text to image')}
              </ToggleGroupItem>
              <ToggleGroupItem className='flex-1 justify-center' value='img2img'>
                {t('Reference image edit')}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {mode === 'img2img' ? (
            <div className='space-y-2'>
              <Label>{t('Reference image')}</Label>
              <input
                ref={fileInputRef}
                accept='image/*'
                className='hidden'
                type='file'
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null
                  // Read the file first, then reset via the ref so the same
                  // file can be picked again. `event.currentTarget` is only
                  // valid while the handler runs.
                  if (fileInputRef.current !== null) {
                    fileInputRef.current.value = ''
                  }
                  void onUploadReference(file)
                }}
              />
              {refImage ? (
                <div className='relative'>
                  <img
                    alt={t('Reference image')}
                    className='bg-muted max-h-80 w-full rounded-md border object-contain'
                    src={refImage}
                    onError={() => setError(t('Failed to read the reference image'))}
                  />
                  <button
                    aria-label={t('Remove')}
                    className='bg-background/80 text-muted-foreground hover:text-destructive absolute top-1.5 right-1.5 rounded-full p-1'
                    title={t('Remove')}
                    type='button'
                    onClick={() => setRefImage(null)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <Button
                  className='h-16 w-full justify-start gap-2'
                  type='button'
                  variant='outline'
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlusIcon size={16} />
                  {t('Upload reference image')}
                </Button>
              )}
            </div>
          ) : null}

          <div className='space-y-2'>
            <Label htmlFor='image-prompt'>{t('Prompt')}</Label>
            <Textarea
              id='image-prompt'
              className='field-sizing-fixed'
              placeholder={t('Describe the image you want to generate...')}
              rows={11}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>

          <Separator />

          <div className='space-y-2'>
            <Label>{t('Image size')}</Label>
            <ToggleGroup
              aria-label={t('Image size')}
              className='grid w-full grid-cols-3'
              spacing={2}
              value={[aspect]}
              variant='outline'
              onValueChange={(values) => {
                if (values.length > 0) {
                  setAspect(values[0])
                }
              }}
            >
              {IMAGE_ASPECT_OPTIONS.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  className='justify-center'
                  value={option.value}
                >
                  {option.value}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className='space-y-2'>
            <Label>{t('Quality')}</Label>
            <ToggleGroup
              aria-label={t('Quality')}
              className='grid w-full grid-cols-3'
              spacing={2}
              value={[qualityChoice]}
              variant='outline'
              onValueChange={(values) => {
                if (values.length > 0) {
                  setQualityChoice(values[0] as QualityChoice)
                }
              }}
            >
              {QUALITY_CHOICES.map((choice) => (
                <ToggleGroupItem
                  key={choice}
                  className='justify-center'
                  value={choice}
                >
                  {QUALITY_LABELS[choice]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className='space-y-2'>
            <Label>{t('Image count')}</Label>
            {/* One bordered pill. The value stays editable, but the field is a
                text input so no native number spinners appear beside it. */}
            <div className='flex h-8 w-full items-center justify-between rounded-md border border-input px-1'>
              <Button
                aria-label={t('Decrease')}
                className='size-6 shrink-0 rounded-sm p-0'
                disabled={n <= 1}
                type='button'
                variant='ghost'
                onClick={() => {
                  setCountDraft(null)
                  setN(Math.max(1, n - 1))
                }}
              >
                <Minus size={14} />
              </Button>
              <Input
                aria-label={t('Image count')}
                className='h-6 w-12 border-0 bg-transparent px-0 text-center shadow-none focus-visible:ring-0'
                inputMode='numeric'
                type='text'
                value={countDraft ?? String(n)}
                onBlur={() => {
                  if (countDraft === null) {
                    return
                  }
                  const parsed = Number(countDraft.trim())
                  if (countDraft.trim() !== '' && !Number.isNaN(parsed)) {
                    setN(Math.min(MAX_IMAGE_COUNT, Math.max(1, Math.round(parsed))))
                  }
                  setCountDraft(null)
                }}
                onChange={(event) => setCountDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur()
                  }
                }}
              />
              <Button
                aria-label={t('Increase')}
                className='size-6 shrink-0 rounded-sm p-0'
                disabled={n >= MAX_IMAGE_COUNT}
                type='button'
                variant='ghost'
                onClick={() => {
                  setCountDraft(null)
                  setN(Math.min(MAX_IMAGE_COUNT, n + 1))
                }}
              >
                <Plus size={14} />
              </Button>
            </div>
          </div>

          <div className='text-sm text-muted-foreground'>{priceNode}</div>

          <Button
            className='w-full'
            disabled={!canGenerate}
            type='button'
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? <Spinner className='mr-2' /> : null}
            {t('Generate')}
          </Button>

          {error ? <p className='text-sm text-destructive'>{error}</p> : null}
        </div>
      </ResizablePanel>

      {columnDivider}

      {/* Center: result + progress */}
      <ResizablePanel className='min-w-0' defaultSize={isMobile ? '34%' : '70%'} minSize='0%'>
        <div className='flex h-full min-w-0 flex-col items-center justify-center gap-4 overflow-y-auto p-4'>
          {centerContent}
        </div>
      </ResizablePanel>

      {columnDivider}

      {/* Right: recent generations — locked to the same share as the settings
          column so the two sidebars always match. */}
      <ResizablePanel
        className='min-w-0'
        defaultSize={isMobile ? '20%' : '15%'}
        disabled={!isMobile}
        maxSize={isMobile ? undefined : '15%'}
        minSize={isMobile ? '18%' : '15%'}
      >
        <div className='flex h-full min-w-0 flex-col gap-3 overflow-y-auto p-4'>
          <h3 className='text-sm font-medium'>{t('Recent generations')}</h3>
          {recentContent}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
