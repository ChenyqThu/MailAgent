// G-16 + W-C（dogfood 轮 2）—— 干系人两步 Picker（设计 §2.21 的 640px 两步弹窗）。
//
// v52 起「联系人库」是真表（matter_contact，全局一份），第一步照设计给满三组：
// ① 本事项往来里出现过（已关联资料 metadata 推导，零新请求）②「联系人库」（全局池，
// 一次批量取，含其它事项的干系人）③「从邮件提取」一键 —— 确定性扫 email_metadata 的
// 收发件人按频次汇总（服务端做，不走 LLM），选中入库并关联本事项。手输邮箱新建仍是兜底，
// 保存即写回联系人库。设计里的「组织通讯录 + 立即同步」仍是 mock，不做假开关。
//
// 🔴 列表性能铁律：三组数据都是**整组批量**到手（分别 0 / 1 / 1 个请求），
// 绝不逐行发请求（`frontend/ARCHITECTURE.md` §7.1-7.2）。

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Loader2, ScanSearch, UserPlus, Users, X } from 'lucide-react'

import type {
  Matter,
  MatterResourceListItem,
  MatterStakeholder,
  MatterStakeholderCreateInput
} from '@shared/api/types/matter'
import { RecipientAvatar } from '@shared/components/email/compose/recipient-avatar'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Checkbox } from '@shared/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Input } from '@shared/components/ui/input'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { formatRelativeTime } from '@shared/format'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { useMattersApi } from './hooks'
import { useMatterMutation } from './matterMutation'
import {
  MATTER_STAKEHOLDER_EMAIL_RE,
  MATTER_STAKEHOLDER_ROLE_PRESETS,
  buildStakeholderPickerPools,
  deriveStakeholderCandidates,
  filterStakeholderPool
} from './matterStakeholderCandidates'
import type { MatterStakeholderPoolPerson } from './matterStakeholderCandidates'

interface DraftRow {
  email: string
  displayName: string | null
  role: string
  /** 组织字段：从库/提取候选带出时预填，仍可改 —— 保存后经服务端 upsert 写回全局
   *  联系人库（v52 起「随联系人库自动带出」是真的）。 */
  organization: string
  waiting: boolean
  note: string
}

interface MatterStakeholderPickerProps {
  matter: Matter
  resources: readonly MatterResourceListItem[]
  stakeholders: readonly MatterStakeholder[]
  /** 非空 = 编辑既有干系人（直接进第二步，只有一行）。 */
  editing: MatterStakeholder | null
  open: boolean
  onOpenChange(open: boolean): void
  onChanged(): void
}

