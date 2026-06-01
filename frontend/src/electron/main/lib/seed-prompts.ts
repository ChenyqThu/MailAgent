// 打包首次运行: 把 bundle 出厂 prompt 模板 seed 到可写的 <userData>/prompts/。
//
// 背景: 后端 config.py 的 LLM prompt 默认路径 = _under_data_root('prompts/email_*.md')
// = <DATA_ROOT>/prompts/(打包态 DATA_ROOT=userData)。但出厂模板只经 electron-builder
// extraResources 装到 bundle 的 <resourcesPath>/prompts/(只读), 从没 copy 到可写的
// userData/prompts/ —— 打包首次该目录空 → 后端日志 "[llm-prompt] file not found ...
// using empty prompt" → LLM 用空 prompt 分类(质量退化)。v0.1.5 把前端读写 + 后端读都
// 锚到 userData/prompts(一致), 本模块补上"首次 seed 出厂模板"这一环。
//
// 调用点: index.ts app.whenReady 内、打包分支、registerBackendLifecycle() 之前
// (须在 backend spawn 前, 让 serve / serve-api 起来就读得到)。

import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

import { resolveBundledResourcesRoot } from '../cli_runner'
import { resolveDataRoot } from '../db'

/** 出厂 prompt 模板文件名 (与 handlers/prompts.ts DEFAULTS + config.py 默认对齐)。 */
const PROMPT_FILES = ['email_inbox.md', 'email_sent.md'] as const

/**
 * 把 <resourcesPath>/prompts/*.md (bundle 只读出厂模板) seed 到 <userData>/prompts/*.md。
 *
 * 规则:
 *  - **仅 copy 目标不存在的** —— 不覆盖用户在 Settings→AI 编辑过的版本。
 *  - dev 态 src===dest (resolveBundledResourcesRoot 与 resolveDataRoot 都落仓库根) → 整体
 *    跳过, 避免 copy 自己到自己。
 *  - 失败 non-fatal: 仅 console.error, 不抛 —— seed 不了顶多后端 fallback 空 prompt,
 *    不该阻塞 app 启动。
 */
export function seedPromptTemplatesIfNeeded(): void {
  try {
    const srcDir = join(resolveBundledResourcesRoot(), 'prompts')
    const destDir = join(resolveDataRoot(), 'prompts')
    if (srcDir === destDir) return // dev: 仓库 prompts/ 自己, 无需 seed
    let seeded = 0
    for (const name of PROMPT_FILES) {
      const dest = join(destDir, name)
      if (existsSync(dest)) continue // 已有 (用户编辑过的 / 上次 seed 的) → 不覆盖
      const src = join(srcDir, name)
      if (!existsSync(src)) continue // bundle 模板缺失 (理论不该发生)
      mkdirSync(destDir, { recursive: true })
      copyFileSync(src, dest)
      seeded++
    }
    if (seeded > 0) {
      console.log(`[seed-prompts] seeded ${seeded} 个出厂 prompt 模板 → ${destDir}`)
    }
  } catch (err) {
    console.error('[seed-prompts] seed 失败 (non-fatal; 后端将 fallback 空 prompt)', err)
  }
}
