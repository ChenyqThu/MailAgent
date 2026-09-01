// L4 群聊（CHAT_DB v30）— group-chat SPEAKER-run pure helpers.
//
// A group session (ai_chat_sessions origin='group' + members_json) holds ONE shared transcript;
// each member's speaking turn is a separate LLM run driven by POST /api/ai/group-chat
// (server.ts handleGroupChat). This module owns the two pure pieces of that run:
//
//   • parseGroupMemberIds — the members_json → string[] read (tolerant: anything that isn't a
//     non-empty string array collapses to []; a group with zero readable members admits no speaker).
//   • assembleGroupHistory — the 多人历史装配约定 (task spec §2): the speaking agent's own
//     persisted assistant rows become `assistant`-role history; every OTHER participant's row
//     becomes `user`-role text prefixed with its speaker label (`[标题] …` for other agents,
//     `[用户] …` for the owner). Consecutive user-role texts are merged into ONE user message —
//     the model sees a strictly alternating transcript regardless of how many members spoke
//     between the agent's own turns.
//
// 🔴 Pure: no node:http / electron / ai imports. Unit-tested in plain Node
// (tests/ai-gateway/group_chat.test.ts).

import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
import type { GroupHistoryRow } from './config'

/** The owner's speaker label in assembled history. One fixed label (not the account name) so the
 *  convention is stable across accounts and the prompt block can explain it verbatim. */
export const GROUP_USER_LABEL = '用户'

/** Parse ai_chat_sessions.members_json into the member agent-id array. Tolerant by contract:
 *  malformed JSON / non-array / non-string entries → dropped (a zero-member group admits no
 *  speaker — handleGroupChat then 403s every speakAsAgentId). */
export function parseGroupMemberIds(membersJson: string | null | undefined): string[] {
  if (typeof membersJson !== 'string' || membersJson.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(membersJson)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
  } catch {
    return []
  }
}

/**
 * Assemble the model-facing history for ONE speaker's turn.
 *
 * Rows admitted: role 'user'|'assistant' with non-empty content, status 'complete' (or absent —
 * hand-built fixtures); error/aborted/streaming rows never reach the model. Returns UIMessages
 * (text parts only — a group speaking turn is text-in/text-out by design).
 */
export function assembleGroupHistory(
  rows: readonly GroupHistoryRow[],
  speakAsAgentId: string,
  titleByAgentId: ReadonlyMap<string, string>
): MailAgentUIMessage[] {
  const messages: MailAgentUIMessage[] = []
  let seq = 0
  const push = (role: 'user' | 'assistant', text: string): void => {
    const last = messages[messages.length - 1]
    // Merge consecutive user-role texts (see header). Assistant rows are the speaker's OWN turns
    // and stay one-message-per-row.
    if (role === 'user' && last?.role === 'user') {
      const part = last.parts[0] as { type: 'text'; text: string }
      part.text = `${part.text}\n\n${text}`
      return
    }
    messages.push({
      id: `group-${role}-${seq++}`,
      role,
      parts: [{ type: 'text', text }]
    } as MailAgentUIMessage)
  }
  for (const row of rows) {
    if (typeof row.content !== 'string' || row.content.length === 0) continue
    if (row.status != null && row.status !== 'complete') continue
    if (row.role === 'user') {
      push('user', `[${GROUP_USER_LABEL}] ${row.content}`)
    } else if (row.role === 'assistant') {
      const speaker = row.speakerAgentId
      if (speaker != null && speaker === speakAsAgentId) {
        push('assistant', row.content)
      } else {
        // Another member's reply (or a legacy NULL-speaker assistant row) reads as third-party
        // speech: user role, labelled. NULL speaker in a group session can only come from
        // pre-group rows and is labelled with its raw id fallback.
        const label = speaker == null ? GROUP_USER_LABEL : (titleByAgentId.get(speaker) ?? speaker)
        push('user', `[${label}] ${row.content}`)
      }
    }
    // system/tool rows (none are written by the group writer) are skipped.
  }
  return messages
}