export function MatterStakeholderPicker({
  matter,
  resources,
  stakeholders,
  editing,
  open,
  onOpenChange,
  onChanged
}: MatterStakeholderPickerProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()

  const [step, setStep] = useState<0 | 1>(0)
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, DraftRow>>({})
  // 「从邮件提取」是一键显式动作 —— 扫描不便宜，不在每次开弹窗时白跑。
  const [extractRequested, setExtractRequested] = useState(false)

  // 联系人库整池一次批量取（编辑单人时用不上，不发）。
  const contactsQuery = useQuery({
    queryKey: qk.matters.contacts(),
    queryFn: () => api.listContacts(),
    enabled: open && !editing,
    staleTime: 30_000
  })
  const extractQuery = useQuery({
    queryKey: qk.matters.contactEmailCandidates(),
    queryFn: () => api.listContactEmailCandidates(),
    enabled: open && !editing && extractRequested,
    staleTime: 30_000
  })
  const pools = buildStakeholderPickerPools(
    deriveStakeholderCandidates(resources, stakeholders),
    contactsQuery.data ?? [],
    extractRequested ? (extractQuery.data ?? []) : [],
    stakeholders
  )

  // 打开 / 切换编辑对象时重置。编辑态直接落在第二步。
  const identity = `${open ? 'open' : 'closed'}:${editing?.id ?? 'new'}`
  const [identityFor, setIdentityFor] = useState(identity)
  if (identityFor !== identity) {
    setIdentityFor(identity)
    if (open) {
      setSearch('')
      setExtractRequested(false)
      if (editing) {
        const key = editing.email_normalized ?? `id:${editing.id}`
        setStep(1)
        setPicked([key])
        setRows({
          [key]: {
            email: editing.email_normalized ?? '',
            displayName: editing.display_name,
            role: editing.role ?? '',
            organization: editing.organization ?? '',
            waiting: editing.is_waiting_on,
            note: editing.relationship ?? ''
          }
        })
      } else {
        setStep(0)
        setPicked([])
        setRows({})
      }
    }
  }

  const visibleFromMatter = filterStakeholderPool(pools.fromMatter, search)
  const visibleLibrary = filterStakeholderPool(pools.library, search)
  const visibleExtracted = filterStakeholderPool(pools.extracted, search)
  const anyVisible =
    visibleFromMatter.length + visibleLibrary.length + visibleExtracted.length > 0
  const manualEmail = MATTER_STAKEHOLDER_EMAIL_RE.test(search.trim())
    ? search.trim().toLowerCase()
    : null
  const knownEmails = new Set(
    [...pools.fromMatter, ...pools.library, ...pools.extracted].map((p) => p.email)
  )
  const manualIsNew = manualEmail !== null && !knownEmails.has(manualEmail)

  const toggle = (person: Pick<MatterStakeholderPoolPerson, 'email' | 'displayName'> & {
    organization?: string | null
  }): void => {
    setPicked((current) =>
      current.includes(person.email)
        ? current.filter((value) => value !== person.email)
        : [...current, person.email]
    )
    setRows((current) =>
      current[person.email]
        ? current
        : {
            ...current,
            [person.email]: {
              email: person.email,
              displayName: person.displayName,
              role: '',
              organization: person.organization ?? '',
              waiting: false,
              note: ''
            }
          }
    )
  }

  const patchRow = (key: string, patch: Partial<DraftRow>): void =>
    setRows((current) => ({ ...current, [key]: { ...current[key], ...patch } }))

  const save = useMatterMutation({
    matterId: matter.public_id,
    mutationFn: async () => {
      // 🔴 串行 + 逐条推进版本：`createStakeholder` 带 CAS，一批并发必然自撞乐观锁。
      let version = matter.version
      for (const key of picked) {
        const row = rows[key]
        if (!row) continue
        const input: MatterStakeholderCreateInput = {
          display_name: row.displayName || null,
          email: row.email || null,
          role: row.role.trim() || null,
          organization: row.organization.trim() || null,
          is_waiting_on: row.waiting,
          // 备注复用既有的 `relationship` 列（干系人表本来就有它，语义是「和这件事的关系」）。
          relationship: row.note.trim() || null
        }
        const result = editing
          ? await api.patchStakeholder(matter.public_id, editing.id, input, {
              expectedVersion: version
            })
          : await api.createStakeholder(matter.public_id, input, { expectedVersion: version })
        version = result.matter?.version ?? version + 1
      }
      return { version }
    },
    // G-33 —— 设计 §2.23「已添加 N 位干系人 · 姓名与职位随联系人库同步」。编辑既有干系人走
    // 同一条 mutation，那种情况说「已更新」而不是「已添加 1 位」。
    // 🔴 不带撤销：这里是 N 次串行写入（同 `MatterLinkResourceModal` 的理由），且服务端只为
    // 最后一条产出 descriptor。
    onSuccess: () => {
      toastSuccess(
        editing
          ? t('matters.stakeholderPicker.updated')
          : t('matters.stakeholderPicker.added', { count: picked.length })
      )
      onOpenChange(false)
      onChanged()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const canSave =
    picked.length > 0 && picked.every((key) => rows[key]?.email || rows[key]?.displayName)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[84vh] w-[640px] max-w-[calc(100vw-2rem)] grid-rows-[auto_1fr_auto]">
        <DialogHeader>
          <DialogTitle>
            {t(
              editing
                ? 'matters.context.editStakeholder'
                : step === 0
                  ? 'matters.stakeholderPicker.stepPick'
                  : 'matters.stakeholderPicker.stepRole'
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              step === 0
                ? 'matters.stakeholderPicker.pickDescription'
                : 'matters.stakeholderPicker.roleDescription'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-3 overflow-y-auto pr-1 scrollbar-thin">
          {step === 0 ? (
            <>
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('matters.stakeholderPicker.searchPlaceholder')}
                aria-label={t('matters.stakeholderPicker.searchPlaceholder')}
              />

              {visibleFromMatter.length > 0 ? (
                <PoolGroup
                  label={t('matters.stakeholderPicker.fromMatter')}
                  count={visibleFromMatter.length}
                >
                  {visibleFromMatter.map((person) => (
                    <PoolRow
                      key={person.email}
                      person={person}
                      picked={picked.includes(person.email)}
                      onToggle={() => toggle(person)}
                    />
                  ))}
                </PoolGroup>
              ) : null}

              {visibleLibrary.length > 0 ? (
                <PoolGroup
                  label={t('matters.stakeholderPicker.library')}
                  count={visibleLibrary.length}
                  hint={t('matters.stakeholderPicker.libraryHint')}
                >
                  {visibleLibrary.map((person) => (
                    <PoolRow
                      key={person.email}
                      person={person}
                      picked={picked.includes(person.email)}
                      onToggle={() => toggle(person)}
                    />
                  ))}
                </PoolGroup>
              ) : null}

              {/* W-C —— 一键从邮件往来提取（确定性扫描，服务端聚合，不走 LLM）。 */}
              <section>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-fg-3">
                    {t('matters.stakeholderPicker.extractTitle')}
                  </span>
                  {extractRequested && visibleExtracted.length > 0 ? (
                    <span className="font-mono text-meta text-ink-fg-3">
                      {visibleExtracted.length}
                    </span>
                  ) : null}
                </div>
                {!extractRequested ? (
                  <button
                    type="button"
                    onClick={() => setExtractRequested(true)}
                    className="flex w-full items-center gap-2.5 rounded-[var(--r-card)] border border-dashed border-ink-border bg-ink-2/50 px-3 py-2.5 text-left transition-colors duration-fast ease-standard hover:bg-ink-3/60"
                  >
                    <ScanSearch size={15} className="shrink-0 text-ink-fg-3" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-aux text-ink-fg">
                        {t('matters.stakeholderPicker.extractAction')}
                      </span>
                      <span className="block text-meta text-ink-fg-3">
                        {t('matters.stakeholderPicker.extractHint')}
                      </span>
                    </span>
                    <ChevronRight size={13} className="shrink-0 text-ink-fg-3" />
                  </button>
                ) : extractQuery.isPending ? (
                  <div className="flex items-center gap-2 rounded-[var(--r-card)] border border-ink-border bg-ink-2/50 px-3 py-2.5 text-meta text-ink-fg-3">
                    <Loader2 size={13} className="animate-spin" />
                    {t('matters.stakeholderPicker.extractLoading')}
                  </div>
                ) : visibleExtracted.length > 0 ? (
                  <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border">
                    {visibleExtracted.map((person) => (
                      <PoolRow
                        key={person.email}
                        person={person}
                        picked={picked.includes(person.email)}
                        onToggle={() => toggle(person)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="rounded-[var(--r-card)] border border-ink-border bg-ink-2/50 px-3 py-2.5 text-meta text-ink-fg-3">
                    {t('matters.stakeholderPicker.extractEmpty')}
                  </p>
                )}
              </section>

              {!anyVisible && !manualEmail ? (
                <EmptyState
                  icon={<Users size={22} />}
                  title={t('matters.stakeholderPicker.emptyTitle')}
                  hint={t('matters.stakeholderPicker.emptyHint')}
                />
              ) : null}

              {manualIsNew && manualEmail ? (
                <div className="rounded-[var(--r-card)] border border-dashed border-ink-border bg-ink-2/50 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      toggle({ email: manualEmail, displayName: null })
                      setSearch('')
                    }}
                    className="flex w-full items-center gap-2.5 text-left"
                  >
                    <UserPlus size={14} className="shrink-0 text-ink-fg-3" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-aux text-ink-fg">
                        {t('matters.stakeholderPicker.manualAdd')}
                      </span>
                      <span className="block truncate font-mono text-meta text-ink-fg-3">
                        {manualEmail}
                      </span>
                    </span>
                  </button>
                  {/* v52 起为真：保存即 upsert 进全局库（服务端隐式维护）。 */}
                  <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">
                    {t('matters.stakeholderPicker.manualAddHint')}
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <div className="space-y-3">
              {picked.map((key) => {
                const row = rows[key]
                if (!row) return null
                return (
                  <div
                    key={key}
                    className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-3"
                  >
                    <div className="flex items-center gap-2.5">
                      <RecipientAvatar
                        name={row.displayName ?? ''}
                        email={row.email}
                        size={30}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-medium text-ink-fg">
                          {row.displayName || row.email}
                        </span>
                        {row.displayName ? (
                          <span className="block truncate font-mono text-meta text-ink-fg-3">
                            {row.email}
                          </span>
                        ) : null}
                      </span>
                      {!editing ? (
                        <button
                          type="button"
                          title={t('matters.stakeholderPicker.removeFromPicked')}
                          aria-label={t('matters.stakeholderPicker.removeFromPicked')}
                          onClick={() =>
                            setPicked((current) => current.filter((value) => value !== key))
                          }
                          className="shrink-0 rounded-[var(--r-ctl)] p-1.5 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg"
                        >
                          <X size={13} />
                        </button>
                      ) : null}
                    </div>

                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {MATTER_STAKEHOLDER_ROLE_PRESETS.map((preset) => {
                        const label = t(`matters.stakeholderPicker.roles.${preset}`)
                        const on = row.role === label
                        return (
                          <button
                            key={preset}
                            type="button"
                            aria-pressed={on}
                            onClick={() => patchRow(key, { role: on ? '' : label })}
                            className={cn(
                              'rounded-full border px-2.5 py-1 text-meta',
                              'transition-colors duration-fast ease-standard',
                              on
                                ? 'border-coral/40 bg-coral/[0.14] text-coral'
                                : 'border-ink-border bg-ink-1 text-ink-fg-2 hover:bg-ink-3'
                            )}
                          >
                            {label}
                          </button>
                        )
                      })}
                    </div>

                    <div className="mt-2.5 flex items-center gap-2.5">
                      <Input
                        value={row.role}
                        onChange={(event) => patchRow(key, { role: event.target.value })}
                        placeholder={t('matters.stakeholderPicker.rolePlaceholder')}
                        aria-label={t('matters.context.fields.role')}
                        className="min-w-0 flex-1"
                      />
                      <label className="flex shrink-0 cursor-pointer items-center gap-2 text-aux text-ink-fg-2">
                        <Checkbox
                          checked={row.waiting}
                          onCheckedChange={(value) => patchRow(key, { waiting: value })}
                        />
                        {t('matters.stakeholderPicker.waiting')}
                      </label>
                    </div>

                    <Input
                      value={row.organization}
                      onChange={(event) => patchRow(key, { organization: event.target.value })}
                      placeholder={t('matters.stakeholderPicker.organizationPlaceholder')}
                      aria-label={t('matters.context.fields.organization')}
                      className="mt-2"
                    />

                    <Input
                      value={row.note}
                      onChange={(event) => patchRow(key, { note: event.target.value })}
                      placeholder={t('matters.stakeholderPicker.notePlaceholder')}
                      aria-label={t('matters.stakeholderPicker.noteLabel')}
                      className="mt-2"
                    />
                  </div>
                )
              })}
              <p className="text-meta leading-5 text-ink-fg-3">
                {t('matters.stakeholderPicker.waitingHint')}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="items-center justify-start gap-2">
          {step === 1 && !editing ? (
            <button
              type="button"
              onClick={() => setStep(0)}
              className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-3 py-2 text-aux text-ink-fg-2 hover:bg-ink-3"
            >
              <ChevronLeft size={13} />
              {t('matters.stakeholderPicker.back')}
            </button>
          ) : null}
          <span className="ml-auto inline-flex items-center gap-2 text-aux text-ink-fg-3">
            {/* 设计 §2.21 底栏的 AvatarStack —— 复用 `.avatar` 调色板（同一人同色）。 */}
            {picked.length > 0 ? (
              <span className="inline-flex items-center">
                {picked.slice(0, 5).map((key, index) => (
                  <span
                    key={key}
                    className={cn('flex rounded-full ring-[1.5px] ring-ink-1', index > 0 && '-ml-1.5')}
                  >
                    <RecipientAvatar
                      name={rows[key]?.displayName ?? ''}
                      email={rows[key]?.email ?? key}
                      size={20}
                    />
                  </span>
                ))}
              </span>
            ) : null}
            {t('matters.stakeholderPicker.selected', { count: picked.length })}
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-[var(--r-ctl)] px-3 py-2 text-aux hover:bg-ink-3"
          >
            {t('common.cancel')}
          </button>
          {step === 0 ? (
            <button
              type="button"
              disabled={picked.length === 0}
              onClick={() => setStep(1)}
              className="rounded-[var(--r-ctl)] bg-coral/100 px-4 py-2 text-aux font-medium text-accent-fg disabled:opacity-50"
            >
              {t('matters.stakeholderPicker.next')}
            </button>
          ) : (
            <button
              type="button"
              disabled={!canSave || save.isPending}
              onClick={() => save.mutate()}
              className="rounded-[var(--r-ctl)] bg-coral/100 px-4 py-2 text-aux font-medium text-accent-fg disabled:opacity-50"
            >
              {t(editing ? 'common.save' : 'matters.stakeholderPicker.confirmAdd', {
                count: picked.length
              })}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 设计 `pickers.jsx::PkGroup`：小写间距 label + 计数 + 可选说明。 */
function PoolGroup({
  label,
  count,
  hint,
  children
}: {
  label: string
  count: number
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-fg-3">
          {label}
        </span>
        <span className="font-mono text-meta text-ink-fg-3">{count}</span>
        {hint ? <span className="text-meta text-ink-fg-3">{hint}</span> : null}
      </div>
      <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border">
        {children}
      </div>
    </section>
  )
}

/** 设计 `pickers.jsx::PkRow` + personLine：Check + 28px 头像 + 姓名/组织 + mono 邮箱 +
 *  右侧往来密度。选中 = accent/0.07 底 + inset 2px accent 左条（token 走 --c-accent）。 */
function PoolRow({
  person,
  picked,
  onToggle
}: {
  person: MatterStakeholderPoolPerson
  picked: boolean
  onToggle(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const meta =
    person.source === 'email_scan'
      ? t('matters.stakeholderPicker.mailCountMeta', { count: person.mailCount ?? 0 })
      : person.matterCount
        ? t('matters.stakeholderPicker.matterCountMeta', { count: person.matterCount })
        : null
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2.5 border-t border-ink-border px-3 py-2 first:border-t-0',
        'transition-colors duration-fast ease-standard',
        picked
          ? 'bg-coral/[0.07] shadow-[inset_2px_0_0_0_rgb(var(--c-accent))]'
          : 'hover:bg-ink-3/60'
      )}
    >
      <Checkbox checked={picked} onCheckedChange={onToggle} />
      <RecipientAvatar name={person.displayName ?? ''} email={person.email} size={28} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-body font-medium text-ink-fg">
            {person.displayName || person.email}
          </span>
          {person.organization ? (
            <span className="truncate text-meta text-ink-fg-2">{person.organization}</span>
          ) : null}
        </span>
        {person.displayName ? (
          <span className="block truncate font-mono text-meta text-ink-fg-3">{person.email}</span>
        ) : null}
      </span>
      {meta || person.lastSeenAt ? (
        <span className="shrink-0 text-right">
          {meta ? <span className="block text-meta text-ink-fg-2">{meta}</span> : null}
          {person.lastSeenAt ? (
            <span className="block text-meta text-ink-fg-3">
              {formatRelativeTime(new Date(person.lastSeenAt).toISOString())}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  )
}
