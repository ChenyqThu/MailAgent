// 「背景与目标」（`matter.description`）的分段解析与序列化（08-18 owner 推翻裁决 D5）。
//
// 存储**不变**：仍是单个 `matter.description` 字段，两段靠 `## 背景` / `## 目标` 两个
// Markdown 小标题分开 —— 不加 DB 列、不做迁移，Agent 的写权限与审批规则原样不动。
//
// 🔴 规则写在这一处纯函数里，不要在组件里散着写正则：读态渲染、编辑态预填、保存
// 三个地方必须用同一套判据，各写一遍就会分裂（例如读态认得的小标题编辑态不认）。

/** 段落小标题（行首、整行匹配）。 */
const BACKGROUND_HEADING = '## 背景'
const GOAL_HEADING = '## 目标'

export interface MatterDescriptionParts {
  background: string
  goal: string
  /**
   * 老数据：整串**一个小标题都没有**（且非空）。
   *
   * 老字段本来就叫「核心目标」，语义上离「目标」最近，所以整串算 `goal`；`background`
   * 留空。编辑态据此给一次性提示，让 owner 自己把背景部分挪上去 —— **不做静默重新分类**。
   */
  legacy: boolean
}

/** 行首、整行就是这个小标题（允许行尾空白，不允许行首缩进）。 */
function headingOf(line: string): 'background' | 'goal' | null {
  const trimmed = line.trimEnd()
  if (trimmed === BACKGROUND_HEADING) return 'background'
  if (trimmed === GOAL_HEADING) return 'goal'
  return null
}

function join(existing: string, addition: string): string {
  const next = addition.trim()
  if (!next) return existing
  return existing ? `${existing}\n\n${next}` : next
}

/**
 * 按 `## 背景` / `## 目标` 切分 `matter.description`。
 *
 * - 一个小标题都没有 ⇒ 整串算「目标」，`legacy = true`。
 * - 小标题之前的散文（`foo\n## 目标\nbar`）归入「背景」—— 那段本来就是交代来龙去脉的。
 * - 同名小标题出现多次 ⇒ 内容按出现顺序合并进同一段，不丢内容。
 */
export function parseMatterDescription(description: string): MatterDescriptionParts {
  const text = description ?? ''
  const lines = text.split('\n')
  let background = ''
  let goal = ''
  let current: 'background' | 'goal' | null = null
  let buffer: string[] = []
  let sawHeading = false

  const flush = (): void => {
    const chunk = buffer.join('\n')
    buffer = []
    // 小标题之前的内容（current === null）与「背景」同归一段。
    if (current === 'goal') goal = join(goal, chunk)
    else background = join(background, chunk)
  }

  for (const line of lines) {
    const heading = headingOf(line)
    if (heading === null) {
      buffer.push(line)
      continue
    }
    flush()
    sawHeading = true
    current = heading
  }
  flush()

  if (!sawHeading) {
    // 无小标题：整串是老数据，全部算「目标」。
    return { background: '', goal: background, legacy: background !== '' }
  }
  return { background, goal, legacy: false }
}

/**
 * 把两段拼回 `matter.description`。
 *
 * 空段**整段省略**（不写一个空的 `## 背景`）；两段都空 ⇒ 空字符串。
 */
export function serializeMatterDescription(parts: { background: string; goal: string }): string {
  const sections: string[] = []
  const background = parts.background.trim()
  const goal = parts.goal.trim()
  if (background) sections.push(`${BACKGROUND_HEADING}\n${background}`)
  if (goal) sections.push(`${GOAL_HEADING}\n${goal}`)
  return sections.join('\n\n')
}
