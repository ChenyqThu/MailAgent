// 文件类型 → 图标色调 / 中文名 / 可执行动作。
//
// 色调**不自己造**：走主仓 `email/attachmentPreview.ts` 的 `pickIconTone`
// （design §2.3 明写「复用 pickIconTone」）。它吃的是附件行的形状
// `{content_type, filename, size_bytes}`，这里按 kind 反推一个 mime 喂给它，
// 落地时 library 行本来就带 mime，直接传即可。

import { pickIconTone, type IconTone } from '@shared/components/email/attachmentPreview'

import type { LibFile, LibKind } from '../fixtures'
import { S } from '../strings'

const MIME_BY_KIND: Record<LibKind, string> = {
  markdown: 'text/markdown',
  html: 'text/html',
  pdf: 'application/pdf',
  office: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  image: 'image/png',
  text: 'text/plain',
  video: 'video/mp4',
  placeholder: 'application/octet-stream',
  other: 'application/octet-stream'
}

export function toneOf(file: Pick<LibFile, 'kind' | 'filename' | 'size_bytes'>): IconTone {
  return pickIconTone({
    content_type: MIME_BY_KIND[file.kind],
    filename: file.filename,
    size_bytes: file.size_bytes
  } as Parameters<typeof pickIconTone>[0])
}

export const KIND_LABEL: Record<LibKind, string> = {
  markdown: 'Markdown',
  html: 'HTML',
  pdf: 'PDF',
  office: 'Office',
  image: '图片',
  text: '文本',
  video: '视频',
  placeholder: 'iCloud 占位',
  other: '其他'
}

/** 原件该交给哪个应用打开（design §2.4「原件 · 用 X 打开」）。 */
export function openWithApp(file: LibFile): string | null {
  const name = file.filename.toLowerCase()
  if (/\.(docx?|rtf)$/.test(name)) return 'Word'
  if (/\.(xlsx?|csv)$/.test(name)) return 'Excel'
  if (/\.pptx?$/.test(name)) return 'PowerPoint'
  if (name.endsWith('.pdf')) return '预览'
  if (name.endsWith('.html')) return '浏览器'
  if (file.kind === 'video') return '播放器'
  return null
}

export function sourceLabel(file: LibFile): string {
  return S.sourceLabel[file.source]
}

/** 创建者显示名：'user' → 我；其余是 agent_id。 */
const AGENT_NAMES: Record<string, string> = {
  main: '主 Agent',
  'followup-agent': '跟进 Agent',
  'report-agent': '报告 Agent'
}
export function creatorLabel(file: LibFile): string {
  if (file.created_by === 'user') return '我'
  return AGENT_NAMES[file.created_by] ?? file.created_by
}

export function changedByLabel(who: string): string {
  if (who === 'user') return '我'
  if (who === 'external') return '应用之外的改动'
  return AGENT_NAMES[who] ?? who
}

/** 列表「名称」列：md 取 frontmatter.title，回落文件名（design §2.3）。 */
export function displayName(file: LibFile): string {
  return file.title && file.kind === 'markdown' ? file.title : file.filename
}

/** 这个文件是不是在只读区（投影区 / ro 挂载 / unavailable 挂载）。 */
export function isReadonlyPath(path: string, mountReadonly: ReadonlySet<string>): boolean {
  if (path.startsWith('mail-attachments')) return true
  for (const root of mountReadonly) {
    if (path === root || path.startsWith(`${root}/`)) return true
  }
  return false
}

/** 只读预览要不要把 YAML frontmatter 渲染出来？—— 不要。
 *  Streamdown 不认 frontmatter，`---` 会被当成分隔线、`title:` 当成正文，
 *  于是每份带 frontmatter 的 md 顶部都多出一段乱码似的元数据。
 *  这里在渲染前剥掉；编辑态的 textarea 仍是原文（frontmatter 要能改）。
 *  🔴 落地时这是一处真实决策，不是 mockup 的权宜：见 README「设计缺漏」§F1。 */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md
  const end = md.indexOf('\n---', 3)
  if (end < 0) return md
  return md.slice(md.indexOf('\n', end + 1) + 1).replace(/^\n+/, '')
}
