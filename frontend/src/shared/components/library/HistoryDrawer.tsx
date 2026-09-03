// 历史抽屉（design §4；mockup C9）：版本列表 + 单条快照查看 + 回滚（二次确认 / 409 态）。
//
// 三条服务端语义，UI 措辞与分支全靠它们，别按直觉改：
//   · 列表是**新 → 旧**，且**不带快照正文**（只有 `snapshot_bytes`）—— 展开某一行才去
//     `GET /library/file/{id}/history/{history_id}` 单独取那一条。
//   · 快照存的是**那次写入之后**的正文，不是之前 ⇒ 「回滚到这一版」= 把这份正文原样写回，
//     文案不能写成「恢复到这次修改之前」。
//   · 回滚**走的是一次普通写**（同一道 `expected_hash` CAS）⇒ 它**也会撞 409**：打开历史之后
//     文件在应用之外被改了。撞了不是失败到此为止 —— 服务端下一次会用新 hash 重算，所以给
//     「重试」而不是只弹一句 toast。
//
// `changed_by` 三档（`'user'` / agent id / `'external'`）各有措辞；`external` 那档**天生没有**
// change_note（它是打开时对账补记的外部改动，mockup F8：这是用户唯一一次被告知我们做了
// 尽力而为的对账），占位文案必须把这件事说出来。

import { useCallback, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock3, Info, RotateCcw, X } from 'lucide-react'

import type { LibraryFile, LibraryHistoryEntry } from '@shared/api/types/library'
import { isLibraryVersionConflict } from '@shared/api/library'
import { Button } from '@shared/components/ui/button'
import { Drawer } from '@shared/components/ui/drawer'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { formatFileSize } from '@shared/format'
import { HISTORY_MAX_PER_FILE, HISTORY_MAX_TOTAL_BYTES } from '@shared/libraryConstants'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'

import { formatShortTime } from './fileMeta'
import {
  useInvalidateLibrary,
  useLibraryApi,
  useLibraryHistoryQuery,
  useLibraryHistorySnapshotQuery
} from './hooks'
import { Notice, Pill } from './parts'

interface Props {
  open: boolean
  onOpenChange(open: boolean): void
  file: LibraryFile
}

/** 展开的快照正文。单独一个组件 = query 只在真的展开时挂载（列表 50 行不预取 50 份正文）。 */
function SnapshotBody({
  fileId,
  historyId
}: {
  fileId: number
  historyId: number
}): ReactElement {
  const { t } = useTranslation()
  const snapshot = useLibraryHistorySnapshotQuery(fileId, historyId)
  if (snapshot.isPending) return <Skeleton rows={3} className="mt-2" width="2/3" />
  if (snapshot.isError) {
    return (
      <div className="mt-2">
        <Notice tone="fail">
          {t('library.history.snapshotFailed')}
          <span className="ml-1.5 text-ink-fg-3">{errorMessage(snapshot.error)}</span>
        </Notice>
      </div>
    )
  }
  const text = snapshot.data.content_snapshot
  return (
    <pre
      data-testid="library-history-snapshot"
      className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 font-mono text-micro leading-5 text-ink-fg-1 scrollbar-thin"
    >
      {text === '' ? t('library.history.snapshotEmpty') : text}
    </pre>
  )
}

