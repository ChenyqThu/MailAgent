// @vitest-environment happy-dom
//
// decodeImapUtf7 —— 跨语言镜像的一致性闸 (task 08-20-perf-shell-prefetch-sidebar §③)。
//
// 🔴 算法单源在后端 `src/mail/backend/imap_utf7.py::decode_imap_utf7`; 下面的期望值
// 全部由该 Python 实现现算生成 (venv python 逐条跑过), 其中前两条与
// tests/api/test_folder_discover.py 的 fixture / multi-folder-sync gate 是同一批实测
// 样本。改任何一侧的解码行为, 先回去对 Python 输出再改这里的向量。

import { describe, expect, test } from 'vitest'

import { decodeImapUtf7 } from '@shared/lib/imapUtf7'

describe('decodeImapUtf7 — 与 Python decode_imap_utf7 的共享向量', () => {
  test('实测样本 (multi-folder-sync gate 同源)', () => {
    expect(decodeImapUtf7('DMS&VvpO9lPRXgM-')).toBe('DMS固件发布')
    expect(decodeImapUtf7('&W,mL3VOGU,KLsF9V-')).toBe('对话历史记录')
  })

  test('纯 ASCII 原样返回', () => {
    expect(decodeImapUtf7('Jira')).toBe('Jira')
    expect(decodeImapUtf7('Proj/Q2')).toBe('Proj/Q2')
    expect(decodeImapUtf7('')).toBe('')
  })

  test('`&-` = 字面 &', () => {
    expect(decodeImapUtf7('R&-D')).toBe('R&D')
    expect(decodeImapUtf7('&-')).toBe('&')
  })

  test('层级路径: 编码段不含字面 "/", 按 "/" 切层级安全', () => {
    // Python: 'Proj/&MEYw6TC5-' -> 'Proj/うラス'
    expect(decodeImapUtf7('Proj/&MEYw6TC5-')).toBe('Proj/うラス')
    // Python: 'A&ZeVnLA-B' -> 'A日本B' (编码段夹在 ASCII 之间)
    expect(decodeImapUtf7('A&ZeVnLA-B')).toBe('A日本B')
  })

  test('UTF-16 代理对 (astral 字符) 正确拼合', () => {
    // Python: '&2D3cqA-' -> '💨' (U+1F4A8, UTF-16BE 代理对)
    expect(decodeImapUtf7('&2D3cqA-')).toBe('💨')
  })

  test('非法输入不抛异常, 尽力保留原文', () => {
    // 缺结束符: 与 Python 同 —— 按字面保留剩余内容。
    expect(decodeImapUtf7('&broken')).toBe('&broken')
    // 无效 base64: TS 保留原始分段 '&!!!-' (Python 的 b64decode(validate=False) 会
    // 丢弃非法字符解出空串 → 'x')。已知的良性分歧: 两侧都不抛; 真实 Exchange 文件夹
    // 名不会出现非法编码段, 且 discover 回来后正式树会纠正。
    expect(decodeImapUtf7('&!!!-x')).toBe('&!!!-x')
  })
})
