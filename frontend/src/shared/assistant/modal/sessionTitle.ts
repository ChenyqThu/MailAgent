// assistant-modal P4 — shared session-title precedence (no component export, so importing it doesn't
// break react-refresh's only-export-components in either consumer). Mirrors AgentThreadList.titleOf:
// stored title (manual rename / haiku auto-title) → email subject → first user message → "untitled".

import type { TFunction } from 'i18next'
import type { ChatSessionListItem } from '@shared/api/types'

export function titleOf(item: ChatSessionListItem, t: TFunction): string {
  return (
    item.title?.trim() ||
    item.email_subject?.trim() ||
    item.first_user_message?.trim() ||
    t('sessions.untitled')
  )
}
