// 报告「导出到资料库」——概要栏的第三个按钮 + 目标文件夹选择 + 写入。
//
// 独立成组件（而不是塞进 ReportDetailView）有一条硬理由：写完要让资料库整域的 query 失效，
// 那需要 `useQueryClient`。把这个 hook 提到 ReportDetailView 那一层，就等于给它的每一处
// 挂载点（/reports、轻窗、组件测试）都加上「必须有 QueryClientProvider」的前提 —— 而这个
// 按钮本来就只在一种载体下出现。
//
// 显隐由调用方门控（ReportsPage：desktopMac + 非轻窗），组件自己只管「按下去之后发生什么」。
import { useCallback, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import type { LibraryApi } from '@shared/api/library'
import type { LibraryFile } from '@shared/api/types/library'
import type { ReportDoc } from '@shared/api/types'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'
import { FolderPickerDialog } from '@shared/components/library/FolderPickerDialog'
import { useLibraryOpenToast } from '@shared/components/library/deeplink'
import { useInvalidateLibrary, useLibraryApi } from '@shared/components/library/hooks'

import { ReportIcon } from './primitives'
import { nextFilenameCandidate, reportDocToMarkdown, reportExportFilename } from './reportMarkdown'

/** 重名退让的次数上限。够不上就把最后一次的错误照实抛给用户 —— 无限往后数只会把一个
 *  「这个文件夹里已经有二十份同名报告」的异常状况变成静默的第二十一份。 */
const MAX_NAME_ATTEMPTS = 20

/** 同路径已存在时服务端恒 409 `E_VERSION_CONFLICT`（`LibraryService.create_file`）。
 *  重名往后让一个序号再试，最终用的名字照实进回执 —— 覆盖别人的文件比重名更糟，而
 *  「这一步没做成」在这里是能自动化解的。 */
async function createWithUniqueName(
  api: LibraryApi,
  parentPath: string,
  filename: string,
  content: string
): Promise<LibraryFile> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    try {
      return await api.createTextFile({
        parent_path: parentPath,
        filename: nextFilenameCandidate(filename, attempt),
        content,
        // 人在界面上点的导出 = `user`。报告不是任何一种既有 `source_ref` 语义
        // （derived = 原文件 id / chat = '{sessionId}:{uiMessageId}'），故不带 —— 服务端
        // 的 CreateTextRequest 是 extra="forbid"，发个自造的前缀会被 422 打回。
        source: 'user'
      })
    } catch (err) {
      if ((err as { code?: string }).code !== 'E_VERSION_CONFLICT') throw err
      lastError = err
    }
  }
  throw lastError
}

export function ReportExportButton({
  doc,
  fallbackTitle
}: {
  doc: ReportDoc
  fallbackTitle: string
}): ReactElement {
  const { t } = useTranslation()
  const api = useLibraryApi()
  const invalidate = useInvalidateLibrary()
  const openToast = useLibraryOpenToast()
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const filename = reportExportFilename(doc, fallbackTitle)

  const runExport = useCallback(
    async (targetPath: string): Promise<void> => {
      setBusy(true)
      try {
        const saved = await createWithUniqueName(
          api,
          targetPath,
          filename,
          reportDocToMarkdown(doc)
        )
        await invalidate.all()
        setPicking(false)
        // 回执恒带一个「打开」深链 —— 没有去处的回执一律视为缺陷（design §9.5）。
        const title = t('library.report.exportedAs', { name: saved.filename })
        if (saved.id !== null) openToast(title, saved.id)
        else toastSuccess(title)
      } catch (err) {
        toastError(t('library.toast.actionFailed'), errorMessage(err))
      } finally {
        setBusy(false)
      }
    },
    [api, doc, filename, invalidate, openToast, t]
  )

  return (
    <>
      <button
        type="button"
        onClick={() => setPicking(true)}
        className="flex items-center"
        // 形态抄同一条概要栏上的「在新窗口打开」/「重新生成」：透明底、12px、hover 变
        // accent、按下 0.97。
        style={{
          gap: 5,
          fontFamily: 'inherit',
          fontSize: 12,
          color: 'rgb(var(--ink-fg-2))',
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
          transition:
            'color 120ms cubic-bezier(0.4,0,0.2,1), transform 120ms cubic-bezier(0.4,0,0.2,1)'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'rgb(var(--c-accent))'
        }}
        onMouseDown={(e) => {
          e.currentTarget.style.transform = 'scale(0.97)'
        }}
        onMouseUp={(e) => {
          e.currentTarget.style.transform = 'none'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'rgb(var(--ink-fg-2))'
          e.currentTarget.style.transform = 'none'
        }}
      >
        <ReportIcon name="folder" size={12} />
        {t('library.report.exportToLibrary')}
      </button>
      {picking && (
        <FolderPickerDialog
          open
          onOpenChange={(next) => {
            if (!next) setPicking(false)
          }}
          mode="export"
          file={{ filename }}
          busy={busy}
          onConfirm={(targetPath) => void runExport(targetPath)}
        />
      )}
    </>
  )
}
