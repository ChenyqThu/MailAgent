// Sprint 2 hotfix — mail_parse.ts pure logic. parseSender drives EmailRow's
// "Name · addr" header (mockup §5.1 pattern); cleanSnippet strips the
// markdown-table residue markdownify emits for Outlook safety banners /
// inline images.

import { describe, expect, test } from 'vitest'

import { parseAddressList, parseSender, cleanSnippet } from '../../src/shared/lib/mail_parse'

describe('parseSender', () => {
  test('RFC 822 quoted-name + angle-addr', () => {
    expect(parseSender('"Justin Ma" <justin.ma@tp-link.com>')).toEqual({
      name: 'Justin Ma',
      email: 'justin.ma@tp-link.com'
    })
  })

  test('Unquoted name + angle-addr (most common from mail-sync)', () => {
    expect(parseSender('Justin Ma <justin.ma@tp-link.com>')).toEqual({
      name: 'Justin Ma',
      email: 'justin.ma@tp-link.com'
    })
  })

  test('Chinese name in quotes', () => {
    expect(parseSender('"YuanQuan.Chen陈源泉" <chenyq.thu@gmail.com>')).toEqual({
      name: 'YuanQuan.Chen陈源泉',
      email: 'chenyq.thu@gmail.com'
    })
  })

  test('Multi-word display name', () => {
    expect(parseSender('Sannie at Superhuman <hello@superhuman.com>')).toEqual({
      name: 'Sannie at Superhuman',
      email: 'hello@superhuman.com'
    })
  })

  test('Bare email address', () => {
    expect(parseSender('alice@example.com')).toEqual({
      name: '',
      email: 'alice@example.com'
    })
  })

  test('null / empty', () => {
    expect(parseSender(null)).toEqual({ name: '', email: '' })
    expect(parseSender('')).toEqual({ name: '', email: '' })
    expect(parseSender('   ')).toEqual({ name: '', email: '' })
  })

  test('Malformed input surfaces the raw value as name (so the row never blanks)', () => {
    expect(parseSender('totally not an email')).toEqual({
      name: 'totally not an email',
      email: ''
    })
  })
})

describe('cleanSnippet', () => {
  test('returns null for null/empty', () => {
    expect(cleanSnippet(null)).toBeNull()
    expect(cleanSnippet('')).toBeNull()
    expect(cleanSnippet(undefined)).toBeNull()
  })

  test('passes through plain prose unchanged', () => {
    expect(cleanSnippet('Hello world — short message.')).toBe('Hello world — short message.')
  })

  test('truncates at maxLen with ellipsis', () => {
    const long = 'a'.repeat(200)
    const out = cleanSnippet(long, 50)!
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(51)
  })

  test('strips Outlook safety-banner table residue (the real production case)', () => {
    const md = `  |  |  |
| --- | --- | --- |
|  | You don't often get email from hello@superhuman.com. [Learn why this is important](https://aka.ms/LearnAboutSenderIdentification) |  |

![](https://iterable-links.s)
Hi Lucien, please update payment information for Superhuman Mail.`
    const out = cleanSnippet(md, 200)!
    // The first real prose line is the safety-banner text; that's fine — it
    // IS the first prose. The crucial part is that the leading `|---|`
    // garbage is gone.
    expect(out).not.toContain('---')
    expect(out).not.toContain('|  |  |')
    expect(out).toMatch(/You don't often|Hi Lucien/)
  })

  test('strips image-only lines + inline image syntax', () => {
    const md = `![banner](https://x.com/img.png)

Welcome to MailAgent.`
    expect(cleanSnippet(md)).toBe('Welcome to MailAgent.')
  })

  test('converts markdown links to plain text', () => {
    expect(cleanSnippet('Click [here](https://example.com) to confirm.')).toBe(
      'Click here to confirm.'
    )
  })

  test('strips bold/italic markers', () => {
    expect(cleanSnippet('This is **bold** and _italic_ text.')).toBe(
      'This is bold and italic text.'
    )
  })

  test('strips heading markers but keeps text', () => {
    expect(cleanSnippet('# Welcome\n\nThis is the body.')).toBe('Welcome This is the body.')
  })

  test('handles markdown blockquote prefix', () => {
    expect(cleanSnippet('> quoted reply\nmy answer below')).toBe('quoted reply my answer below')
  })

  test('returns null if only separators / images', () => {
    const md = `| --- | --- |
| --- | --- |
![](x.png)
---`
    expect(cleanSnippet(md)).toBeNull()
  })

  test('keeps CJK content intact', () => {
    const md = '这是一封正文双写测试邮件。\n\n附上了一个测试附件，和一个内联图片。'
    const out = cleanSnippet(md, 80)!
    expect(out).toContain('这是一封正文双写测试邮件')
    expect(out).toContain('附上了一个测试附件')
  })
})

// 通讯录 WP4 —— shared 地址切分器（EmailDetail chip 流 + ComposePanel 草稿回填共用）。
describe('parseAddressList', () => {
  test('mixed comma/semicolon list with names, bare addr and angle-addr', () => {
    expect(parseAddressList('"Justin Ma" <justin.ma@tp-link.com>, bob@y.com; Carol <carol@z.com>')).toEqual([
      { name: 'Justin Ma', email: 'justin.ma@tp-link.com' },
      { name: '', email: 'bob@y.com' },
      { name: 'Carol', email: 'carol@z.com' }
    ])
  })

  test('quoted display name containing a comma stays ONE entry', () => {
    expect(parseAddressList('"Doe, John" <john.doe@x.com>, a@y.com')).toEqual([
      { name: 'Doe, John', email: 'john.doe@x.com' },
      { name: '', email: 'a@y.com' }
    ])
  })

  test('single bare address', () => {
    expect(parseAddressList('solo@x.com')).toEqual([{ name: '', email: 'solo@x.com' }])
  })

  test('empty / null / undefined → []', () => {
    expect(parseAddressList('')).toEqual([])
    expect(parseAddressList(null)).toEqual([])
    expect(parseAddressList(undefined)).toEqual([])
    expect(parseAddressList('  ,  ;  ')).toEqual([])
  })

  test('de-dupes case-insensitively, keeps first casing', () => {
    expect(parseAddressList('A@X.com, a@x.com, b@y.com')).toEqual([
      { name: '', email: 'A@X.com' },
      { name: '', email: 'b@y.com' }
    ])
  })

  test('unparseable token surfaces raw as email with empty name (old parseAddrList parity)', () => {
    expect(parseAddressList('Undisclosed recipients')).toEqual([
      { name: '', email: 'Undisclosed recipients' }
    ])
  })
})
