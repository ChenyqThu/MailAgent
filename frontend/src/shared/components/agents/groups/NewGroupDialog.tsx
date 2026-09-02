// L4 群聊 UX 批 — 建群对话框（从 GroupChatWorkspace 抽出，一次填齐）。
//
// 一次填齐 = 名称 / 用途 / 成员 + **每人响应模式** / 法官位（labs on 才有后两项）。g1 是「先建群、
// 再到另一个对话框改模式」，第二步没人会去。
//
// 🔴 建群是两次写（`POST /chat/sessions/new` 落成员，`PUT group-config` 落模式 / 法官 / 用途）：
// 第二步失败必须把第一步建出来的会话删掉再报错 —— 否则列表里留下一个「成员对但模式全默认」的
// 半建群，owner 完全看不出它和填的不一样（AC1）。
//
// 名称输入框的 `placeholder` **恒**是「新群聊」：勾了谁不改占位，已选成员名放输入框下方的次级
// 提示（留空就用那串名字当标题）。

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'

import type { ChatSession } from '@shared/api/types'
import type { GroupConfigPatch } from '@shared/api/groupSettings'
import { createWerewolfGame, setGroupConfig } from '@shared/api/groupSettings'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError } from '@shared/state/toast'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Checkbox } from '@shared/components/ui/checkbox'
import { Input } from '@shared/components/ui/input'
import { Button } from '@shared/components/ui/button'
import { SegmentedControl } from '@shared/components/ui/segmented'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'

import { AgentAvatar } from '../AgentAvatar'
import type { GroupCandidate } from './members'

import { MAX_GROUP_MEMBERS, type GroupResponseMode } from '../../../../ai-gateway/groupFloors'

/** 「不设法官」在 Select 里的哨兵值（Radix 不接受空串作为 item value）。 */
const JUDGE_NONE = '__none__'

