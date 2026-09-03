// dogfood 0903 —— 资料库四个写工具的富审批卡，取代原来的 SimpleApprovalCard。
//
// 换掉它的理由（owner 反馈原话：「资料库写入的操作授权审批卡，是不是没做 UI 啊」）：通用卡
// 把整个 args 对象 `JSON.stringify` 成一行等宽文本铺在卡里 —— 一份三千字的 markdown 变成
// `{"mode":"create_new","path":"…","content":"# 标题\n\n…"}` 这样一条带转义符的长串。
// 那是**能批**，但不是**能读**：用户没法判断自己在批准什么内容写进哪个文件。
//
// 这张卡只做三件事：
//   ① 说清动作与落点 —— 新建 / 覆写 / 追加 / 移动 / 删除，各自的目标路径（overwrite 与
//      append 的参数里只有 `file_id`，卡片查一次库把路径补出来，否则「#42」等于没说）；
//   ② 正文按 markdown 渲染（`.md/.markdown/.txt`），其余扩展名原样等宽显示；
//   ③ 批准 / 拒绝走与其他富卡完全相同的 `respondToApproval` 通道 A（无岛可批）。
//
// 🔴 正文一律**当第二方内容**渲染：它是模型生成的 markdown，`TranslatedBody`（Streamdown）
// 走的是 rehype-harden，不会执行脚本；这里不额外放 HTML 直通口。

import { useTranslation } from 'react-i18next'
import { FileInput, FilePen, FilePlus, FolderInput, Trash2 } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { useLibraryFileQuery } from '@shared/components/library/hooks'
import { TRASH_TTL_DAYS } from '@shared/libraryConstants'

import { ApprovalActions, CardDetails, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'
import {
  LIBRARY_WRITE_COPY_KEY,
  readLibraryWriteInput,
  rendersAsMarkdown,
  type LibraryWriteShape
} from './libraryWriteCard.lib'

function iconFor(shape: LibraryWriteShape): React.ReactNode {
  if (shape === 'overwrite') return <FilePen size={13} strokeWidth={2} />
  if (shape === 'append') return <FileInput size={13} strokeWidth={2} />
  if (shape === 'move') return <FolderInput size={13} strokeWidth={2} />
  if (shape === 'delete') return <Trash2 size={13} strokeWidth={2} />
  return <FilePlus size={13} strokeWidth={2} />
}

/** 一行「标签：值」，值用等宽（路径 / hash 这类要能逐字核对）。 */
function PathLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 text-meta text-ink-fg-3">{label}</span>
      <span className="min-w-0 break-all font-mono text-meta text-ink-fg">{value}</span>
    </div>
  )
}

export function LibraryWriteCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, argsText, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const input = readLibraryWriteInput(toolName, args, argsText)

  // overwrite / append 的参数里只有 file_id：查一次库把路径补出来。create/move/delete 自带
  // `path`，不发这个请求（`enabled` 由 ref=null 关掉）。
  const needsLookup = input.path === null && input.fileId !== null
  const detail = useLibraryFileQuery(needsLookup ? { id: input.fileId as number } : null)
  const resolvedPath =
    input.path ?? (detail.data?.path ?? (input.fileId === null ? null : `#${input.fileId}`))

  const copy = LIBRARY_WRITE_COPY_KEY[input.shape]
  const markdown = rendersAsMarkdown(input.path ?? detail.data?.path ?? null)

  const onApprove = (): void => respondToApproval({ approved: true })
  const onReject = (reason?: string): void => respondToApproval({ approved: false, reason })

  return (
    <CardFrame
      icon={iconFor(input.shape)}
      title={t(`chat.libraryWriteCard.${copy}.title`)}
      phase={phase}
    >
      <div className="flex flex-col gap-1">
        {resolvedPath !== null ? (
          <PathLine
            label={t(input.shape === 'move' ? 'chat.libraryWriteCard.fromLabel' : 'chat.libraryWriteCard.fileLabel')}
            value={resolvedPath}
          />
        ) : null}
        {input.targetPath !== null ? (
          <PathLine label={t('chat.libraryWriteCard.toLabel')} value={input.targetPath} />
        ) : null}
        {input.changeNote !== null ? (
          <div className="text-aux text-ink-fg-2">{input.changeNote}</div>
        ) : null}
      </div>

      {/* overwrite 没带 `expected_hash` = 不基于任何已读版本直接盖掉现有正文。服务端此时按
          「新建语义」判，路径已存在会 409；但只要模型带了 file_id 走的就是覆写，用户有权
          在批准前知道这一次没有版本基线。 */}
      {input.shape === 'overwrite' && !input.hasExpectedHash ? (
        <div className="mt-1.5 text-meta text-warn">{t('chat.libraryWriteCard.noBaseline')}</div>
      ) : null}
      {input.shape === 'delete' ? (
        <div className="mt-1.5 text-meta text-ink-fg-2">
          {t('chat.libraryWriteCard.trashNote', { days: TRASH_TTL_DAYS })}
        </div>
      ) : null}

      {input.content !== null && input.content.length > 0 ? (
        <CardDetails label={t(`chat.libraryWriteCard.${copy}.contentLabel`)}>
          <div className="scrollbar-thin mt-1 max-h-72 overflow-auto rounded-md border border-ink-border-soft bg-ink-2 px-2.5 py-2">
            {markdown ? (
              <TranslatedBody text={input.content} />
            ) : (
              <pre className="whitespace-pre-wrap break-all font-mono text-meta text-ink-fg">
                {input.content}
              </pre>
            )}
          </div>
        </CardDetails>
      ) : null}

      <ApprovalActions onApprove={onApprove} onReject={onReject} rejectReason />
      {phase === 'rejected' || phase === 'expired' ? <TerminalBanner phase={phase} /> : null}
    </CardFrame>
  )
}
