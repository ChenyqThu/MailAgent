// 合并 dialog（task 08-13 WP3，设计 §2.4 / D6：两步 560→760px）。
//
// 步骤 1（560px）：搜索另一条记录（PersonPicker 单选；排除自己，墓碑服务端已滤；
// 顶部虚线占位 = Phase 3「疑似同人」自动建议的落点）。入口 ②（列表多选恰 2 条）
// 跳过此步直入步骤 2。
// 步骤 2（760px）：左右两列对照 + 每列底部「保留这一条」单选 + 「合并后」结果卡
// （主邮箱单选 + 每行曾用勾选 + N 封·最近区间、变体并集、事项并集、墓碑说明）
// + 连带冲突黄色提示（两侧事项交集，逐个 matter，不静默）+ 克制红色危险提示。
//
// 🔴 默认值全部来自 `mergeModel.ts` 纯函数（last_seen 推导 + 60 天条款，与保留方
// 无关）；失败分支 = toast「合并未完成 · 两条记录都未改动」，dialog 停在步骤 2、
// 无乐观更新。成功 = toast done → 关闭 → onMerged(winnerId)（列表/详情切保留方）。

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CircleAlert, TriangleAlert } from 'lucide-react'

import type { ContactDetailDto, ContactEmailDto } from '@shared/api/types/contact'
import { Checkbox } from '@shared/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { Monogram } from './Monogram'
import { SecHead } from './parts'
import { PersonPicker } from './PersonPicker'
import { useContactDetail, useContactList, useContactMatters, useContactsApi } from './hooks'
import {
  defaultKeepContactId,
  defaultMergeFormer,
  defaultMergePrimary,
  mergeMatterConflicts,
  mergeMatterUnion,
  mergeVariantUnion,
  type MergeMatterRef
} from './mergeModel'

const SEARCH_DEBOUNCE_MS = 250
/** 步骤 1 候选展示上限：dialog 列表无虚拟滚动；按往来密度排序 + 服务端 q 收窄，
 *  截断的都是长尾（同 matters picker 的 PICKER_POOL_CAP 语义）。 */
const MERGE_CANDIDATE_CAP = 200

export interface MergeContactsDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** 入口 ①：详情页「合并到另一条记录…」—— A 侧固定，步骤 1 搜另一条。 */
  sourceId: number | null
  /** 入口 ②：列表多选恰 2 条 —— 直入步骤 2。 */
  pairIds: readonly [number, number] | null
  onMerged(winnerId: number): void
}

function fmtMonth(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short' }).format(ms)
}

function contactLabel(detail: ContactDetailDto): string {
  return (
    detail.display_name ??
    detail.emails.find((email) => email.is_primary)?.address ??
    detail.emails[0]?.address ??
    `#${detail.id}`
  )
}

function toMatterRefs(
  items: readonly { matter_id: number; public_id: string; title: string; role: string | null }[]
): MergeMatterRef[] {
  return items.map((item) => ({
    matter_id: item.matter_id,
    public_id: item.public_id,
    title: item.title,
    role: item.role
  }))
}

