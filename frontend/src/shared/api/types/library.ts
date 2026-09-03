// 资料库（library）serve-api 的 wire 类型（design §3 端点全表；表结构 §1.2 + 多根 §8.2）。
//
// 🔴 **字段名一律 snake_case 且与 `library_file` / `library_mount` 的列名逐字同名**。
// 本文件的形状是 2026-09-03 与 serve-api lane 逐条对过的最终契约（`src/api/routers/library.py`
// 与 `src/library/repository.py`），不是照 design 推的。想改名 = 两侧同改，别在读侧做映射
// 把差异藏起来。
//
// 值域（kind / source / status / text_status / mount mode 与 status）不在这里重新声明，
// 直接用零依赖叶子 `@shared/libraryConstants` 的联合类型 —— 那份与 `src/library/constants.py`
// 有跨语言闸，多抄一份就多一处会漂的地方。

import type {
  LibraryFileStatus,
  LibraryKind,
  LibraryMountMode,
  LibraryMountStatus,
  LibrarySource,
  LibraryTextStatus
} from '@shared/libraryConstants'

/**
 * 文件对象 —— `GET /library/folder` 的 `files`、`GET /library/file/{id}`、
 * `GET /library/search` 的 hits、以及全部写端点的返回体共用这一个形状。
 *
 * 🔴 **`id` 可能是 `null`**：邮件附件投影行不在 `library_file` 里（design §1.1 的只读投影），
 * 它们靠 `attachment_id` 寻址，`is_projection` 为 true。任何「按 id 做事」的调用点都必须先
 * 判空 —— 这是本类型最容易踩的一处。
 */
export interface LibraryFile {
  id: number | null
  /** 0 = 库根；>0 = `library_mount.id`（design §8.2 多根）。 */
  mount_id: number
  /** 根内相对路径（`library_file.rel_path` 列）。 */
  rel_path: string
  /** 虚拟路径 `<根 slug>/<相对路径>`；挂载根形如 `@label/sub/x.md`。显示与寻址都用它，
   *  绝对路径永不上 wire。 */
  path: string
  /** 所在文件夹的虚拟路径；根下的文件是根 slug 本身。 */
  parent_path: string
  filename: string
  kind: LibraryKind
  /** 服务端按扩展名猜的 MIME（`pickIconTone` 吃的就是它）。 */
  mime: string | null
  size_bytes: number | null
  /** epoch 秒（`library_file.mtime` REAL）。 */
  mtime: number | null
  /** 乐观锁判据。写入必带（`PUT` 的 `expected_hash` 就是它）；投影行 / 未算出时 null。 */
  content_hash: string | null
  source: LibrarySource
  /** mail: attachment_id；chat: `{sessionId}:{uiMessageId}`；agent: agent_id；derived: 原文件 id。 */
  source_ref: string | null
  /** 'user' | agent_id。 */
  created_by: string | null
  status: LibraryFileStatus
  text_status: LibraryTextStatus | null
  created_at: number
  updated_at: number

  // ── 投影行（邮件附件）专属，`is_projection` 为 true 时才有 ────────────────────
  //
  // 🔴 投影行**没有 library id**，`/library/file/{id}` 那一整套对它全都走不通。library router
  // 另给三条**只读兄弟端点**（与 `/file/{id}` 家族同形，client 上是 `attachment*` 三个方法）：
  //   · 行对象 → `GET /library/attachment/{attachment_id}`（文本类附件带 `content`）；
  //   · 解析文本 → `GET /library/attachment/{attachment_id}/text`（直接读 `email_attachment_text`，
  //     **不重抽**；返回体的 `file_id` 是 null，多一个 `attachment_id`）；
  //   · 原件字节 → `GET /library/attachment/{attachment_id}/inline`（Range 206）。
  //   · 另存到资料库 → `POST /library/keep-attachment`，返回库内文件对象，此后就是普通 `id`。
  is_projection?: boolean
  attachment_id?: number
  /** 附件所属邮件的 `internal_id`（点「来源」跳回邮件用）。 */
  internal_id?: number
  subject?: string | null
  sender?: string | null
  sender_name?: string | null
  /** 邮件收件时间（`'YYYY-MM-DD hh:mm:ss'` 文本，不是 epoch）。 */
  date_received?: string | null
  /** 列表「来源」列的人类可读串 = 主题 · 发件人。P1 只在投影行上算。 */
  source_label?: string | null
  /** markdown frontmatter 的 title。🔴 **P1 服务端不算**，读侧一律回落 `filename`。 */
  title?: string | null
}

/** `GET /library/tree` 的一行。层级靠 `parent_path` 还原（根行 `parent_path` 是**空串**）。
 *  只读与不可用**不上 wire** —— 前端从投影根 slug 与挂载的 mode / status 推（单一判据，
 *  服务端多一个布尔就多一处会与 mode 打架的真相）。 */
