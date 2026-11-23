// 人物档案页（设计 §2.2）：档案头（含裸邮箱降级 D8 + 就地改名落锁 + WP6「职务由画像
// 推断」旁路）→ 画像卡（WP6 `ContactProfileCard`：完整态 + 四空态；robot/list 换一行
// 说明）→ 身份信息（邮箱锚点主/曾用 + 字段行点击即编辑 + 枚举 chips + 锁 pill + 手记 +
// 名字变体）→ 关联邮件（角色过滤 + 加载更多）→ 关联事项。
// 危险操作全收进「更多操作」菜单（🔒 不放行内悬浮危险钮）；「合并」不渲染（WP3）。

import { memo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, EyeOff, MoreHorizontal } from 'lucide-react'

import type {
  ContactLockableField,
  ContactMailDirection,
  ContactPatchBody
} from '@shared/api/types/contact'
import { CONTACT_FUNCTION_VALUES, CONTACT_SENIORITY_VALUES } from '@shared/api/types/contact'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { formatMatterAgo } from '@shared/lib/matterDerive'
import { openNewCompose } from '@shared/state/compose-new'
import { toastError, toastSuccess } from '@shared/state/toast'

import { ContactOrgSection } from './ContactOrgSection'
import { ContactProfileCard } from './ContactProfileCard'
import type { ContactGovernanceTarget, ContactRowActions } from './ContactRow'
import { ContactDetailSkeleton } from './ContactSkeleton'
import { FIELD_LABEL_KEY, fmtContactMonth } from './contactFields'
import {
  useContactDetail,
  useContactMails,
  useContactMatters,
  useContactsApi,
  useInvalidateContact
} from './hooks'
import { Monogram } from './Monogram'
import {
  AiMark,
  ContactPip,
  GenderPip,
  HiddenPip,
  KindPip,
  LockPill,
  SecHead,
  SelfPip,
  TwoWayBar
} from './parts'
import { ContactMailList, ContactMatterList } from './detail/ContactActivityLists'
import { EmailAnchorRow, EnumRow, FieldRow, GenderRow } from './detail/ContactFieldRows'

// ── 档案页 ────────────────────────────────────────────────────────────────────

export interface ContactDetailProps {
  contactId: number
  /** <860px 单列态返回列表。 */
  onBack?: () => void
  /** 治理动作与列表行共用一份（改判/隐藏/self —— 同一套 toast 与失效）。 */
  actions: Pick<ContactRowActions, 'onSetKind' | 'onToggleSelf' | 'onToggleHidden'>
  showBack: boolean
  /** WP3 入口 ①：头部「更多操作 → 合并到另一条记录…」（dialog 挂在 Workspace）。 */
  onMergeRequest?: () => void
}

