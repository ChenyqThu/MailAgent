// Compose — daemon forwarder + opts validation (D1: 收编本机 serve-api in-process)。
//
// 旧契约测 composeArgs 的 CLI argv 形状; D1 起 compose 经 daemonRequest 转发本机
// serve-api (bodyHtml 直进 JSON body, 无临时文件), 故改测:
//   - runComposeDraft/runComposeSend/runDraftPlan 的 method/path/body
//     (mirror HttpApi.email.draft/.send/.draftPlan)
//   - validateComposeOpts 仍守 internalId / mode (转发前早校验)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockDaemonRequest, mockDaemonRequestRaw } = vi.hoisted(() => ({
  mockDaemonRequest: vi.fn(),
  mockDaemonRequestRaw: vi.fn()
}))

vi.mock('../../src/electron/main/daemon_api', () => ({
  daemonRequest: mockDaemonRequest,
  daemonRequestRaw: mockDaemonRequestRaw
}))

import { __testing } from '../../src/electron/main/handlers/draft'
import type { ComposeDraftOpts } from '@shared/api/types'

const {
  validateComposeOpts,
  runComposeDraft,
  runComposeSend,
  runDraftPlan,
  runComposeAttachmentUpload
} = __testing

beforeEach(() => {
  mockDaemonRequest.mockReset()
  mockDaemonRequest.mockResolvedValue({ ok: 'stub' })
  mockDaemonRequestRaw.mockReset()
  mockDaemonRequestRaw.mockResolvedValue({ stage_id: 'stub' })
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

  test('composeAttachmentUpload → PUT raw bytes (octet-stream), filename/mime 走 query', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    await runComposeAttachmentUpload('报 告.pdf', bytes, 'application/pdf')
    expect(mockDaemonRequestRaw).toHaveBeenCalledWith(
      'PUT',
      '/email/compose-attachment',
      bytes,
      'application/octet-stream',
      { query: { filename: '报 告.pdf', mime: 'application/pdf' } }
    )
  })

  test('draft body 可带 D1 attachments refs (stage_id / attachment_id 原样透传)', async () => {
    const opts: ComposeDraftOpts = {
      internalId: -1,
      mode: 'new',
      to: ['a@b.com'],
      bodyHtml: '<p>hi</p>',
      attachments: [{ stage_id: 'st-1' }, { attachment_id: 7 }]
    }
    await runComposeDraft(opts)
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/email/draft', { body: opts })
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
