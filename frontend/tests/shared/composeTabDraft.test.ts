// compose 现场快照的形状收窄（08-27 P2 Lane W）：TabDescriptor.draft 是 store 不解释的
// 开放形状 + 会进 localStorage（可能被手改 / 来自旧版本），读侧必须整份校验。

import { describe, expect, test } from 'vitest'

import {
  readComposeTabDraft,
  toDraftSnapshot,
  type ComposeTabDraft
} from '../../src/shared/components/email/compose/composeTabDraft'

const VALID: ComposeTabDraft = {
  kind: 'compose',
  mode: 'reply',
  to: ['a@x.com'],
  cc: [],
  bcc: [],
  subject: 'Re: hi',
  importance: 'high',
  ccVisible: false,
  bccVisible: false,
  bodyHtml: '<p>草稿</p>',
  lineHeightChoice: '',
  attachments: [{ filename: 'a.pdf', size: 12, stageId: 's1' }],
  fwdHydrated: false,
  dirty: true
}

describe('readComposeTabDraft', () => {
  test('JSON 往返后逐字段恢复（快照进 localStorage 的真实路径）', () => {
    const roundtrip = JSON.parse(JSON.stringify(toDraftSnapshot(VALID)))
    expect(readComposeTabDraft(roundtrip)).toEqual(VALID)
  })

  test('kind / mode / 字段形状不对 → 整份放弃（null）', () => {
    expect(readComposeTabDraft(null)).toBeNull()
    expect(readComposeTabDraft(undefined)).toBeNull()
    expect(readComposeTabDraft({})).toBeNull()
    expect(readComposeTabDraft({ ...VALID, kind: 'other' })).toBeNull()
    expect(readComposeTabDraft({ ...VALID, mode: 'draft-edit' })).toBeNull()
    expect(readComposeTabDraft({ ...VALID, to: 'a@x.com' })).toBeNull()
    expect(readComposeTabDraft({ ...VALID, subject: 7 })).toBeNull()
  })

  test('可选/降级字段：importance 非法归 normal，坏附件条目丢弃，bodyHtml 非串归 null', () => {
    const parsed = readComposeTabDraft({
      ...VALID,
      importance: 'urgent',
      bodyHtml: 7,
      attachments: [{ filename: 'ok.txt' }, { nope: true }, null]
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.importance).toBe('normal')
    expect(parsed?.bodyHtml).toBeNull()
    expect(parsed?.attachments).toEqual([{ filename: 'ok.txt', size: null }])
  })
})
