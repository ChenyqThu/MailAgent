// mailbox 语义跨语言一致性闸 + 列表过滤展开语义 (issue #42 / 后续)。
//
// 背景: `email_metadata.mailbox` 的同一概念存在多种历史写法 (发件箱/已发送/Sent/…)。
// C 案 (v1.14.1) 把判定集收进单源 —— 后端 `src/mail/mailbox_semantics.py`, 前端手抄
// 镜像 `src/shared/lib/mailboxSemantics.ts` (TS 无法 import Python 常量)。**漏一种写法
// 即静默 bug** 正是本 issue 的病根, 所以两边成员必须恒等, 靠本测试替代记忆。
//
// 后续轮 (本文件新增): 内建三视图的列表查询从单值 `=` 改判定集 `IN (...)`。提交者 fork
// 生产实证 —— 库里 mailbox='INBOX' 的历史行在收件箱视图**不可见**, 只在「所有邮件」
// 露出, 而判定面 (Sent 游标/报告/飞书) 已认全变体。
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

import {
  DRAFT_MAILBOX_LABELS,
  DRAFTS_LABEL,
  INBOX_LABEL,
  INBOX_MAILBOX_LABELS,
  SENT_LABEL,
  SENT_MAILBOX_LABELS,
  mailboxFilterLabels,
  viewForMailbox
} from '../../../src/shared/lib/mailboxSemantics'

const HERE = dirname(fileURLToPath(import.meta.url))
// frontend/tests/shared/lib → 上溯四级到仓库根。
const REPO_ROOT = resolve(HERE, '../../../..')

/** 从 Python 单源里抽 `NAME: Tuple[str, ...] = (...)` 的字符串成员 (声明序)。 */
function pythonVariants(pySrc: string, name: string): string[] {
  const block = pySrc.match(
    new RegExp(`${name}:\\s*Tuple\\[str, \\.\\.\\.\\]\\s*=\\s*\\(([^)]*)\\)`)
  )
  expect(block, `mailbox_semantics.py 里没找到 ${name} 的 tuple 定义`).not.toBeNull()
  // 成员形如 SENT_LABEL(常量引用) 或 "已发送"(字面量) —— 只取字面量, 常量引用由
  // canonical 断言单独覆盖 (下方 test)。
  return [...block![1].matchAll(/"([^"]*)"/g)].map((m) => m[1])
}

describe('mailbox 变体集跨语言一致性', () => {
  const pySrc = readFileSync(resolve(REPO_ROOT, 'src/mail/mailbox_semantics.py'), 'utf8')

  test.each([
    ['INBOX_LABEL_VARIANTS', INBOX_MAILBOX_LABELS, INBOX_LABEL],
    ['SENT_LABEL_VARIANTS', SENT_MAILBOX_LABELS, SENT_LABEL],
    ['DRAFT_LABEL_VARIANTS', DRAFT_MAILBOX_LABELS, DRAFTS_LABEL]
  ])('%s 成员与前端镜像逐一相等 (含声明序)', (pyName, tsLabels, canonical) => {
    const pyLiterals = pythonVariants(pySrc, pyName)
    // Python 侧首位是 canonical 常量引用 (非字面量), 前端镜像同序展开。
    expect(
      [canonical, ...pyLiterals],
      `${pyName} 与前端 mailboxSemantics.ts 漂移 —— 改集合必须两边同步 (漏一种写法 = 静默 bug)`
    ).toEqual([...tsLabels])
  })
})

describe('mailboxFilterLabels — 列表过滤展开', () => {
  test('内建 canonical 展开成变体全集', () => {
    expect(mailboxFilterLabels(INBOX_LABEL)).toEqual(INBOX_MAILBOX_LABELS)
    expect(mailboxFilterLabels(SENT_LABEL)).toEqual(SENT_MAILBOX_LABELS)
    expect(mailboxFilterLabels(DRAFTS_LABEL)).toEqual(DRAFT_MAILBOX_LABELS)
  })

  test('传变体本身也展开到同一全集', () => {
    expect(mailboxFilterLabels('INBOX')).toEqual(INBOX_MAILBOX_LABELS)
    expect(mailboxFilterLabels('Sent Items')).toEqual(SENT_MAILBOX_LABELS)
    expect(mailboxFilterLabels('草稿')).toEqual(DRAFT_MAILBOX_LABELS)
  })

  test('viewForMailbox 同径认变体 (搜索结果点变体行落内建视图, 不退回「所有邮件」)', () => {
    expect(viewForMailbox('INBOX')).toBe('inbox')
    expect(viewForMailbox('Sent Items')).toBe('outbox')
    expect(viewForMailbox('草稿')).toBe('drafts')
    // 存档 / 自定义文件夹 / 空值仍落 'all' (无内建视图)
    expect(viewForMailbox('存档')).toBe('all')
    expect(viewForMailbox('DMS固件发布')).toBe('all')
    expect(viewForMailbox(null)).toBe('all')
  })

  test('自定义文件夹 / 存档保持精确匹配 (单元素)', () => {
    // 🔴 已知取舍的反向锁: 展开只对内建 canonical/变体生效, 自定义文件夹只认自己。
    expect(mailboxFilterLabels('DMS固件发布')).toEqual(['DMS固件发布'])
    expect(mailboxFilterLabels('存档')).toEqual(['存档'])
    expect(mailboxFilterLabels('')).toEqual([''])
  })
})
