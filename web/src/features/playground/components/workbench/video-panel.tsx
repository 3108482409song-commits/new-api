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
import { ImagePlusIcon, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/error-state'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ModelGroupSelector } from '@/components/model-group-selector'
import { useMediaQuery } from '@/hooks'
import {
  estimateWorkbench,
  generateWorkbenchVideo,
  getUserGroups,
  getUserWorkbenchTasks,
  getWorkbenchModels,
} from '../../api'
import { DEFAULT_GROUP } from '../../constants'
import { videoPlatformOptions } from '../../lib/workbench-options'
import { formatQuota, isVideoStatusTerminal, isWorkbenchTask, workbenchErrorMessage } from '../../lib/workbench-utils'
import type { ModelOption, TaskStatus, VideoMode, WorkbenchTask } from '../../types'
import { VideoResult } from './result-viewer'

const VIDEO_MODE_LABELS = {
  text_to_video: 'Text to video',
  first_tail_to_video: 'First-last frame to video',
  reference_to_video: 'Reference to video',
} as const

function statusDotClass(status: TaskStatus): string {
  if (status === 'SUCCESS') {
    return 'size-2 rounded-full bg-green-500'
  }
  if (status === 'FAILURE') {
    return 'size-2 rounded-full bg-destructive'
  }
  return 'size-2 rounded-full bg-blue-500'
}

function statusLabel(status: TaskStatus): string {
  if (status === 'SUCCESS') {
    return 'Success'
  }
  if (status === 'FAILURE') {
    return 'Failure'
  }
  return 'Running'
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)))
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsDataURL(file)
  })
}

