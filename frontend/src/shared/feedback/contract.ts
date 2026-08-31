// 快捷反馈的传输契约单源（task 08-27-l4-tab-workspace P4a）。
//
// owner 已在 Notion 建好一张**公开匿名可提交**的表单（`anonymous_submissions: true` /
// `submission_permissions: "none"`），本模块复用它的提交接口：客户端不持任何 token，
// 也就不需要服务端中转（design.md §11 里「webhook-server 收口端点」是旧设想，已推翻）。
//
// 🔴 `/api/v3/` 是 Notion 的**私有 API**：没有文档、没有版本号、不承诺兼容，改了不会通知
//    任何人，而且失效会是**静默的**。所以本模块的三条硬要求：
//      ① 提交只在返回体带 `submissionBlockId` 时才算成功（HTTP 200 不作数）；
//      ② 失败一律抛 FeedbackSubmitError，调用方给「打开表单页手动提交」的降级；
//      ③ 附件上传的 S3 POST 只认 204。
//
// 🔴 请求必须带**正常浏览器 UA**。`Python-urllib/3.x` 与空 UA 会被 Cloudflare 拦成
//    `403 error code 1010`，而错误正文里**没有任何关于 UA 的线索**（逆向时在这上面耗了很久）。
//    UA 由调用方经 `deps.userAgent` 传入（主进程拼 app.getVersion()）。
//
// 零依赖叶子模块：纯 TS + 全局 fetch/FormData/Blob，不引 electron / react / @shared 别名，
// 所以 Electron 主进程 handler、gateway 工具（pure-Node harness 也要能加载）与 renderer
// 的类型面可以共用同一份。

