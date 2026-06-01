// seed-prompts.ts — 打包首次 seed 出厂 prompt 模板到 userData/prompts 的行为契约。
//
// seed-prompts → cli_runner/db → import electron; vi.mock 防 import 挂。用 env override
// (MAILAGENT_PROJECT_ROOT 控 resolveBundledResourcesRoot, MAILAGENT_DATA_ROOT 控
// resolveDataRoot) 把 src/dest 指到 tmpdir scratch, 不碰真实 ~/Library 或仓库 prompts/。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// vi.hoisted: vi.mock 被 hoist 到顶, factory 引用的 appMock 须在那之前初始化 (否则 TDZ)。
const { appMock } = vi.hoisted(() => ({
  appMock: { isPackaged: true, getPath: (_k: string) => '/tmp' } as {
    isPackaged: boolean
    getPath: (key: string) => string
  }
}))
vi.mock('electron', () => ({ app: appMock }))

const { seedPromptTemplatesIfNeeded } = await import('../../src/electron/main/lib/seed-prompts')

let srcRoot: string
let destRoot: string

beforeEach(() => {
  const u = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  srcRoot = join(tmpdir(), `seed-src-${u}`)
  destRoot = join(tmpdir(), `seed-dest-${u}`)
  mkdirSync(join(srcRoot, 'prompts'), { recursive: true })
  writeFileSync(join(srcRoot, 'prompts', 'email_inbox.md'), '# inbox template', 'utf8')
  writeFileSync(join(srcRoot, 'prompts', 'email_sent.md'), '# sent template', 'utf8')
  process.env['MAILAGENT_PROJECT_ROOT'] = srcRoot // resolveBundledResourcesRoot 读
  process.env['MAILAGENT_DATA_ROOT'] = destRoot // resolveDataRoot 读
})

afterEach(() => {
  delete process.env['MAILAGENT_PROJECT_ROOT']
  delete process.env['MAILAGENT_DATA_ROOT']
  for (const r of [srcRoot, destRoot]) if (existsSync(r)) rmSync(r, { recursive: true, force: true })
})

describe('seedPromptTemplatesIfNeeded', () => {
  test('首次 (dest 空) → copy bundle 模板到 userData/prompts', () => {
    seedPromptTemplatesIfNeeded()
    expect(readFileSync(join(destRoot, 'prompts', 'email_inbox.md'), 'utf8')).toBe('# inbox template')
    expect(readFileSync(join(destRoot, 'prompts', 'email_sent.md'), 'utf8')).toBe('# sent template')
  })

  test('dest 已存在 → 不覆盖 (保用户编辑), 缺的仍补', () => {
    mkdirSync(join(destRoot, 'prompts'), { recursive: true })
    writeFileSync(join(destRoot, 'prompts', 'email_inbox.md'), '# user edited', 'utf8')
    seedPromptTemplatesIfNeeded()
    expect(readFileSync(join(destRoot, 'prompts', 'email_inbox.md'), 'utf8')).toBe('# user edited')
    expect(readFileSync(join(destRoot, 'prompts', 'email_sent.md'), 'utf8')).toBe('# sent template')
  })

  test('dev (src===dest) → 跳过, 不创建文件', () => {
    process.env['MAILAGENT_PROJECT_ROOT'] = destRoot // src=dest
    seedPromptTemplatesIfNeeded()
    expect(existsSync(join(destRoot, 'prompts', 'email_inbox.md'))).toBe(false)
  })
})
