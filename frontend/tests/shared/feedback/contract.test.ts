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
function fakeFetch(opts?: { submitStatus?: number; submitBody?: unknown; uploadStatus?: number }): {
  impl: typeof fetch
  calls: { url: string; init?: RequestInit }[]
} {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/getFormUploadFileUrl')) {
      return new Response(
        JSON.stringify({
          signedPostUrl: 'https://s3.test/upload',
          fields: { key: 'k', policy: 'p' },
          token: 'jwt-token'
        }),
        { status: 200 }
      )
    }
    if (url === 'https://s3.test/upload') {
      return new Response(null, { status: opts?.uploadStatus ?? 204 })
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
    await submitFeedbackToNotion(
      { ...base, screenshot: shot },
      { ...DEPS, fetchImpl: withShot.impl }
    )
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

  test('建议类提交出去的 payload 里也没有复现频率（端到端，不是只测 builder）', async () => {
    const { impl, calls } = fakeFetch()
    await submitFeedbackToNotion({ ...base, kind: '建议' }, { ...DEPS, fetchImpl: impl })
    const props = submitBodyOf(calls).blockProperties as Record<string, unknown>
    expect(props[P.freq]).toEqual([])
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
      submitFeedbackToNotion({ ...base, screenshot: shot }, { ...DEPS, fetchImpl: impl })
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
