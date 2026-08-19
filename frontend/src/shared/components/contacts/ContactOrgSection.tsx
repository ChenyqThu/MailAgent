// 组织关系区（task 08-13 WP5，设计 §2.2.1 / 原型 `cdetail.jsx::OrgSection/RelChip`）。
//
// 上级人物卡（点击跳人物页 / hover 出「解除关系」/ 未设时虚线引导）→ 下级反查列表
// +「添加下级」→ 同组织同事前 6（标「自动归类」，块随 peers 空整个不渲染）。
// 🔒 只存一侧：所有写都是「改某人的 manager 字段」——「添加下级」= 对下级那行
// 调同一端点；反查由服务端投影（detail.reports）。
// `manager_src==='auto'` 的「从邮件推断」标记是 WP6 结构位（WP5 REST 恒 manual）；
// SuggestRow 上级建议随 WP6，本区不渲染。
//
// 指定上级 / 添加下级 = 轻量选人弹层（原型 `cpicker.jsx::PersonPickerModal`，
// 520px 单选；池 = person 且非 self / 非隐藏，服务端 q + density 排序）。
// 环的最终判据在服务端（set_manager 守卫），前端 taken 只做明显项（自己 / 已是下级）。

import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Pencil, Plus, Send, X, type LucideIcon } from 'lucide-react'

import type { ContactDetailDto, ContactRelPersonDto } from '@shared/api/types/contact'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/components/ui/dialog'
import { errorMessage } from '@shared/lib/ipcErrors'
import { openNewCompose } from '@shared/state/compose-new'
import { toastError, toastSuccess } from '@shared/state/toast'

import { Monogram } from './Monogram'
import { AiMark, SecHead } from './parts'
import { PersonPicker } from './PersonPicker'
import { useContactList, useContactsApi, useInvalidateContact } from './hooks'
import { useContactNavigation } from './navigation'

const SEARCH_DEBOUNCE_MS = 250
/** 弹层候选上限：无虚拟滚动，density 排序 + 服务端 q 收窄后截长尾
 *  （镜像 MergeContactsDialog 的 MERGE_CANDIDATE_CAP）。 */
const PICK_CANDIDATE_CAP = 200

/** 原型 `cui.jsx::AiMark`（sparkles + c-ai 字/10% 底/25% 边）。WP6 起签名本体上移到
 *  `parts.tsx::AiMark`（档案头的「职务由画像推断」用同一个），这里只固定文案。 */
function AutoSrcMark(): React.ReactElement {
  const { t } = useTranslation()
  return <AiMark>{t('contacts.org.autoSrc')}</AiMark>
}

/** 子块标签行右侧的 ghost 小钮（原型 `Btn size="sm" kind="ghost" icon`）。 */
function GhostBtn({
  icon: Icon,
  label,
  onClick
}: {
  icon: LucideIcon
  label: string
  onClick(): void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.06] hover:text-ink-fg"
    >
      <Icon size={12} aria-hidden />
      {label}
    </button>
  )
}

/** 虚线空态行（未设上级引导 / 还没有下级）。 */
function DashedNote({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="rounded-[var(--r-row)] border border-dashed border-ink-border px-2.5 py-[7px] text-meta text-ink-fg-3">
      {children}
    </div>
  )
}

/** 关系人物卡（原型 `RelChip`）：点击跳人物页，hover 出「解除关系」，尾部 chevron。 */
function RelChip({
  person,
  big,
  onOpen,
  onRemove,
  removeLabel
}: {
  person: ContactRelPersonDto
  big?: boolean
  onOpen(): void
  onRemove(): void
  removeLabel: string
}): React.ReactElement {
  const sub = [person.organization, person.role_title].filter(Boolean).join(' · ')
  return (
    <div className="group/rel flex items-center gap-[9px] rounded-[var(--r-row)] border border-ink-border bg-ink-2 px-2.5 py-[7px]">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-[9px] text-left"
      >
        <Monogram
          displayName={person.display_name}
          primaryEmail={person.primary_email}
          kind={person.kind}
          size={big ? 30 : 26}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-ink-fg">
            {person.display_name ?? person.primary_email?.split('@')[0] ?? '—'}
          </span>
          {sub ? <span className="mt-px block truncate text-meta text-ink-fg-2">{sub}</span> : null}
        </span>
      </button>
      <button
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
        className="grid size-[22px] shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-3 opacity-0 transition-opacity duration-fast ease-standard hover:bg-ink-fg/[0.08] hover:text-ink-fg-1 focus-visible:opacity-100 group-hover/rel:opacity-100"
      >
        <X size={12} />
      </button>
      <ChevronRight size={12} aria-hidden className="shrink-0 text-ink-fg-3" />
    </div>
  )
}

