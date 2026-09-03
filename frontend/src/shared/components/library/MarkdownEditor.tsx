// markdown 三态（design §2.4 / §4；mockup C2）：只读（Streamdown，F1 剥 frontmatter 渲成文件头元信息）
// → 编辑（textarea + 变更说明 + 保存 / 取消，抄 StandingDocsSection）→ 保存冲突（409）。
//
// 保存走 CAS：`PUT /library/file/{id}` 带打开时读到的 `content_hash`。撞 409 三件事：
// 提示「已被改动」、显示当前版本（🔴 靠重拉 `GET /library/file/{id}`，409 body 到不了 UI）、
// 保留我的文本不丢。「用我的覆盖」= 拿当前版本的 hash 再写一次；「放弃」= 回到当前版本。

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'

import { isLibraryVersionConflict } from '@shared/api/library'
import type { LibraryFileDetail } from '@shared/api/types/library'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { Button } from '@shared/components/ui/button'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'

import { stripFrontmatter, type FrontmatterMeta } from './fileMeta'
import { useInvalidateLibrary, useLibraryApi, useRefetchDetail } from './hooks'
import { Pill } from './parts'

export type MarkdownMode = 'read' | 'edit'

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 8) : '—'
}

export function FrontmatterLine({ meta }: { meta: FrontmatterMeta | null }): ReactElement | null {
  if (!meta || (!meta.title && !meta.summary && meta.tags.length === 0)) return null
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-ink-border-soft pb-2 text-meta text-ink-fg-2">
      {meta.title ? <span className="font-medium text-ink-fg">{meta.title}</span> : null}
      {meta.summary ? <span className="min-w-0 truncate">{meta.summary}</span> : null}
      {meta.tags.map((tag) => (
        <Pill key={tag} tone="ink">
          {tag}
        </Pill>
      ))}
    </div>
  )
}

interface Props {
  file: LibraryFileDetail
  mode: MarkdownMode
  onModeChange(next: MarkdownMode): void
}

