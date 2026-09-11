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
import { CheckCircle, LayoutGrid, LoaderCircle, XCircle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { ErrorState } from '@/components/error-state'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getUserWorkbenchTasks } from '../../api'
import { WORKBENCH_ACTION_WHITELIST } from '../../constants'
import { formatQuota, isImageTask, isRunningStatus, isWorkbenchTask } from '../../lib/workbench-utils'
import type { WorkbenchTask } from '../../types'
import { ImageResultGrid, VideoResult } from './result-viewer'

type TaskFilter = 'all' | 'running' | 'success' | 'failure'

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
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const tasksQuery = useQuery({
    queryKey: ['workbench-tasks'],
    queryFn: async () => {
      const page = await getUserWorkbenchTasks({
        actions: [...WORKBENCH_ACTION_WHITELIST],
        page: 1,
        pageSize: 100,
      })
      return page.items.filter(isWorkbenchTask)
    },
    enabled: active,
    refetchInterval: 3000,
    staleTime: 2000,
  })

  const tasks = tasksQuery.data ?? []
  const filtered = tasks.filter((task) => {
    if (filter === 'running') {
      return isRunningStatus(task.status)
    }
    if (filter === 'success') {
      return task.status === 'SUCCESS'
    }
    if (filter === 'failure') {
      return task.status === 'FAILURE'
    }
    return true
  })
  const selected = tasks.find((task) => task.task_id === selectedId) ?? null

  let listContent
  if (tasksQuery.isLoading) {
    listContent = (
      <div className='flex flex-1 items-center justify-center'>
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
  } else if (filtered.length === 0) {
    listContent = (
      <Empty className='flex-1'>
        <EmptyTitle>{t('No tasks')}</EmptyTitle>
        <EmptyDescription>{t('Tasks created in the Image and Video tabs appear here')}</EmptyDescription>
      </Empty>
    )
  } else {
    listContent = (
      <div className='min-h-0 flex-1 overflow-auto rounded-lg border'>
        <table className='min-w-[42rem] w-full text-sm'>
          <thead className='sticky top-0 bg-muted/80 text-left text-xs text-muted-foreground'>
            <tr>
              <th className='px-3 py-2 font-medium'>{t('Task')}</th>
              <th className='px-3 py-2 font-medium'>{t('Model')}</th>
              <th className='px-3 py-2 font-medium'>{t('Type')}</th>
              <th className='px-3 py-2 font-medium'>{t('Status')}</th>
              <th className='px-3 py-2 font-medium'>{t('Quota')}</th>
              <th className='px-3 py-2 font-medium'>{t('Created at')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((task) => {
              const status = statusInfo(task)
              const image = isImageTask(task)
              const open = selected?.task_id === task.task_id
              return (
                <TaskRow
                  key={task.task_id}
                  image={image}
                  open={open}
                  status={status}
                  task={task}
                  onToggle={() => setSelectedId(open ? null : task.task_id)}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className='flex h-full min-h-0 flex-col gap-3 p-4'>
      <Tabs
        className='max-w-full overflow-x-auto'
        value={filter}
        onValueChange={(value) => setFilter(value as TaskFilter)}
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

      {listContent}

      {selected ? (
        <div id={`task-details-${selected.task_id}`} className='max-h-64 overflow-y-auto rounded-lg border p-3'>
          <div className='mb-2 flex flex-wrap items-center gap-3 text-sm'>
            <span className='font-medium'>{selected.properties?.input ?? selected.task_id}</span>
            <span className='text-muted-foreground'>{selected.fail_reason || ''}</span>
          </div>
          {isImageTask(selected) && selected.data?.images ? (
            <ImageResultGrid images={selected.data.images} />
          ) : null}
          {!isImageTask(selected) && selected.result_url ? (
            <VideoResult url={selected.result_url} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function TaskRow({
  task,
  image,
  status,
  open,
  onToggle,
}: {
  task: WorkbenchTask
  image: boolean
  status: { label: string; className: string }
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
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
          {isRunningStatus(task.status) && task.progress ? ` ${task.progress}` : ''}
        </Badge>
      </td>
      <td className='px-3 py-2 text-muted-foreground'>{formatQuota(task.quota)}</td>
      <td className='px-3 py-2 text-muted-foreground'>
        {dayjs.unix(task.submit_time).format('MM-DD HH:mm')}
      </td>
    </tr>
  )
}