export function MergeContactsDialog({
  open,
  onOpenChange,
  sourceId,
  pairIds,
  onMerged
}: MergeContactsDialogProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'zh-CN'
  const api = useContactsApi()
  const queryClient = useQueryClient()

  const aId = sourceId ?? pairIds?.[0] ?? null

  const [step, setStep] = useState<'pick' | 'preview'>('pick')
  const [otherId, setOtherId] = useState<number | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [keepChoice, setKeepChoice] = useState<number | null>(null)
  const [primaryChoice, setPrimaryChoice] = useState<string | null>(null)
  const [formerOverrides, setFormerOverrides] = useState<Record<string, boolean>>({})

  // 打开 / 换目标时整体重置（identity-key 模式，照 MatterStakeholderPicker）。
  const identity = `${open ? 'open' : 'closed'}:${sourceId ?? ''}:${pairIds?.join('+') ?? ''}`
  const [identityFor, setIdentityFor] = useState(identity)
  if (identityFor !== identity) {
    setIdentityFor(identity)
    if (open) {
      setStep(pairIds ? 'preview' : 'pick')
      setOtherId(pairIds?.[1] ?? null)
      setSearchInput('')
      setSearch('')
      setKeepChoice(null)
      setPrimaryChoice(null)
      setFormerOverrides({})
    }
  }

  // 步骤 1 搜索：防抖后走服务端 q（任一锚点邮箱/姓名/变体/组织可搜；
  // 250ms 照 ContactsWorkspace 的模式）。
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const listQuery = useContactList({
    view: 'all',
    q: search,
    sort: 'density',
    enabled: open && step === 'pick'
  })
  const candidates = useMemo(
    () =>
      (listQuery.data?.items ?? [])
        .filter((row) => row.id !== aId)
        .slice(0, MERGE_CANDIDATE_CAP),
    [aId, listQuery.data]
  )

  const bId = otherId
  const previewEnabled = open && step === 'preview' && aId !== null && bId !== null
  // A 侧详情在步骤 1 就取 —— merge.sub 的 {name} 与预览都用它。
  const detailA = useContactDetail(open ? aId : null, open && aId !== null)
  const detailB = useContactDetail(previewEnabled ? bId : null, previewEnabled)
  const mattersA = useContactMatters(previewEnabled ? aId : null, previewEnabled)
  const mattersB = useContactMatters(previewEnabled ? bId : null, previewEnabled)

  const a = detailA.data ?? null
  const b = detailB.data ?? null
  const ready = a !== null && b !== null

  const keepId = ready
    ? (keepChoice ??
      defaultKeepContactId(
        { id: a.id, mail_count: a.mail_count, last_seen_at: a.last_seen_at },
        { id: b.id, mail_count: b.mail_count, last_seen_at: b.last_seen_at }
      ))
    : null
  const winner = ready ? (keepId === a.id ? a : b) : null
  const loser = ready ? (keepId === a.id ? b : a) : null

  const emails = useMemo<ContactEmailDto[]>(
    () => (ready ? [...a.emails, ...b.emails] : []),
    [a, b, ready]
  )
  const primary = primaryChoice ?? defaultMergePrimary(emails)
  const formerDefaults = useMemo(
    () => new Set(defaultMergeFormer(emails, primary)),
    [emails, primary]
  )
  const isFormerChecked = (address: string): boolean =>
    address !== primary && (formerOverrides[address] ?? formerDefaults.has(address))

  const matterRefsA = useMemo(() => toMatterRefs(mattersA.data?.items ?? []), [mattersA.data])
  const matterRefsB = useMemo(() => toMatterRefs(mattersB.data?.items ?? []), [mattersB.data])
  const conflicts = useMemo(
    () => mergeMatterConflicts(matterRefsA, matterRefsB),
    [matterRefsA, matterRefsB]
  )
  const conflictIds = useMemo(
    () => new Set(conflicts.map((matter) => matter.matter_id)),
    [conflicts]
  )
  const matterUnion = useMemo(
    () => mergeMatterUnion(matterRefsA, matterRefsB),
    [matterRefsA, matterRefsB]
  )
  const variantUnion = ready ? mergeVariantUnion(a.name_variants, b.name_variants) : []

  const merge = useMutation({
    mutationFn: async (): Promise<{ detail: ContactDetailDto; restoreFailed: string[] }> => {
      if (!winner || !loser || !primary) throw new Error('merge preview not ready')
      const formerList = emails
        .map((email) => email.address)
        .filter((address) => isFormerChecked(address))
      const detail = await api.merge(winner.id, {
        loser_id: loser.id,
        primary_email: primary,
        former_emails: formerList
      })
      // 「落库按勾选写」的补角：本来就是曾用、但 owner 显式取消勾选的地址 ——
      // merge API 不清 former，这里补 unformer（幂等，走同一守卫）。失败不算
      // 合并失败（合并已落地，不能谎报「两条记录都未改动」），单独提示。
      const restoreFailed: string[] = []
      for (const email of emails) {
        if (
          email.former_at != null &&
          email.address !== primary &&
          !isFormerChecked(email.address)
        ) {
          try {
            await api.setEmailFormer(winner.id, email.address, false)
          } catch {
            restoreFailed.push(email.address)
          }
        }
      }
      return { detail, restoreFailed }
    },
    onSuccess: async ({ detail, restoreFailed }) => {
      toastSuccess(t('contacts.merge.done', { n: detail.emails.length }))
      if (restoreFailed.length > 0) {
        toastError(t('contacts.toast.saveFailed'), restoreFailed.join(', '))
      }
      // contacts 全域失效（列表 + 两侧 detail/mails/matters）+ 受影响事项。
      const invalidations = [
        queryClient.invalidateQueries({ queryKey: qk.contacts.all() }),
        queryClient.invalidateQueries({ queryKey: qk.matters.list() }),
        ...matterUnion.map((matter) =>
          queryClient.invalidateQueries({ queryKey: qk.matters.detail(matter.public_id) })
        )
      ]
      await Promise.all(invalidations)
      const winnerId = detail.id
      onOpenChange(false)
      onMerged(winnerId)
    },
    onError: (error) => toastError(t('contacts.toast.mergeFailed'), errorMessage(error))
  })

  const sourceName = a?.display_name ?? ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'max-h-[84vh] max-w-[calc(100vw-2rem)] grid-rows-[auto_1fr_auto]',
          'transition-[width] duration-base ease-standard',
          step === 'pick' ? 'w-[560px]' : 'w-[760px]'
        )}
      >
        <DialogHeader>
          <DialogTitle>
            {t(step === 'pick' ? 'contacts.merge.title' : 'contacts.merge.previewTitle')}
          </DialogTitle>
          <DialogDescription>
            {step === 'pick'
              ? t('contacts.merge.sub', { name: sourceName })
              : t('contacts.merge.previewSub')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto pr-1 scrollbar-thin">
          {step === 'pick' ? (
            <PersonPicker
              items={candidates}
              loading={listQuery.isPending}
              search={searchInput}
              onSearchChange={setSearchInput}
              searchPlaceholder={t('contacts.merge.searchPlaceholder')}
              mode="single"
              onPick={(row) => {
                setOtherId(row.id)
                setKeepChoice(null)
                setPrimaryChoice(null)
                setFormerOverrides({})
                setStep('preview')
              }}
              aboveList={
                <p className="rounded-[var(--r-card)] border border-dashed border-ink-border bg-ink-2/50 px-3 py-2 text-meta leading-5 text-ink-fg-3">
                  {t('contacts.merge.futureSuggest')}
                </p>
              }
              empty={
                <p className="rounded-[var(--r-card)] border border-ink-border bg-ink-2/50 px-3 py-2.5 text-meta text-ink-fg-3">
                  {t('contacts.picker.empty')}
                </p>
              }
            />
          ) : !ready || !winner || !loser ? (
            <div className="py-8 text-center text-meta text-ink-fg-3">…</div>
          ) : (
            <div className="space-y-3">
              {/* ── 左右对照两列 ── */}
              <div className="grid grid-cols-2 gap-3">
                {[a, b].map((side) => (
                  <MergeSideCard
                    key={side.id}
                    detail={side}
                    matters={side.id === a.id ? matterRefsA : matterRefsB}
                    locale={locale}
                    kept={keepId === side.id}
                    onKeep={() => setKeepChoice(side.id)}
                  />
                ))}
              </div>

              {/* ── 合并后结果卡（原型：中性 Card + 上方 SecHead，不抢 accent 语义）── */}
              <SecHead title={t('contacts.merge.result')} className="mb-0" />
              <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-3.5">
                <div className="flex items-center gap-2.5">
                  <Monogram
                    displayName={winner.display_name}
                    primaryEmail={primary}
                    kind={winner.kind}
                    size={34}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-semibold text-ink-fg">
                      {contactLabel(winner)}
                    </span>
                    <span className="block text-meta text-ink-fg-2">
                      {t('contacts.stat.exchange', {
                        n: a.mail_count + b.mail_count,
                        sent: a.sent_to_count + b.sent_to_count
                      })}
                    </span>
                  </span>
                </div>

                <div className="mt-2.5 text-meta text-ink-fg-2">
                  {t('contacts.merge.pickPrimary')}
                </div>
                <div className="mt-1.5 space-y-1.5">
                  {emails.map((email) => {
                    const isPrimary = email.address === primary
                    const range =
                      email.first_seen_at != null && email.last_seen_at != null
                        ? t('contacts.email.meta', {
                            n: email.mail_count,
                            from: fmtMonth(email.first_seen_at, locale),
                            to: fmtMonth(email.last_seen_at, locale)
                          })
                        : String(email.mail_count)
                    return (
                      <div
                        key={email.address}
                        className={cn(
                          'flex items-center gap-2.5 rounded-[var(--r-row)] border px-2.5 py-1.5',
                          isPrimary ? 'border-coral/40 bg-coral/5' : 'border-ink-border'
                        )}
                      >
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                          <input
                            type="radio"
                            name="merge-primary"
                            checked={isPrimary}
                            onChange={() => setPrimaryChoice(email.address)}
                            className="size-3.5 shrink-0 accent-coral"
                          />
                          <span
                            className={cn(
                              'truncate font-mono text-meta text-ink-fg',
                              !isPrimary && isFormerChecked(email.address) &&
                                'text-ink-fg-2 line-through'
                            )}
                          >
                            {email.address}
                          </span>
                          {isPrimary ? (
                            <span className="shrink-0 rounded-full border border-coral/40 bg-coral/10 px-1.5 py-px text-micro leading-4 text-coral">
                              {t('contacts.email.primary')}
                            </span>
                          ) : null}
                        </label>
                        <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
                          {range}
                        </span>
                        {!isPrimary ? (
                          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-micro text-ink-fg-2">
                            <Checkbox
                              checked={isFormerChecked(email.address)}
                              onCheckedChange={(value) =>
                                setFormerOverrides((current) => ({
                                  ...current,
                                  [email.address]: value === true
                                }))
                              }
                            />
                            {t('contacts.email.formerPip')}
                          </label>
                        ) : null}
                      </div>
                    )
                  })}
                </div>

                {variantUnion.length > 0 ? (
                  <div className="mt-2 text-micro text-ink-fg-3">
                    <span className="mr-1.5">{t('contacts.field.variants')}</span>
                    {variantUnion.join(' · ')}
                  </div>
                ) : null}

                {matterUnion.length > 0 ? (
                  <div className="mt-2.5">
                    <div className="text-micro font-medium uppercase tracking-wide text-ink-fg-3">
                      {t('contacts.section.matters')}
                    </div>
                    <div className="mt-1 space-y-1">
                      {matterUnion.map((matter) => (
                        <div key={matter.matter_id}>
                          <div className="truncate text-meta text-ink-fg-1">{matter.title}</div>
                          {conflictIds.has(matter.matter_id) ? (
                            <div className="mt-0.5 flex items-start gap-1.5 rounded-[var(--r-row)] border border-warn/30 bg-warn/[0.07] px-2 py-1.5 text-micro leading-4 text-ink-fg-1">
                              <TriangleAlert size={11} className="mt-px shrink-0 text-warn" />
                              <span>{t('contacts.merge.conflict', { matter: matter.title })}</span>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="mt-2.5 text-meta text-ink-fg-2">
                  {t('contacts.merge.loser', { name: contactLabel(loser) })}
                </div>
              </div>

              {/* ── 危险提示（克制的红：底/边是红，正文仍是常规前景色）── */}
              <div className="flex gap-2.5 rounded-[var(--r-row)] border border-crit/25 bg-crit/[0.06] px-3 py-2.5">
                <CircleAlert size={13} aria-hidden className="mt-0.5 shrink-0 text-crit" />
                <p className="min-w-0 text-meta leading-relaxed text-ink-fg-1">
                  {t('contacts.merge.danger')}
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="items-center gap-2">
          {step === 'preview' ? (
            <button
              type="button"
              onClick={() => {
                // 换一条：清掉上一对的选择（保留方/主邮箱/曾用勾选都随对子失效）。
                setStep('pick')
                setOtherId(null)
                setKeepChoice(null)
                setPrimaryChoice(null)
                setFormerOverrides({})
              }}
              className="mr-auto rounded-[var(--r-ctl)] px-3 py-2 text-aux text-ink-fg-2 hover:bg-ink-3"
            >
              {t('contacts.merge.back')}
            </button>
          ) : (
            <span className="mr-auto" />
          )}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-[var(--r-ctl)] px-3 py-2 text-aux hover:bg-ink-3"
          >
            {t('common.cancel')}
          </button>
          {step === 'preview' ? (
            <button
              type="button"
              disabled={!ready || primary === null || merge.isPending}
              onClick={() => merge.mutate()}
              className="rounded-[var(--r-ctl)] bg-coral/100 px-4 py-2 text-aux font-medium text-accent-fg disabled:opacity-50"
            >
              {t('contacts.merge.confirm')}
            </button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 对照列：姓名/组织职务/往来/时间跨度/事项数/邮箱 + 底部「保留这一条」单选。 */
function MergeSideCard({
  detail,
  matters,
  locale,
  kept,
  onKeep
}: {
  detail: ContactDetailDto
  matters: readonly MergeMatterRef[]
  locale: string
  kept: boolean
  onKeep(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const subtitle = [detail.organization, detail.department, detail.role_title]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-[var(--r-card)] border p-3',
        kept ? 'border-coral/50 bg-coral/[0.05]' : 'border-ink-border bg-ink-1'
      )}
    >
      <div className="flex items-center gap-2">
        <Monogram
          displayName={detail.display_name}
          primaryEmail={
            detail.emails.find((email) => email.is_primary)?.address ??
            detail.emails[0]?.address ??
            null
          }
          kind={detail.kind}
          size={30}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-ink-fg">
            {contactLabel(detail)}
          </span>
          {subtitle ? (
            <span className="block truncate text-meta text-ink-fg-2">{subtitle}</span>
          ) : null}
        </span>
      </div>
      <div className="text-micro font-mono tabular-nums text-ink-fg-3">
        {t('contacts.stat.exchange', { n: detail.mail_count, sent: detail.sent_to_count })}
      </div>
      {detail.first_seen_at != null && detail.last_seen_at != null ? (
        <div className="text-micro font-mono tabular-nums text-ink-fg-3">
          {fmtMonth(detail.first_seen_at, locale)}–{fmtMonth(detail.last_seen_at, locale)}
        </div>
      ) : null}
      <div className="text-micro text-ink-fg-3">
        {t('contacts.section.matters')} · {matters.length}
      </div>
      <div className="space-y-0.5">
        {detail.emails.map((email) => (
          <div key={email.address} className="truncate font-mono text-micro text-ink-fg-2">
            {email.address}
          </div>
        ))}
      </div>
      <label className="mt-auto flex cursor-pointer items-center gap-2 border-t border-ink-border pt-2 text-meta text-ink-fg-1">
        <input
          type="radio"
          name="merge-keep"
          checked={kept}
          onChange={onKeep}
          className="size-3.5 shrink-0 accent-coral"
        />
        {t('contacts.merge.keepThis')}
      </label>
    </div>
  )
}

