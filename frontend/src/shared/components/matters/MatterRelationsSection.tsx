// G-15 —— ContextTab 第 4 段「关联事项」。
//
// 这是一处**能力落空点**而不是新功能：后端 `matter_relation` 表 + 5 个端点 + chat 工具
// `matter_relation_mutate` 早就齐了，Agent 和用户都能写，但前端一个渲染面都没有 —— 写进去
// 的关系没人看得见。这里把它接上：展示 + 添加 + 解除 + 点进对端事项。
//
// 🔴 关系类型词表以后端为单源（`src/matters/models.py::MatterRelationType`），TS 侧是
// `MATTER_RELATION_TYPES`（`api/types/matter.ts`），两侧由
// `tests/matters/test_matters_contract_parity.py` 钉死 —— 这里只消费，不新造第三份。
// 🔴 备注落在 `provenance.note`：`matter_relation` 没有 note 列，加列要 bump DB_VERSION，
// 本批不动 schema。代价是备注只能在创建时写、之后不可编辑（`patch_relation` 不收 provenance）。

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronRight, GitBranch, Plus, Search, X } from 'lucide-react'

import { MATTER_RELATION_TYPES } from '@shared/api/types/matter'
import type { Matter, MatterRelation, MatterRelationType } from '@shared/api/types/matter'
import { EmptyState } from '@shared/components/feedback/EmptyState'
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
import { useMatterNavigation } from './navigation'

const RELATION_NOTE_MAX = 200

/** 关系类型的语气色 —— 与设计 §2.9 的 REL_TYPE Pip 对应，只用 v3 token。 */
const RELATION_TONE: Record<MatterRelationType, string> = {
  related_to: 'bg-ink-4 text-ink-fg-2',
  depends_on: 'bg-warn/10 text-warn',
  blocks: 'bg-fail/10 text-fail',
  follow_up_of: 'bg-ai/10 text-ai',
  supersedes: 'bg-ok/10 text-ok'
}

function relationNote(relation: MatterRelation): string | null {
  const note = relation.provenance?.note
  return typeof note === 'string' && note.trim() ? note.trim() : null
}

interface MatterRelationsSectionProps {
  matter: Matter
  onChanged(): void
}

