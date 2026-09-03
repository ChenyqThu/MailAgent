// 09-02 misc05 —「事项跟进」成员的设置档。
//
// 🔴 这里只做**深链**，不复制配置面（判据与「设置 → 事项」那一页逐字相同）：跟进的可写面
// 全在事项域 —— 全局默认在 `MatterGlobalAgentModal`（任务契约 prompt / 模型三档 / 工具面），
// 逐事项的跟进规则在那件事自己的页面里。同一份数据再画一遍表单就是第二处真相。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2 } from 'lucide-react'

import { MatterGlobalAgentModal } from '@shared/components/matters/MatterGlobalAgentModal'
import { Button } from '@shared/components/ui/button'

import { ReadonlyCard } from './sections'

export function MatterFollowupSettings(): React.ReactElement {
  const { t } = useTranslation()
  const [globalAgentOpen, setGlobalAgentOpen] = useState(false)

  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-matter-followup-settings>
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 p-[18px]">
        <p className="text-meta leading-relaxed text-ink-fg-2">
          {t('team.matterFollowup.settingsIntro')}
        </p>
        <div>
          <Button variant="outline" size="sm" onClick={() => setGlobalAgentOpen(true)}>
            <Settings2 size={13} />
            {t('team.matterFollowup.openGlobalConfig')}
          </Button>
        </div>
        <ReadonlyCard title={t('team.matterFollowup.perMatterTitle')}>
          {t('team.matterFollowup.perMatterNote')}
        </ReadonlyCard>
      </div>
      {globalAgentOpen ? (
        <MatterGlobalAgentModal onClose={() => setGlobalAgentOpen(false)} />
      ) : null}
    </div>
  )
}
