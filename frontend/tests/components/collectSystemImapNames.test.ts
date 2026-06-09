// @vitest-environment node
//
// onboarding 纯逻辑测试 — collectSystemImapNames
//
// 测试 steps.tsx 导出的纯函数: 给定 FolderInfo[] 返回系统文件夹 imap_name Set。
// 无 DOM 依赖, node 环境即可。

import { describe, expect, test } from 'vitest'
import { collectSystemImapNames } from '../../src/electron/renderer/onboarding/steps'
import type { FolderInfo } from '../../src/shared/api/types'

function makeFolder(imap_name: string, is_system: boolean): FolderInfo {
  return {
    imap_name,
    display_name: imap_name,
    delimiter: '/',
    special_use: null,
    is_system,
    has_children: false,
    parent: null,
    message_count: 0,
    is_synced: false
  }
}

describe('collectSystemImapNames', () => {
  test('空列表 → 空 Set', () => {
    expect(collectSystemImapNames([])).toEqual(new Set())
  })

  test('混合列表 → 只含系统文件夹的 imap_name', () => {
    const folders: FolderInfo[] = [
      makeFolder('INBOX', true),
      makeFolder('Sent Items', true),
      makeFolder('Jira', false),
      makeFolder('DMS&VvpO9lPRXgM-', false)
    ]
    const result = collectSystemImapNames(folders)
    expect(result).toEqual(new Set(['INBOX', 'Sent Items']))
    expect(result.has('Jira')).toBe(false)
    expect(result.has('DMS&VvpO9lPRXgM-')).toBe(false)
  })

  test('全部自定义文件夹 → 空 Set', () => {
    const folders: FolderInfo[] = [makeFolder('Jira', false), makeFolder('Archive', false)]
    expect(collectSystemImapNames(folders)).toEqual(new Set())
  })

  test('全部系统文件夹 → 包含全部 imap_name', () => {
    const folders: FolderInfo[] = [
      makeFolder('INBOX', true),
      makeFolder('Drafts', true),
      makeFolder('Trash', true)
    ]
    expect(collectSystemImapNames(folders)).toEqual(new Set(['INBOX', 'Drafts', 'Trash']))
  })
})
