// 资料库文件对象的纯函数层（design §2.3 / §2.4 / §9.5）：寻址、显示名、图标色调、frontmatter
// 剥离、时间 / 废纸篓倒计时。不产 JSX、不 import 组件，FolderView / FilePreview / 树 / 附件面共用。

import type { LibraryFile } from '@shared/api/types/library'
import { pickIconTone, type IconTone } from '@shared/components/email/attachmentPreview'
import {
  PROJECTION_SLUG,
  RESOURCE_KEY_PREFIX,
  TRASH_SLUG,
  TRASH_TTL_DAYS,
  type LibrarySource
} from '@shared/libraryConstants'
import { MOUNTS_GROUP_PATH } from './tree'

/** 文件寻址：库内文件按 `id`，邮件附件投影行按 `attachment_id`（`id` 为 null，design §1.1）。
 *  预览面只认这个 ref，端点选择在 hooks 层做，子视图不分支。 */
export type LibraryFileRef = { id: number } | { attachmentId: number }

export function refOf(file: Pick<LibraryFile, 'id' | 'attachment_id'>): LibraryFileRef | null {
  if (typeof file.id === 'number') return { id: file.id }
  if (typeof file.attachment_id === 'number') return { attachmentId: file.attachment_id }
  return null
}

export function refKey(ref: LibraryFileRef): string {
  return 'id' in ref ? `f:${ref.id}` : `a:${ref.attachmentId}`
}

export function sameRef(a: LibraryFileRef | null, b: LibraryFileRef | null): boolean {
  if (a === null || b === null) return a === b
  return refKey(a) === refKey(b)
}

export function isProjection(file: Pick<LibraryFile, 'is_projection' | 'path'>): boolean {
  return file.is_projection === true || file.path.startsWith(`${PROJECTION_SLUG}/`)
}

/** 图标色调走 `email/attachmentPreview.pickIconTone`（design §2.3 点名复用）。它吃附件行形状，
 *  library 行本来就带 mime，直接喂；🔴 不要按 kind 反推 mime（mockup 的 MIME_BY_KIND 是权宜）。 */
export function libraryIconTone(
  file: Pick<LibraryFile, 'mime' | 'filename' | 'size_bytes'>
): IconTone {
  return pickIconTone({
    content_type: file.mime,
    filename: file.filename,
    size_bytes: file.size_bytes
  } as Parameters<typeof pickIconTone>[0])
}

/** 列表「名称」列：md 取 frontmatter.title 回落文件名（design §2.3）。P1 服务端不算 title，
 *  读侧照样支持 —— 字段一旦补上这里不用动。 */
export function displayName(file: Pick<LibraryFile, 'filename' | 'kind' | 'title'>): string {
  const title = file.title?.trim()
  return file.kind === 'markdown' && title ? title : file.filename
}

/** 预览协议用的虚拟路径：投影行没有磁盘路径，走 `mail-attachments/<attachment_id>/<文件名>`
 *  （主进程按 attachment_id 落到 `email_attachment.local_path` 所在目录，同目录相对引用可解析）。 */
export function previewPathOf(
  file: Pick<LibraryFile, 'path' | 'filename' | 'attachment_id' | 'is_projection'>
): string {
  if (isProjection(file) && typeof file.attachment_id === 'number') {
    return `${PROJECTION_SLUG}/${file.attachment_id}/${file.filename}`
  }
  return file.path
}