function ContactDetailView({
  contactId,
  onBack,
  actions,
  showBack,
  onMergeRequest
}: ContactDetailProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'zh-CN'
  const api = useContactsApi()
  const invalidate = useInvalidateContact()
  const detailQuery = useContactDetail(contactId, true)
  const detail = detailQuery.data
  // render 期不许调 Date.now()（react-hooks/purity）—— MatterDetail 同款快照模式。
  const [now] = useState(() => Date.now())
  const [mailDirection, setMailDirection] = useState<ContactMailDirection>('all')

  // 🔴 waterfall 拆解（task 08-20 P0-3）：关联邮件 / 关联事项这两条查询在**早返回之前**声明
  //   —— 它们原先只挂在下方的两个子组件上，而那两个组件在 `!detail` 时根本没被渲染，于是
  //   「detail 到达」成了它们的发车信号（首屏 4 跳的最后一跳）。声明到这里之后三条并发。
  //   子组件用同一 queryKey 各自再声明一次，react-query 按 key 去重 ⇒ 请求数不变。
  useContactMails(contactId, mailDirection)
  useContactMatters(contactId, true)

  const [nameEditing, setNameEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState<string | null>(null)
  const [headMenuOpen, setHeadMenuOpen] = useState(false)
  const headMenuRef = useRef<HTMLButtonElement>(null)

  const [prevContactId, setPrevContactId] = useState(contactId)
  if (prevContactId !== contactId) {
    setPrevContactId(contactId)
    setNameEditing(false)
    setNotesDraft(null)
    setHeadMenuOpen(false)
  }

  const patch = useMutation({
    mutationFn: (body: ContactPatchBody) => api.patch(contactId, body),
    onSuccess: async (result, body) => {
      await invalidate(contactId)
      // 🔴 `gender` 与 `notes` 都**不落锁**（后端 CONTACT_LOCKABLE_FIELDS 里没有它们）——
      // 漏掉这一层过滤会拿 `FIELD_LABEL_KEY['gender']`（undefined）去 t()，报出一句
      // 「undefined 已保存并锁定」，而且那句话本身就是假的。
      const lockedFields = Object.keys(body).filter(
        (field) => field !== 'notes' && field !== 'gender'
      ) as ContactLockableField[]
      if (lockedFields.length > 0) {
        toastSuccess(t('contacts.toast.locked', { field: t(FIELD_LABEL_KEY[lockedFields[0]!]) }))
      }
      void result
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })
  const setLock = useMutation({
    mutationFn: (input: { field: ContactLockableField; locked: boolean }) =>
      api.setLock(contactId, input.field, input.locked),
    onSuccess: async (_result, input) => {
      await invalidate(contactId)
      if (input.locked) {
        toastSuccess(t('contacts.toast.locked', { field: t(FIELD_LABEL_KEY[input.field]) }))
      } else {
        toastSuccess(t('contacts.toast.unlocked'))
      }
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })
  const setPrimary = useMutation({
    mutationFn: (email: string) => api.setPrimaryEmail(contactId, email),
    onSuccess: async (_result, email) => {
      await invalidate(contactId)
      toastSuccess(t('contacts.toast.primary', { email }))
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })
  const setFormer = useMutation({
    mutationFn: (input: { email: string; former: boolean }) =>
      api.setEmailFormer(contactId, input.email, input.former),
    onSuccess: async (_result, input) => {
      await invalidate(contactId)
      toastSuccess(t(input.former ? 'contacts.toast.former' : 'contacts.toast.unformer'))
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })

  if (!detail) {
    // 拉取中 → 骨架占住版式（v2 任务 ③）；落定却没有 detail（404 / 请求失败）→ 维持原来的
    // 空壳：那时候画骨架就是在假装「马上就好」，而实际上永远不会来。
    return detailQuery.isPending ? (
      <ContactDetailSkeleton />
    ) : (
      <div className="h-full min-h-0 overflow-y-auto scrollbar-none" />
    )
  }

  const locks = detail.identity_locks
  const primaryEmail =
    detail.emails.find((email) => email.is_primary)?.address ?? detail.emails[0]?.address ?? null
  const bare = !detail.display_name
  const localPart = primaryEmail?.split('@')[0] ?? '—'
  // WP6 职务旁路（原型 `DossierHead` :12-13）：身份字段没有职务、而画像推断出一个时，
  // 副行用推断值补位并挂 AI 标记 —— 🔒 只是**显示**旁路，不写身份字段（写入的唯一路径
  // 是画像卡建议值区的「采纳」）。
  const inferredRoleTitle =
    detail.role_title == null ? (detail.profile.document?.role_title ?? null) : null
  // 原型 `DossierHead` 的 `[...new Set([...])]`：组织/部门/职务重复时只留一份。
  const subtitleParts = [
    ...new Set(
      [detail.organization, detail.department, detail.role_title ?? inferredRoleTitle].filter(
        Boolean
      )
    )
  ]
  const rowLike: ContactGovernanceTarget = {
    id: detail.id,
    display_name: detail.display_name,
    kind: detail.kind,
    is_self: detail.is_self,
    hidden_at: detail.hidden_at,
    primary_email: primaryEmail
  }

  const commitName = (): void => {
    setNameEditing(false)
    const next = nameDraft.trim()
    if (next !== (detail.display_name ?? '')) patch.mutate({ display_name: next })
  }

  const compose = (): void => {
    openNewCompose(primaryEmail ?? undefined)
    if (primaryEmail) toastSuccess(t('contacts.toast.composePrefill', { email: primaryEmail }))
  }
  // WP5「写邮件并抄送上级」：收件人 = TA、抄送 = TA 的上级。上级主邮箱直接取
  // `detail.manager`（同 `ContactOrgSection` 的抄送钮），不为它再取一次详情。
  const composeCc = (): void => {
    const manager = detail.manager
    if (!manager) return
    openNewCompose(
      primaryEmail ?? undefined,
      manager.primary_email ? [manager.primary_email] : undefined
    )
    if (primaryEmail) toastSuccess(t('contacts.toast.composePrefill', { email: primaryEmail }))
  }

  const headMenuItems: PopmenuItem[] = [
    {
      kind: 'action',
      id: 'compose',
      label: t('contacts.action.compose'),
      onSelect: compose
    },
    // 有上级才出这一项（可用性判据 = detail.manager）。
    ...(detail.manager
      ? ([
          {
            kind: 'action',
            id: 'compose-cc',
            label: t('contacts.org.composeCc'),
            onSelect: composeCc
          }
        ] satisfies PopmenuItem[])
      : []),
    { kind: 'separator', id: 'sep-compose' },
    ...(['robot', 'list', 'person'] as const)
      .filter((kind) => kind !== detail.kind)
      .map(
        (kind): PopmenuItem => ({
          kind: 'action',
          id: `kind-${kind}`,
          label: t(
            kind === 'robot'
              ? 'contacts.action.kindRobot'
              : kind === 'list'
                ? 'contacts.action.kindList'
                : 'contacts.action.kindPerson'
          ),
          onSelect: () => actions.onSetKind(rowLike, kind)
        })
      ),
    {
      kind: 'action',
      id: 'self',
      label: t(detail.is_self ? 'contacts.action.unmarkSelf' : 'contacts.action.markSelf'),
      onSelect: () => actions.onToggleSelf(rowLike)
    },
    {
      kind: 'action',
      id: 'hide',
      label: t(detail.hidden_at != null ? 'contacts.action.unhide' : 'contacts.action.hide'),
      onSelect: () => actions.onToggleHidden(rowLike)
    },
    ...(onMergeRequest
      ? ([
          { kind: 'separator', id: 'sep-merge' },
          {
            kind: 'action',
            id: 'merge',
            label: t('contacts.action.merge'),
            onSelect: () => onMergeRequest()
          }
        ] satisfies PopmenuItem[])
      : [])
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── 档案头（原型 `DossierHead`：不随内容滚动，下方一条分界线）── */}
      <div className="shrink-0 border-b border-ink-border px-[22px] pb-3.5 pt-4">
        <div className="flex items-start gap-3.5">
          {showBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label={t('contacts.nav.title')}
              className="mt-1.5 grid size-7 shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.08] hover:text-ink-fg"
            >
              <ChevronLeft size={16} />
            </button>
          ) : null}
          <Monogram
            displayName={detail.display_name}
            primaryEmail={primaryEmail}
            kind={detail.kind}
            size={48}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {nameEditing ? (
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={commitName}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitName()
                    if (event.key === 'Escape') setNameEditing(false)
                  }}
                  className="h-8 min-w-0 flex-1 rounded-[var(--r-ctl)] border border-coral/50 bg-ink-1 px-2 text-[18px] font-semibold text-ink-fg outline-none"
                />
              ) : (
                <button
                  type="button"
                  title={t('contacts.detail.editHint')}
                  onClick={() => {
                    setNameDraft(detail.display_name ?? '')
                    setNameEditing(true)
                  }}
                  className={cn(
                    'min-w-0 truncate rounded-[var(--r-ctl)] text-left text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink-fg transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.04]',
                    bare && 'italic'
                  )}
                >
                  {bare ? localPart : detail.display_name}
                </button>
              )}
              {/* 英文名与姓名同一行（原型 `DossierHead`），且与常用名不同时才出。 */}
              {!bare && detail.formal_name && detail.formal_name !== detail.display_name ? (
                <span className="shrink-0 text-aux text-ink-fg-2">{detail.formal_name}</span>
              ) : null}
              {/* 性别贴着名字（是名字的属性），排在状态 pip 之前；档案头字号大一号。 */}
              <GenderPip gender={detail.gender} size={13} />
              {locks.display_name != null ? (
                <LockPill
                  locked
                  onToggle={() => setLock.mutate({ field: 'display_name', locked: false })}
                />
              ) : null}
              {detail.is_self ? <SelfPip /> : null}
              <KindPip kind={detail.kind} />
              {detail.hidden_at != null ? <HiddenPip /> : null}
            </div>
            {bare ? (
              <div className="mt-[5px] flex min-w-0 flex-wrap items-center gap-[7px]">
                <span className="truncate font-mono text-meta text-ink-fg-1">{primaryEmail}</span>
                <ContactPip>{t('contacts.detail.bareOnly')}</ContactPip>
                <button
                  type="button"
                  onClick={() => {
                    setNameDraft('')
                    setNameEditing(true)
                  }}
                  className="shrink-0 text-meta text-coral transition-opacity duration-fast ease-standard hover:opacity-80"
                >
                  {t('contacts.detail.addName')}
                </button>
              </div>
            ) : (
              <div className="mt-[5px] flex min-w-0 flex-wrap items-center gap-[7px]">
                <span className="truncate text-body text-ink-fg-1">
                  {subtitleParts.length > 0 ? subtitleParts.join(' · ') : (primaryEmail ?? '')}
                </span>
                {inferredRoleTitle ? <AiMark>{t('contacts.profile.aiRole')}</AiMark> : null}
                {detail.function || detail.seniority ? (
                  <ContactPip>
                    {[
                      detail.function ? t(`contacts.fn.${detail.function}`) : null,
                      detail.seniority ? t(`contacts.level.${detail.seniority}`) : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </ContactPip>
                ) : null}
              </div>
            )}
            {/* 统计与双向条并排一行（原型：数字 + 条 + 起止时间同一行）。 */}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span className="flex items-center gap-1.5">
                <span className="whitespace-nowrap font-mono text-meta tabular-nums text-ink-fg-1">
                  {t('contacts.stat.exchange', {
                    n: detail.mail_count,
                    sent: detail.sent_to_count
                  })}
                </span>
                <TwoWayBar sent={detail.sent_to_count} total={detail.mail_count} className="w-11" />
              </span>
              {detail.first_seen_at != null && detail.last_seen_at != null ? (
                <span className="text-meta text-ink-fg-3">
                  {t('contacts.stat.since', {
                    date: fmtContactMonth(detail.first_seen_at, locale),
                    ago: formatMatterAgo(detail.last_seen_at, now, locale)
                  })}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={compose}
              className="rounded-[var(--r-ctl)] border border-coral/30 bg-coral/10 px-3 py-1 text-meta font-medium text-coral transition-colors duration-fast ease-standard hover:bg-coral/[0.17]"
            >
              {t('contacts.action.compose')}
            </button>
            <div className="relative">
              <button
                ref={headMenuRef}
                type="button"
                aria-label={t('contacts.row.more')}
                onClick={() => setHeadMenuOpen((open) => !open)}
                className="grid size-7 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.08] hover:text-ink-fg"
              >
                <MoreHorizontal size={14} />
              </button>
              <Popmenu
                open={headMenuOpen}
                onClose={() => setHeadMenuOpen(false)}
                ariaLabel={t('contacts.row.more')}
                items={headMenuItems}
                triggerRef={headMenuRef}
                align="end"
                width={220}
                // 满配 9 行（7 项 + 2 分隔线）≈ 290px，刚过基座默认的 288px 上限 ——
                // 不抬就为 2px 多出一条内滚。真放不下时基座仍按「面板顶到视口底」二次夹取。
                maxHeight={320}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── 滚动区（原型：`18px 22px 60px` + 块间 24px + 内容宽 820）── */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-none">
        <div className="mx-auto flex max-w-[820px] flex-col gap-6 px-[22px] pb-14 pt-[18px]">
          {/* 已隐藏说明条 */}
          {detail.hidden_at != null ? (
            <div className="flex items-center gap-2.5 rounded-[var(--r-row)] border border-ink-border bg-ink-fg/[0.03] px-3 py-2">
              <EyeOff size={13} aria-hidden className="shrink-0 text-ink-fg-2" />
              <span className="min-w-0 flex-1 text-meta text-ink-fg-1">
                {t('contacts.toast.hidden', { name: detail.display_name ?? primaryEmail ?? '' })}
              </span>
              <button
                type="button"
                onClick={() => actions.onToggleHidden(rowLike)}
                className="shrink-0 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.06]"
              >
                {t('contacts.action.unhide')}
              </button>
            </div>
          ) : null}

          {/* ── 画像卡（WP6：完整态 + 四空态；非人换一行说明）── */}
          {detail.kind !== 'person' ? (
            <div className="flex items-center gap-2.5 rounded-[var(--r-card)] border border-dashed border-ink-border bg-ink-fg/[0.02] px-3.5 py-3 text-meta text-ink-fg-1">
              <span className="min-w-0 flex-1">
                {t('contacts.profile.notPerson', { kind: t(`contacts.kind.${detail.kind}`) })}
              </span>
              <button
                type="button"
                onClick={() => actions.onSetKind(rowLike, 'person')}
                className="shrink-0 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.06]"
              >
                {t('contacts.action.kindPerson')}
              </button>
            </div>
          ) : (
            <ContactProfileCard
              contactId={contactId}
              profile={detail.profile}
              mailCount={detail.mail_count}
            />
          )}

          {/* ── 身份信息 ── */}
          <section>
            <SecHead title={t('contacts.section.emails')} count={detail.emails.length} />
            <div className="space-y-1.5">
              {detail.emails.map((email) => (
                <EmailAnchorRow
                  key={email.address}
                  email={email}
                  locale={locale}
                  onSetPrimary={(address) => setPrimary.mutate(address)}
                  onSetFormer={(address, former) => setFormer.mutate({ email: address, former })}
                />
              ))}
            </div>

            <SecHead
              className="mt-5"
              title={t('contacts.section.identity')}
              right={
                <span className="shrink-0 text-micro text-ink-fg-3">
                  {t('contacts.detail.editHint')}
                </span>
              }
            />
            <div className="divide-y divide-ink-border-soft">
              <FieldRow
                field="display_name"
                value={detail.display_name}
                locked={locks.display_name != null}
                onSave={(next) => patch.mutate({ display_name: next })}
                onToggleLock={() =>
                  setLock.mutate({ field: 'display_name', locked: locks.display_name == null })
                }
              />
              <FieldRow
                field="formal_name"
                value={detail.formal_name}
                locked={locks.formal_name != null}
                onSave={(next) => patch.mutate({ formal_name: next })}
                onToggleLock={() =>
                  setLock.mutate({ field: 'formal_name', locked: locks.formal_name == null })
                }
              />
              <FieldRow
                field="organization"
                value={detail.organization}
                locked={locks.organization != null}
                onSave={(next) => patch.mutate({ organization: next })}
                onToggleLock={() =>
                  setLock.mutate({ field: 'organization', locked: locks.organization == null })
                }
              />
              <FieldRow
                field="department"
                value={detail.department}
                locked={locks.department != null}
                onSave={(next) => patch.mutate({ department: next })}
                onToggleLock={() =>
                  setLock.mutate({ field: 'department', locked: locks.department == null })
                }
              />
              <FieldRow
                field="role_title"
                value={detail.role_title}
                locked={locks.role_title != null}
                onSave={(next) => patch.mutate({ role_title: next })}
                onToggleLock={() =>
                  setLock.mutate({ field: 'role_title', locked: locks.role_title == null })
                }
              />
              <FieldRow
                field="phone"
                value={detail.phone}
                locked={locks.phone != null}
                onSave={(next) => patch.mutate({ phone: next })}
                onToggleLock={() => setLock.mutate({ field: 'phone', locked: locks.phone == null })}
              />
              <EnumRow
                field="function"
                value={detail.function}
                values={CONTACT_FUNCTION_VALUES}
                locked={locks.function != null}
                labelOf={(value) => t(`contacts.fn.${value}`)}
                onSave={(next) => patch.mutate({ function: next as never })}
                onToggleLock={() =>
                  setLock.mutate({ field: 'function', locked: locks.function == null })
                }
              />
              <EnumRow
                field="seniority"
                value={detail.seniority}
                values={CONTACT_SENIORITY_VALUES}
                locked={locks.seniority != null}
                labelOf={(value) => t(`contacts.level.${value}`)}
                onSave={(next) => patch.mutate({ seniority: next as never })}
                onToggleLock={() =>
                  setLock.mutate({ field: 'seniority', locked: locks.seniority == null })
                }
              />
              {/* 未设置 = 传 null（后端 NULL 即未知）——「清空」和「没选过」是同一件事。 */}
              <GenderRow
                value={detail.gender}
                onChange={(next) => patch.mutate({ gender: next })}
              />
            </div>

            <SecHead
              className="mt-5"
              title={t('contacts.section.notes')}
              right={
                <span className="shrink-0 text-micro text-ink-fg-3">
                  {t('contacts.section.notesHint')}
                </span>
              }
            />
            <textarea
              value={notesDraft ?? detail.notes ?? ''}
              onChange={(event) => setNotesDraft(event.target.value)}
              onBlur={() => {
                if (notesDraft !== null && notesDraft !== (detail.notes ?? '')) {
                  patch.mutate({ notes: notesDraft })
                }
                setNotesDraft(null)
              }}
              className="min-h-[68px] w-full resize-y rounded-[var(--r-row)] border border-ink-border bg-ink-2 px-2.5 py-2 text-body leading-relaxed text-ink-fg outline-none placeholder:text-ink-fg-3 focus:border-coral/50"
            />

            {detail.name_variants.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="shrink-0 text-micro text-ink-fg-3">
                  {t('contacts.field.variants')}
                </span>
                {detail.name_variants.map((variant) => (
                  <span
                    key={variant}
                    className="rounded-[var(--r-ctl)] bg-ink-fg/[0.035] px-1.5 py-px text-meta text-ink-fg-2"
                  >
                    {variant}
                  </span>
                ))}
                <span className="text-micro text-ink-fg-3">
                  · {t('contacts.field.variantsHint')}
                </span>
              </div>
            ) : null}
          </section>

          {/* ── 组织关系（WP5，原型挂载序 Identity→Org→Mail）──
              🔴 task 08-14 WP-3 起 self 也渲染：owner「上下级也无法关联我」——
              「我」得能挂进汇报线，画像同理（上面那张卡不再对 self 特判）。 */}
          {detail.kind === 'person' ? <ContactOrgSection detail={detail} /> : null}

          {/* ── 关联邮件 / 关联事项 ── */}
          <ContactMailList
            contactId={contactId}
            direction={mailDirection}
            onDirectionChange={setMailDirection}
          />
          <ContactMatterList contactId={contactId} />
        </div>
      </div>
    </div>
  )
}

/** 🔴 `memo` 不是装饰（task 08-20 P1-6）：这棵树上千行，而它的 props 全部来自
 *  `ContactsWorkspace` —— 那边每敲一个搜索字符 / 每次任意 state 变动都会重渲染一遍。
 *  props 侧的配套在调用方：`actions` 与两个回调都已是稳定引用，否则 memo 恒失效。 */
export const ContactDetail = memo(ContactDetailView)
