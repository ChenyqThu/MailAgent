// 干系人 picker（通讯录 WP3 · 设计 S3 单页改版，task 08-13）。
//
// 单页（无步骤切换）：搜索框（可粘贴邮箱）→ 通讯录池列表（PersonPicker，按往来
// 密度排序、任一锚点邮箱可搜；hidden / 自己的地址 / 墓碑恒不出现）→ 已在事项中
// 的行置灰打勾禁选 → 输入库外邮箱时首行虚线「以这个邮箱新建联系人并添加」→
// 底部角色 chips（作用于本次要添加的所有人）+「添加 {n}」。次要开关「也显示
// 邮件组 / 机器人」只做客户端 kind 过滤。原三池组装（本事项推导 / 联系人库 /
// 「从邮件提取」tab）已退役，数据来源用一行说明交代（contacts.picker.source）。
//
// `editing` 模式（编辑既有干系人的角色）收敛成 dialog 内的精简编辑态：角色
// chips + 自由文本 + 等待/备注（等价功能保留）；姓名与组织不再在这里编辑 ——
// 始终读通讯录，不在事项里另存一份（contacts.picker.syncHint）。
//
// 🔴 写面不动：`createStakeholder` 继续吃 email（选中联系人 = 传其主邮箱；库外
// 邮箱 = 直接传输入值，后端 `_upsert_contact` 写穿兜底），串行 + 逐条推进
// expectedVersion 的 CAS 链一字不变。

import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { UserPlus, Users } from 'lucide-react'

import type {
  Matter,
  MatterStakeholder,
  MatterStakeholderCreateInput
} from '@shared/api/types/matter'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { PersonPicker } from '@shared/components/contacts/PersonPicker'
import { useContactList } from '@shared/components/contacts/hooks'
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
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { useMattersApi } from './hooks'
import { useMatterMutation } from './matterMutation'
import {
  MATTER_STAKEHOLDER_ROLE_PRESETS,
  PICKER_POOL_CAP,
  buildStakeholderTakenIndex,
  filterPickerRows,
  isPickerRowTaken,
  pickerManualEmail
} from './matterStakeholderCandidates'

const SEARCH_DEBOUNCE_MS = 250

/** 本次要添加的人：来自通讯录（contactId + 主邮箱）或库外邮箱手输（contactId=null）。 */
interface PickedEntry {
  key: string
  contactId: number | null
  email: string | null
  displayName: string | null
}

interface MatterStakeholderPickerProps {
  matter: Matter
  stakeholders: readonly MatterStakeholder[]
  /** 非空 = 编辑既有干系人（精简角色编辑态）。 */
  editing: MatterStakeholder | null
  open: boolean
  onOpenChange(open: boolean): void
  onChanged(): void
}

