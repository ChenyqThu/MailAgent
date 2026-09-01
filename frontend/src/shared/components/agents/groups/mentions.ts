// L4 群聊 — 发送框 @ 提及解析（纯函数叶子，零 react / 零 api import）。
//
// 约定（任务规格 §3）：文本里出现 `@成员显示名` 即点名该成员；有点名 → 只有被点名的成员
// 回复，无点名 → 全员按成员序各回一轮。解析按**显示名**匹配（补全弹层插入的就是
// `@显示名`），返回值恒按 members 传入序（= members_json 成员序 = 回复顺序），去重。
//
// 匹配纪律：名字后必须是边界（串尾 / 非字母数字）——避免「@研」误命中「@研究员」的前缀；
// 先按名字长度降序检出、再回到成员序输出，长名优先吃掉重叠。

export interface GroupMentionMember {
  agentId: string
  title: string
}

/** 名字后的边界判定：串尾 / 空白 / 标点（中文名后常直接跟中文标点或正文，此处只排除
 *  字母/数字/下划线续接 —— `@agent1x` 不算提及 `agent1`）。 */
function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true
  return !/[A-Za-z0-9_]/.test(ch)
}

/** 解析文本中被 @ 点名的成员 id。无点名 → []（调用方按「全员各回一轮」处理）。 */
export function parseGroupMentions(text: string, members: readonly GroupMentionMember[]): string[] {
  if (!text.includes('@') || members.length === 0) return []
  const hit = new Set<string>()
  // 长名优先：避免短名作为长名前缀时双命中（去重靠 Set，但边界判定在长名场景下更稳）。
  const byLength = [...members]
    .filter((m) => m.title.length > 0)
    .sort((a, b) => b.title.length - a.title.length)
  for (const member of byLength) {
    let from = 0
    for (;;) {
      const idx = text.indexOf(`@${member.title}`, from)
      if (idx === -1) break
      const after = text[idx + 1 + member.title.length]
      if (isBoundary(after)) {
        hit.add(member.agentId)
        break
      }
      from = idx + 1
    }
  }
  // 恒按成员序输出 = 回复顺序稳定可预期。
  return members.filter((m) => hit.has(m.agentId)).map((m) => m.agentId)
}

/** 补全触发探测：光标前最后一个 `@` 起的未完成片段（`@` 后无空白/换行）。
 *  返回 null = 不在补全语境；返回 { query, start } = 弹层按 query 过滤成员，
 *  start = `@` 在文本中的下标（供插入时替换）。 */
export function detectMentionDraft(
  text: string,
  caret: number
): { query: string; start: number } | null {
  const upto = text.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at === -1) return null
  const fragment = upto.slice(at + 1)
  if (/[\s\n]/.test(fragment)) return null
  return { query: fragment, start: at }
}
