// Onboarding 用户状态检测 (打包 P2)。
//
// 信号 = DATA_ROOT/.env 是否存在且含必填项。无需额外 settings flag: .env 里必填键齐全
// 本身就是"已配置"的权威信号 (下次启动 detect 到 configured → 正常起后端)。
//
// 必填键口径与后端 config.py 的 Field(...) 强制项对齐 (task 07-12 P3b: Notion 可选化后
// 仅剩 USER_EMAIL —— NOTION_TOKEN/EMAIL_DATABASE_ID 改为 default=""、缺失时后端走
// 本地-only 同步)。🔴 判据与向导的 .env 写入约定必须一致: buildCompletePatch 对空值
// 是"丢弃不写行" (不会写 NOTION_TOKEN=)、detect 只要求 USER_EMAIL —— 跳过 Notion 的
// 用户不会循环弹向导。
//   (MAIL_ACCOUNT_NAME 默认 Exchange、CALENDAR_DATABASE_ID 默认空, 不强制。)

import { existsSync, readFileSync } from 'fs'

import { resolveEnvPath } from '../lib/env-path'

export type UserState =
  | 'new' // 无 .env: 全新用户, 走配置向导
  | 'config-incomplete' // 有 .env 但缺必填项: 跳到向导补填
  | 'configured' // 必填齐全: 正常起后端

export const ONBOARDING_REQUIRED_KEYS = ['USER_EMAIL'] as const

/** 解析 .env 文本里"有非空值"的 key 集合 (不依赖 pydantic, 简单行解析)。 */
function activeEnvKeys(text: string): Set<string> {
  const keys = new Set<string>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (key && val !== '' && val !== '""' && val !== "''") keys.add(key)
  }
  return keys
}

/**
 * 检测用户状态。opts.envPath 可注入便于单测。
 */
export function detectUserState(opts: { envPath?: string } = {}): UserState {
  const envPath = opts.envPath ?? resolveEnvPath()
  if (!existsSync(envPath)) return 'new'
  let text = ''
  try {
    text = readFileSync(envPath, 'utf8')
  } catch {
    // .env 存在但读不了 (权限) → 当全新处理, 让向导重写。
    return 'new'
  }
  const present = activeEnvKeys(text)
  const missing = ONBOARDING_REQUIRED_KEYS.filter((k) => !present.has(k))
  return missing.length > 0 ? 'config-incomplete' : 'configured'
}
