// 标签工作区的 compose 现场快照（task 08-27 P2 Lane W；dogfood 波3 扩到 draft-edit）。
//
// 「写一半回复的标签切走再切回，草稿还在」的载体：ComposePanelInner 卸载时（切邮件 /
// 切域 / 详情早退分支）把可序列化的现场写进 TabDescriptor.draft。两条恢复入口：
//   - overlay（reply/reply-all/forward）：以「compose store 仍指向本邮件且 open」为
//     非显式关闭的判据；切回该标签时 EmailDetail 自动重开 compose；
//   - draft-edit（波3）：不经 compose store，EmailDetail 草稿箱分支直渲面板并传
//     initialTabDraft；卸载兜底只在「dirty 或本会话保存过」时写（干看不锁标签），
//     显式丢弃经面板的 suppress 位压住。
// 面板按正常预填后用快照覆写用户可编辑的字段。
//
// 🔴 只存**用户改得动的**字段：quoteHtml / splitQuote / preserveOriginal 从 plan 重建
//（planQ staleTime Infinity，重建逐字节一致）——引用块动辄几百 KB，进 localStorage 会
// 顶爆配额（updateTab 每次提交都整份重写）。bodyHtml 为 null = 用户没动过正文，恢复时
// 保留 plan 的建议正文。
//
// 真实草稿仍走后端草稿箱（store 契约注释）；本快照不跨 force-quit（unmount cleanup 才写）。

import type { ComposeMode } from '@shared/api/types'
import type { DraftSnapshot } from '@shared/state/tab-workspace'

/** 附件 chip 的可序列化半边（previewUrl 是 objectURL，不可序列化，恢复后无缩略图）。
 *  status 只留 'done'：uploading 中的丢弃（stage 未完成，引用不了），error 的本来就要重传。 */
export interface ComposeTabDraftAttachment {
  readonly filename: string
  readonly size: number | null
  readonly stageId?: string
  readonly attachmentId?: number
}

/** 参与快照链的面板模式。dogfood 波3 起 draft-edit（草稿点开即编辑）也进快照 ——
 *  与 overlay 的差别：它不经 compose store，恢复入口是 EmailDetail 的草稿箱分支。 */
export type ComposeTabDraftMode = ComposeMode | 'draft-edit'

export interface ComposeTabDraft {
  /** 快照种类标记 —— TabDescriptor.draft 是 store 不解释的开放形状，读侧靠它收窄。 */
  readonly kind: 'compose'
  readonly mode: ComposeTabDraftMode
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly subject: string
  readonly importance: 'high' | 'normal' | 'low'
  readonly ccVisible: boolean
  readonly bccVisible: boolean
  /** null = 用户没改过正文（编辑器 update 事件从未触发），恢复时保留 plan 建议正文。 */
  readonly bodyHtml: string | null
  /** 本封行距覆写（'' = 跟随设置默认）。 */
  readonly lineHeightChoice: string
  readonly attachments: readonly ComposeTabDraftAttachment[]
  /** forward 的原附件 hydrate 是否已完成过（codex F1 状态机）。true = 恢复时不再重
   *  hydrate（快照里的 chips 已含原附件，或用户已显式移除它们——重跑会加回来）。 */
  readonly fwdHydrated: boolean
  readonly dirty: boolean
  /** draft-edit 专用 —— C-1 replace 锚（保存成功后指镜像新行）。旧快照缺省 = 恢复侧
   *  回落 internalId（换锚后 tab 已 retarget，两者相等）。 */
  readonly draftRowId?: number
  /** draft-edit 专用 —— 「已保存 HH:MM」时间戳（epoch ms），恢复时重建 lastSavedAt。 */
  readonly lastSavedAtMs?: number
}

const COMPOSE_MODES: readonly ComposeTabDraftMode[] = [
  'reply',
  'reply-all',
  'forward',
  'draft-edit'
]

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string')
}

/** TabDescriptor.draft → ComposeTabDraft 的收窄。持久化存档可能被手改 / 来自旧版本，
 *  形状不对整份放弃（快照是可再生的工作状态，不做迁移）。 */
export function readComposeTabDraft(
  draft: DraftSnapshot | null | undefined
): ComposeTabDraft | null {
  if (draft === null || draft === undefined) return null
  const rec = draft as Record<string, unknown>
  if (rec.kind !== 'compose') return null
  if (!COMPOSE_MODES.includes(rec.mode as ComposeTabDraftMode)) return null
  if (!isStringArray(rec.to) || !isStringArray(rec.cc) || !isStringArray(rec.bcc)) return null
  if (typeof rec.subject !== 'string') return null
  const importance =
    rec.importance === 'high' || rec.importance === 'low' ? rec.importance : 'normal'
  const attachments: ComposeTabDraftAttachment[] = []
  if (Array.isArray(rec.attachments)) {
    for (const item of rec.attachments) {
      if (item === null || typeof item !== 'object') continue
      const a = item as Record<string, unknown>
      if (typeof a.filename !== 'string') continue
      attachments.push({
        filename: a.filename,
        size: typeof a.size === 'number' ? a.size : null,
        ...(typeof a.stageId === 'string' ? { stageId: a.stageId } : {}),
        ...(typeof a.attachmentId === 'number' ? { attachmentId: a.attachmentId } : {})
      })
    }
  }
  return {
    kind: 'compose',
    mode: rec.mode as ComposeTabDraftMode,
    to: rec.to,
    cc: rec.cc,
    bcc: rec.bcc,
    subject: rec.subject,
    importance,
    ccVisible: rec.ccVisible === true,
    bccVisible: rec.bccVisible === true,
    bodyHtml: typeof rec.bodyHtml === 'string' ? rec.bodyHtml : null,
    lineHeightChoice: typeof rec.lineHeightChoice === 'string' ? rec.lineHeightChoice : '',
    attachments,
    fwdHydrated: rec.fwdHydrated === true,
    dirty: rec.dirty === true,
    // 波3 新增字段：旧快照缺省 → 不进对象（收窄器给「没有」而不是 undefined 值）。
    ...(typeof rec.draftRowId === 'number' && Number.isInteger(rec.draftRowId)
      ? { draftRowId: rec.draftRowId }
      : {}),
    ...(typeof rec.lastSavedAtMs === 'number' && Number.isFinite(rec.lastSavedAtMs)
      ? { lastSavedAtMs: rec.lastSavedAtMs }
      : {})
  }
}

/** ComposeTabDraft 本身就是 JSON-safe 的 DraftSnapshot（readonly 数组在运行时是普通数组）。 */
export function toDraftSnapshot(draft: ComposeTabDraft): DraftSnapshot {
  return draft as unknown as DraftSnapshot
}
