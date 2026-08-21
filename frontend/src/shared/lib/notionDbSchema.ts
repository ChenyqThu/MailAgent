// task 08-20 Notion OAuth — 两库 schema 契约的 TS 运行时消费面。
//
// 单源 = 同目录 notionDbSchema.contract.json（机器可读唯一权威，🔴 内容以写入侧代码
// 为准；Python 侧由 tests/notion/test_schema_contract_parity.py 对同一 JSON 与写入侧
// property 名集合对账）。本文件是**零依赖叶子**：只 import 那份 JSON，不 import
// electron / 任何重模块 —— electron main（notion_oauth.ts 库发现）与 renderer
//（Lane 3 选择器 UI）都要用它，且 vitest 直接可测（纯函数）。
//
// 语义（design.md v2「库发现与校验」+「schema 必需字段单源」）：
//   * 角色识别按 schema 签名不按标题：signature=true 的字段（名 + 类型）全命中
//     才算该角色；两个角色的签名同时命中 → 'unknown'（无法唯一识别，进选择器）。
//   * 两档校验：required 档（默认同步路径会写）缺失/类型不符 → invalid + missing
//     清单；recommended 档（仅可选功能如 LLM agent 写）缺失 → 只进 warnings，
//     不影响 valid（UI 提示但允许选用）。

import contract from './notionDbSchema.contract.json'

export type NotionDbRole = 'email' | 'calendar'

export interface ContractProperty {
  name: string
  /** Notion property type 字面量（title / rich_text / select / date / ...）。 */
  type: string
  /** 角色识别签名字段（design.md：邮件库 = Subject(title)+Message ID；日历库 = Event ID+Time(date)）。 */
  signature: boolean
}

/** 库发现请求统一带的 Notion-Version（2025-09-03 data source 语义；
 *  client.py 里 2022-06-28 是个别老请求的遗留，不作参照）。 */
export const NOTION_API_VERSION: string = contract.notionVersion

/** Notion data source `properties` 映射里单个 property 对象的最小形状。 */
export interface NotionPropertyLike {
  type?: string
}

export function requiredProperties(role: NotionDbRole): readonly ContractProperty[] {
  return contract.databases[role].requiredProperties
}

export function recommendedProperties(role: NotionDbRole): readonly ContractProperty[] {
  return contract.databases[role].recommendedProperties
}

export interface SchemaValidationResult {
  /** required 档全齐才为 true（recommended 缺失不影响）。 */
  valid: boolean
  /** required 档缺失/类型不符清单，如 `Message ID (rich_text)`、`Date (date, 现为 rich_text)`。 */
  missing: string[]
  /** recommended 档缺失/类型不符清单（仅提示，不拦）。 */
  warnings: string[]
}

function tierGaps(
  tier: readonly ContractProperty[],
  properties: Record<string, NotionPropertyLike | undefined>
): string[] {
  const gaps: string[] = []
  for (const req of tier) {
    const actual = properties[req.name]
    if (actual === undefined) {
      gaps.push(`${req.name} (${req.type})`)
    } else if (actual.type !== req.type) {
      gaps.push(`${req.name} (${req.type}, 现为 ${actual.type ?? 'unknown'})`)
    }
  }
  return gaps
}

/** 两档字段校验（data source 的 properties 映射 → required 缺失 + recommended 提示）。 */
export function validateDataSourceProperties(
  role: NotionDbRole,
  properties: Record<string, NotionPropertyLike | undefined>
): SchemaValidationResult {
  const missing = tierGaps(requiredProperties(role), properties)
  const warnings = tierGaps(recommendedProperties(role), properties)
  return { valid: missing.length === 0, missing, warnings }
}

function signatureMatches(
  role: NotionDbRole,
  properties: Record<string, NotionPropertyLike | undefined>
): boolean {
  return requiredProperties(role)
    .filter((p) => p.signature)
    .every((p) => properties[p.name]?.type === p.type)
}

/** 按 schema 签名识别 data source 角色。两个签名都命中 / 都不命中 → 'unknown'
 *  （不盲选 —— 交给选择器由用户挑）。 */
export function classifyDataSource(
  properties: Record<string, NotionPropertyLike | undefined>
): NotionDbRole | 'unknown' {
  const isEmail = signatureMatches('email', properties)
  const isCalendar = signatureMatches('calendar', properties)
  if (isEmail && !isCalendar) return 'email'
  if (isCalendar && !isEmail) return 'calendar'
  return 'unknown'
}
