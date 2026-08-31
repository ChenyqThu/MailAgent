// P4a agent-config lane — 配置页的纯逻辑 helper（零 React 依赖，单测直取）。
//
// ① 标题正则的实时校验与「拿最近 5 封标题试一下」的本地匹配。
//    🔴 后端 ProjectProgressDetector 用 Python `re.search`；这里用 JS RegExp 近似
//    （无锚点 test 即 search 语义）。个别 Python 专有写法（如 `(?P<name>…)` 命名分组）
//    JS 编译不过 → 只会误报「无法编译」，不会漏放非法输入 —— UI 文案里说明这一点。
// ② 项目进度库 ID 的格式识别：接受 32 位十六进制（带/不带连字符），也接受直接
//    粘贴 Notion 库链接（从路径里提取最后一段 32-hex）。识别只做反馈与提取，
//    写回 env 的仍是输入框里的字面值（不静默改写用户输入）。

export type RegexCompileResult = { ok: true; regex: RegExp } | { ok: false; error: string }

export function compileSubjectRegex(pattern: string): RegexCompileResult {
  try {
    return { ok: true, regex: new RegExp(pattern) }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 逐条标题跑 `re.search` 语义的命中判定。pattern 编译失败 → null（区别于「全部未命中」）。 */
export function testSubjectsAgainst(pattern: string, subjects: string[]): boolean[] | null {
  const compiled = compileSubjectRegex(pattern)
  if (!compiled.ok) return null
  return subjects.map((subject) => compiled.regex.test(subject))
}

export type NotionDbIdParse =
  | { kind: 'empty' }
  | { kind: 'id'; id: string }
  /** 粘贴的是链接，从中提取出了库 ID（提取值供「使用这个 ID」按钮回填）。 */
  | { kind: 'url'; id: string }
  | { kind: 'invalid' }

const DASHED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BARE_HEX32 = /^[0-9a-f]{32}$/i

export function parseNotionDatabaseId(raw: string): NotionDbIdParse {
  const s = raw.trim()
  if (!s) return { kind: 'empty' }
  if (DASHED_UUID.test(s) || BARE_HEX32.test(s)) return { kind: 'id', id: s }
  if (/^https?:\/\//i.test(s)) {
    // Notion 链接形如 notion.so/{workspace}/{标题}-{32hex}?v=…：取 query 前最后一段 hex 连串的
    // **末 32 位**（标题里的 hex 片段去掉连字符后可能与 ID 连成一串，ID 恒在串尾）。
    const beforeQuery = s.split('?')[0].replace(/-/g, '')
    const hexRuns = beforeQuery.match(/[0-9a-f]{32,}/gi)
    if (hexRuns && hexRuns.length > 0) {
      return { kind: 'url', id: hexRuns[hexRuns.length - 1].slice(-32) }
    }
    return { kind: 'invalid' }
  }
  return { kind: 'invalid' }
}
