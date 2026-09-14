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
import dayjs from 'dayjs'
import { ImagePlusIcon, Minus, Plus, Trash2, X } from 'lucide-react'
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
  deleteWorkbenchTask,
  editWorkbenchImage,
  estimateWorkbench,
  generateWorkbenchImage,
  getUserGroups,
  getUserWorkbenchTasks,
  getWorkbenchModels,
  getWorkbenchTask,
} from '../../api'
import { DEFAULT_GROUP } from '../../constants'
import {
  imageAspectOptions,
  QUALITY_CHOICES,
  qualityValueForChoice,
  sizeForAspect,
  type QualityChoice,
} from '../../lib/workbench-options'
import {
  decodeReferenceImage,
  SUPPORTED_REFERENCE_IMAGE_TYPES,
} from '../../lib/reference-image'
import {
  formatQuota,
  isImageTask,
  isWorkbenchTask,
  isRunningStatus,
  workbenchErrorMessage,
} from '../../lib/workbench-utils'
import {
  GroupSelector,
  ModelSelector,
} from '@/components/model-group-selector'
import type { ModelOption, WorkbenchImageResult } from '../../types'
import { ImageResultGrid, type ImageResultMeta } from './result-viewer'

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
  const [refImages, setRefImages] = useState<string[]>([])
  const [result, setResult] = useState<WorkbenchImageResult[] | null>(null)
  // What the viewer prints on the image itself: a bare result array cannot say
  // which model produced it or when.
  const [resultMeta, setResultMeta] = useState<ImageResultMeta | undefined>(
    undefined
  )
  // The history entry currently on screen, so deleting it also clears the
  // viewer instead of leaving a removed record displayed.
  const [resultTaskId, setResultTaskId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const groupsQuery = useQuery({
    queryKey: ['workbench-groups'],
    queryFn: getUserGroups,
    staleTime: 5 * 60 * 1000,
    enabled: active,
  })

  // The video panel shares this query key, so the cached payload must never be
  // narrowed in place. Unlike that panel — where the capability comes from the
  // task-plugin registry — the image panel offers every model the selected group
  // exposes. Which models can generate images is decided by how the operator
  // curates the group, not by a name pattern, so nothing is filtered out here:
  // a name-based filter silently hid real image models, e.g. "gpt-image-2",
  // whose name does not contain the "gpt-image-1" pattern.
  const modelsQuery = useQuery({
    queryKey: ['workbench-models', group],
    queryFn: () => getWorkbenchModels(group),
    staleTime: 60 * 1000,
    enabled: active,
  })
  const imageModels: ModelOption[] = useMemo(
    () =>
      (modelsQuery.data ?? []).map((item) => ({
        label: item.name,
        value: item.name,
      })),
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

  // Aspect buttons come from the sizes the selected model really supports, so
  // every ratio shown equals the pixels that will be requested.
  const aspectOptions = useMemo(() => imageAspectOptions(model), [model])
  const size = sizeForAspect(model, aspect)
  const quality = qualityValueForChoice(model, qualityChoice)

  // The reference-image limit is read from the model the server published, never
  // re-derived here: the picker and the upload validator then enforce one number
  // instead of two that can drift apart. 0 means the server has no limit
  // configured for this model, so the picker keeps its original single-file form
  // rather than inventing a cap of its own.
  const maxReferenceImages = useMemo(
    () =>
      modelsQuery.data?.find((item) => item.name === model)
        ?.max_reference_images ?? 0,
    [modelsQuery.data, model],
  )
  const allowsMultipleReferenceImages = maxReferenceImages > 1

  // Switching to a model with a smaller limit must not leave more images selected
  // than the server will accept, which would fail on submit with no visible cause.
  useEffect(() => {
    if (maxReferenceImages <= 0 || refImages.length <= maxReferenceImages) {
      return
    }
    setRefImages(refImages.slice(0, maxReferenceImages))
    setError(t('At most {{max}} reference images', { max: maxReferenceImages }))
  }, [maxReferenceImages, refImages, t])

  // Switching to a model that cannot output the current ratio must not leave an
  // empty size behind.
  useEffect(() => {
    if (aspectOptions.length === 0) {
      return
    }
    if (!aspectOptions.some((option) => option.value === aspect)) {
      setAspect(aspectOptions[0].value)
    }
  }, [aspectOptions, aspect])

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
        pageSize: 20,
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

  // A list row carries only a preview, so opening a record loads its full result
  // on demand. That keeps the list light while the viewer — and the download it
  // offers — still works from the original image.
  const openTask = useMutation({
    mutationFn: (taskId: string) => getWorkbenchTask(taskId),
    onSuccess: (task) => {
      setResult(task.data?.images ?? [])
      setResultMeta({
        model: task.properties?.origin_model_name,
        createdAt: task.finish_time || task.submit_time,
        status: task.status,
      })
      setResultTaskId(task.task_id)
    },
    onError: (openError) => {
      setError(workbenchErrorMessage(openError, t('Failed to load')))
    },
  })

  const generate = useMutation({
    mutationFn: async () => {
      setError(null)
      if (mode === 'img2img') {
        if (refImages.length === 0) {
          throw new Error(t('Upload a reference image'))
        }
        return editWorkbenchImage({
          group,
          model,
          prompt,
          n,
          size,
          quality,
          images: refImages,
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
      setResultMeta({
        model,
        createdAt: Math.floor(Date.now() / 1000),
        status: 'SUCCESS',
      })
      // A just-generated result is not one of the listed entries yet, so no
      // history record owns it.
      setResultTaskId(null)
      void queryClient.invalidateQueries({ queryKey: ['workbench-recent-images'] })
      void queryClient.invalidateQueries({ queryKey: ['workbench-tasks'] })
    },
    onError: (generateError) => {
      setError(workbenchErrorMessage(generateError, t('Failed to generate image')))
    },
  })

  const removeTask = useMutation({
    mutationFn: (taskId: string) => deleteWorkbenchTask(taskId),
    onSuccess: (_deleted, taskId) => {
      if (taskId === resultTaskId) {
        setResult(null)
        setResultMeta(undefined)
        setResultTaskId(null)
      }
      void queryClient.invalidateQueries({ queryKey: ['workbench-recent-images'] })
      void queryClient.invalidateQueries({ queryKey: ['workbench-tasks'] })
    },
    onError: (deleteError) => {
      setError(workbenchErrorMessage(deleteError, t('Failed to delete task')))
    },
  })

  // Add the picked files to the selection. The whole batch is rejected if any
  // file is unusable or the total would exceed the model's limit: silently
  // dropping or truncating would leave the panel showing something other than
  // what the operator asked for.
  const onUploadReference = async (files: File[]) => {
    if (files.length === 0) {
      return
    }
    const picked: string[] = []
    for (const file of files) {
      if (!SUPPORTED_REFERENCE_IMAGE_TYPES.has(file.type)) {
        setError(t('{{modality}} not supported', { modality: file.type || 'unknown' }))
        return
      }
      try {
        const dataUrl = await readFileAsDataUrl(file)
        // Validate the real bytes: the browser MIME type is caller-supplied, so a
        // renamed or truncated file would otherwise stay selected and be uploaded.
        decodeReferenceImage(dataUrl)
        // The same picture twice is one reference image, not two.
        if (!refImages.includes(dataUrl) && !picked.includes(dataUrl)) {
          picked.push(dataUrl)
        }
      } catch {
        setError(t('Failed to read the reference image'))
        return
      }
    }

    const next = [...refImages, ...picked]
    if (maxReferenceImages > 0 && next.length > maxReferenceImages) {
      setError(t('At most {{max}} reference images', { max: maxReferenceImages }))
      return
    }
    setError(null)
    setRefImages(next)
  }

  const removeReferenceImage = (image: string) => {
    setRefImages((current) => current.filter((item) => item !== image))
    setError(null)
  }

  const referenceLimitReached =
    maxReferenceImages > 0 && refImages.length >= maxReferenceImages
  // A multi-image model keeps the add control available until its limit is
  // reached; a single-image model hides it as soon as one is picked.
  const showReferencePicker = allowsMultipleReferenceImages
    ? !referenceLimitReached
    : refImages.length === 0
  // More than one selected image has to be shown as a grid whatever the model
  // says, or switching models would submit images the panel never displayed.
  const showReferenceGrid =
    allowsMultipleReferenceImages || refImages.length > 1

  // One image gets a large preview; several get a grid. Picked here instead of
  // nesting ternaries in the markup.
  let referenceDisplay
  if (refImages.length > 0 && showReferenceGrid) {
    referenceDisplay = (
      <div className='grid grid-cols-2 gap-2'>
        {refImages.map((image) => (
          <div
            key={image}
            className='bg-muted relative overflow-hidden rounded-md border'
          >
            <img
              alt={t('Reference image')}
              className='aspect-square w-full object-cover'
              src={image}
              onError={() => {
                // A preview that cannot decode is not a usable reference image:
                // drop it so it can never be submitted.
                removeReferenceImage(image)
                setError(t('Failed to read the reference image'))
              }}
            />
            <button
              aria-label={t('Remove')}
              className='bg-background/80 text-muted-foreground hover:text-destructive absolute top-1 right-1 rounded-full p-1'
              title={t('Remove')}
              type='button'
              onClick={() => removeReferenceImage(image)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    )
  } else if (refImages.length > 0) {
    referenceDisplay = (
      <div className='relative'>
        <img
          alt={t('Reference image')}
          className='bg-muted max-h-80 w-full rounded-md border object-contain'
          src={refImages[0]}
          onError={() => {
            removeReferenceImage(refImages[0])
            setError(t('Failed to read the reference image'))
          }}
        />
        <button
          aria-label={t('Remove')}
          className='bg-background/80 text-muted-foreground hover:text-destructive absolute top-1.5 right-1.5 rounded-full p-1'
          title={t('Remove')}
          type='button'
          onClick={() => removeReferenceImage(refImages[0])}
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  const canGenerate =
    Boolean(model && prompt.trim() && size) &&
    (mode !== 'img2img' || refImages.length > 0) &&
    !generate.isPending
  const estimate = estimateQuery.data

  let priceNode
  if (!estimateEnabled) {
    priceNode = t('Select a model and size to see the price')
  } else if (estimate && estimate.use_price) {
    // A configured per-call price is the exact charge for this request, and it is
    // already denominated in money. Printing the backing quota next to it would
    // only show an internal unit that is never billed, so the price stands alone.
    priceNode = `${t('Price')}: ${estimate.free_model ? t('Free') : `$${estimate.usd.toFixed(4)}`}`
  } else if (estimate) {
    // A token-ratio pre-consume is only a guess, so it keeps both the quota it is
    // derived from and the approximate money it may settle at.
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
      <div className='text-muted-foreground m-auto flex flex-col items-center gap-2'>
        <Spinner className='size-8' />
        <span>{t('Generating...')}</span>
      </div>
    )
  } else if (result && result.length > 0) {
    // `fill` makes the images take the whole center column on the neutral
    // backdrop, which is the point of this panel.
    centerContent = <ImageResultGrid fill images={result} meta={resultMeta} />
  } else {
    centerContent = (
      <Empty className='m-auto'>
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
      // The list owns the scrolling so a long history never pushes the heading
      // out of the column.
      <div className='flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1'>
        {recentQuery.data.map((task) => {
          const src = task.preview ?? null
          const running = isRunningStatus(task.status)
          return (
            // One row per generation: thumbnail, prompt, then model and time.
            // The delete control only shows on hover so the list stays readable.
            <div
              key={task.task_id}
              className='group hover:bg-accent/60 flex items-center gap-2 rounded-lg border p-1.5 transition-colors'
            >
              <button
                className='flex min-w-0 flex-1 items-center gap-2 text-left'
                disabled={openTask.isPending}
                title={task.properties?.input}
                type='button'
                onClick={() => openTask.mutate(task.task_id)}
              >
                <span className='bg-muted block size-10 shrink-0 overflow-hidden rounded'>
                  {src ? (
                    <img
                      alt={task.properties?.input ?? ''}
                      className='size-full object-cover'
                      src={src}
                    />
                  ) : (
                    <span className='text-muted-foreground flex size-full items-center justify-center px-0.5 text-center text-[10px] leading-tight'>
                      {running ? t('Generating...') : t('Failure')}
                    </span>
                  )}
                </span>
                <span className='flex min-w-0 flex-col'>
                  <span className='truncate text-xs'>
                    {task.properties?.input || task.task_id}
                  </span>
                  <span className='text-muted-foreground truncate text-[10px]'>
                    {[
                      task.properties?.origin_model_name,
                      dayjs
                        .unix(task.finish_time || task.submit_time)
                        .format('MM-DD HH:mm'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </button>
              {/* A running record still has an upstream job to collect, so the
                  backend refuses to delete it and the control stays hidden. */}
              {running ? null : (
                <button
                  aria-label={t('Delete')}
                  className='text-muted-foreground hover:text-destructive focus-visible:opacity-100 disabled:opacity-50 shrink-0 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100'
                  disabled={removeTask.isPending}
                  title={t('Delete')}
                  type="button"
                  onClick={() => removeTask.mutate(task.task_id)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
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
          <div className='space-y-2'>
            <Label>{t('Group')}</Label>
            <GroupSelector
              aria-label={t('Group')}
              className='w-full'
              disabled={groupsQuery.isLoading || modelsQuery.isLoading}
              groups={groupsQuery.data ?? []}
              onGroupChange={(value) => {
                setGroup(value)
                setModel('')
              }}
              selectedGroup={group}
            />
          </div>

          <div className='space-y-2'>
            <Label>{t('Model')}</Label>
            <ModelSelector
              aria-label={t('Model')}
              className='w-full'
              disabled={groupsQuery.isLoading || modelsQuery.isLoading}
              models={imageModels}
              onModelChange={setModel}
              selectedModel={model}
            />
          </div>

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
              <div className='flex items-center justify-between gap-2'>
                <Label>
                  {allowsMultipleReferenceImages
                    ? t('Reference images')
                    : t('Reference image')}
                </Label>
                {/* How many are attached against the model's limit, so the number
                    is visible before the limit is hit rather than after. */}
                {maxReferenceImages > 0 ? (
                  <span className='text-muted-foreground text-xs tabular-nums'>
                    {refImages.length}/{maxReferenceImages}
                  </span>
                ) : null}
              </div>
              <input
                ref={fileInputRef}
                accept='image/png,image/jpeg'
                className='hidden'
                multiple={allowsMultipleReferenceImages}
                type='file'
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])]
                  // Read the files first, then reset via the ref so the same
                  // file can be picked again. `event.currentTarget` is only
                  // valid while the handler runs.
                  if (fileInputRef.current !== null) {
                    fileInputRef.current.value = ''
                  }
                  void onUploadReference(files)
                }}
              />
              {referenceDisplay}
              {showReferencePicker ? (
                <Button
                  className='h-16 w-full justify-start gap-2'
                  type='button'
                  variant='outline'
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlusIcon size={16} />
                  {t('Upload reference image')}
                </Button>
              ) : null}
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
              {aspectOptions.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  className='justify-center'
                  title={`${option.value} · ${option.size}`}
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
            variant='secondary'
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? <Spinner className='mr-2' /> : null}
            {t('Generate')}
          </Button>

          {error ? <p className='text-sm text-destructive'>{error}</p> : null}
        </div>
      </ResizablePanel>

      {columnDivider}

      {/* Center: result + progress. The column stretches its content rather than
          centring it, so a result can fill the whole area. */}
      <ResizablePanel className='min-w-0' defaultSize={isMobile ? '34%' : '70%'} minSize='0%'>
        <div className='flex h-full min-w-0 flex-col overflow-y-auto p-4'>
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
        <div className='flex h-full min-w-0 flex-col gap-3 p-4'>
          <h3 className='text-sm font-medium'>{t('Recent generations')}</h3>
          {recentContent}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
