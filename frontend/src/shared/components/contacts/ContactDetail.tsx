// 人物档案页（设计 §2.2）：档案头（含裸邮箱降级 D8 + 就地改名落锁 + WP6「职务由画像
// 推断」旁路）→ 画像卡（WP6 `ContactProfileCard`：完整态 + 四空态；robot/list 换一行
// 说明）→ 身份信息（邮箱锚点主/曾用 + 字段行点击即编辑 + 枚举 chips + 锁 pill + 手记 +
// 名字变体）→ 关联邮件（角色过滤 + 加载更多）→ 关联事项。
// 危险操作全收进「更多操作」菜单（🔒 不放行内悬浮危险钮）；「合并」不渲染（WP3）。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  ChevronLeft,
  ChevronRight,
  EyeOff,
  Inbox,
  MoreHorizontal,
  Send,
  UsersRound
} from 'lucide-react'

import type {
  ContactEmailDto,
  ContactLockableField,
  ContactMailDirection,
  ContactPatchBody
} from '@shared/api/types/contact'
import {
  CONTACT_FUNCTION_VALUES,
  CONTACT_MAIL_DIRECTIONS,
  CONTACT_SENIORITY_VALUES
} from '@shared/api/types/contact'
import { MatterPip } from '@shared/components/matters/MatterPip'
import { MATTER_STATUS_ICONS, MATTER_STATUS_TONES } from '@shared/components/matters/matterVocab'
import type { MatterStatus } from '@shared/api/types/matter'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { formatMatterAgo } from '@shared/lib/matterDerive'
import { qk } from '@shared/lib/queryKeys'
import { openNewCompose } from '@shared/state/compose-new'
import { useActiveEmail } from '@shared/state/active-email'
import { toastError, toastSuccess } from '@shared/state/toast'

import { ContactOrgSection } from './ContactOrgSection'
import { ContactProfileCard } from './ContactProfileCard'
import { Monogram } from './Monogram'
import {
  AiMark,
  ContactPip,
  HiddenPip,
  KindPip,
  LockPill,
  SecHead,
  SelfPip,
  TwoWayBar
} from './parts'
import { useContactDetail, useContactMatters, useContactsApi, useInvalidateContact } from './hooks'
import type { ContactGovernanceTarget, ContactRowActions } from './ContactRow'

const MAIL_PAGE_SIZE = 6

/** field → i18n 标签键（toast「{field} 已保存并锁定」与字段行共用一份）。 */
const FIELD_LABEL_KEY: Record<ContactLockableField, string> = {
  display_name: 'contacts.field.name',
  formal_name: 'contacts.field.formalName',
  organization: 'contacts.field.org',
  department: 'contacts.field.dept',
  role_title: 'contacts.field.role',
  phone: 'contacts.field.phone',
  function: 'contacts.field.fn',
  seniority: 'contacts.field.level'
}

function fmtMonth(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short' }).format(ms)
}

// ── 字段行（点击即编辑 → PATCH 落锁；行尾锁 pill 可切换）──────────────────────

function FieldRow({
  field,
  value,
  locked,
  onSave,
  onToggleLock
}: {
  field: ContactLockableField
  value: string | null
  locked: boolean
  onSave(next: string): void
  onToggleLock(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    setEditing(false)
    if (draft.trim() !== (value ?? '')) onSave(draft.trim())
  }
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className="w-16 shrink-0 text-meta text-ink-fg-2">{t(FIELD_LABEL_KEY[field])}</span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setEditing(false)
          }}
          className="h-7 min-w-0 flex-1 rounded-[var(--r-ctl)] border border-coral/50 bg-ink-1 px-2 text-body text-ink-fg outline-none"
        />
      ) : (
        <button
          type="button"
          title={t('contacts.detail.editHint')}
          onClick={() => {
            setDraft(value ?? '')
            setEditing(true)
          }}
          className="min-w-0 flex-1 truncate rounded-[var(--r-ctl)] px-1 py-0.5 text-left text-body text-ink-fg hover:bg-ink-3"
        >
          {value || <span className="text-ink-fg-3">—</span>}
        </button>
      )}
      <LockPill locked={locked} onToggle={onToggleLock} />
    </div>
  )
}

