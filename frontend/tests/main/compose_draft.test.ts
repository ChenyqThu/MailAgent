// Compose — daemon forwarder + opts validation (D1: 收编本机 serve-api in-process)。
//
// 旧契约测 composeArgs 的 CLI argv 形状; D1 起 compose 经 daemonRequest 转发本机
// serve-api (bodyHtml 直进 JSON body, 无临时文件), 故改测:
//   - runComposeDraft/runComposeSend/runDraftPlan 的 method/path/body
//     (mirror HttpApi.email.draft/.send/.draftPlan)
//   - validateComposeOpts 仍守 internalId / mode (转发前早校验)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockDaemonRequest } = vi.hoisted(() => ({ mockDaemonRequest: vi.fn() }))

vi.mock('../../src/electron/main/daemon_api', () => ({
  daemonRequest: mockDaemonRequest
}))

import { __testing } from '../../src/electron/main/handlers/draft'
import type { ComposeDraftOpts } from '@shared/api/types'

const { validateComposeOpts, runComposeDraft, runComposeSend, runDraftPlan } = __testing

beforeEach(() => {
  mockDaemonRequest.mockReset()
  mockDaemonRequest.mockResolvedValue({ ok: 'stub' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('compose forwarders — daemon path/body (mock daemonRequest)', () => {
  test('draft → POST /email/draft, body = full ComposeDraftOpts (bodyHtml inline, no temp file)', async () => {
    const opts: ComposeDraftOpts = {
      internalId: 53675,
      mode: 'reply-all',
      to: ['a@b.com', 'c@d.com'],
      cc: ['e@f.com'],
      subject: 'Re: x',
      bodyHtml: '<p>hi</p>'
    }
    await runComposeDraft(opts)
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/email/draft', { body: opts })
  })

  test('send → POST /email/send, body = opts (no --yes; server forces confirmed)', async () => {
    const opts: ComposeDraftOpts = {
      internalId: 1,
      mode: 'forward',
      to: ['x@y.z'],
      bodyHtml: '<p>fwd</p>'
    }
    await runComposeSend(opts)
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/email/send', { body: opts })
  })

  test('draftPlan → POST /email/{id}/draft-plan, body = { mode } only (id in path)', async () => {
    await runDraftPlan({ internalId: 53675, mode: 'reply' })
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/email/53675/draft-plan', {
      body: { mode: 'reply' }
    })
  })
})

describe('validateComposeOpts — guards', () => {
  test('valid opts pass through unchanged', () => {
    const opts: ComposeDraftOpts = { internalId: 5, mode: 'reply' }
    expect(validateComposeOpts(opts, 'email:draft')).toBe(opts)
  })

  test('missing opts → E_INVALID_ARG envelope', () => {
    const out = validateComposeOpts(undefined, 'email:draft')
    expect(out).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })

  test('negative internalId → E_INVALID_ARG', () => {
    const out = validateComposeOpts({ internalId: -1, mode: 'reply' }, 'email:draft')
    expect(out).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })

  test('bad mode → E_INVALID_ARG', () => {
    const out = validateComposeOpts(
      { internalId: 1, mode: 'bogus' as ComposeDraftOpts['mode'] },
      'email:send'
    )
    expect(out).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })
})
