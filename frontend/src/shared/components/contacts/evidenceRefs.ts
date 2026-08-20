// 内联证据引用 `[id:N]` 的解析 / 剥离单源。
//
// prompt 约定见 `src/contacts/profile_prompts.py`（HARD RULES 3「cite supporting email
// internal_id values inline, for example [id:123]」）。两个消费方：画像卡把它切成可点角标
// （`ContactProfileCard::InlineRefs`），chips / 建议值 / 治理建议结论句只做显示侧剥离。
// 落在独立模块而不是组件文件里，是为了两边共用同一个正则（手抄第二份 = 改一处漏一处）。
//
// 🔒 这不构成 markdown/HTML 渲染：切段之后每一段仍走 `{value}` 插值（React 转义）。
// 🔴 冒号后容空白 —— 实际脏值形如 `[id: 54216]`。容空格是原 `[id:N]` 的超集，
//    解析行为只增不减。`[id:abc]` / `[id:]` 仍然不匹配。

export const EVIDENCE_REF_PATTERN = /\[id:\s*(\d+)\]/g

/** 剥离专用：连标记**前面的空白**一起吃掉。只删标记会留下孤儿空格，而结论句是拿这些值
 *  拼出来的 → `补上部门「Procurement [id: 54216]」` 会剥成 `「Procurement 」`。
 *  从 `EVIDENCE_REF_PATTERN.source` 派生而不是手抄第二份，两者不会漂。 */
const EVIDENCE_REF_STRIP_PATTERN = new RegExp(`\\s*${EVIDENCE_REF_PATTERN.source}`, 'g')

export type InlineSegment = { kind: 'text'; value: string } | { kind: 'ref'; value: number }

/** 把一段画像文本切成「纯文本段 / 证据引用段」。非法引用不产生 ref 段，其字面量随周围
 *  文本一起留在 text 段里。 */
export function parseEvidenceRefs(text: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  let cursor = 0
  for (const match of text.matchAll(EVIDENCE_REF_PATTERN)) {
    const id = Number.parseInt(match[1] as string, 10)
    // 🔴 超长数字（`[id:99999999999999999999]`）落在安全整数外 —— 不可能是真的 internal_id，
    // 做成钮只会跳去一封不存在的邮件。跳过（不推进 cursor）＝ 它随后并入下一段纯文本。
    if (!Number.isSafeInteger(id)) continue
    const at = match.index
    if (at > cursor) segments.push({ kind: 'text', value: text.slice(cursor, at) })
    segments.push({ kind: 'ref', value: id })
    cursor = at + match[0].length
  }
  if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) })
  return segments
}

/** 剥掉标记而不是留字面量。用在放不下引用钮的地方：chips（原型 `cdetail.jsx::ChipList`
 *  就是纯展示 span）、建议值行、治理建议结论句 —— 后两者是老数据的脏尾巴兜底
 *  （模型把内联引证写进了结构化字段）。剥完把多出来的空隙收拢。 */
export function stripEvidenceRefs(text: string): string {
  return text
    .replace(EVIDENCE_REF_STRIP_PATTERN, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
