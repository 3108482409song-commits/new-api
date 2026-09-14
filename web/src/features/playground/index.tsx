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
import { Image as ImageIcon, ListChecks, MessageSquare, Video as VideoIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'

import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { ChatPanel } from './components/workbench/chat-panel'
import { ImagePanel } from './components/workbench/image-panel'
import { TaskPanel } from './components/workbench/task-panel'
import { VideoPanel } from './components/workbench/video-panel'

export function Playground() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('chat')

  return (
    <div className='flex size-full min-h-0 flex-col'>
      <Tabs className='min-h-0 flex-1' value={activeTab} onValueChange={setActiveTab}>
        <div className='flex flex-col'>
          {/* flex + mx-auto on the list centres it while it fits, and collapses
              to a scrollable left-aligned row once it is wider than the bar.
              overflow-y is pinned to hidden: leaving it visible makes the
              browser compute it as auto, which puts a stray vertical scrollbar
              on the right of the bar over a sub-pixel height difference. */}
          <div className='flex overflow-x-auto overflow-y-hidden px-4 pt-3'>
            <TabsList className='mx-auto min-w-max'>
              <TabsTrigger className='gap-1.5 px-3 sm:min-w-36 sm:px-4' value='chat'>
                <MessageSquare className='size-4' />
                {t('Chat')}
              </TabsTrigger>
              <TabsTrigger className='gap-1.5 px-3 sm:min-w-36 sm:px-4' value='image'>
                <ImageIcon className='size-4' />
                {t('Image')}
              </TabsTrigger>
              <TabsTrigger className='gap-1.5 px-3 sm:min-w-36 sm:px-4' value='video'>
                <VideoIcon className='size-4' />
                {t('Video')}
              </TabsTrigger>
              <TabsTrigger className='gap-1.5 px-3 sm:min-w-36 sm:px-4' value='tasks'>
                <ListChecks className='size-4' />
                {t('Task list')}
              </TabsTrigger>
            </TabsList>
          </div>
          <Separator className='mt-3' />
        </div>
        {/* keepMounted keeps each panel's in-progress work (prompt, uploaded
            frames, results) alive while the user checks another tab. Panels
            gate their queries on `active`, so inactive tabs stay idle. */}
        <TabsContent className='flex min-h-0 flex-1' keepMounted value='chat'>
          <ChatPanel />
        </TabsContent>
        <TabsContent className='flex min-h-0 flex-1' keepMounted value='image'>
          <ImagePanel active={activeTab === 'image'} />
        </TabsContent>
        <TabsContent className='flex min-h-0 flex-1' keepMounted value='video'>
          <VideoPanel active={activeTab === 'video'} />
        </TabsContent>
        <TabsContent className='flex min-h-0 flex-1' keepMounted value='tasks'>
          <TaskPanel active={activeTab === 'tasks'} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
