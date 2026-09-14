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
import { useQuery } from '@tanstack/react-query'
import dayjs from 'dayjs'
import {
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  LoaderCircle,
  XCircle,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/error-state'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatLogQuota } from '@/lib/format'
import { getUserWorkbenchTasks, getWorkbenchTask } from '../../api'
import {
  WORKBENCH_ACTION_WHITELIST,
  WORKBENCH_RUNNING_STATUSES,
} from '../../constants'
import { isImageTask, isRunningStatus } from '../../lib/workbench-utils'
import type { WorkbenchTask } from '../../types'
import { ImageResultGrid, VideoResult } from './result-viewer'

type TaskFilter = 'all' | 'running' | 'success' | 'failure'

const TASK_PAGE_SIZE = 15

// Each filter maps to every status it stands for. Sending the whole set matters
// once the list is paginated: filtering on the client would only ever see the
// rows of the current page, so "running" would silently miss the rest.
const FILTER_STATUSES: Record<TaskFilter, readonly string[] | null> = {
  all: null,
  running: WORKBENCH_RUNNING_STATUSES,
  success: ['SUCCESS'],
  failure: ['FAILURE'],
}

function statusInfo(task: WorkbenchTask): { label: string; className: string } {
  if (task.status === 'SUCCESS') {
    return { label: 'Success', className: 'bg-green-500/15 text-green-600' }
  }
  if (task.status === 'FAILURE') {
    return { label: 'Failure', className: 'bg-destructive/15 text-destructive' }
  }
  return { label: 'Running', className: 'bg-blue-500/15 text-blue-600' }
}

export function TaskPanel({ active = true }: { active?: boolean }) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const statuses = FILTER_STATUSES[filter]

  const tasksQuery = useQuery({
    queryKey: ['workbench-tasks', filter, page],
    queryFn: () =>
      getUserWorkbenchTasks({
        actions: [...WORKBENCH_ACTION_WHITELIST],
        page,
        pageSize: TASK_PAGE_SIZE,
        statuses: statuses ? [...statuses] : undefined,
      }),
    enabled: active,
    // Only poll while something on screen is still running: a page of finished
    // records never changes, so polling it would just re-fetch the same rows.
    refetchInterval: (query) => {
      const items = (query.state.data?.items ?? []) as WorkbenchTask[]
      return items.some((task) => isRunningStatus(task.status)) ? 3000 : false
    },
    staleTime: 2000,
  })

  const tasks = tasksQuery.data?.items ?? []
  const total = tasksQuery.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / TASK_PAGE_SIZE))

  // Deleting the last record of a trailing page would otherwise leave the
  // operator on an empty page while matching records still exist before it.
  useEffect(() => {
    if (total > 0 && page > totalPages) {
      setPage(totalPages)
    }
  }, [page, total, totalPages])

  // The list carries a preview only, so the open record is fetched in full. The
  // detail is tied to a visible row: switching filter or page closes it rather
  // than leaving a record from another page on screen.
  const selectedRow = tasks.find((task) => task.task_id === selectedId) ?? null
  const detailQuery = useQuery({
    queryKey: ['workbench-task-detail', selectedId],
    queryFn: () => getWorkbenchTask(selectedId ?? ''),
    enabled: active && selectedRow !== null,
  })
  const selected = detailQuery.data ?? null

  // The detail area is one of four shapes, so it is picked here rather than
  // stacked into nested ternaries in the markup.
  let detailContent
  if (detailQuery.isPending) {
    detailContent = (
      <span className='text-muted-foreground text-sm'>{t('Loading...')}</span>
    )
  } else if (detailQuery.isError) {
    detailContent = (
      <p className='text-destructive text-sm'>{t('Failed to load')}</p>
    )
  } else if (selected && isImageTask(selected) && selected.data?.images) {
    detailContent = (
      <ImageResultGrid
        images={selected.data.images}
        meta={{
          model: selected.properties?.origin_model_name,
          createdAt: selected.finish_time || selected.submit_time,
          status: selected.status,
        }}
      />
    )
  } else if (selected && !isImageTask(selected) && selected.preview) {
    detailContent = <VideoResult url={selected.preview} />
  }

  let listContent
  if (tasksQuery.isLoading) {
    listContent = (
      <div className='flex min-h-0 flex-1 items-center justify-center'>
        <Spinner className='size-6' />
      </div>
    )
  } else if (tasksQuery.isError) {
    listContent = (
      <ErrorState
        className='min-h-0 flex-1'
        description={t('Failed to load')}
        onRetry={() => void tasksQuery.refetch()}
      />
    )
  } else if (tasks.length === 0) {
    listContent = (
      <Empty className='min-h-0 flex-1'>
        <EmptyTitle>{t('No tasks')}</EmptyTitle>
        <EmptyDescription>
          {t('Tasks created in the Image and Video tabs appear here')}
        </EmptyDescription>
      </Empty>
    )
  } else {
    listContent = (
      <div className='min-h-0 flex-1 overflow-auto rounded-lg border'>
        <table className='w-full min-w-[52rem] text-sm'>
          <thead className='bg-muted/80 text-muted-foreground sticky top-0 text-left text-xs'>
            <tr>
              <th className='px-3 py-2 font-medium'>{t('Preview')}</th>
              <th className='px-3 py-2 font-medium'>{t('Task')}</th>
              <th className='px-3 py-2 font-medium'>{t('Model')}</th>
              <th className='px-3 py-2 font-medium'>{t('Type')}</th>
              <th className='px-3 py-2 font-medium'>{t('Status')}</th>
              <th className='px-3 py-2 font-medium'>{t('Cost')}</th>
              <th className='px-3 py-2 font-medium'>{t('Created at')}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <TaskRow
                key={task.task_id}
                open={task.task_id === selectedId}
                task={task}
                onToggle={() =>
                  setSelectedId(task.task_id === selectedId ? null : task.task_id)
                }
              />
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    // size-full matters: the panel is a flex item of the tab strip's content
    // row, and without an explicit width it shrinks to the table's content
    // width instead of filling the workspace.
    <div className='flex size-full min-h-0 flex-col gap-3 p-4'>
      <div className='flex shrink-0 items-center gap-2'>
        {/* overflow-y is pinned to hidden: leaving it visible makes the browser
            compute it as auto, which draws a stray vertical scrollbar beside the
            filter row over a sub-pixel height difference. */}
        <Tabs
          className='overflow-x-auto overflow-y-hidden'
          value={filter}
          onValueChange={(value) => {
            setFilter(value as TaskFilter)
            setPage(1)
          }}
        >
          <TabsList>
            <TabsTrigger className='gap-1.5 px-4' value='all'>
              <LayoutGrid className='size-4' />
              {t('All')}
            </TabsTrigger>
            <TabsTrigger className='gap-1.5 px-4' value='running'>
              <LoaderCircle className='text-amber-500 size-4' />
              {t('Running')}
            </TabsTrigger>
            <TabsTrigger className='gap-1.5 px-4' value='success'>
              <CheckCircle className='text-green-600 size-4' />
              {t('Success')}
            </TabsTrigger>
            <TabsTrigger className='gap-1.5 px-4' value='failure'>
              <XCircle className='text-destructive size-4' />
              {t('Failure')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {listContent}

      {selectedRow ? (
        <div
          id={`task-details-${selectedRow.task_id}`}
          className='max-h-[45%] min-h-0 shrink-0 overflow-y-auto rounded-lg border p-3'
        >
          <div className='mb-2 flex flex-wrap items-center gap-3 text-sm'>
            <span className='font-medium'>
              {selectedRow.properties?.input ?? selectedRow.task_id}
            </span>
            <span className='text-muted-foreground'>
              {selectedRow.fail_reason || ''}
            </span>
          </div>
          {detailContent}
        </div>
      ) : null}

      {/* Pagination is pinned to the bottom-right corner as the panel's footer,
          so it stays put whether or not a record is expanded above it. */}
      <div className='text-muted-foreground flex shrink-0 items-center justify-end gap-2 text-xs'>
        <span>
          {t('Total')}: {total}
        </span>
        <Button
          aria-label={t('Previous page')}
          className='size-7 p-0'
          disabled={page <= 1}
          type='button'
          variant='ghost'
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          <ChevronLeft className='size-4' />
        </Button>
        <span className='tabular-nums'>
          {t('Page {{current}} of {{total}}', {
            current: page,
            total: totalPages,
          })}
        </span>
        <Button
          aria-label={t('Next page')}
          className='size-7 p-0'
          disabled={page >= totalPages}
          type='button'
          variant='ghost'
          onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
        >
          <ChevronRight className='size-4' />
        </Button>
      </div>
    </div>
  )
}

function TaskRow({
  task,
  open,
  onToggle,
}: {
  task: WorkbenchTask
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const status = statusInfo(task)
  const image = isImageTask(task)
  const running = isRunningStatus(task.status)
  const preview = task.preview ?? ''

  // A row shows the image, a video's first frame, or a status chip while there
  // is nothing to show yet.
  let thumbnail
  if (!preview) {
    thumbnail = (
      <span className='text-muted-foreground flex size-full items-center justify-center px-0.5 text-center text-[10px] leading-tight'>
        {running ? t('Generating...') : t(status.label)}
      </span>
    )
  } else if (image) {
    thumbnail = (
      <img
        alt=''
        className='size-full object-cover'
        loading='lazy'
        src={preview}
      />
    )
  } else {
    // A video preview is the artifact itself: metadata preload shows its first
    // frame without downloading the whole file.
    thumbnail = (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        className='size-full object-cover'
        muted
        preload='metadata'
        src={preview}
      />
    )
  }

  return (
    <tr
      aria-controls={open ? `task-details-${task.task_id}` : undefined}
      aria-expanded={open}
      aria-label={t('Open task details')}
      className={`cursor-pointer border-t outline-none focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${open ? 'bg-accent/40' : 'hover:bg-muted/50'}`}
      role='button'
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
    >
      <td className='px-3 py-2'>
        <span className='bg-muted block size-10 overflow-hidden rounded'>
          {thumbnail}
        </span>
      </td>
      <td className='max-w-64 truncate px-3 py-2' title={task.properties?.input}>
        {task.properties?.input ?? task.task_id}
      </td>
      <td className='max-w-48 truncate px-3 py-2 text-muted-foreground'>
        {task.properties?.origin_model_name ?? task.platform}
      </td>
      <td className='px-3 py-2'>{image ? t('Image') : t('Video')}</td>
      <td className='px-3 py-2'>
        <Badge className={status.className}>
          {t(status.label)}
          {running && task.progress ? ` ${task.progress}` : ''}
        </Badge>
      </td>
      {/* Quota is stored in internal units; the column shows what the call
          actually consumed, in the display currency the operator configured. */}
      <td className='px-3 py-2 tabular-nums text-muted-foreground'>
        {formatLogQuota(task.quota)}
      </td>
      <td className='px-3 py-2 text-muted-foreground'>
        {dayjs.unix(task.submit_time).format('MM-DD HH:mm')}
      </td>
    </tr>
  )
}