export function MarkdownEditor({ file, mode, onModeChange }: Props): ReactElement {
  const { t } = useTranslation()
  const api = useLibraryApi()
  const invalidate = useInvalidateLibrary()
  const refetchDetail = useRefetchDetail()
  const content = file.content ?? ''
  const [text, setText] = useState(content)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<LibraryFileDetail | null>(null)

  // F5（owner 09-02 拍板）「不丢」：挂载根切只读时正在编辑的文件降级为只读，**未保存文本不丢**。
  // 判据是「上一次是怎么离开编辑态的」：
  //   · 用户自己离开（取消 / 保存成功 / 放弃冲突，都经 `leaveEdit`）→ 回到编辑态按磁盘正文重新起草
  //     （「取消 = 丢弃草稿」的语义就在这里）；
  //   · 被 readonly 压出去（mode prop 自己从 edit 变 read，没人经过 `leaveEdit`）→ 切回可写时
  //     **跳过** reseed，草稿原样留在编辑框里。
  // 🔴 不要改成「content 没变就不 seed」—— 那会连带把取消的丢弃语义一起改掉。
  // 头部那枚「编辑」按钮再点一次也属于后者（它是显示开关，不是取消）：草稿留着。
  const userLeftEdit = useRef(true)
  const leaveEdit = useCallback((): void => {
    userLeftEdit.current = true
    onModeChange('read')
  }, [onModeChange])

  // 进编辑态时从当前正文起草；只读态下正文更新（别处保存 / 外部改动）也跟着刷。
  const [seeded, setSeeded] = useState<{ hash: string | null; mode: MarkdownMode }>({
    hash: file.content_hash,
    mode
  })
  useEffect(() => {
    if (seeded.mode === mode && seeded.hash === file.content_hash) return
    setSeeded({ hash: file.content_hash, mode })
    if (mode === 'edit' && seeded.mode !== 'edit' && userLeftEdit.current) {
      // 刚进编辑态：草稿 = 磁盘原文（含 frontmatter，用户编辑的是真文件）。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText(content)
      setNote('')
      setConflict(null)
      userLeftEdit.current = false
    }
  }, [content, file.content_hash, mode, seeded])

  async function write(expectedHash: string | null): Promise<void> {
    if (file.id === null) return
    setSaving(true)
    try {
      await api.writeFile(file.id, {
        content: text,
        expected_hash: expectedHash,
        change_note: note.trim() === '' ? undefined : note.trim()
      })
      await invalidate.file({ id: file.id })
      setConflict(null)
      leaveEdit()
      toastSuccess(t('library.preview.savedToast'))
    } catch (err) {
      if (isLibraryVersionConflict(err)) {
        // 我的文本原样留在编辑框；并排显示磁盘上的当前版本。
        try {
          setConflict(await refetchDetail({ id: file.id }))
        } catch (refetchErr) {
          toastError(t('library.preview.saveFailedToast'), errorMessage(refetchErr))
        }
      } else {
        toastError(t('library.preview.saveFailedToast'), errorMessage(err))
      }
    } finally {
      setSaving(false)
    }
  }

  if (mode === 'read') {
    const { body, meta } = stripFrontmatter(content)
    return (
      <div className="px-5 py-4">
        <FrontmatterLine meta={meta} />
        {body.trim() === '' ? (
          <div className="text-meta text-ink-fg-3">{t('library.preview.noContent')}</div>
        ) : (
          <TranslatedBody text={body} />
        )}
      </div>
    )
  }

  const editor = (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label={t('library.actions.edit')}
        className="min-h-[260px] flex-1 resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 font-mono text-aux leading-6 text-ink-fg outline-none transition-colors duration-fast focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
      />
      <div className="flex items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('library.history.changeNotePlaceholder')}
          aria-label={t('library.history.changeNoteLabel')}
          className="h-8 min-w-0 flex-1 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 text-aux text-ink-fg outline-none placeholder:text-ink-fg-3 focus-visible:border-coral/60"
        />
        <Button size="sm" variant="ghost" disabled={saving} onClick={leaveEdit}>
          {t('library.actions.cancel')}
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void write(file.content_hash)}>
          {t('library.actions.save')}
        </Button>
      </div>
    </div>
  )

  if (conflict === null) {
    return <div className="flex min-h-0 flex-1 flex-col px-5 py-4">{editor}</div>
  }

  const current = stripFrontmatter(conflict.content ?? '')
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
      <div
        role="alert"
        className="rounded-[var(--r-card)] border border-warn/35 bg-warn/[0.07] px-3 py-2"
      >
        <div className="flex items-center gap-1.5 text-aux font-medium text-warn">
          <TriangleAlert size={14} strokeWidth={2} aria-hidden />
          {t('library.preview.conflictTitle')}
        </div>
        <p className="mt-1 text-meta leading-relaxed text-ink-fg-1">{t('library.preview.conflictBody')}</p>
        <p className="mt-0.5 font-mono text-micro text-ink-fg-3">
          expected_hash {shortHash(file.content_hash)} → {shortHash(conflict.content_hash)}
        </p>
        <div className="mt-2 flex items-center gap-1.5">
          <Button size="sm" disabled={saving} onClick={() => void write(conflict.content_hash)}>
            {t('library.preview.conflictKeepMine')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={saving}
            onClick={() => {
              setText(conflict.content ?? '')
              setConflict(null)
              leaveEdit()
            }}
          >
            {t('library.preview.conflictDiscard')}
          </Button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 font-mono text-micro uppercase tracking-widest text-ink-fg-3">
            {t('library.preview.mineUnsaved')}
          </div>
          {editor}
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 font-mono text-micro uppercase tracking-widest text-ink-fg-3">
            {t('library.preview.currentVersion')}
          </div>
          <div
            data-testid="library-conflict-current"
            className="min-h-0 flex-1 overflow-y-auto rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 scrollbar-thin"
          >
            <FrontmatterLine meta={current.meta} />
            <TranslatedBody text={current.body} />
          </div>
        </div>
      </div>
    </div>
  )
}
