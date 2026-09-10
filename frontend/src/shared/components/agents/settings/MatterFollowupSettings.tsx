// 09-02 misc05 —「事项跟进」成员的设置档。
//
// 跟进的全局默认（任务契约 / 模型三档 / 工具面）直接铺在这里，与其它成员同一副设置骨架。
// 🔴 数据仍只有一份：三块与「设置 → 事项」里的全局配置弹窗共用同一组 hook 与组件
// （`useMatterTaskContract` / `MatterModelDefaultsPanel` / `MatterToolFacePanel`），不是第二套表单。
// 逐事项的跟进规则仍在那件事自己的页面里。
// 页头「保存」只管任务契约；模型与网页档是改一下存一次（两个面板的既有交互，见各自头注）。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MatterModelDefaultsPanel } from '@shared/components/matters/MatterModelDefaultsPanel'
import { MatterPromptAssembly } from '@shared/components/matters/MatterPromptAssembly'
import { MatterTaskContractField } from '@shared/components/matters/MatterTaskContractField'
import { MatterToolFacePanel } from '@shared/components/matters/MatterToolFacePanel'
import { useMatterTaskContract } from '@shared/components/matters/useMatterGlobalAgentDoc'
import type { StatefulButtonState } from '@shared/components/ui/stateful-button'

import { ReadonlyCard, SettingsScaffold } from './sections'

export function MatterFollowupSettings(): React.ReactElement {
  const { t } = useTranslation()
  const [saveDone, setSaveDone] = useState(false)
  const contract = useMatterTaskContract(() => {
    setSaveDone(true)
    window.setTimeout(() => setSaveDone(false), 1600)
  })
  const saveState: StatefulButtonState = contract.isSaving
    ? 'loading'
    : contract.isSaveError
      ? 'error'
      : saveDone
        ? 'success'
        : 'idle'

  return (
    <SettingsScaffold
      title={t('team.matterFollowup.title')}
      subtitle={t('agentSettings.role.builtin')}
      banner={
        <p data-matter-followup-settings className="text-meta leading-relaxed text-ink-fg-2">
          {t('team.matterFollowup.settingsIntro')}
        </p>
      }
      save={{ state: saveState, onSave: contract.save, disabled: !contract.canSave }}
      sections={{
        instructions: (
          <>
            <MatterPromptAssembly />
            <MatterTaskContractField contract={contract} />
          </>
        ),
        model: <MatterModelDefaultsPanel embedded />,
        capabilities: <MatterToolFacePanel embedded />,
        specific: (
          <ReadonlyCard title={t('team.matterFollowup.perMatterTitle')}>
            {t('team.matterFollowup.perMatterNote')}
          </ReadonlyCard>
        )
      }}
    />
  )
}