export function MatterRelationsSection({
  matter,
  onChanged
}: MatterRelationsSectionProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()
  const openMatter = useMatterNavigation((state) => state.open)
  const [adding, setAdding] = useState(false)

  const relations = useQuery({
    queryKey: qk.matters.relations(matter.public_id),
    queryFn: () => api.listRelations(matter.public_id),
    staleTime: 15_000
  })

  const remove = useMatterMutation({
    matterId: matter.public_id,
    mutationFn: (relation: MatterRelation) =>
      api.deleteRelation(matter.public_id, relation.id, {
        expectedVersion: matter.version,
        reason: 'user_removed_matter_relation'
      }),
    onSuccess: () => {
      toastSuccess(t('matters.relations.removed'))
      onChanged()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const rows = relations.data ?? []

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-body font-semibold text-ink-fg">
          {t('matters.relations.title')}
          <span className="ml-1 font-mono text-meta text-ink-fg-3">· {rows.length}</span>
        </h2>
        <span className="text-meta text-ink-fg-3">{t('matters.relations.hint')}</span>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-aux hover:bg-ink-3"
          >
            <Plus size={13} />
            {t('matters.relations.add')}
          </button>
        </div>
      </div>

      {rows.length > 0 ? (
        <div className="space-y-2">
          {rows.map((relation) => {
            // 关系是有向的，本事项可能在任一端 —— 卡上永远显示**对端**。
            const outgoing = relation.source_public_id === matter.public_id
            const peerId = outgoing ? relation.target_public_id : relation.source_public_id
            const peerTitle = outgoing ? relation.target_title : relation.source_title
            const type = (relation.relation_type ?? 'related_to') as MatterRelationType
            const note = relationNote(relation)
            return (
              <article
                key={relation.id}
                className="group flex items-start gap-2.5 rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-3"
              >
                <span
                  className={cn(
                    'shrink-0 rounded-[var(--r-pill)] px-2 py-1 text-meta',
                    RELATION_TONE[type]
                  )}
                >
                  {t(
                    outgoing
                      ? `matters.relations.types.${type}`
                      : `matters.relations.inbound.${type}`
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => openMatter(peerId)}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-body text-ink-fg">{peerTitle}</span>
                      <span className="shrink-0 font-mono text-meta text-ink-fg-3">{peerId}</span>
                    </span>
                    {note ? (
                      <span className="mt-1 block text-meta leading-5 text-ink-fg-2">{note}</span>
                    ) : null}
                  </span>
                  <ChevronRight size={14} className="mt-0.5 shrink-0 text-ink-fg-3" />
                </button>
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(relation)}
                  title={t('matters.relations.remove')}
                  aria-label={t('matters.relations.remove')}
                  className="shrink-0 rounded-[var(--r-ctl)] p-1.5 text-ink-fg-3 opacity-0 transition-opacity duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X size={13} />
                </button>
              </article>
            )
          })}
        </div>
      ) : (
        <EmptyState
          icon={<GitBranch size={22} />}
          title={t('matters.relations.emptyTitle')}
          hint={t('matters.relations.emptyHint')}
        />
      )}

      <MatterRelationAddDialog
        matter={matter}
        open={adding}
        existing={rows}
        onOpenChange={setAdding}
        onChanged={onChanged}
      />
    </section>
  )
}

function MatterRelationAddDialog({
  matter,
  open,
  existing,
  onOpenChange,
  onChanged
}: {
  matter: Matter
  open: boolean
  existing: readonly MatterRelation[]
  onOpenChange(open: boolean): void
  onChanged(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()
  const [search, setSearch] = useState('')
  const [target, setTarget] = useState<{ publicId: string; title: string } | null>(null)
  const [type, setType] = useState<MatterRelationType>('related_to')
  const [note, setNote] = useState('')

  const normalised = search.trim()
  // 🔴 独立 key，**不能**用 `qk.matters.list(q)`：空搜索时那是工作台主列表的同一个 key
  // （`MattersWorkspace` 用 limit 100），而这里只取 12 条 —— 共享缓存会让主列表当场缩水成
  // 12 条。同 `resourcePickerMail` 的先例。
  const candidates = useQuery({
    queryKey: qk.matters.relationPicker(normalised),
    queryFn: () => api.list({ q: normalised || undefined, limit: normalised ? 20 : 12 }),
    enabled: open,
    staleTime: 15_000
  })

  const taken = useMemo(() => {
    const keys = new Set<string>([matter.public_id])
    for (const relation of existing) {
      keys.add(relation.source_public_id)
      keys.add(relation.target_public_id)
    }
    return keys
  }, [existing, matter.public_id])

  const rows = (candidates.data?.items ?? []).filter((item) => !taken.has(item.public_id))

  const create = useMatterMutation({
    matterId: matter.public_id,
    mutationFn: () => {
      if (!target) return Promise.reject(new Error('relation target is not selected'))
      const trimmed = note.trim().slice(0, RELATION_NOTE_MAX)
      return api.createRelation(
        matter.public_id,
        {
          target_public_id: target.publicId,
          relation_type: type,
          // 备注没有专属列 —— 落在 provenance 上，键名与 `MatterRelationsSection` 的读侧对齐。
          ...(trimmed ? { provenance: { note: trimmed, created_via: 'context_tab' } } : {}),
          confirmed: true
        },
        { expectedVersion: matter.version, reason: 'user_added_matter_relation' }
      )
    },
    onSuccess: () => {
      toastSuccess(t('matters.relations.added'))
      onOpenChange(false)
      onChanged()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  // 每次打开都回到干净状态。
  const [openFor, setOpenFor] = useState(open)
  if (openFor !== open) {
    setOpenFor(open)
    if (open) {
      setSearch('')
      setTarget(null)
      setType('related_to')
      setNote('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-lg grid-rows-[auto_1fr_auto]">
        <DialogHeader>
          <DialogTitle>{t('matters.relations.addTitle')}</DialogTitle>
          <DialogDescription>{t('matters.relations.addDescription')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-3 overflow-y-auto pr-1 scrollbar-thin">
          <label className="flex items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-1.5">
            <Search size={13} className="shrink-0 text-ink-fg-3" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('matters.relations.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-aux outline-none placeholder:text-ink-fg-3"
            />
          </label>

          <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border">
            {rows.length > 0 ? (
              rows.map((item) => {
                const on = target?.publicId === item.public_id
                return (
                  <button
                    key={item.public_id}
                    type="button"
                    onClick={() => setTarget({ publicId: item.public_id, title: item.title })}
                    className={cn(
                      'flex w-full items-center gap-2 border-t border-ink-border px-3 py-2 text-left first:border-t-0',
                      'transition-colors duration-fast ease-standard',
                      on ? 'bg-coral/[0.07]' : 'hover:bg-ink-3/60'
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-aux text-ink-fg">
                      {item.title}
                    </span>
                    <span className="shrink-0 font-mono text-meta text-ink-fg-3">
                      {item.public_id}
                    </span>
                  </button>
                )
              })
            ) : (
              <p className="px-3 py-6 text-center text-meta text-ink-fg-3">
                {t('matters.relations.noCandidates')}
              </p>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-aux text-ink-fg-1">{t('matters.relations.typeLabel')}</p>
            <div className="flex flex-wrap gap-1.5">
              {MATTER_RELATION_TYPES.map((entry) => {
                const on = type === entry
                return (
                  <button
                    key={entry}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setType(entry)}
                    className={cn(
                      'rounded-[var(--r-pill)] border px-2.5 py-1 text-meta',
                      'transition-colors duration-fast ease-standard',
                      on
                        ? 'border-coral/40 bg-coral/[0.14] text-coral'
                        : 'border-ink-border bg-ink-2 text-ink-fg-2 hover:bg-ink-3'
                    )}
                  >
                    {t(`matters.relations.types.${entry}`)}
                  </button>
                )
              })}
            </div>
          </div>

          <label className="grid gap-1.5 text-aux text-ink-fg-1">
            <span>{t('matters.relations.noteLabel')}</span>
            <Input
              value={note}
              maxLength={RELATION_NOTE_MAX}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t('matters.relations.notePlaceholder')}
            />
          </label>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-[var(--r-ctl)] px-3 py-2 text-aux hover:bg-ink-3"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={!target || create.isPending}
            onClick={() => create.mutate()}
            className="rounded-[var(--r-ctl)] bg-coral/100 px-4 py-2 text-aux font-medium text-accent-fg disabled:opacity-50"
          >
            {t('matters.relations.confirmAdd')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
