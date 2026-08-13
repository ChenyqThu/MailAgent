// G-16 —— 干系人两步 Picker 的**可行子集**（设计 §2.21 的 640px 两步弹窗）。
//
// 设计原型里第一步有三组候选：「本事项往来里出现过」/「联系人库」/「按邮箱新建」。中间那组
// 连同「组织通讯录 + 同步状态」是 mock（裁决 #21：不建 person 表），所以**不做** —— 摆一个
// 永远空的「联系人库」分组比没有更糟。可行子集 = ① 从本事项已关联邮件资源的收发件人推导出
// 候选列（勾选批量加）② 角色预设药丸 + 「正在等他」+ 备注 ③ 保留「按邮箱新建」手输入口。
//
// 🔴 候选推导**不打任何新请求**：`MatterResourceListItem.resource.metadata` 里已经有邮件的
// 发件人/收件人（`_resolve_source_resource` / 候选引擎写进去的），ContextTab 本来就持有这份
// 资料列表，扇出去逐封查邮件才是列表性能铁律禁止的那种写法。
// 代价（有意接受）：metadata 里没有地址的老资料行推不出人来，此时列为空，用手输入口兜底。

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, Mail, UserPlus, Users } from 'lucide-react'

import type {
  Matter,
  MatterResourceListItem,
  MatterStakeholder,
  MatterStakeholderCreateInput
} from '@shared/api/types/matter'
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
import { toastError, toastSuccess } from '@shared/state/toast'

import { useMattersApi } from './hooks'
import { useMatterMutation } from './matterMutation'
import {
  MATTER_STAKEHOLDER_EMAIL_RE,
  MATTER_STAKEHOLDER_ROLE_PRESETS,
  deriveStakeholderCandidates
} from './matterStakeholderCandidates'
import type { MatterStakeholderCandidate } from './matterStakeholderCandidates'

interface DraftRow {
  email: string
  displayName: string | null
  role: string
  /** 保留旧 `StakeholderModal` 的组织字段 —— 设计原型把它交给（mock 的）联系人库自动带出，
   *  本仓没有那张表，去掉输入口就等于**丢掉一项既有能力**（卡片上还在显示它）。 */
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
  const candidates = useMemo(
    () => deriveStakeholderCandidates(resources, stakeholders),
    [resources, stakeholders]
  )

  const [step, setStep] = useState<0 | 1>(0)
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, DraftRow>>({})

  // 打开 / 切换编辑对象时重置。编辑态直接落在第二步。
  const identity = `${open ? 'open' : 'closed'}:${editing?.id ?? 'new'}`
  const [identityFor, setIdentityFor] = useState(identity)
  if (identityFor !== identity) {
    setIdentityFor(identity)
    if (open) {
      setSearch('')
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

  const normalised = search.trim().toLowerCase()
  const visible = candidates.filter(
    (person) =>
      !normalised ||
      person.email.includes(normalised) ||
      (person.displayName ?? '').toLowerCase().includes(normalised)
  )
  const manualEmail = MATTER_STAKEHOLDER_EMAIL_RE.test(search.trim())
    ? search.trim().toLowerCase()
    : null
  const manualIsNew = manualEmail !== null && !candidates.some((p) => p.email === manualEmail)

  const toggle = (person: MatterStakeholderCandidate): void => {
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
              organization: '',
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
              {visible.length > 0 ? (
                <section>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-fg-3">
                      {t('matters.stakeholderPicker.fromMatter')}
                    </span>
                    <span className="font-mono text-meta text-ink-fg-3">{visible.length}</span>
                  </div>
                  <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border">
                    {visible.map((person) => (
                      <label
                        key={person.email}
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 border-t border-ink-border px-3 py-2 first:border-t-0',
                          'transition-colors duration-fast ease-standard',
                          picked.includes(person.email) ? 'bg-coral/[0.07]' : 'hover:bg-ink-3/60'
                        )}
                      >
                        <Checkbox
                          checked={picked.includes(person.email)}
                          onCheckedChange={() => toggle(person)}
                        />
                        <Mail size={13} className="shrink-0 text-ink-fg-3" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body text-ink-fg">
                            {person.displayName || person.email}
                          </span>
                          {person.displayName ? (
                            <span className="block truncate font-mono text-meta text-ink-fg-3">
                              {person.email}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
              ) : (
                <EmptyState
                  icon={<Users size={22} />}
                  title={t('matters.stakeholderPicker.emptyTitle')}
                  hint={t('matters.stakeholderPicker.emptyHint')}
                />
              )}

              {manualIsNew && manualEmail ? (
                <button
                  type="button"
                  onClick={() => {
                    toggle({ email: manualEmail, displayName: null })
                    setSearch('')
                  }}
                  className="flex w-full items-center gap-2.5 rounded-[var(--r-card)] border border-dashed border-ink-border bg-ink-2/50 px-3 py-2.5 text-left hover:bg-ink-3/60"
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
                    <div className="flex items-center gap-2">
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-ink-4 text-aux font-semibold text-ink-fg">
                        {(row.displayName || row.email || '?').slice(0, 1).toUpperCase()}
                      </span>
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
                              'rounded-[var(--r-pill)] border px-2.5 py-1 text-meta',
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
          <span className="ml-auto text-aux text-ink-fg-3">
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
