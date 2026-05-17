// Sprint 4 §6.7 — quick action chips above the composer. Each chip
// injects a pre-built user message and (in Sprint 5) auto-submits. For
// Sprint 4 we only inject — the user still hits ⌘↩ to send so they can
// edit the prefab before committing.

import { useTranslation } from 'react-i18next'
import { cn } from '@shared/lib/cn'

interface Props {
  onPick(prompt: string): void
  disabled?: boolean
}

interface ActionDef {
  key: string
  labelKey: string
  prompt: string
}

const ACTIONS: ActionDef[] = [
  {
    key: 'summarize',
    labelKey: 'chat.quickActions.summarize',
    prompt: '请用 3-5 个要点总结这封邮件的核心内容、发件人意图、需要我做什么。'
  },
  {
    key: 'draft',
    labelKey: 'chat.quickActions.draft',
    prompt: '基于这封邮件，请帮我起草一份合适的回复（中文）。'
  },
  {
    key: 'translate',
    labelKey: 'chat.quickActions.translate',
    prompt: '把这封邮件翻译成中文（保留语义、邮件礼仪、格式）。'
  },
  {
    key: 'extract',
    labelKey: 'chat.quickActions.extract',
    prompt: '请从这封邮件中提取所有动作项 (action items)：谁要做什么、什么时候、给谁回。'
  },
  {
    key: 'linkNotion',
    labelKey: 'chat.quickActions.linkNotion',
    prompt: '在我的 Notion workspace 里找到与这封邮件相关的项目页面，列出 3 个最相关的。'
  }
]

export function QuickActions({ onPick, disabled = false }: Props): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="px-3 pt-2 flex flex-wrap gap-1.5">
      {ACTIONS.map((a) => (
        <button
          key={a.key}
          type="button"
          disabled={disabled}
          onClick={() => onPick(a.prompt)}
          className={cn(
            'rounded-full px-2.5 py-1 text-aux',
            'text-ink-fg-1 border border-ink-border bg-ink-3',
            'hover:bg-ink-4 hover:border-ink-fg-3 transition-colors duration-fast',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {t(a.labelKey)}
        </button>
      ))}
    </div>
  )
}
