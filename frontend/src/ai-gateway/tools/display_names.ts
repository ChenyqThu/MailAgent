// 工具 description 的中文显示名注入 —— 装配面唯一 choke point。
//
// 模型看到的工具 description 全是英文字面量，散在 tools/*.ts 的各个工厂里。用户说「事项」
// 「跟进」「关注信号」时，模型要自己把中文概念桥到 `matter_*` 这类英文工具名上。这里在
// buildGatewayTools() 的最后一步把中文显示名拼到 description 前面：
//
//   matter_find → 「检索事项」Find Matters by text and structured filters. …
//
// 名字表是 shared/assistant/toolDisplayNames 的零依赖叶子模块（renderer i18n 的镜像 + 闸）。
// 表里没有的工具（MCP connector 的 `mcp__*` 动态工具等）description 原样不动。

import type { ToolSet } from 'ai'

// RELATIVE import（不是 @shared alias）—— 与 tools/types.ts 引 a2ui 同理：纯 Node 的 poc
// harness（tsx）不解析 tsconfig paths。
import { TOOL_DISPLAY_NAMES_ZH } from '../../shared/assistant/toolDisplayNames'

/** 给有中文名的工具的 description 加上「中文名」前缀。输入 ToolSet 不被修改。 */
export function applyToolDisplayNames(tools: ToolSet): ToolSet {
  const out: ToolSet = { ...tools }
  for (const [name, zh] of Object.entries(TOOL_DISPLAY_NAMES_ZH)) {
    const t = out[name]
    if (!t) continue
    // Object.assign 而不是对象展开：Tool 是一堆 input/output 相关联的变体的联合类型，展开会把
    // 关联信息摊平成 any/never 而不再可赋值回 Tool；Object.assign 的交叉类型保留原变体。
    out[name] = Object.assign({}, t, {
      description: t.description ? `「${zh}」${t.description}` : `「${zh}」`
    })
  }
  return out
}