export function MatterStakeholderPicker({
  matter,
  stakeholders,
  editing,
  open,
  onOpenChange,
  onChanged
}: MatterStakeholderPickerProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()
  const queryClient = useQueryClient()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [picked, setPicked] = useState<PickedEntry[]>([])
  const [role, setRole] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  // 打开 / 切换编辑对象时重置（identity-key 模式）。
  const identity = `${open ? 'open' : 'closed'}:${editing?.id ?? 'new'}`
  const [identityFor, setIdentityFor] = useState(identity)
  if (identityFor !== identity) {
    setIdentityFor(identity)
    if (open) {
      setSearchInput('')
      setSearch('')
      setShowAll(false)
      setPicked([])
      setRole(editing?.role ?? '')
      setWaiting(editing?.is_waiting_on ?? false)
      setNote(editing?.relationship ?? '')
    }
  }

  // 通讯录池：一次批量 + 服务端 q（与通讯录工作台共享缓存 key）。
  const listQuery = useContactList({
    view: 'all',
    q: search,
    sort: 'density',
    enabled: open && !editing
  })
  const takenIndex = useMemo(() => buildStakeholderTakenIndex(stakeholders), [stakeholders])
  const rows = useMemo(
    () =>
      filterPickerRows(listQuery.data?.items ?? [], { onlyPeople: !showAll }).slice(
        0,
        PICKER_POOL_CAP
      ),
    [listQuery.data, showAll]
  )
  const manualEmail = pickerManualEmail(search, rows)
  const manualPicked = manualEmail !== null && picked.some((entry) => entry.key === `e:${manualEmail}`)

  const selectedIds = useMemo(
    () =>
      new Set(
        picked
          .map((entry) => entry.contactId)
          .filter((value): value is number => value !== null)
      ),
    [picked]
  )

  const toggleEntry = (entry: PickedEntry): void =>
    setPicked((current) =>
      current.some((existing) => existing.key === entry.key)
        ? current.filter((existing) => existing.key !== entry.key)
        : [...current, entry]
    )

  const save = useMatterMutation({
    matterId: matter.public_id,
    mutationFn: async () => {
      // 🔴 串行 + 逐条推进版本：`createStakeholder` 带 CAS，一批并发必然自撞乐观锁。
      let version = matter.version
      if (editing) {
        const result = await api.patchStakeholder(
          matter.public_id,
          editing.id,
          {
            role: role.trim() || null,
            is_waiting_on: waiting,
            // 备注复用既有 `relationship` 列（语义是「和这件事的关系」）。
            relationship: note.trim() || null
          },
          { expectedVersion: version }
        )
        version = result.matter?.version ?? version + 1
        return { version }
      }
      for (const entry of picked) {
        const input: MatterStakeholderCreateInput = {
          display_name: entry.displayName || null,
          email: entry.email || null,
          role: role.trim() || null
        }
        const result = await api.createStakeholder(matter.public_id, input, {
          expectedVersion: version
        })
        version = result.matter?.version ?? version + 1
      }
      return { version }
    },
    onSuccess: () => {
      if (editing) {
        toastSuccess(t('matters.stakeholderPicker.updated'))
      } else {
        const manualEntries = picked.filter((entry) => entry.contactId === null)
        if (manualEntries.length > 0 && picked.length === 1) {
          // 单独用库外邮箱建入 → 建档 toast（同时写进通讯录 + 挂到事项）。
          toastSuccess(t('contacts.toast.pickerCreated', { email: manualEntries[0]!.email }))
        } else {
          toastSuccess(t('contacts.toast.pickerAdded', { n: picked.length }))
        }
        // 库外邮箱会经写穿新建联系人 → 通讯录列表随之失效。
        void queryClient.invalidateQueries({ queryKey: qk.contacts.all() })
      }
      onOpenChange(false)
      onChanged()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const canSave = editing ? true : picked.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[84vh] w-[640px] max-w-[calc(100vw-2rem)] grid-rows-[auto_1fr_auto]">
        <DialogHeader>
          <DialogTitle>
            {t(editing ? 'matters.context.editStakeholder' : 'contacts.picker.title')}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? t('contacts.picker.syncHint')
              : t('contacts.picker.sub', { pub: matter.public_id, title: matter.title })}
          </DialogDescription>
        </DialogHeader>

        {/* p-1（非 pr-1）—— 搜索框的 focus-visible ring-2 是 2px box-shadow，此容器
            overflow-y-auto 会裁掉紧贴边缘的 shadow；四边留 4px 呼吸空间防止 ring
            在上/左被裁成不规则形状（dogfood 轮 5 反馈①，量测见 harness）。 */}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-1 scrollbar-thin">
          {editing ? (
            <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-3">
              <div className="min-w-0">
                <div className="truncate text-body font-medium text-ink-fg">
                  {editing.display_name || editing.email_normalized || '—'}
                </div>
                {editing.email_normalized ? (
                  <div className="truncate font-mono text-meta text-ink-fg-3">
                    {editing.email_normalized}
                  </div>
                ) : null}
              </div>
              <RoleChips role={role} onRoleChange={setRole} />
              <div className="mt-2.5 flex items-center gap-2.5">
                <Input
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  placeholder={t('matters.stakeholderPicker.rolePlaceholder')}
                  aria-label={t('matters.context.fields.role')}
                  className="min-w-0 flex-1"
                />
                <label className="flex shrink-0 cursor-pointer items-center gap-2 text-aux text-ink-fg-2">
                  <Checkbox checked={waiting} onCheckedChange={(value) => setWaiting(value)} />
                  {t('matters.stakeholderPicker.waiting')}
                </label>
              </div>
              <Input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={t('matters.stakeholderPicker.notePlaceholder')}
                aria-label={t('matters.stakeholderPicker.noteLabel')}
                className="mt-2"
              />
              <p className="mt-2 text-meta leading-5 text-ink-fg-3">
                {t('matters.stakeholderPicker.waitingHint')}
              </p>
            </div>
          ) : (
            <>
              <PersonPicker
                items={rows}
                loading={listQuery.isPending}
                search={searchInput}
                onSearchChange={setSearchInput}
                searchPlaceholder={t('contacts.picker.searchPlaceholder')}
                mode="multi"
                selectedIds={selectedIds}
                onToggle={(row) =>
                  toggleEntry({
                    key: `c:${row.id}`,
                    contactId: row.id,
                    email: row.primary_email,
                    displayName: row.display_name
                  })
                }
                takenIds={
                  new Set(rows.filter((row) => isPickerRowTaken(row, takenIndex)).map((r) => r.id))
                }
                takenLabel={t('contacts.picker.taken')}
                aboveList={
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-3">
                      {t('contacts.picker.source')}
                    </span>
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-meta text-ink-fg-2">
                      <Checkbox checked={showAll} onCheckedChange={(value) => setShowAll(value)} />
                      {t('contacts.picker.showAll')}
                    </label>
                  </div>
                }
                belowList={
                  <>
                    {manualEmail ? (
                      <button
                        type="button"
                        aria-pressed={manualPicked}
                        onClick={() =>
                          toggleEntry({
                            key: `e:${manualEmail}`,
                            contactId: null,
                            email: manualEmail,
                            displayName: null
                          })
                        }
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-[var(--r-card)] border border-dashed px-3 py-2.5 text-left',
                          'transition-colors duration-fast ease-standard',
                          manualPicked
                            ? 'border-coral/50 bg-coral/[0.07]'
                            : 'border-ink-border bg-ink-2/50 hover:bg-ink-3/60'
                        )}
                      >
                        <UserPlus size={14} className="shrink-0 text-ink-fg-3" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-aux text-ink-fg">
                            {t('contacts.picker.createByEmail')}
                          </span>
                          <span className="block truncate font-mono text-meta text-ink-fg-3">
                            {manualEmail}
                          </span>
                        </span>
                      </button>
                    ) : null}
                    <p className="text-meta leading-5 text-ink-fg-3">
                      {t('contacts.picker.syncHint')}
                    </p>
                  </>
                }
                empty={
                  manualEmail ? null : (
                    <EmptyState
                      icon={<Users size={22} />}
                      title={t('contacts.picker.empty')}
                      hint={t('contacts.picker.emptyHint')}
                    />
                  )
                }
              />
              <div>
                <div className="mb-1.5 text-meta text-ink-fg-2">{t('contacts.picker.role')}</div>
                <RoleChips role={role} onRoleChange={setRole} />
              </div>
            </>
          )}
        </div>

        <DialogFooter className="items-center gap-2">
          {!editing && picked.length > 0 ? (
            <span className="mr-auto text-aux text-ink-fg-3">
              {t('matters.stakeholderPicker.selected', { count: picked.length })}
            </span>
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
          <button
            type="button"
            disabled={!canSave || save.isPending}
            onClick={() => save.mutate()}
            className="rounded-[var(--r-ctl)] bg-coral/100 px-4 py-2 text-aux font-medium text-accent-fg disabled:opacity-50"
          >
            {editing ? t('common.save') : t('contacts.picker.add', { n: picked.length })}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 角色预设 chips（6 档；作用于本次要添加的所有人；落库存译文，`role` 是自由文本列）。 */
function RoleChips({
  role,
  onRoleChange
}: {
  role: string
  onRoleChange(next: string): void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {MATTER_STAKEHOLDER_ROLE_PRESETS.map((preset) => {
        const label = t(`matters.stakeholderPicker.roles.${preset}`)
        const on = role === label
        return (
          <button
            key={preset}
            type="button"
            aria-pressed={on}
            onClick={() => onRoleChange(on ? '' : label)}
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
  )
}
