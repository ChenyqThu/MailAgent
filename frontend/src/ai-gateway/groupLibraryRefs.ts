// P2-L13 群聊 @ 资料（design §9.3 (b)）— 群消息「引用了哪几份资料库文件」的载体单源。
//
// 与 T2 群附件（groupAttachments.ts）的关键差别：**只带标识，不带正文**。设计拍板 (b) 的理由有两条：
//   • 群附件那条路把正文塞进 metadata，单件 20k 字符上限就是被它逼出来的；资料库文件没有上限，
//     再塞一遍等于把窗口预算交给文件大小。
//   • 「发送即入库」已经把对话附件落了盘，正文再抄一份进 metadata 是同一份内容的第二次落盘。
// 所以这里只搬运 `{fileId, path, name}` 三件，成员 agent 拿到的是一行指路，正文自己用
// `library_read(file_id=…)` 去取（那条路上有 LIBRARY_FILE 围栏 + 服务端授权）。
//
// 🔴 三处跨进程键名从这里**单源**出去，任何一处都不许再写一遍字面量（09-02 话题批的
//    `groupId` / `sessionId` 两侧拼写不一致导致三绿静默失效）：
//      renderer POST body  ← `libraryRefsBodyPatch()` / `readLibraryRefsInput()`（键 `libraryRefs`）
//      metadata 列          ← `encodeLibraryRefsMetadata()` / `parseLibraryRefsMetadata()`（键 `library_refs`）
//    闸：tests/ai-gateway/group_library_refs.test.ts 的「跨进程键名单源」一节 —— 把常量改坏，
//    真 `appendGroupUserMessage` 发出的 body 就过不了真 `readLibraryRefsInput`。
//
// 🔴 `metadata` 这一列不是本模块专用（`{via:'main_agent'}` / `{kind:'game_over'}` / attachments
//    都住在同一个对象里）：编码是「往同一个 JSON 对象里加一个键」，其余键原样保留。
// 🔴 解析对脏输入恒返 null、绝不抛（读侧面对的是历史数据，崩了整条群时间线就没了）。
// 🔴 Pure：零 node / electron / react import（与 groupChat.ts / groupAttachments.ts 同一纪律）。

/** 一条引用。字段名逐字来自 design §7 拍板表：`[{fileId, path, name}]`。 */
export interface GroupLibraryRef {
  /** 资料库文件 id —— `library_read(file_id=…)` 的入参。🔴 投影行（mail-attachments）恒 null，
   *  在选取侧就被滤掉，永远走不到这里。 */
  fileId: number
  /** 虚拟路径（`<根 slug>/<相对路径>`）—— 进模型那一行给的就是它。 */
  path: string
  /** 文件名 —— 只给 renderer 的 chip 用，不进模型（路径尾巴已经是它）。 */
  name: string
}

/** 一条消息最多带几份资料。与 `GROUP_ATTACHMENTS_MAX` 取同一个数：同一个「一条消息里挂多少
 *  东西」的直觉，没有理由分成两个数。 */
export const GROUP_LIBRARY_REFS_MAX = 6

/** path / name 的字符上限。够长到不截断真实路径，短到六条也撑不爆那一行。 */
const LABEL_MAX_CHARS = 200

/** 🔴 键名字面量的**唯一**两处出现。 */
const BODY_KEY = 'libraryRefs'
const METADATA_KEY = 'library_refs'

/** 换行 / 控制字符一律折成空格：文件名是别人起的，`\n[用户] ` 这种名字能在装配后的转录里
 *  伪造一个说话人标签。截断在折行之后（先去噪再量长度）。 */
function sanitizeLabel(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, LABEL_MAX_CHARS)
}