export function HistoryDrawer({ open, onOpenChange, file }: Props): ReactElement {
  const { t } = useTranslation()
  const api = useLibraryApi()
  const invalidate = useInvalidateLibrary()
  const history = useLibraryHistoryQuery(file.id, open)
  const [snapshotId, setSnapshotId] = useState<number | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  /** 撞了 409 的那一条 —— 只有它显示冲突条与「重试」。 */
  const [conflictId, setConflictId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const runRollback = useCallback(
    async (historyId: number): Promise<void> => {
      if (file.id === null) return
      setBusy(true)
      try {
        await api.rollback(file.id, historyId)
        setConfirmId(null)
        setConflictId(null)
        await invalidate.all()
        toastSuccess(t('library.history.rollbackDoneToast'))
      } catch (err) {
        if (isLibraryVersionConflict(err)) {
          // 文件在应用之外被改过 ⇒ 服务端拿到的当前 hash 与它自己读到的对不上。重拉一遍
          // （预览面 / 历史列表都要跟着变），再让用户决定要不要用新版本再回滚一次。
          setConfirmId(null)
          setConflictId(historyId)
          await invalidate.all()
        } else {
          toastError(t('library.toast.actionFailed'), errorMessage(err))
        }
      } finally {
        setBusy(false)
      }
    },
    [api, file.id, invalidate, t]
  )

  const entries: readonly LibraryHistoryEntry[] = history.data ?? []

  const changedByLabel = (who: string): string => {
    if (who === 'user') return t('library.history.changedByUser')
    if (who === 'external') return t('library.history.changedByExternal')
    return who
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} ariaLabel={t('library.actions.history')} width={560}>
      <div className="flex h-full flex-col bg-ink-1">
        <div className="flex h-[41px] shrink-0 items-center gap-2 border-b border-ink-border px-4">
          <Clock3 size={14} strokeWidth={1.9} aria-hidden className="text-ink-fg-2" />
          <span className="flex-1 truncate text-body font-medium text-ink-fg">
            {t('library.actions.history')} · {file.filename}
          </span>
          <button
            type="button"
            aria-label={t('library.actions.close')}
            onClick={() => onOpenChange(false)}
            className="grid size-7 place-items-center rounded text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="px-4 py-2 text-meta text-ink-fg-3">
            {/* 条数与总量取自 `libraryConstants`（与 Python 侧有 parity 闸），不在文案里手抄数字。 */}
            {t('library.history.retention', {
              n: HISTORY_MAX_PER_FILE,
              size: formatFileSize(HISTORY_MAX_TOTAL_BYTES)
            })}
          </div>
          {history.isPending ? (
            <Skeleton rows={5} className="px-4 py-2" width="2/3" />
          ) : history.isError ? (
            <div className="px-4 py-2">
              <Notice tone="fail">
                {t('library.history.loadFailed')}
                <span className="ml-1.5 text-ink-fg-3">{errorMessage(history.error)}</span>
              </Notice>
            </div>
          ) : entries.length === 0 ? (
            <div className="px-4 py-3 text-meta text-ink-fg-3">{t('library.history.empty')}</div>
          ) : (
            entries.map((entry, index) => {
              // 列表是新 → 旧，所以「上一版」在**后**一个下标；最老那条没有对照，不显示增减。
              const older = entries[index + 1]
              const delta = older ? entry.snapshot_bytes - older.snapshot_bytes : null
              // 与磁盘当前正文同 hash = 这就是当前版本，回滚到它是空操作（服务端 no-op）。
              const isCurrent = file.content_hash !== null && entry.new_hash === file.content_hash
              return (
                <div
                  key={entry.id}
                  data-testid="library-history-row"
                  data-history-id={entry.id}
                  className="border-b border-ink-border-soft px-4 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-meta tabular-nums text-ink-fg-2">
                      {formatShortTime(entry.created_at)}
                    </span>
                    <Pill
                      tone={
                        entry.changed_by === 'user'
                          ? 'ink'
                          : entry.changed_by === 'external'
                            ? 'warn'
                            : 'ai'
                      }
                    >
                      {changedByLabel(entry.changed_by)}
                    </Pill>
                    <span className="font-mono text-micro tabular-nums text-ink-fg-3">
                      {formatFileSize(entry.snapshot_bytes)}
                      {delta !== null && delta !== 0 ? (
                        <span className={delta > 0 ? 'ml-1 text-ok' : 'ml-1 text-fail'}>
                          {delta > 0 ? '+' : '−'}
                          {formatFileSize(Math.abs(delta))}
                        </span>
                      ) : null}
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="library-history-view"
                        onClick={() => setSnapshotId(snapshotId === entry.id ? null : entry.id)}
                      >
                        {t('library.actions.viewSnapshot')}
                      </Button>
                      {isCurrent ? (
                        <Pill tone="ok" title={t('library.history.currentVersionHint')}>
                          {t('library.history.currentVersion')}
                        </Pill>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          data-testid="library-history-rollback"
                          onClick={() => {
                            setConflictId(null)
                            setConfirmId(entry.id)
                          }}
                        >
                          <RotateCcw size={13} aria-hidden />
                          {t('library.actions.rollback')}
                        </Button>
                      )}
                    </span>
                  </div>
                  <div className="mt-0.5 text-meta text-ink-fg-1">
                    {entry.change_note ?? (
                      <span className="text-ink-fg-3">
                        {entry.changed_by === 'external'
                          ? t('library.history.externalNoNote')
                          : t('library.history.noNote')}
                      </span>
                    )}
                  </div>
                  {snapshotId === entry.id && file.id !== null ? (
                    <SnapshotBody fileId={file.id} historyId={entry.id} />
                  ) : null}
                </div>
              )
            })
          )}
        </div>

        {confirmId !== null ? (
          <div
            data-testid="library-history-confirm"
            className="shrink-0 border-t border-ink-border bg-ink-2 px-4 py-3"
          >
            <div className="flex items-start gap-2">
              <Info size={14} className="mt-0.5 shrink-0 text-info" aria-hidden />
              <div className="min-w-0 flex-1 text-meta leading-relaxed text-ink-fg-1">
                {t('library.history.rollbackConfirmBody')}
              </div>
            </div>
            <div className="mt-2 flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmId(null)}>
                {t('library.actions.cancel')}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                data-testid="library-history-confirm-ok"
                onClick={() => void runRollback(confirmId)}
              >
                {t('library.actions.confirm')}
              </Button>
            </div>
          </div>
        ) : conflictId !== null ? (
          <div
            data-testid="library-history-conflict"
            className="shrink-0 border-t border-ink-border bg-ink-2 px-4 py-3"
          >
            <Notice tone="warn">
              <span className="font-medium">{t('library.history.conflictTitle')}</span>
              <span className="ml-1.5 text-ink-fg-2">{t('library.history.conflictBody')}</span>
            </Notice>
            <div className="mt-2 flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConflictId(null)}>
                {t('library.actions.cancel')}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                data-testid="library-history-retry"
                onClick={() => void runRollback(conflictId)}
              >
                {t('library.actions.retry')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Drawer>
  )
}
