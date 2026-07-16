// harness-chat lane A B4 (task 07-15) — the ONE unread-badge derivation the three history lists
// share (ChatHistoryPopover / ChatModalHistoryDropdown / AgentThreadList), so the semantics can't
// drift between surfaces.
//
// unread ⇔ the session was READ at least once (last_read_at non-null) AND new content landed after
// that (updated_at > last_read_at — appendMessage bumps updated_at on every persisted turn,
// including the approval-pause eager persist). last_read_at NULL/undefined (legacy pre-v20 rows /
// never-opened sessions / Python mirror on a not-yet-migrated DB) deliberately reads as NOT unread:
// lighting up the entire history on first launch after the v20 migration would be noise, and a
// session the user never opened has no "came back to unread" story to tell.

import type { ChatSession } from '@shared/api/types'

export function isSessionUnread(
  session: Pick<ChatSession, 'updated_at'> & { last_read_at?: number | null }
): boolean {
  return session.last_read_at != null && session.updated_at > session.last_read_at
}
