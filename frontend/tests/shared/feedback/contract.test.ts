// 快捷反馈的传输契约（task 08-27 P4a）—— payload 形状与失败可见。
//
// 🔴 这里断言的是 **payload 字段**，不是 UI class。「撤掉附件」「建议类不发复现频率」这两条
//    只有断言 payload 才抓得到静默错：界面上把勾去掉了、payload 里还带着，两者看起来一模一样。
// 🔴 三条失败路径各一条用例：网络错 / HTTP 200 但返回体没有 submissionBlockId / 403。
//    私有 API 的失效是静默的，「只看 res.ok」正是那个静默口。

import { describe, expect, test, vi } from 'vitest'

import {
  appendFeedbackLog,
  buildFeedbackBlockProperties,
  feedbackUploadName,
  FEEDBACK_LOG_MAX,
  FEEDBACK_PROPERTY_IDS,
  FeedbackSubmitError,
  submitFeedbackToNotion,
  type FeedbackSubmitInput
} from '../../../src/shared/feedback/contract'

const P = FEEDBACK_PROPERTY_IDS
const DEPS = { userAgent: 'Mozilla/5.0 (Macintosh) MailAgent/test' }

const base: FeedbackSubmitInput = {
  kind: '问题',
  title: '切换标签后正文停在上一封',
  detail: '开两个标签，来回切',
  freq: '偶发',
  version: '2.26.0 · darwin · /settings'
}

// ── payload ──────────────────────────────────────────────────────────────────

describe('buildFeedbackBlockProperties', () => {
  test('问题类：复现频率进 payload', () => {
    const props = buildFeedbackBlockProperties(base)
    expect(props[P.freq]).toEqual([['偶发']])
    expect(props[P.title]).toEqual([['切换标签后正文停在上一封']])
    expect(props[P.kind]).toEqual([['问题']])
  })

  test('🔴 建议类：复现频率整段不发（哪怕 input 里还留着值）', () => {
    const props = buildFeedbackBlockProperties({ ...base, kind: '建议', freq: '每次必现' })
    expect(props[P.kind]).toEqual([['建议']])
    expect(props[P.freq]).toEqual([])
  })

  test('咨询类同理', () => {
    expect(buildFeedbackBlockProperties({ ...base, kind: '咨询' })[P.freq]).toEqual([])
  })

  test('空字段传 [] 而不是省略（Notion 表单要求）', () => {
    const props = buildFeedbackBlockProperties({ kind: '咨询', title: 'x' })
    expect(Object.keys(props).sort()).toEqual(
      [P.title, P.kind, P.detail, P.freq, P.version, P.email, P.screenshot, P.diagnostics].sort()
    )
    expect(props[P.detail]).toEqual([])
    expect(props[P.email]).toEqual([])
  })

  test('文件属性的值恒空数组（真正的引用走 filePropertyIdToTokens）', () => {
    const props = buildFeedbackBlockProperties(base)
    expect(props[P.screenshot]).toEqual([])
    expect(props[P.diagnostics]).toEqual([])
  })
})

// ── 提交（成功路径 + 附件三步） ───────────────────────────────────────────────