export interface LibraryFolderNode {
  path: string
  /** `''` = 根节点。 */
  parent_path: string
  /** 末段显示名。内置根返 slug（UI 走 i18n 换文案），挂载根返 `@<label>`。 */
  name: string
  mount_id: number
  /** 该目录直属的 present 文件数（树上的角标）；`.trash` 是废纸篓行数。 */
  file_count: number
}

/** 树里内嵌的挂载投影 —— 🔴 **不带 `abs_path`**（renderer 只在设置页拿绝对路径）。 */
export interface LibraryMountSummary {
  id: number
  label: string
  /** 挂载根的虚拟路径，恒 `@<label>`。**用它，别自己拼**（label 可能含特殊字符）。 */
  path: string
  mode: LibraryMountMode
  status: LibraryMountStatus
  file_count: number
}

/** `GET/POST/PATCH/DELETE /library/mounts` 的完整行 —— 唯一带 `abs_path` 的响应。 */
export interface LibraryMount {
  id: number
  label: string
  abs_path: string
  mode: LibraryMountMode
  status: LibraryMountStatus
  file_count: number
  added_at: number
}

export interface LibraryTreeResponse {
  folders: LibraryFolderNode[]
  mounts: LibraryMountSummary[]
  /** 全库 present 文件总数。 */
  file_count: number
}

/** `GET /library/folder?path=` —— 子文件夹 + 文件条目，文件侧分页（`FOLDER_PAGE_SIZE`）。
 *  🔴 排序在**服务端**做完再分页：客户端排序只能排当前这一页，第 2 页起就是错的。 */
export interface LibraryFolderPage {
  path: string
  folders: LibraryFolderNode[]
  files: LibraryFile[]
  total: number
  limit: number
  offset: number
  /** 服务端算好的「还有下一页」——别用 `offset + files.length < total` 自己推。 */
  has_more: boolean
}

/** `GET /library/file/{id}` —— 文件对象 + 正文。`content` 只对文本类且 ≤2 MB 给，
 *  否则 null（可读正文走 `/text` 的解析版）。 */
export interface LibraryFileDetail extends LibraryFile {
  content: string | null
}

/** `GET /library/file/{id}/text` —— 解析版（`library_text`），预览 / 搜索 / agent 读同一来源。 */
export interface LibraryFileText {
  /** 🔴 投影腿（`/library/attachment/{id}/text`）为 null —— 那份文本不属于任何 library 行。 */
  file_id: number | null
  /** 只有投影腿带。 */
  attachment_id?: number
  text_status: LibraryTextStatus
  /** 三态未就绪时 null。 */
  markdown: string | null
  /** `anydoc|pypdf|pdf_ocr|vision_ocr|plaintext|native…`，未抽取时 null。 */
  extractor: string | null
  truncated: boolean
  /** 生成这份文本时的 `content_hash`。 */
  source_hash: string | null
  /** 文件当前的 `content_hash`。 */
  content_hash: string | null
  /** `source_hash !== content_hash` —— 正文变了、解析版还没重抽。 */
  stale: boolean
  /** 给人 / 模型看的说明串，两条腿都有，`extracted` 时恒 null。
   *  🔴 **选文案的判据是 `text_status`，不是它** —— `hint` 只作兜底展示，永远不要拿它
   *  做分支（它是自由文本，不是枚举）。 */
  hint: string | null
}

/** 搜索命中 = 文件对象**摊平**再挂三个命中字段（不是 `{file, …}` 嵌套）。 */
export type LibrarySearchHit = LibraryFile & {
  /** FTS5 snippet（含高亮标记），无正文时 null。 */
  snippet: string | null
  /** bm25 排序位次；trigram 表按 mtime 排时为 null。 */
  rank: number | null
  /** 服务端报的命中来源（正文 / 文件名），按字符串透传不做收窄。 */
  match: string | null
}

export interface LibrarySearchResponse {
  query: string
  /** 走了哪条检索路径。已知值 `empty|too_short|like|trigram|porter`
   *  （`src/library/repository.py::SearchResult.mode`）—— 只用于显示，故不在这里收窄成
   *  联合类型：跨语言手抄一份枚举而没有闸，漂了比不收窄更坏。 */
  mode: string
  hits: LibrarySearchHit[]
  /** 机器可读的「查了但没查成」说明，如 `cjk_too_short:<字>`；正常时空数组。 */
  warnings: string[]
}

/** `GET /library/file/{id}/history` 的一行（`library_history`）。
 *  🔴 列表**不带快照正文**，只给字节数；要看内容走 rollback 前的单独取用。 */
export interface LibraryHistoryEntry {
  id: number
  file_id: number
  old_hash: string | null
  new_hash: string
  /** 'user' | agent_id | 'external'。external 行天生没有 change_note。 */
  changed_by: string
  change_note: string | null
  session_id: number | null
  message_id: number | null
  created_at: number
  snapshot_bytes: number
}

/** `POST /library/rescan` 的回执。 */
export interface LibraryRescanResult {
  scanned: number
  added: number
  /** 外部改动、对账时补记 `changed_by='external'` 的那一类。 */
  updated: number
  missing: number
  elapsed_ms: number
}