/** 轻量选人弹层（原型 `PersonPickerModal` 520px 单选）。sub 两句无 i18n key
 *  （零新增纪律）→ title-only。 */
function PersonPickDialog({
  open,
  title,
  excludeIds,
  takenIds,
  onClose,
  onPick
}: {
  open: boolean
  title: string
  /** 不进池（自己）。 */
  excludeIds: ReadonlySet<number>
  /** 置灰打勾禁选（已是下级）。 */
  takenIds: ReadonlySet<number>
  onClose(): void
  onPick(contactId: number): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => {
    if (open) return
    setSearchInput('')
    setSearch('')
  }, [open])
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const listQuery = useContactList({ view: 'all', q: search, sort: 'density', enabled: open })
  // 池过滤照原型：person / 非隐藏；exclude 不渲染（本人）。
  // 🔴 task 08-14 WP-3 起不再排除 is_self —— owner「上下级也无法关联我」：
  // 「我」得能被选成别人的上级、也得能出现在候选里。
  const items = useMemo(
    () =>
      (listQuery.data?.items ?? [])
        .filter((row) => row.kind === 'person' && row.hidden_at == null && !excludeIds.has(row.id))
        .slice(0, PICK_CANDIDATE_CAP),
    [excludeIds, listQuery.data]
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-h-[84vh] w-[520px] max-w-[calc(100vw-2rem)] grid-rows-[auto_1fr]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/* 滚动形态照 MergeContactsDialog：外层整体滚，min-h 兜住空列表时的塌缩。
            🔴 四边都要 padding（不能只 `pr-1`）—— PersonPicker 的搜索框焦点态是
            `ring-2`，而 ring 是 box-shadow：净空 < 2px 的那几边会被 overflow 裁掉，
            视觉上变成「只有右下两边的不规则阴影」。三个消费者同一几何，同一处置。 */}
        <div className="min-h-[280px] overflow-y-auto p-1 scrollbar-thin">
          <PersonPicker
            items={items}
            loading={listQuery.isPending}
            search={searchInput}
            onSearchChange={setSearchInput}
            searchPlaceholder={t('contacts.search.placeholder')}
            mode="single"
            onPick={(row) => onPick(row.id)}
            takenIds={takenIds}
            empty={
              <p className="rounded-[var(--r-card)] border border-ink-border bg-ink-2/50 px-3 py-2.5 text-meta text-ink-fg-3">
                {t('contacts.picker.empty')}
              </p>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ContactOrgSection({ detail }: { detail: ContactDetailDto }): React.ReactElement {
  const { t } = useTranslation()
  const api = useContactsApi()
  const invalidate = useInvalidateContact()
  const openContact = useContactNavigation((state) => state.open)
  const [pickFor, setPickFor] = useState<'manager' | 'report' | null>(null)

  const manager = detail.manager
  const reports = detail.reports
  const peers = detail.peers
  // 弹层的 exclude / taken（裁决 10：指定上级 taken=自己；添加下级 taken=自己+已是
  // 其下级者。自己照原型 exclude 不进池，其余走 taken 置灰打勾）。
  const pickExcludeIds = useMemo(() => new Set([detail.id]), [detail.id])
  const pickTakenIds = useMemo(
    () => (pickFor === 'report' ? new Set(reports.map((r) => r.id)) : new Set<number>()),
    [pickFor, reports]
  )
  const subjectPrimaryEmail =
    detail.emails.find((email) => email.is_primary)?.address ?? detail.emails[0]?.address ?? null

  // 写面统一走「改 contactId 的 manager 字段」（🔒 只存一侧）。成功失效双方
  // detail + 列表（汇报线分组 / 行菜单可用性都吃 list 的 manager 字段）。
  const setManager = useMutation({
    mutationFn: (input: { contactId: number; managerContactId: number | null; other: number }) =>
      api.setManager(input.contactId, input.managerContactId),
    onSuccess: async (_result, input) => {
      await Promise.all([invalidate(input.contactId), invalidate(input.other)])
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })

  const composeCc = (): void => {
    if (!manager) return
    openNewCompose(
      subjectPrimaryEmail ?? undefined,
      manager.primary_email ? [manager.primary_email] : undefined
    )
    if (subjectPrimaryEmail) {
      toastSuccess(t('contacts.toast.composePrefill', { email: subjectPrimaryEmail }))
    }
  }

  return (
    <section>
      <SecHead
        title={t('contacts.org.section')}
        right={
          manager ? (
            <GhostBtn icon={Send} label={t('contacts.org.composeCc')} onClick={composeCc} />
          ) : undefined
        }
      />
      <div className="flex flex-col gap-2.5">
        {/* ── 上级 ── */}
        <div>
          <div className="mb-[5px] flex items-center gap-[7px]">
            <span className="text-micro text-ink-fg-2">{t('contacts.org.manager')}</span>
            {manager && detail.manager_src === 'auto' ? <AutoSrcMark /> : null}
            <span className="flex-1" />
            <GhostBtn
              icon={manager ? Pencil : Plus}
              label={t('contacts.org.setManager')}
              onClick={() => setPickFor('manager')}
            />
          </div>
          {manager ? (
            <RelChip
              person={manager}
              big
              onOpen={() => openContact(manager.id)}
              onRemove={() =>
                setManager.mutate({
                  contactId: detail.id,
                  managerContactId: null,
                  other: manager.id
                })
              }
              removeLabel={t('contacts.org.unlink')}
            />
          ) : (
            <DashedNote>{t('contacts.org.noManager')}</DashedNote>
          )}
        </div>

        {/* ── 下级（反查） ── */}
        <div>
          <div className="mb-[5px] flex items-center gap-[7px]">
            <span className="text-micro text-ink-fg-2">{t('contacts.org.reports')}</span>
            <span className="font-mono text-micro tabular-nums text-ink-fg-3">
              {reports.length}
            </span>
            <span className="flex-1" />
            <GhostBtn
              icon={Plus}
              label={t('contacts.org.addReport')}
              onClick={() => setPickFor('report')}
            />
          </div>
          {reports.length > 0 ? (
            <div className="flex flex-col gap-[5px]">
              {reports.map((report) => (
                <RelChip
                  key={report.id}
                  person={report}
                  onOpen={() => openContact(report.id)}
                  onRemove={() =>
                    setManager.mutate({
                      contactId: report.id,
                      managerContactId: null,
                      other: detail.id
                    })
                  }
                  removeLabel={t('contacts.org.unlink')}
                />
              ))}
            </div>
          ) : (
            <DashedNote>{t('contacts.org.noReports')}</DashedNote>
          )}
        </div>

        {/* ── 同组织同事（派生，peers 空整块不渲染） ── */}
        {peers.length > 0 ? (
          <div>
            <div className="mb-[5px] text-micro text-ink-fg-2">{t('contacts.org.peers')}</div>
            <div className="flex flex-wrap gap-1.5">
              {peers.map((peer) => (
                <button
                  key={peer.id}
                  type="button"
                  onClick={() => openContact(peer.id)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-ink-border bg-ink-fg/[0.03] py-[3px] pl-1 pr-[9px] transition-colors duration-fast ease-standard hover:border-coral/35"
                >
                  <Monogram
                    displayName={peer.display_name}
                    primaryEmail={peer.primary_email}
                    kind={peer.kind}
                    size={18}
                  />
                  <span className="text-meta text-ink-fg-1">
                    {peer.display_name ?? peer.primary_email?.split('@')[0] ?? '—'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <PersonPickDialog
        open={pickFor !== null}
        title={t(pickFor === 'report' ? 'contacts.org.addReport' : 'contacts.org.setManager')}
        excludeIds={pickExcludeIds}
        takenIds={pickTakenIds}
        onClose={() => setPickFor(null)}
        onPick={(pickedId) => {
          if (pickFor === 'manager') {
            setManager.mutate({ contactId: detail.id, managerContactId: pickedId, other: pickedId })
          } else if (pickFor === 'report') {
            // 「添加下级」= 写对方的 manager 字段（无双写）。
            setManager.mutate({
              contactId: pickedId,
              managerContactId: detail.id,
              other: detail.id
            })
          }
          setPickFor(null)
        }}
      />
    </section>
  )
}