/** 反馈类型 —— 🔴 传的是 Notion select 的**显示值字符串**，不是 option id。 */
export const FEEDBACK_KINDS = ['问题', '建议', '咨询'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

/** 复现频率 —— 🔴 只在「问题」类有意义，别的类整段不发（buildFeedbackBlockProperties 落实）。 */
export const FEEDBACK_FREQUENCIES = ['每次必现', '偶发', '仅出现一次'] as const
export type FeedbackFrequency = (typeof FEEDBACK_FREQUENCIES)[number]

// 🔴 上面两组的**值**是与 Notion 表单对齐的中文枚举，**不许改值**（改了 select 就落不上）。
// 界面文案走下面这两张 key 表（ConfigDrawer 的 PRIORITY_LABEL_KEYS 先例：value 是权威、
// displayLabel 走 i18n）。
export const FEEDBACK_KIND_LABEL_KEYS: Record<FeedbackKind, string> = {
  问题: 'feedback.kind.problem',
  建议: 'feedback.kind.suggestion',
  咨询: 'feedback.kind.question'
}

export const FEEDBACK_FREQ_LABEL_KEYS: Record<FeedbackFrequency, string> = {
  每次必现: 'feedback.freq.always',
  偶发: 'feedback.freq.sometimes',
  仅出现一次: 'feedback.freq.once'
}

export const FEEDBACK_FORM_ID = '02d42f55-731e-43c1-bfd0-575fa11f8078'
export const FEEDBACK_SPACE_ID = '883c77cc-e7d8-4103-84a8-13ba401a991c'
export const FEEDBACK_API_BASE = 'https://tp-link.notion.site/api/v3'

/** 提交失败时的降级目标：直接打开表单页手动填。 */
export const FEEDBACK_FORM_URL = `https://tp-link.notion.site/${FEEDBACK_FORM_ID.replace(/-/g, '')}`

/** 「查看反馈」看板（owner 的库视图，浏览器打开，不嵌 iframe）。 */
export const FEEDBACK_BOARD_URL =
  'https://app.notion.com/p/tp-link/f8455e24c3b1432aab206d23301f02b8?v=e3734264073d444496d01bec71d9452e'

/** property id ≠ 字段名。这张表是从 `POST /api/v3/getFormData`（公开可读）拿的，
 *  别按中文字段名硬编。 */
export const FEEDBACK_PROPERTY_IDS = {
  title: 'title',
  kind: 'Icfp',
  detail: '}N`n',
  freq: 'O_T>',
  version: 'b]b_',
  email: '\\NXQ',
  screenshot: '[A]Y',
  diagnostics: 'iIxi'
} as const

/** 一个待上传的附件（主进程读盘 / 截图后填 body）。 */
export interface FeedbackAttachment {
  name: string
  /** MIME，例如 `image/png` / `application/zip`。 */
  type: string
  body: Uint8Array
}

/** 一条反馈的**权威 payload 输入**。UI 的勾选框最终只体现为这里的字段在不在 ——
 *  「撤掉截图」必须真的把 `screenshot` 拿掉，而不是只改个 class。 */
export interface FeedbackSubmitInput {
  kind: FeedbackKind
  title: string
  detail?: string
  /** 只有 kind==='问题' 时才会进 payload（见 buildFeedbackBlockProperties）。 */
  freq?: FeedbackFrequency
  /** 自动带上的运行环境，形如 `2.26.0 · darwin · /settings`。 */
  version?: string
  email?: string
  screenshot?: FeedbackAttachment
  diagnostics?: FeedbackAttachment
  /** true = 主 Agent 代发（回执要说清是谁提交的）。截图这一项在 agent 提交时恒无。 */
  viaAgent?: boolean
}

/** Notion 富文本：`[["文本"]]`；🔴 空字段传 `[]` 而不是省略。 */
type RichText = string[][]
function rt(v?: string): RichText {
  const s = (v ?? '').trim()
  return s.length > 0 ? [[s]] : []
}

/**
 * payload 的 `blockProperties`。**单独导出**是为了让测试直接断言 payload 字段
 * （断言 UI class 抓不到「撤掉了但还是发出去了」这类静默错）。
 *
 * 🔴 复现频率只在「问题」类出现 —— 换成建议 / 咨询时整段不发，不是发空串。
 */
export function buildFeedbackBlockProperties(input: FeedbackSubmitInput): Record<string, RichText> {
  const P = FEEDBACK_PROPERTY_IDS
  return {
    [P.title]: rt(input.title),
    [P.kind]: rt(input.kind),
    [P.detail]: rt(input.detail),
    [P.freq]: rt(input.kind === '问题' ? input.freq : undefined),
    [P.version]: rt(input.version),
    [P.email]: rt(input.email),
    // 文件属性的值恒空数组，真正的引用走 filePropertyIdToTokens。
    [P.screenshot]: [],
    [P.diagnostics]: []
  }
}

/** 提交失败。`stage` 说明卡在哪一步，调用方据此写「没发出去」的文案与降级入口。 */
export class FeedbackSubmitError extends Error {
  readonly stage: 'upload' | 'submit'
  readonly status: number
  readonly body: unknown
  constructor(stage: 'upload' | 'submit', status: number, body: unknown, message?: string) {
    super(message ?? `feedback ${stage} failed (status ${status})`)
    this.name = 'FeedbackSubmitError'
    this.stage = stage
    this.status = status
    this.body = body
  }
}

export interface FeedbackDeps {
  /** 🔴 必须是正常浏览器/Electron UA，否则 Cloudflare 403 error 1010（正文无线索）。 */
  userAgent: string
  /** 注入点只为可测（默认全局 fetch）。 */
  fetchImpl?: typeof fetch
}

interface UploadMeta {
  signedPostUrl?: string
  fields?: Record<string, unknown>
  token?: string
}

/** 附件三步的前两步：换签名 URL → multipart POST 到 S3。返回上传 token（JWT，24h 有效）。 */
async function uploadOne(file: FeedbackAttachment, deps: FeedbackDeps): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch
  const metaRes = await doFetch(`${FEEDBACK_API_BASE}/getFormUploadFileUrl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': deps.userAgent },
    body: JSON.stringify({
      name: file.name,
      contentType: file.type,
      // 🔴 contentLength 是必需字段，漏了直接 400。
      contentLength: file.body.byteLength,
      spaceId: FEEDBACK_SPACE_ID,
      formId: FEEDBACK_FORM_ID
    })
  })
  const meta = (await metaRes.json().catch(() => null)) as UploadMeta | null
  if (!metaRes.ok || !meta?.signedPostUrl || !meta.fields || !meta.token) {
    throw new FeedbackSubmitError('upload', metaRes.status, meta)
  }

  const form = new FormData()
  for (const [k, v] of Object.entries(meta.fields)) form.append(k, String(v))
  // Blob 只接受 ArrayBuffer 视图；Uint8Array 直接给即可。
  form.append('file', new Blob([file.body as unknown as BlobPart], { type: file.type }), file.name)
  const put = await doFetch(meta.signedPostUrl, { method: 'POST', body: form })
  // 🔴 S3 预签名 POST 成功是 204（不是 200）。
  if (put.status !== 204) throw new FeedbackSubmitError('upload', put.status, null)

  return meta.token
}

/**
 * 提交一条反馈。成功返回 `submissionBlockId`（= 回执编号）。
 *
 * 🔴 失败可见：**没有 submissionBlockId 就是没发出去**，哪怕 HTTP 200。
 */
export async function submitFeedbackToNotion(
  input: FeedbackSubmitInput,
  deps: FeedbackDeps
): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch
  const filePropertyIdToTokens: Record<string, string[]> = {}
  if (input.screenshot) {
    filePropertyIdToTokens[FEEDBACK_PROPERTY_IDS.screenshot] = [
      await uploadOne(input.screenshot, deps)
    ]
  }
  if (input.diagnostics) {
    filePropertyIdToTokens[FEEDBACK_PROPERTY_IDS.diagnostics] = [
      await uploadOne(input.diagnostics, deps)
    ]
  }

  const res = await doFetch(`${FEEDBACK_API_BASE}/submitForm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': deps.userAgent },
    body: JSON.stringify({
      formId: FEEDBACK_FORM_ID,
      spaceId: FEEDBACK_SPACE_ID,
      blockProperties: buildFeedbackBlockProperties(input),
      filePropertyIdToTokens
    })
  })
  const json = (await res.json().catch(() => null)) as { submissionBlockId?: unknown } | null
  const id = json?.submissionBlockId
  if (!res.ok || typeof id !== 'string' || id.length === 0) {
    throw new FeedbackSubmitError('submit', res.status, json)
  }
  return id
}

// ── 本地对账台账 ────────────────────────────────────────────────────────────────
//
// 私有 API 的失效是静默的，出问题时 owner 需要能对账「我提交过哪些、成没成」。
// 只留最近 N 条，纯本地，不含附件内容。

export const FEEDBACK_LOG_MAX = 20

export interface FeedbackLogEntry {
  at: number
  kind: FeedbackKind
  title: string
  ok: boolean
  /** 成功时的回执编号。 */
  submissionBlockId?: string
  /** 失败时的原因摘要（stage + status）。 */
  error?: string
  viaAgent?: boolean
}

/** 追加一条并裁到上限（纯函数，方便两侧共用与测试）。 */
export function appendFeedbackLog(
  log: readonly FeedbackLogEntry[],
  entry: FeedbackLogEntry
): FeedbackLogEntry[] {
  return [entry, ...log].slice(0, FEEDBACK_LOG_MAX)
}