export function VideoPanel({ active = true }: { active?: boolean }) {
  const { t } = useTranslation()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const queryClient = useQueryClient()
  const [group, setGroup] = useState<string>(DEFAULT_GROUP)
  const [model, setModel] = useState('')
  const [platform, setPlatform] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<VideoMode>('text_to_video')
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState(5)
  const [resolution, setResolution] = useState('')
  const [aspect, setAspect] = useState('')
  const [firstFrame, setFirstFrame] = useState<string | null>(null)
  const [lastFrame, setLastFrame] = useState<string | null>(null)
  const [referenceImages, setReferenceImages] = useState<string[]>([])
  const [submittedTaskId, setSubmittedTaskId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const firstFrameRef = useRef<HTMLInputElement>(null)
  const lastFrameRef = useRef<HTMLInputElement>(null)
  const referenceRef = useRef<HTMLInputElement>(null)

  const groupsQuery = useQuery({
    queryKey: ['workbench-groups'],
    queryFn: getUserGroups,
    staleTime: 5 * 60 * 1000,
    enabled: active,
  })

  // Shares ['workbench-models', group] with the image panel, so this query
  // must cache the raw WorkbenchModel[] and narrow it here.
  const modelsQuery = useQuery({
    queryKey: ['workbench-models', group],
    queryFn: () => getWorkbenchModels(group),
    staleTime: 60 * 1000,
    enabled: active,
  })
  const videoModels: ModelOption[] = useMemo(
    () =>
      (modelsQuery.data ?? [])
        .filter((item) => item.video)
        .filter((item) => item.platform && videoPlatformOptions(item.platform))
        .map((item) => ({
          label: item.name,
          value: item.name,
        })),
    [modelsQuery.data],
  )

  useEffect(() => {
    if (videoModels.length === 0) {
      if (model) {
        setModel('')
      }
      return
    }

    if (!videoModels.some((item) => item.value === model)) {
      setModel(videoModels[0].value)
    }
  }, [model, videoModels])

  const option = videoPlatformOptions(platform)
  const modes = option?.modes ?? []
  const modeRefs = modes.find((item) => item.value === mode)?.refs

  // Sync platform + defaults whenever the model changes.
  useEffect(() => {
    const next = modelsQuery.data?.find((item) => item.name === model)
    const nextPlatform = next?.platform
    setPlatform(nextPlatform)
    const nextOption = videoPlatformOptions(nextPlatform)
    if (!nextOption) {
      return
    }

    const firstMode = nextOption.modes[0]
    setMode(firstMode.value)
    setDuration(nextOption.durations[0])
    setResolution(nextOption.resolutions[0].value)
    setAspect(nextOption.ratios[0].value)
  }, [model, modelsQuery.data])

  useEffect(() => {
    if (mode !== 'first_tail_to_video') {
      setFirstFrame(null)
      setLastFrame(null)
    }
    if (mode !== 'reference_to_video') {
      setReferenceImages([])
    }
  }, [mode])

  // Poll the just-submitted task until it reaches a terminal state.
  const submittedQuery = useQuery({
    queryKey: ['workbench-task', submittedTaskId],
    queryFn: async () => {
      const page = await getUserWorkbenchTasks({ taskId: submittedTaskId ?? undefined, pageSize: 1 })
      return page.items[0] ?? null
    },
    enabled: active && Boolean(submittedTaskId),
    refetchInterval: (query) => {
      const task = query.state.data as WorkbenchTask | null | undefined
      if (task && !isVideoStatusTerminal(task.status)) {
        return 3000
      }
      return false
    },
  })
  const submittedTask = submittedQuery.data

  const recentQuery = useQuery({
    queryKey: ['workbench-recent-videos'],
    queryFn: async () => {
      const page = await getUserWorkbenchTasks({
        actions: ['text_to_video', 'image_to_video', 'first_tail_to_video', 'reference_to_video'],
        page: 1,
        pageSize: 20,
      })
      return page.items.filter(isWorkbenchTask)
    },
    enabled: active,
    refetchInterval: (query) => {
      const data = query.state.data ?? []
      const running = data.some((task) => !isVideoStatusTerminal(task.status))
      return running ? 3000 : false
    },
  })

  // Display-only price estimate. The backend returns the base per-call price
  // before the channel adaptor's runtime ratios, so the UI labels it as an
  // estimate and the final cost is settled when the task completes.
  const estimateEnabled = Boolean(model && option)
  const estimateQuery = useQuery({
    queryKey: ['workbench-estimate', 'video', group, model, mode, duration, resolution, aspect],
    queryFn: () =>
      estimateWorkbench({
        type: 'video',
        group,
        model,
        mode,
        duration,
        resolution,
        aspect,
        ref_images: referenceImages.length,
      }),
    enabled: active && estimateEnabled,
  })

  const generate = useMutation({
    mutationFn: async () => {
      setError(null)
      const result = await generateWorkbenchVideo({
        group,
        model,
        prompt,
        mode,
        duration,
        resolution,
        aspect,
        firstFrame: firstFrame ?? undefined,
        lastFrame: lastFrame ?? undefined,
        referenceImages: mode === 'reference_to_video' ? referenceImages : undefined,
      })
      return result.task_id
    },
    onSuccess: (taskId) => {
      setSubmittedTaskId(taskId)
      void queryClient.invalidateQueries({ queryKey: ['workbench-recent-videos'] })
      void queryClient.invalidateQueries({ queryKey: ['workbench-tasks'] })
    },
    onError: (generateError) => {
      setError(workbenchErrorMessage(generateError, t('Failed to submit video task')))
    },
  })

  const onUpload = async (slot: 'first' | 'last' | 'reference', files: File[]) => {
    if (files.length === 0) {
      return
    }
    try {
      const dataUrls = await Promise.all(files.map((file) => readFileAsDataUrl(file)))
      if (slot === 'first') {
        setFirstFrame(dataUrls[0])
      } else if (slot === 'last') {
        setLastFrame(dataUrls[0])
      } else {
        setReferenceImages((previous) => [...previous, ...dataUrls].slice(0, 4))
      }
    } catch {
      setError(t('Failed to read the reference image'))
    }
  }

  let centerContent
  if (generate.isPending) {
    centerContent = (
      <div className='flex flex-col items-center gap-2 text-muted-foreground'>
        <Spinner className='size-8' />
        <span>{t('Submitting...')}</span>
      </div>
    )
  } else if (submittedTask) {
    centerContent = (
      <div className='flex w-full flex-col items-center gap-3'>
        {!isVideoStatusTerminal(submittedTask.status) ? (
          <div className='flex flex-col items-center gap-2 text-muted-foreground'>
            <Spinner className='size-8' />
            <span>
              {t('Generating...')} ({submittedTask.progress || '0%'})
            </span>
          </div>
        ) : null}
        {submittedTask.status === 'SUCCESS' && submittedTask.preview ? (
          <VideoResult url={submittedTask.preview} />
        ) : null}
        {submittedTask.status === 'FAILURE' ? (
          <p className='max-w-md break-words text-sm text-destructive'>
            {submittedTask.fail_reason}
          </p>
        ) : null}
      </div>
    )
  } else {
    centerContent = (
      <Empty>
        <EmptyTitle>{t('No video yet')}</EmptyTitle>
        <EmptyDescription>{t('Enter a prompt and click Generate')}</EmptyDescription>
      </Empty>
    )
  }
  const canGenerate =
    Boolean(model && prompt.trim() && option) &&
    !(mode === 'first_tail_to_video' && (!firstFrame || !lastFrame)) &&
    !(mode === 'reference_to_video' && referenceImages.length === 0) &&
    !generate.isPending

  const estimate = estimateQuery.data
  let priceNode
  if (!estimateEnabled) {
    priceNode = t('Select a model to see the price')
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
      <ul className='flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1'>
        {recentQuery.data.map((task) => (
          <li key={task.task_id}>
            <button
              className='flex w-full min-w-0 items-center gap-2 rounded-lg border p-2 text-left text-sm hover:bg-muted/50'
              title={task.properties?.input}
              type='button'
              onClick={() => setSubmittedTaskId(task.task_id)}
            >
              {task.status === 'SUCCESS' && task.preview ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  className='size-12 shrink-0 rounded object-cover'
                  muted
                  preload='metadata'
                  src={task.preview}
                />
              ) : (
                <span className={`${statusDotClass(task.status)} mx-1 shrink-0`} />
              )}
              <span className='min-w-0 flex-1'>
                <span className='block truncate'>
                  {task.properties?.input ?? task.task_id}
                </span>
                <span className='text-xs text-muted-foreground'>
                  {t(statusLabel(task.status))}
                  {isVideoStatusTerminal(task.status) ? '' : ` · ${task.progress || '0%'}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
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
      // Matches the image panel: a smaller radius token for the dense controls.
      className='min-h-0 flex-1 [--radius:0.5rem]'
      orientation={isMobile ? 'vertical' : 'horizontal'}
    >
      {/* Left: generation settings */}
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
          <ModelGroupSelector
            disabled={groupsQuery.isLoading}
            groups={groupsQuery.data ?? []}
            models={videoModels}
            onGroupChange={(value) => {
              setGroup(value)
              setModel('')
            }}
            onModelChange={setModel}
            selectedGroup={group}
            selectedModel={model}
          />

          <div className='space-y-2'>
            <Label>{t('Mode')}</Label>
            <RadioGroup
              className='flex flex-col gap-2'
              value={mode}
              onValueChange={(value) => setMode(value as VideoMode)}
            >
              {modes.map((option) => (
                <div key={option.value} className='flex items-center gap-2'>
                  <RadioGroupItem id={`video-mode-${option.value}`} value={option.value} />
                  <Label htmlFor={`video-mode-${option.value}`}>{t(VIDEO_MODE_LABELS[option.value])}</Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div className='space-y-2'>
            <Label htmlFor='video-prompt'>{t('Prompt')}</Label>
            <Textarea
              id='video-prompt'
              className='field-sizing-fixed'
              placeholder={t('Describe the video you want to generate')}
              rows={5}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>

          {(modeRefs === 1 || modeRefs === 2 || modeRefs === 'multi') && option ? (
            <div className='space-y-2'>
              <Label>{t('Reference images')}</Label>
              {mode === 'first_tail_to_video' ? (
                <>
                  <input
                    ref={firstFrameRef}
                    accept='image/*'
                    className='hidden'
                    type='file'
                    onChange={(event) => {
                      const files = event.target.files ? [...event.target.files] : []
                      event.currentTarget.value = ''
                      void onUpload('first', files)
                    }}
                  />
                  <input
                    ref={lastFrameRef}
                    accept='image/*'
                    className='hidden'
                    type='file'
                    onChange={(event) => {
                      const files = event.target.files ? [...event.target.files] : []
                      event.currentTarget.value = ''
                      void onUpload('last', files)
                    }}
                  />
                  <Button
                    className='w-full justify-start gap-2'
                    type='button'
                    variant='outline'
                    onClick={() => firstFrameRef.current?.click()}
                  >
                    <ImagePlusIcon size={16} />
                    {t('Upload first frame')}
                  </Button>
                  <Button
                    className='w-full justify-start gap-2'
                    type='button'
                    variant='outline'
                    onClick={() => lastFrameRef.current?.click()}
                  >
                    <ImagePlusIcon size={16} />
                    {t('Upload last frame')}
                  </Button>
                </>
              ) : (
                <input
                  ref={referenceRef}
                  accept='image/*'
                  className='hidden'
                  type='file'
                  multiple
                  onChange={(event) => {
                    const files = event.target.files ? [...event.target.files] : []
                    event.currentTarget.value = ''
                    void onUpload('reference', files)
                  }}
                />
              )}
              {mode === 'reference_to_video' ? (
                <Button
                  className='w-full justify-start gap-2'
                  type='button'
                  variant='outline'
                  onClick={() => referenceRef.current?.click()}
                >
                  <ImagePlusIcon size={16} />
                  {t('Upload reference images')}
                </Button>
              ) : null}
              {firstFrame ? (
                <div className='relative'>
                  <img
                    alt={t('First frame')}
                    className='max-h-32 w-full rounded-lg border object-contain'
                    src={firstFrame}
                  />
                  <button
                    aria-label={t('Remove')}
                    className='bg-background/80 text-muted-foreground hover:text-destructive absolute top-1.5 right-1.5 rounded-full p-1'
                    title={t('Remove')}
                    type='button'
                    onClick={() => setFirstFrame(null)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : null}
              {lastFrame ? (
                <div className='relative'>
                  <img
                    alt={t('Last frame')}
                    className='max-h-32 w-full rounded-lg border object-contain'
                    src={lastFrame}
                  />
                  <button
                    aria-label={t('Remove')}
                    className='bg-background/80 text-muted-foreground hover:text-destructive absolute top-1.5 right-1.5 rounded-full p-1'
                    title={t('Remove')}
                    type='button'
                    onClick={() => setLastFrame(null)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : null}
              {referenceImages.length > 0 ? (
                <div className='grid grid-cols-3 gap-2'>
                  {referenceImages.map((image) => (
                    <div key={`${image.length}-${image.slice(-16)}`} className='relative'>
                      <img
                        alt={t('Reference image')}
                        className='aspect-square w-full rounded-lg border object-cover'
                        src={image}
                      />
                      <button
                        aria-label={t('Remove')}
                        className='bg-background/80 text-muted-foreground hover:text-destructive absolute top-1 right-1 rounded-full p-1'
                        title={t('Remove')}
                        type='button'
                        onClick={() =>
                          setReferenceImages((previous) => {
                            const itemIndex = previous.indexOf(image)
                            return itemIndex < 0
                              ? previous
                              : previous.filter((_, currentIndex) => currentIndex !== itemIndex)
                          })
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className='grid grid-cols-1 gap-3'>
            {option ? (
              <>
                <div className='space-y-2'>
                  <Label>{t('Resolution')}</Label>
                  <Select
                    items={option.resolutions.map((item) => ({
                      value: item.value,
                      label: item.label,
                    }))}
                    value={resolution}
                    onValueChange={(value) => setResolution(String(value))}
                  >
                    <SelectTrigger className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {option.resolutions.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className='space-y-2'>
                  <Label>{t('Duration')}</Label>
                  <Select
                    items={option.durations.map((item) => ({
                      value: String(item),
                      label: `${item}s`,
                    }))}
                    value={String(duration)}
                    onValueChange={(value) => setDuration(Number(value))}
                  >
                    <SelectTrigger className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {option.durations.map((item) => (
                          <SelectItem key={item} value={String(item)}>
                            {item}s
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className='space-y-2'>
                  <Label>{t('Aspect ratio')}</Label>
                  <Select
                    items={option.ratios.map((item) => ({
                      value: item.value,
                      label: item.label,
                    }))}
                    value={aspect}
                    onValueChange={(value) => setAspect(String(value))}
                  >
                    <SelectTrigger className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {option.ratios.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : null}
          </div>

          <div className='rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground'>
            <p>{priceNode}</p>
            {estimate ? (
              <p className='mt-0.5 text-xs'>{t('Final cost is settled when the task completes')}</p>
            ) : null}
          </div>

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

      {/* Center: result + progress */}
      <ResizablePanel className='min-w-0' defaultSize={isMobile ? '38%' : '70%'} minSize='0%'>
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
        <div className='flex h-full min-w-0 flex-col gap-3 p-4'>
          <h3 className='text-sm font-medium'>{t('Recent generations')}</h3>
          {recentContent}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