/** 解析一段 metadata 成普通对象。非字符串 / 空串 / 脏 JSON / 数组 / null → null。 */
function parseMetadataObject(json: string | null | undefined): Record<string, unknown> | null {
  if (typeof json !== 'string' || json.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** 一条引用的形状校验。`fileId` 不是正整数 / `path` 为空 → null（这一条不算数）。 */
function sanitizeOne(raw: unknown): GroupLibraryRef | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const item = raw as { fileId?: unknown; path?: unknown; name?: unknown }
  // fileId 是这条引用**唯一**的用处（模型拿它去 library_read）：没有它就不是一条引用。
  if (typeof item.fileId !== 'number' || !Number.isInteger(item.fileId) || item.fileId <= 0) {
    return null
  }
  const path = typeof item.path === 'string' ? sanitizeLabel(item.path) : ''
  if (path.length === 0) return null
  const name = typeof item.name === 'string' ? sanitizeLabel(item.name) : ''
  return { fileId: item.fileId, path, name: name.length > 0 ? name : path }
}

/** 形状校验 + 条数上限（超出的从尾部丢弃）+ 按 fileId 去重（同一份文件 @ 两次只算一条）。 */
function sanitizeAll(items: unknown): GroupLibraryRef[] {
  if (!Array.isArray(items)) return []
  const out: GroupLibraryRef[] = []
  const seen = new Set<number>()
  for (const raw of items) {
    if (out.length >= GROUP_LIBRARY_REFS_MAX) break
    const one = sanitizeOne(raw)
    if (one === null || seen.has(one.fileId)) continue
    seen.add(one.fileId)
    out.push(one)
  }
  return out
}

/**
 * renderer 侧：拼进 `POST /api/ai/group-chat` body 的那一片。
 *
 * 🔴 一条合格引用都没有 → 返回**空对象**，展开进 body 后与改动前**逐字节一致**（不发一个
 * `libraryRefs: undefined` 键 —— JSON.stringify 会把它丢掉，但 body 的构造分支会因此多一条
 * 谁也没测过的路径）。
 */
export function libraryRefsBodyPatch(
  refs: readonly GroupLibraryRef[] | null | undefined
): Record<string, unknown> {
  const clean = sanitizeAll(refs)
  return clean.length > 0 ? { [BODY_KEY]: clean } : {}
}

/** append 分支对 body 里那一片的校验结果；ok=false 时 hint 直接进 400 响应体。 */
export type GroupLibraryRefsInput =
  | { ok: true; items: GroupLibraryRef[] }
  | { ok: false; hint: string }

/**
 * gateway 侧：从 append 分支的 body 里读出引用。缺键 / null → 零引用（常态，不是错）。
 *
 * 🔴 写侧不静默丢：形状不合格或超上限一律整条 400（与 `validateAttachmentsInput` 同一纪律 ——
 * 用户 @ 了 3 份、落库成 2 份还没人告诉他，比直接报错难查得多）。读侧反过来必须容错。
 */
export function readLibraryRefsInput(body: Record<string, unknown>): GroupLibraryRefsInput {
  const raw = body[BODY_KEY]
  if (raw === undefined || raw === null) return { ok: true, items: [] }
  if (!Array.isArray(raw)) return { ok: false, hint: `${BODY_KEY} must be an array` }
  if (raw.length > GROUP_LIBRARY_REFS_MAX) {
    return { ok: false, hint: `${BODY_KEY}: at most ${GROUP_LIBRARY_REFS_MAX} per message` }
  }
  const items = sanitizeAll(raw)
  if (items.length !== raw.length) {
    return { ok: false, hint: `each ${BODY_KEY} entry needs { fileId, path, name }` }
  }
  return { ok: true, items }
}

/**
 * 把引用编码进一行的 metadata。`baseMetadataJson` 的键原样保留，只有 `library_refs` 由本函数写。
 * 一条合格引用都没有 → 原样返回 base（不写一个空键，无引用的行与改动前字节一致）。
 */
export function encodeLibraryRefsMetadata(
  refs: readonly GroupLibraryRef[] | null | undefined,
  baseMetadataJson?: string | null
): string | null {
  const clean = sanitizeAll(refs)
  if (clean.length === 0) return baseMetadataJson ?? null
  return JSON.stringify({ ...(parseMetadataObject(baseMetadataJson) ?? {}), [METADATA_KEY]: clean })
}

/**
 * 从一行的 metadata 里读出引用。null = 这行没有引用（**不是**空数组）—— 脏 JSON、没有这个键、
 * 不是数组、一条合格的都没有，四种情况一律 null。
 */
export function parseLibraryRefsMetadata(
  metadataJson: string | null | undefined
): GroupLibraryRef[] | null {
  const parsed = parseMetadataObject(metadataJson)
  if (parsed === null) return null
  const clean = sanitizeAll(parsed[METADATA_KEY])
  return clean.length > 0 ? clean : null
}

/**
 * 装配时前置进 user 行的**一行**指路。无引用 → 空串（那条正文一个字节都不变）。
 *
 * 🔴 这里只出现路径与 id，**永远不放正文** —— 正文是 `library_read` 的事（模块头注两条理由）。
 * 恒一行（引用之间用 `；` 隔开，不按条数换行）：多一行就多一处能被伪造成说话人标签的地方，
 * 而 path / name 是文件系统里别人起的名字。
 */
export function renderLibraryRefsLine(
  refs: readonly GroupLibraryRef[] | null | undefined
): string {
  const clean = sanitizeAll(refs)
  if (clean.length === 0) return ''
  const body = clean.map((r) => `${r.path} file_id=${r.fileId}`).join('；')
  return `[附带资料（用 library_read 读）：${body}]\n`
}
