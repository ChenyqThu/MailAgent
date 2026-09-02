// L4 群聊 UX 批 — 折叠组：同人 3 分钟内连发只画一次头像 + 名字 + 相对时间，气泡逐条列出。
//
// 🔴 DOM 契约（GroupChat.test.tsx V1 的三条选择器，design §2.6「组件不变式」）：
//   (a) 名字元素 textContent 恒 === 名字：相对时间用 data-time + `::after { content: attr(data-time) }`
//       画在右侧（伪元素不进 textContent），元素内不放任何子节点；
//   (b) 组容器类名 `flex max-w-[86%] items-start gap-2.5` 逐字保留（closest 选择器），头像
//       `[data-avatar=id][data-size="30"]` 在容器内；
//   (c) 第一条气泡是名字元素的**下一个兄弟**（previousElementSibling）。
//   user 组：右对齐容器保留 `self-end`。
// 做不到 (a)/(c) 必须回 PRD 改 AC7，不许单方面改 V1。

import { Fragment, memo } from 'react'
import { useTranslation } from 'react-i18next'

import type { AgentAvatarConfig } from '@shared/api/types'
import type { GroupAttachment } from '@shared/chat_model'

import type { GroupMentionMember } from '../../../../ai-gateway/groupChat'
import { AgentAvatar } from '../AgentAvatar'
import { GroupBubble } from './GroupBubble'
import { absoluteTimeLabel, relativeTimeLabel } from './groupPresentation'
import type { GroupTimelineItem } from './groupTimeline'

export type GroupTimelineGroup = Extract<GroupTimelineItem, { kind: 'group' }>

export const GroupMessageGroup = memo(function GroupMessageGroup({
  item,
  name,
  color,
  avatar,
  members,
  memberIds,
  now,
  attachmentsById
}: {
  item: GroupTimelineGroup
  /** 成员组的名字（user 组不用）。 */
  name: string
  color: string
  avatar?: AgentAvatarConfig | null
  members: readonly GroupMentionMember[]
  memberIds: readonly string[]
  now: number
  /** T2 — 落库 user 行的附件（按消息 id）；本地气泡 id 为 null，不查。 */
  attachmentsById: ReadonlyMap<number, readonly GroupAttachment[]>
}): React.ReactElement {
  const { t } = useTranslation()
  const rel = relativeTimeLabel(item.startedAt, now, t)

  if (item.speaker.type === 'user') {
    return (
      <div className="flex max-w-[86%] flex-col items-end gap-1 self-end">
        <div className="text-meta tabular-nums text-ink-fg-3">{rel}</div>
        {item.messages.map((m) => (
          <Fragment key={m.key}>
            <GroupBubble
              text={m.text}
              streaming={false}
              variant="user"
              members={members}
              memberIds={memberIds}
              usage={null}
              title={absoluteTimeLabel(m.createdAt)}
              attachments={m.id != null ? attachmentsById.get(m.id) : undefined}
            />
            {m.failed && (
              <div className="text-micro text-fail">
                {t('groupChat.sendFailed', { error: m.error ?? 'unknown' })}
              </div>
            )}
          </Fragment>
        ))}
      </div>
    )
  }

  const agentId = item.speaker.agentId
  return (
    <div className="flex max-w-[86%] items-start gap-2.5">
      <div className="shrink-0 pt-0.5">
        <AgentAvatar agentId={agentId} config={avatar} size={30} title={name} />
      </div>
      <div className="flex min-w-0 flex-col items-start">
        <div
          data-time={rel}
          className="mb-0.5 text-micro font-semibold after:ml-1.5 after:font-normal after:tabular-nums after:text-ink-fg-3 after:content-[attr(data-time)] after:text-meta"
          style={{ color }}
        >
          {name}
        </div>
        {item.messages.map((m, i) => (
          <Fragment key={m.key}>
            <GroupBubble
              text={m.text}
              streaming={m.streaming}
              variant="member"
              typingName={name}
              members={members}
              memberIds={memberIds}
              usage={m.usage}
              title={absoluteTimeLabel(m.createdAt)}
              className={i > 0 ? 'mt-1' : undefined}
            />
            {m.failed && (
              <div className="mt-1 text-micro text-fail">
                {t('groupChat.speakerFailed', { error: m.error ?? 'unknown' })}
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  )
})
