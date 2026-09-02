// GroupApprovalCards（L4 群聊 g2）—— group_create / group_post 两张审批卡。
//
// 两个工具都是 edit-tier + class capability_change，主 agent 单聊里默认弹卡。缺卡 = 审批暂停的
// tool part 落到无按钮的 ToolTraceCard（永久 spinner，无法批准）—— v1.5.0 那次死锁的形状，
// 所以两张卡与工具同批登记。
//
// 🔴 卡上的每个字都来自 tool part 自己（args / result）：群工具没有 audited ui_payload，
//    componentForTool 对它们返回 null。不去 serve-api 拉群事实 —— 建群时那个群还不存在，
//    投递的目标群标题也不在模型入参里。
// 🔴「首轮最多唤醒 N 位」是**上界**不是预测：真正唤醒谁由服务端调度器按响应模式 + 链地板决定，
//    卡片只把地板换算成一句人话（chainCap 不在工具入参里 → 从 groupFloors 叶子读出厂默认）。

import { MessagesSquare, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { CHAIN_CAP_DEFAULT } from '../../../../ai-gateway/groupFloors'
import { ApprovalActions, CardFrame, CardParams, TerminalBanner } from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(obj: Record<string, unknown> | null, key: string): string {
  const v = obj?.[key]
  return typeof v === 'string' ? v : ''
}

function strList(obj: Record<string, unknown> | null, key: string): string[] {
  const v = obj?.[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function num(obj: Record<string, unknown> | null, key: string): number | null {
  const v = obj?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 参数流式阶段 args 还是空的，argsText 里可能已有完整 JSON（FeedbackApprovalCard 同款回落）。 */
function parseArgs(args: unknown, argsText: string | undefined): Record<string, unknown> | null {
  const obj = asRecord(args)
  if (obj && Object.keys(obj).length > 0) return obj
  if (argsText) {
    try {
      return asRecord(JSON.parse(argsText))
    } catch {
      return obj
    }
  }
  return obj
}

/** 首轮唤醒上界：realtime 成员（没给 modes 就是全员）与链地板取小。
 *  不导出（react-refresh/only-export-components：本文件只导出组件）—— 断言走渲染出来的那句话。 */
function firstTurnWakeCount(
  memberAgentIds: readonly string[],
  modes: Record<string, unknown> | null
): number {
  const realtime = modes
    ? Object.values(modes).filter((m) => m === 'realtime').length
    : memberAgentIds.length
  return Math.min(CHAIN_CAP_DEFAULT, realtime)
}

export function GroupCreateCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const args = parseArgs(props.args, props.argsText)
  const members = strList(args, 'member_agent_ids')
  const judge = str(args, 'judge_agent_id')
  const modes = asRecord(args?.modes)
  const result = asRecord(props.result)

  const params = [
    {
      id: 'title',
      label: t('chat.groupCreateCard.groupTitle'),
      value: str(args, 'title') || '—',
      accent: true
    },
    {
      id: 'members',
      label: t('chat.groupCreateCard.members'),
      value: members.length > 0 ? members.join('、') : '—'
    },
    ...(judge ? [{ id: 'judge', label: t('chat.groupCreateCard.judge'), value: judge }] : []),
    {
      id: 'opening',
      label: t('chat.groupCreateCard.opening'),
      value: str(args, 'opening_text') || '—'
    },
    {
      id: 'wake',
      label: t('chat.groupCreateCard.wake'),
      value: t('chat.groupCreateCard.wakeValue', { count: firstTurnWakeCount(members, modes) })
    }
  ]

  return (
    <CardFrame
      icon={<MessagesSquare size={13} strokeWidth={2} />}
      title={t('chat.groupCreateCard.cardTitle')}
      phase={phase}
    >
      {phase === 'pending' ? (
        <div className="space-y-2">
          <CardParams items={params} />
          <ApprovalActions
            onApprove={() => props.respondToApproval?.({ approved: true })}
            onReject={(reason) => props.respondToApproval?.({ approved: false, reason })}
            approveLabel={t('chat.groupCreateCard.approve')}
            rejectReason
          />
        </div>
      ) : phase === 'done' && result ? (
        <div className="space-y-1.5">
          <p className="text-aux text-ink-fg">
            {t('chat.groupCreateCard.created', {
              title: (typeof result.title === 'string' && result.title) || str(args, 'title'),
              id: num(result, 'session_id') ?? '—'
            })}
          </p>
          {/* 🔴 建群三步无事务：群建成了但群设置没写进去时必须说出来，否则主持人 / 响应模式
              静默停留在出厂默认，owner 以为配好了。 */}
          {result.config_applied === false ? (
            <p className="text-meta text-warn">{t('chat.groupCreateCard.configWarning')}</p>
          ) : null}
          <p className="text-meta text-ink-fg-2">
            {t('chat.groupCreateCard.woke', {
              names: strList(result, 'woke').join('、') || t('chat.groupCreateCard.wokeNone')
            })}
          </p>
        </div>
      ) : (
        <>
          <CardParams items={params} />
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}

export function GroupPostCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const args = parseArgs(props.args, props.argsText)
  const result = asRecord(props.result)
  const sessionId = num(args, 'session_id')

  const params = [
    {
      id: 'target',
      label: t('chat.groupPostCard.target'),
      value: sessionId == null ? '—' : `#${sessionId}`,
      mono: true
    },
    {
      id: 'text',
      label: t('chat.groupPostCard.text'),
      value: str(args, 'text') || '—',
      accent: true
    },
    // 🔴 这张卡存在本身就说明服务端没采信 user_requested（核验通过就免卡了，不会渲染到这里），
    //    所以这一行只能写成「模型这么声明」，不能写成免卡依据。
    ...(args?.user_requested === true
      ? [
          {
            id: 'requested',
            label: t('chat.groupPostCard.source'),
            value: t('chat.groupPostCard.userRequested')
          }
        ]
      : [])
  ]

  return (
    <CardFrame
      icon={<Send size={13} strokeWidth={2} />}
      title={t('chat.groupPostCard.cardTitle')}
      phase={phase}
    >
      {phase === 'pending' ? (
        <div className="space-y-2">
          <CardParams items={params} />
          <ApprovalActions
            onApprove={() => props.respondToApproval?.({ approved: true })}
            onReject={(reason) => props.respondToApproval?.({ approved: false, reason })}
            approveLabel={t('chat.groupPostCard.approve')}
            rejectReason
          />
        </div>
      ) : phase === 'done' && result ? (
        <div className="space-y-1.5">
          <p className="text-aux text-ink-fg">
            {t('chat.groupPostCard.posted', { id: num(result, 'message_id') ?? '—' })}
          </p>
          <p className="text-meta text-ink-fg-2">
            {t('chat.groupPostCard.woke', {
              names: strList(result, 'woke').join('、') || t('chat.groupPostCard.wokeNone')
            })}
          </p>
        </div>
      ) : (
        <>
          <CardParams items={params} />
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