/** 一个照 Notion 三个端点应答的假 fetch，记录每次调用。 */
function fakeFetch(opts?: {
  submitStatus?: number
  submitBody?: unknown
  uploadStatus?: number
  /** 换签名 URL 这一步的应答（模拟 Notion 按扩展名拒收）。 */
  metaFor?: (name: string) => { status: number; body: unknown } | undefined
}): {
  impl: typeof fetch
  calls: { url: string; init?: RequestInit }[]
} {
  const calls: { url: string; init?: RequestInit }[] = []
  let tokenSeq = 0
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/getFormUploadFileUrl')) {
      const name = (JSON.parse(String(init?.body)) as { name: string }).name
      const canned = opts?.metaFor?.(name)
      if (canned) return new Response(JSON.stringify(canned.body), { status: canned.status })
      return new Response(
        JSON.stringify({
          signedPostUrl: 'https://s3.test/upload',
          fields: { key: 'k', policy: 'p' },
          token: `jwt-token${tokenSeq++ === 0 ? '' : `-${tokenSeq - 1}`}`
        }),
        { status: 200 }
      )
    }
    if (url === 'https://s3.test/upload') {
      return new Response(opts?.uploadStatus === 204 || !opts?.uploadStatus ? null : 'boom', {
        status: opts?.uploadStatus ?? 204
      })
    }
    return new Response(JSON.stringify(opts?.submitBody ?? { submissionBlockId: 'blk-1' }), {
      status: opts?.submitStatus ?? 200
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

function submitBodyOf(calls: { url: string; init?: RequestInit }[]): Record<string, unknown> {
  const call = calls.find((c) => c.url.endsWith('/submitForm'))
  expect(call, 'submitForm was never called').toBeDefined()
  return JSON.parse(String(call?.init?.body)) as Record<string, unknown>
}

describe('submitFeedbackToNotion — 成功路径', () => {
  test('返回 submissionBlockId，且请求带正常 UA', async () => {
    const { impl, calls } = fakeFetch()
    const id = await submitFeedbackToNotion(base, { ...DEPS, fetchImpl: impl })
    expect(id).toBe('blk-1')
    const submit = calls.find((c) => c.url.endsWith('/submitForm'))
    const headers = submit?.init?.headers as Record<string, string>
    // 🔴 Cloudflare 按 UA 拦（403 error 1010），错误正文里没有任何线索。
    expect(headers['User-Agent']).toContain('Mozilla/5.0')
  })

  test('无附件时 filePropertyIdToTokens 为空 —— 一次上传都不发', async () => {
    const { impl, calls } = fakeFetch()
    await submitFeedbackToNotion(base, { ...DEPS, fetchImpl: impl })
    expect(calls.some((c) => c.url.endsWith('/getFormUploadFileUrl'))).toBe(false)
    expect(submitBodyOf(calls).filePropertyIdToTokens).toEqual({})
  })

  test('🔴 撤掉附件 = payload 真的少一项（带 vs 不带的两次提交对比）', async () => {
    const shot = { name: 's.png', type: 'image/png', body: new Uint8Array([1, 2, 3]) }

    const withShot = fakeFetch()
    await submitFeedbackToNotion({ ...base, images: [shot] }, { ...DEPS, fetchImpl: withShot.impl })
    expect(submitBodyOf(withShot.calls).filePropertyIdToTokens).toEqual({
      [P.screenshot]: ['jwt-token']
    })

    const withoutShot = fakeFetch()
    await submitFeedbackToNotion(base, { ...DEPS, fetchImpl: withoutShot.impl })
    expect(submitBodyOf(withoutShot.calls).filePropertyIdToTokens).toEqual({})
  })

  test('附件三步：contentLength 必须在换签名 URL 的请求里（漏了直接 400）', async () => {
    const { impl, calls } = fakeFetch()
    const diag = { name: 'd.zip', type: 'application/zip', body: new Uint8Array(11) }
    await submitFeedbackToNotion({ ...base, diagnostics: diag }, { ...DEPS, fetchImpl: impl })
    const meta = calls.find((c) => c.url.endsWith('/getFormUploadFileUrl'))
    const body = JSON.parse(String(meta?.init?.body)) as { contentLength?: number }
    expect(body.contentLength).toBe(11)
    expect(submitBodyOf(calls).filePropertyIdToTokens).toEqual({ [P.diagnostics]: ['jwt-token'] })
  })

  test('多张图 → 同一个 file property 挂多个 token（顺序与传入一致）', async () => {
    const { impl, calls } = fakeFetch()
    const img = (n: string) => ({ name: n, type: 'image/png', body: new Uint8Array([1]) })
    await submitFeedbackToNotion(
      { ...base, images: [img('a.png'), img('b.png')] },
      { ...DEPS, fetchImpl: impl }
    )
    expect(calls.filter((c) => c.url.endsWith('/getFormUploadFileUrl'))).toHaveLength(2)
    expect(submitBodyOf(calls).filePropertyIdToTokens).toEqual({
      [P.screenshot]: ['jwt-token', 'jwt-token-1']
    })
  })

  test('建议类提交出去的 payload 里也没有复现频率（端到端，不是只测 builder）', async () => {
    const { impl, calls } = fakeFetch()
    await submitFeedbackToNotion({ ...base, kind: '建议' }, { ...DEPS, fetchImpl: impl })
    const props = submitBodyOf(calls).blockProperties as Record<string, unknown>
    expect(props[P.freq]).toEqual([])
  })
})

// ── 🔴 诊断包的扩展名闸（08-31 dogfood：勾了诊断包必 400 的那个 bug） ────────────
//
// Notion 的表单上传按**扩展名**拦，`.zip` 恒 400 `Uploading .zip files is not allowed`
// （2026-08-31 对着真端点实测，同一份内容改名就过）。P4a 只验过 PNG，所以这条路一直是坏的。

describe('feedbackUploadName —— 被拦的扩展名再套一层 .txt', () => {
  test('诊断包 .zip → .zip.txt', () => {
    expect(feedbackUploadName('mailagent-diagnostics-20260831.zip')).toBe(
      'mailagent-diagnostics-20260831.zip.txt'
    )
  })

  test('实测同样被拦的几种一并处理', () => {
    expect(feedbackUploadName('a.gz')).toBe('a.gz.txt')
    expect(feedbackUploadName('a.7z')).toBe('a.7z.txt')
    expect(feedbackUploadName('a.json')).toBe('a.json.txt')
  })

  test('放行的一个字都不改（图片是主力附件，改名反而会破坏预览）', () => {
    expect(feedbackUploadName('shot.png')).toBe('shot.png')
    expect(feedbackUploadName('a.JPG')).toBe('a.JPG')
    expect(feedbackUploadName('log.txt')).toBe('log.txt')
    expect(feedbackUploadName('noext')).toBe('noext')
  })

  test('大小写不敏感（.ZIP 也是 zip）', () => {
    expect(feedbackUploadName('D.ZIP')).toBe('D.ZIP.txt')
  })
})

describe('🔴 诊断包上传：报给 Notion 的名字必须已过闸', () => {
  test('.zip 的诊断包上传时报的是 .zip.txt —— 否则真端点 400', async () => {
    const { impl, calls } = fakeFetch()
    await submitFeedbackToNotion(
      {
        ...base,
        diagnostics: { name: 'diag.zip', type: 'application/zip', body: new Uint8Array(9) }
      },
      { ...DEPS, fetchImpl: impl }
    )
    const meta = calls.find((c) => c.url.endsWith('/getFormUploadFileUrl'))
    const body = JSON.parse(String(meta?.init?.body)) as { name: string }
    expect(body.name).toBe('diag.zip.txt')
  })

  test('把真端点的拒收形状原样回放：过了闸的名字才拿得到 token', async () => {
    // metaFor 复刻实测行为 —— 只看扩展名，`.zip` 一律 400，别的放行。
    const { impl } = fakeFetch({
      metaFor: (name) =>
        name.toLowerCase().endsWith('.zip')
          ? {
              status: 400,
              body: {
                isNotionError: true,
                name: 'ValidationError',
                debugMessage: 'Uploading .zip files is not allowed',
                message: 'Something went wrong. (400)'
              }
            }
          : undefined
    })
    const id = await submitFeedbackToNotion(
      {
        ...base,
        diagnostics: { name: 'diag.zip', type: 'application/zip', body: new Uint8Array(9) }
      },
      { ...DEPS, fetchImpl: impl }
    )
    expect(id).toBe('blk-1')
  })

  test('🔴 上传失败时 Notion 说的原因要进 error.message（不然用户只看到 status 400）', async () => {
    const { impl } = fakeFetch({
      metaFor: () => ({
        status: 400,
        body: {
          debugMessage: 'Uploading .bin files is not allowed',
          message: 'Something went wrong. (400)'
        }
      })
    })
    await expect(
      submitFeedbackToNotion(
        {
          ...base,
          images: [{ name: 'x.bin', type: 'application/octet-stream', body: new Uint8Array(1) }]
        },
        { ...DEPS, fetchImpl: impl }
      )
    ).rejects.toThrow(/Uploading \.bin files is not allowed/)
  })
})

// ── 🔴 失败可见（三条路径都必须抛，绝不能当成功） ────────────────────────────

describe('submitFeedbackToNotion — 失败一律抛', () => {
  test('① 网络错（fetch reject）', async () => {
    const impl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch
    await expect(submitFeedbackToNotion(base, { ...DEPS, fetchImpl: impl })).rejects.toThrow(
      'ECONNREFUSED'
    )
  })

  test('② HTTP 200 但返回体没有 submissionBlockId —— 这就是「没发出去」', async () => {
    const { impl } = fakeFetch({ submitStatus: 200, submitBody: { ok: true } })
    await expect(submitFeedbackToNotion(base, { ...DEPS, fetchImpl: impl })).rejects.toBeInstanceOf(
      FeedbackSubmitError
    )
  })

  test('② bis：submissionBlockId 是空串同样算失败', async () => {
    const { impl } = fakeFetch({ submitBody: { submissionBlockId: '' } })
    await expect(submitFeedbackToNotion(base, { ...DEPS, fetchImpl: impl })).rejects.toBeInstanceOf(
      FeedbackSubmitError
    )
  })

  test('③ 403（Cloudflare error 1010 的形状）', async () => {
    const { impl } = fakeFetch({ submitStatus: 403, submitBody: { error: 'error code: 1010' } })
    await expect(submitFeedbackToNotion(base, { ...DEPS, fetchImpl: impl })).rejects.toMatchObject({
      stage: 'submit',
      status: 403
    })
  })

  test('附件上传非 204 → 抛在 upload 阶段，且**不提交表单**（不能留半条）', async () => {
    const { impl, calls } = fakeFetch({ uploadStatus: 200 })
    const shot = { name: 's.png', type: 'image/png', body: new Uint8Array([1]) }
    await expect(
      submitFeedbackToNotion({ ...base, images: [shot] }, { ...DEPS, fetchImpl: impl })
    ).rejects.toMatchObject({ stage: 'upload' })
    expect(calls.some((c) => c.url.endsWith('/submitForm'))).toBe(false)
  })
})

// ── 本地对账台账 ─────────────────────────────────────────────────────────────

describe('appendFeedbackLog', () => {
  test('新的在最前，且裁到上限', () => {
    let log = [] as ReturnType<typeof appendFeedbackLog>
    for (let i = 0; i < FEEDBACK_LOG_MAX + 5; i++) {
      log = appendFeedbackLog(log, { at: i, kind: '问题', title: `t${i}`, ok: true })
    }
    expect(log).toHaveLength(FEEDBACK_LOG_MAX)
    expect(log[0].title).toBe(`t${FEEDBACK_LOG_MAX + 4}`)
  })

  test('失败也进台账（对账时要能看到「发过但没成」）', () => {
    const log = appendFeedbackLog([], {
      at: 1,
      kind: '建议',
      title: 'x',
      ok: false,
      error: 'submit:403'
    })
    expect(log[0].ok).toBe(false)
    expect(log[0].error).toBe('submit:403')
  })
})