/** F2：解析版（`source='derived'`）指回原文件的 id；不是派生文件或 ref 坏了返回 null。 */
export function derivedSourceId(file: Pick<LibraryFile, 'source' | 'source_ref'>): number | null {
  if (file.source !== 'derived' || !file.source_ref) return null
  const id = Number(file.source_ref)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** 来源邮件的附件 id（`source='mail'` 时 `source_ref` 就是 `email_attachment.id`，见
 *  `src/library/service.py::keep_attachment`）。
 *
 *  🔴 投影行**不走这里**：它自己带 `internal_id` / `subject` / `sender`，不必再查一次。
 *  这个函数只服务「另存到资料库」之后的库内行 —— 那种行上除了 `source_ref` 什么邮件信息都没有。 */
export function mailSourceAttachmentId(
  file: Pick<LibraryFile, 'source' | 'source_ref' | 'is_projection' | 'path'>
): number | null {
  if (isProjection(file) || file.source !== 'mail' || !file.source_ref) return null
  const id = Number(file.source_ref)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** 来源会话的 session id（`source='chat'` 时 `source_ref` 是 `'{sessionId}:{uiMessageId}'`）。
 *
 *  🔴 会话段**可能是空串**：新会话的第一条消息在发出时 session 还没持久化下来
 *  （`chatAttachmentAdapter.ts` 的注释说的就是这一种），那种行没有可跳转的落点，返回 null。 */
export function chatSourceSessionId(
  file: Pick<LibraryFile, 'source' | 'source_ref'>
): number | null {
  if (file.source !== 'chat' || !file.source_ref) return null
  const id = Number(file.source_ref.split(':')[0])
  return Number.isInteger(id) && id > 0 ? id : null
}

/** 跨模块引用键（design §9.0）：事项侧就是拿这个串挂的资料。 */
export function libraryResourceKey(fileId: number): string {
  return `${RESOURCE_KEY_PREFIX}${fileId}`
}

/** 「用 X 打开」里那个 X 的值域。
 *
 *  🔴 是**固定产品名**，不是本机默认应用的真名。取真名唯一可行的路子是
 *  `NSWorkspace.URLForApplicationToOpenURL`（osascript / JXA），而它只对**存在的文件**返回结果，
 *  且给的是**系统语言**的本地化名 —— 与 app 自己的 i18n 语言无关，两个 locale 都管不到它。
 *  见 `library.common.app.*` 的取舍说明。
 *
 *  数组形态是为了让 i18n 闸能遍历（`tests/components/library/libraryI18nKeys.test.ts`）——
 *  这几个 key 曾整片缺失、UI 上原样吐出 `library.common.app.excel`。 */
export const OPEN_WITH_APPS = [
  'word',
  'excel',
  'powerpoint',
  'preview',
  'browser',
  'player'
] as const
export type OpenWithApp = (typeof OPEN_WITH_APPS)[number]

/** 原件该交给哪个应用打开（design §2.4「原件 · 用 X 打开」）；null = 泛称「系统应用」。 */
export function openWithApp(file: Pick<LibraryFile, 'filename' | 'mime'>): OpenWithApp | null {
  const name = file.filename.toLowerCase()
  if (/\.(docx?|rtf)$/.test(name)) return 'word'
  if (/\.(xlsx?|csv)$/.test(name)) return 'excel'
  if (/\.pptx?$/.test(name)) return 'powerpoint'
  if (name.endsWith('.pdf')) return 'preview'
  if (/\.html?$/.test(name)) return 'browser'
  if ((file.mime ?? '').startsWith('video/') || /\.(mp4|mov|m4v|webm)$/.test(name)) return 'player'
  return null
}

/** 删除动作的文案 key（F12）。
 *
 *  🔴 库内与挂载区**删的不是同一件事**：库内进 `.trash`（30 天可恢复），挂载区动的是用户
 *  磁盘上的真文件、交给系统废纸篓（服务端对挂载区的 `DELETE /library/file/{id}` 恒拒）。
 *  差异前移到菜单文案上 —— 都叫「删除」会让用户以为进的是库内废纸篓。 */
export function deleteActionLabelKey(file: Pick<LibraryFile, 'mount_id'>): string {
  return file.mount_id > 0 ? 'library.trash.moveToSystemTrash' : 'library.actions.delete'
}

export function sourceTone(source: LibrarySource): 'info' | 'ai' | 'ink' {
  if (source === 'mail') return 'info'
  if (source === 'agent') return 'ai'
  return 'ink'
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `YYYY-MM-DD HH:mm`（本地时区）。投影行没有 mtime，调用方回落 `date_received` 文本。 */
export function formatShortTime(epochSeconds: number | null | undefined): string {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return '—'
  const d = new Date(epochSeconds * 1000)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 列表 / 头部的时间列：库内行用 mtime；投影行用邮件收件时间（`'YYYY-MM-DD hh:mm:ss'` 文本）。 */
export function fileTimeLabel(file: Pick<LibraryFile, 'mtime' | 'date_received'>): string {
  if (typeof file.mtime === 'number') return formatShortTime(file.mtime)
  if (file.date_received) return file.date_received.slice(0, 16)
  return '—'
}

/** 废纸篓倒计时（design §1.5：30 天 sweep）。进废纸篓的时刻 = 行的 `updated_at`。 */
export function trashDaysLeft(file: Pick<LibraryFile, 'updated_at'>, now = Date.now()): number {
  const deadline = (file.updated_at + TRASH_TTL_DAYS * 86400) * 1000
  const days = Math.ceil((deadline - now) / 86_400_000)
  return Math.min(TRASH_TTL_DAYS, Math.max(0, days))
}

export interface FrontmatterMeta {
  title: string | null
  summary: string | null
  tags: string[]
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

function parseTags(inline: string, following: readonly string[]): string[] {
  const v = inline.trim()
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map(unquote)
      .filter(Boolean)
  }
  if (v.length > 0) return [unquote(v)]
  const out: string[] = []
  for (const line of following) {
    const m = /^\s*-\s*(.+)$/.exec(line)
    if (!m) break
    out.push(unquote(m[1]))
  }
  return out
}

/** F1（owner 09-03 拍板）：只读预览与解析视图**剥掉** YAML frontmatter —— Streamdown 不认它，
 *  `---` 会渲成分隔线、`title:` 当成正文。把 `title` / `summary` / `tags` 交给渲染层做成正文上方
 *  一行元信息。🔴 只在渲染层剥：编辑态 textarea 保留原文，磁盘内容永不改写，`library_read` 也不剥。 */
export function stripFrontmatter(markdown: string): { body: string; meta: FrontmatterMeta | null } {
  if (!markdown.startsWith('---')) return { body: markdown, meta: null }
  const firstLineEnd = markdown.indexOf('\n')
  if (firstLineEnd < 0 || markdown.slice(0, firstLineEnd).trim() !== '---') {
    return { body: markdown, meta: null }
  }
  const closing = /\n---[ \t]*(?:\n|$)/.exec(markdown.slice(firstLineEnd))
  if (!closing) return { body: markdown, meta: null }
  const headerEnd = firstLineEnd + closing.index
  const header = markdown.slice(firstLineEnd + 1, headerEnd)
  const body = markdown.slice(headerEnd + closing[0].length).replace(/^\n+/, '')
  const lines = header.split('\n')
  const meta: FrontmatterMeta = { title: null, summary: null, tags: [] }
  lines.forEach((line, index) => {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) return
    const key = m[1].toLowerCase()
    if (key === 'title') meta.title = unquote(m[2]) || null
    else if (key === 'summary' || key === 'description') meta.summary = unquote(m[2]) || null
    else if (key === 'tags') meta.tags = parseTags(m[2], lines.slice(index + 1))
  })
  return { body, meta }
}


/** 顶层根的 i18n key。两处 path→key 偏移：`.trash` 去前导点、挂载分组用固定 `mounts`。
 *  放在这个叶子里而不是 `LibraryTreePanel`，是因为 `react-refresh/only-export-components`
 *  要求组件文件只导出组件 —— 规则给的修法就是「换个文件放共享常量与函数」。 */
export function rootLabelKey(path: string): string {
  if (path === TRASH_SLUG) return 'library.tree.roots.trash'
  if (path === MOUNTS_GROUP_PATH) return 'library.tree.roots.mounts'
  return `library.tree.roots.${path}`
}

/** PDF 抽取文本按 form feed 分页（pypdf 逐页拼接时用 `\f` 分隔）；没有分隔符就整段一页。 */
export function splitPdfPages(text: string): string[] {
  const pages = text.split('\f').map((p) => p.replace(/^\n+|\n+$/g, ''))
  return pages.length > 1 ? pages : [text]
}