// ── 枚举行（职能 / 职级 = chips 选择）─────────────────────────────────────────

function EnumRow({
  field,
  value,
  values,
  locked,
  labelOf,
  onSave,
  onToggleLock
}: {
  field: ContactLockableField
  value: string | null
  values: readonly string[]
  locked: boolean
  labelOf(value: string): string
  onSave(next: string | null): void
  onToggleLock(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="py-1.5">
      <div className="flex items-center gap-2.5">
        <span className="w-16 shrink-0 text-meta text-ink-fg-2">{t(FIELD_LABEL_KEY[field])}</span>
        <button
          type="button"
          onClick={() => setOpen((next) => !next)}
          className="min-w-0 flex-1 truncate rounded-[var(--r-ctl)] px-1 py-0.5 text-left text-body text-ink-fg hover:bg-ink-3"
        >
          {value ? labelOf(value) : <span className="text-ink-fg-3">—</span>}
        </button>
        <LockPill locked={locked} onToggle={onToggleLock} />
      </div>
      {open ? (
        <div className="ml-[74px] mt-1.5 flex flex-wrap gap-1.5">
          {values.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => {
                setOpen(false)
                if (candidate !== value) onSave(candidate)
              }}
              className={cn(
                'rounded-full border px-[9px] py-[3px] text-meta leading-4 transition-colors duration-fast ease-standard',
                candidate === value
                  ? 'border-coral/30 bg-coral/10 text-coral'
                  : 'border-ink-border text-ink-fg-2 hover:bg-ink-fg/[0.06]'
              )}
            >
              {labelOf(candidate)}
            </button>
          ))}
          {value ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onSave(null)
              }}
              className="rounded-full border border-ink-border px-[9px] py-[3px] text-meta leading-4 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.06]"
            >
              {t('contacts.enum.clear')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ── 邮箱锚点行 ────────────────────────────────────────────────────────────────

function EmailAnchorRow({
  email,
  locale,
  onSetPrimary,
  onSetFormer
}: {
  email: ContactEmailDto
  locale: string
  onSetPrimary(address: string): void
  onSetFormer(address: string, former: boolean): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const former = email.former_at != null
  const range =
    email.first_seen_at != null && email.last_seen_at != null
      ? t('contacts.email.meta', {
          n: email.mail_count,
          from: fmtMonth(email.first_seen_at, locale),
          to: fmtMonth(email.last_seen_at, locale)
        })
      : undefined
  const items: PopmenuItem[] = [
    {
      kind: 'action',
      id: 'primary',
      label: t(former ? 'contacts.email.setPrimaryRestore' : 'contacts.email.setPrimary'),
      onSelect: () => onSetPrimary(email.address)
    },
    {
      kind: 'action',
      id: 'former',
      label: t(former ? 'contacts.email.unformer' : 'contacts.email.former'),
      onSelect: () => onSetFormer(email.address, !former)
    },
    {
      kind: 'action',
      id: 'copy',
      label: t('contacts.email.copy'),
      onSelect: () => {
        void navigator.clipboard?.writeText(email.address)
        toastSuccess(t('contacts.email.copied', { email: email.address }))
      }
    }
  ]
  // 原型 `cdetail.jsx::IdentitySection`：单行卡片（地址占余宽不被挤压），
  // 主邮箱 = accent 淡描边 · 曾用 = 虚线 + 整体压暗 + 地址删除线。
  return (
    <div
      className={cn(
        'relative flex items-center gap-2.5 rounded-[var(--r-row)] border bg-ink-2 px-2.5 py-2',
        email.is_primary ? 'border-coral/25' : 'border-ink-border',
        former && 'border-dashed opacity-[0.72]'
      )}
      title={range}
    >
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-meta text-ink-fg',
          former && 'line-through decoration-ink-fg-3'
        )}
      >
        {email.address}
      </span>
      {email.is_primary ? <ContactPip>{t('contacts.email.primary')}</ContactPip> : null}
      {former ? <ContactPip>{t('contacts.email.formerPip')}</ContactPip> : null}
      <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
        {email.mail_count}
      </span>
      {!email.is_primary ? (
        <>
          <button
            ref={triggerRef}
            type="button"
            aria-label={t('contacts.row.more')}
            onClick={() => setMenuOpen((open) => !open)}
            className="grid size-6 shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.08] hover:text-ink-fg-1"
          >
            <MoreHorizontal size={13} />
          </button>
          <Popmenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            ariaLabel={t('contacts.row.more')}
            items={items}
            triggerRef={triggerRef}
            align="end"
            width={240}
          />
        </>
      ) : null}
    </div>
  )
}

// ── 关联邮件 ──────────────────────────────────────────────────────────────────

function ContactMailList({ contactId }: { contactId: number }): React.ReactElement {
  const { t, i18n } = useTranslation()
  const api = useContactsApi()
  const navigate = useNavigate()
  const setActiveEmail = useActiveEmail((state) => state.setActive)
  const [direction, setDirection] = useState<ContactMailDirection>('all')
  // render 期不许调 Date.now()（react-hooks/purity）—— 挂载时取一次快照。
  const [now] = useState(() => Date.now())
  const query = useInfiniteQuery({
    queryKey: qk.contacts.mails(contactId, direction),
    queryFn: ({ pageParam }) =>
      api.listMails(contactId, { direction, cursor: pageParam, limit: MAIL_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime: 30_000
  })
  const items = useMemo(() => (query.data?.pages ?? []).flatMap((page) => page.items), [query.data])
  const total = query.data?.pages[0]?.total ?? 0
  const remaining = Math.max(0, total - items.length)
  return (
    <section>
      <SecHead
        title={t('contacts.section.mails')}
        count={total}
        right={
          <SegmentedControl<ContactMailDirection>
            size="sm"
            ariaLabel={t('contacts.section.mails')}
            value={direction}
            onChange={(next) => setDirection(next)}
            options={CONTACT_MAIL_DIRECTIONS.map((value) => ({
              value,
              label: t(`contacts.mail.filter.${value}`)
            }))}
          />
        }
      />
      {items.length === 0 && !query.isPending ? (
        <div className="py-3 text-meta text-ink-fg-3">{t('contacts.mail.empty')}</div>
      ) : (
        <div className="flex flex-col">
          {items.map((mail) => {
            // 方向由后端给（自有地址集的权威在 resolve_self_addresses，前端再算
            // 一遍就是第二个真源）；cc 只作行内次要标记，不参与方向判定。
            const ccOnly =
              mail.direction !== 'from_them' &&
              mail.roles.includes('cc') &&
              !mail.roles.includes('to')
            const RoleIcon =
              mail.direction === 'from_them'
                ? Inbox
                : mail.direction === 'from_me'
                  ? Send
                  : UsersRound
            const roleKey = `contacts.mail.filter.${mail.direction}`
            return (
              <button
                key={mail.internal_id}
                type="button"
                onClick={() => {
                  setActiveEmail(mail.internal_id)
                  void navigate({ to: '/' })
                }}
                className="flex w-full items-start gap-2.5 rounded-[var(--r-row)] px-2.5 py-2 text-left transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.035]"
              >
                <RoleIcon size={13} aria-hidden className="mt-0.5 shrink-0 text-ink-fg-3" />
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  {!mail.is_read ? (
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-coral/100" />
                  ) : null}
                  <span
                    className={cn(
                      'min-w-0 truncate text-body text-ink-fg',
                      mail.is_read ? 'font-medium' : 'font-semibold'
                    )}
                  >
                    {mail.subject || '—'}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-[3px]">
                  <span className="text-micro tabular-nums text-ink-fg-3">
                    {mail.seen_at != null
                      ? formatMatterAgo(mail.seen_at, now, i18n.language || 'zh-CN')
                      : ''}
                  </span>
                  <span className="text-[10.5px] leading-none text-ink-fg-3">
                    {ccOnly ? `${t(roleKey)} · ${t('contacts.mail.ccMark')}` : t(roleKey)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
      {query.hasNextPage ? (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
          className="ml-2.5 mt-1.5 self-start text-meta text-coral transition-opacity duration-fast ease-standard hover:opacity-80 disabled:opacity-50"
        >
          {t('contacts.mail.more', { n: remaining })}
        </button>
      ) : null}
    </section>
  )
}

// ── 关联事项 ──────────────────────────────────────────────────────────────────

function ContactMatterList({ contactId }: { contactId: number }): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const openMatter = useMatterNavigation((state) => state.open)
  const query = useContactMatters(contactId, true)
  const items = query.data?.items ?? []
  return (
    <section>
      <SecHead title={t('contacts.section.matters')} count={items.length} />
      {items.length === 0 ? (
        <div className="py-2 text-meta text-ink-fg-3">{t('contacts.matters.empty')}</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((matter) => {
            const status = matter.status as MatterStatus
            const StatusIcon = MATTER_STATUS_ICONS[status]
            return (
              <button
                key={matter.matter_id}
                type="button"
                onClick={() => {
                  openMatter(matter.public_id)
                  void navigate({ to: '/matters' })
                }}
                className="flex w-full items-center gap-2.5 rounded-[var(--r-row)] border border-ink-border bg-ink-2 px-2.5 py-2 text-left transition-colors duration-fast ease-standard hover:border-ink-fg-3"
              >
                {StatusIcon ? (
                  <MatterPip tone={MATTER_STATUS_TONES[status] ?? 'neutral'} icon={StatusIcon}>
                    {t(`matters.status.${matter.status}`, { defaultValue: matter.status })}
                  </MatterPip>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-body text-ink-fg">
                  {matter.title}
                </span>
                {matter.role ? (
                  <span className="shrink-0 truncate text-meta text-ink-fg-3">{matter.role}</span>
                ) : null}
                <ChevronRight size={13} className="shrink-0 text-ink-fg-3" />
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

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

export function ContactDetail({
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

  const [nameEditing, setNameEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState<string | null>(null)
  const [headMenuOpen, setHeadMenuOpen] = useState(false)
  const headMenuRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setNameEditing(false)
    setNotesDraft(null)
    setHeadMenuOpen(false)
  }, [contactId])

  const patch = useMutation({
    mutationFn: (body: ContactPatchBody) => api.patch(contactId, body),
    onSuccess: async (result, body) => {
      await invalidate(contactId)
      const lockedFields = Object.keys(body).filter(
        (field) => field !== 'notes'
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
    return <div className="h-full min-h-0 overflow-y-auto scrollbar-none" />
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

  const headMenuItems: PopmenuItem[] = [
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

  const compose = (): void => {
    openNewCompose(primaryEmail ?? undefined)
    if (primaryEmail) toastSuccess(t('contacts.toast.composePrefill', { email: primaryEmail }))
  }

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
                    date: fmtMonth(detail.first_seen_at, locale),
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
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── 滚动区（原型：`18px 22px 60px` + 块间 24px + 内容宽 820）── */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-none">
        <div className="flex max-w-[820px] flex-col gap-6 px-[22px] pb-14 pt-[18px]">
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
          <ContactMailList contactId={contactId} />
          <ContactMatterList contactId={contactId} />
        </div>
      </div>
    </div>
  )
}