/** 已选成员名的本地化连接（zh「A、B」/ en "A, B"）；用作次级提示与留空时的标题。 */
function joinNames(locale: string, names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  try {
    // narrow + conjunction = zh「A、B、C」/ en「A, B, C」（unit 档在 zh 下没有分隔符）。
    return new Intl.ListFormat(locale, { style: 'narrow', type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

export function NewGroupDialog({
  open,
  onOpenChange,
  candidates,
  onCreated,
  labsOn
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 主 Agent 在最前（保留 id），其余是 report_agent 行。 */
  candidates: GroupCandidate[]
  onCreated: (session: ChatSession) => void
  /** labs off 时不渲染响应模式与法官位（v1 循环下两者都不生效）。 */
  labsOn: boolean
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const mailApi = useMailApi()
  const [title, setTitle] = useState('')
  const [topic, setTopic] = useState('')
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [modes, setModes] = useState<Record<string, GroupResponseMode>>({})
  const [judge, setJudge] = useState<string>(JUDGE_NONE)
  const [creating, setCreating] = useState(false)

  // 成员序 = 候选清单序（deriveTeamMembers 稳定序），落 members_json = 群内回复顺序。
  const members = useMemo(() => candidates.filter((c) => picked.has(c.id)), [candidates, picked])
  const namesHint = joinNames(
    i18n.language,
    members.map((c) => c.title)
  )

  const toggle = (id: string): void =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_GROUP_MEMBERS) next.add(id)
      return next
    })

  const reset = (): void => {
    setTitle('')
    setTopic('')
    setPicked(new Set())
    setModes({})
    setJudge(JUDGE_NONE)
  }

  // 狼人杀预设：不走下面那条两步建群路径（三群 + 七个 agent 行全在服务端一次建完），
  // 成功后与手工建群一样把主群交给 onCreated 选中。
  const fromTemplate = useMutation({
    mutationFn: () => createWerewolfGame({}),
    onSuccess: (payload) => {
      if (!payload.configApplied) {
        toastError(t('settings.labs.werewolf.partial'))
        return
      }
      onCreated(payload.mainSession)
      onOpenChange(false)
      reset()
    },
    onError: (err) => toastError(t('settings.labs.werewolf.failed'), errorMessage(err))
  })

  const create = async (): Promise<void> => {
    if (members.length === 0 || creating) return
    setCreating(true)
    let session: ChatSession
    try {
      session = await mailApi.chat.newSession({
        anchorType: 'general',
        backendKind: 'ai-sdk',
        groupMembers: members.map((c) => c.id),
        title: title.trim() || namesHint
      })
    } catch (err) {
      toastError(t('groupChat.createFailed', { error: errorMessage(err) }))
      setCreating(false)
      return
    }
    // 第二步：只写「和默认不一样」的部分（缺省模式 = mention，缺省无法官、无用途）。
    const patch: GroupConfigPatch = {}
    if (labsOn) {
      const changed: Record<string, GroupResponseMode> = {}
      for (const c of members) if (modes[c.id] === 'realtime') changed[c.id] = 'realtime'
      if (Object.keys(changed).length > 0) patch.modes = changed
      if (judge !== JUDGE_NONE && picked.has(judge)) patch.judgeAgentId = judge
    }
    if (topic.trim().length > 0) patch.topic = topic.trim()
    if (Object.keys(patch).length > 0) {
      try {
        await setGroupConfig(session.id, patch)
      } catch (err) {
        // 🔴 半建群不留：删掉第一步建出来的会话再报错（AC1）。
        await mailApi.chat.deleteSession(session.id).catch(() => undefined)
        toastError(t('groupChat.createFailed', { error: errorMessage(err) }))
        setCreating(false)
        return
      }
    }
    onCreated(session)
    onOpenChange(false)
    reset()
    setCreating(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('groupChat.dialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className="scrollbar-thin flex max-h-[64vh] flex-col gap-3 overflow-y-auto">
          <label className="flex flex-col gap-1.5">
            <span className="text-aux font-medium text-ink-fg-1">
              {t('groupChat.dialogTitleLabel')}
            </span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('groupChat.defaultTitle')}
            />
            {namesHint.length > 0 && (
              <span className="text-micro text-ink-fg-3">
                {t('groupChat.dialogTitleHint', { names: namesHint })}
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-aux font-medium text-ink-fg-1">
              {t('groupChat.dialogTopicLabel')}
            </span>
            {/* 长度上限的单源在 serve-api（超限读 400 的 hint），这里不设 maxLength。 */}
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t('groupChat.dialogTopicPlaceholder')}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-aux font-medium text-ink-fg-1">
              {t('groupChat.dialogMembersLabel', { max: MAX_GROUP_MEMBERS })}
            </span>
            {candidates.length === 0 ? (
              <div className="rounded-lg bg-ink-2 px-3 py-4 text-center text-meta text-ink-fg-3">
                {t('groupChat.dialogNoCandidates')}
              </div>
            ) : (
              <div className="scrollbar-thin flex max-h-56 flex-col gap-0.5 overflow-y-auto">
                {candidates.map((c) => {
                  const checked = picked.has(c.id)
                  const disabled = !checked && picked.size >= MAX_GROUP_MEMBERS
                  const name = c.title
                  return (
                    // 🔴 行不是 <label>：模式分段控件在行内，label 的隐式关联会把「点实时」
                    // 一并当成「点这一行」→ 刚勾上的成员被取消勾选。勾选面只有 Checkbox 与名字。
                    <div
                      key={c.id}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg px-2 py-1.5',
                        'transition-colors duration-fast hover:bg-ink-2',
                        disabled && 'opacity-50'
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={() => toggle(c.id)}
                      />
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => toggle(c.id)}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-2.5 text-left',
                          disabled ? 'cursor-not-allowed' : 'cursor-pointer'
                        )}
                      >
                        <AgentAvatar agentId={c.id} config={c.avatar} size={24} title={name} />
                        <span className="min-w-0 flex-1 truncate text-body text-ink-fg">
                          {name}
                        </span>
                      </button>
                      {labsOn && (
                        // 🔴 fluid 只给每段 flex-1，不撑容器：窄标签下必须在调用处补 w-full。
                        <SegmentedControl<GroupResponseMode>
                          value={modes[c.id] ?? 'mention'}
                          onChange={(next) => setModes((prev) => ({ ...prev, [c.id]: next }))}
                          options={[
                            { value: 'realtime', label: t('groupChat.details.modeRealtime') },
                            { value: 'mention', label: t('groupChat.details.modeMention') }
                          ]}
                          ariaLabel={t('groupChat.details.modeAria', { name })}
                          fluid
                          className={cn('flex w-[7.5rem] shrink-0', !checked && 'opacity-40')}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {/* 主 Agent 在候选首位，但它入群后的姿态与单聊不同（只有群内两件读工具，没有邮件 /
                日历 / exec 那一套）—— 这句是唯一说清这件事的地方。 */}
            <span className="text-micro text-ink-fg-3">{t('groupChat.dialogMainAgentNote')}</span>
          </div>

          {labsOn && members.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-aux font-medium text-ink-fg-1">
                {t('groupChat.dialogJudgeLabel')}
              </span>
              <Select value={judge} onValueChange={setJudge}>
                <SelectTrigger aria-label={t('groupChat.dialogJudgeLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  <SelectItem value={JUDGE_NONE}>{t('groupChat.details.judgeNone')}</SelectItem>
                  {members.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* 从模板创建 = 狼人杀预设一键建局（服务端一次建出主群 + 两个子群）。labs off 时
              这套编排一条都不生效，按钮禁用并由下方说明指路。 */}
          <div className="flex flex-col gap-1">
            <Button
              variant="outline"
              disabled={!labsOn || fromTemplate.isPending}
              title={t('groupChat.dialogTemplateSoon')}
              onClick={() => fromTemplate.mutate()}
            >
              {fromTemplate.isPending
                ? t('settings.labs.werewolf.creating')
                : t('groupChat.dialogTemplate')}
            </Button>
            <span className="text-micro text-ink-fg-3">{t('groupChat.dialogTemplateSoon')}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('groupChat.cancel')}
          </Button>
          <Button onClick={() => void create()} disabled={members.length === 0 || creating}>
            {creating ? t('groupChat.creating') : t('groupChat.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
