// `chat:group-foreground` 载荷键名的 **main ↔ renderer 对撞闸**（T3 话题，task 09-02）。
//
// 这条 IPC 的载荷形状在两处各手写了一遍：renderer 的唯一发送点
// `shared/api/ElectronApi.ts::setGroupForeground` 组装对象，main 的唯一接收点
// `electron/main/ai_gateway_lifecycle.ts::registerGroupForegroundHandler` 从 `unknown`
// 里按键名取值。**跨进程的 unknown 边界上没有类型**：键名对不上 typecheck 全绿、
// eslint 全绿、运行时也不抛 —— 只是 `foregroundGroup` 恒为 null，表现成「群明明开在
// 眼前，通知照发一条」。T3 把载荷从 `{sessionId}` 改成 `{groupId, threadId}` 时就只改了
// 发送侧，接收侧还在读 `sessionId`（本闸即为此而建）。
//
// 抄 `py_ts_constants_parity.test.ts` 的范式：纯静态读两个源文件 + 正则抽真源，不 import
// 运行时模块（避开 electron mock），本文件不持任何一侧的期望值副本。抽取失败一律红 ——
// 正则只认当前习语，重构写法的人必须回来更新抽取器，顺手核对两侧仍一致。
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

const CHANNEL = 'chat:group-foreground'

/** renderer 侧：`invoker()('chat:group-foreground', { … })` 的对象字面量里的键名。 */
function sentKeys(): string[] {
  const source = read('frontend/src/shared/api/ElectronApi.ts')
  const call = new RegExp(`invoker\\(\\)\\('${CHANNEL}',\\s*\\{([^}]*)\\}`).exec(source)
  if (!call) throw new Error(`ElectronApi.ts: 抽不到 ${CHANNEL} 的 invoke 载荷（写法变了？）`)
  return [...call[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]).sort()
}

/** main 侧：handler 里 `positive(body.X)` 实际读的键名。 */
function readKeys(): string[] {
  const source = read('frontend/src/electron/main/ai_gateway_lifecycle.ts')
  const handler = new RegExp(`ipcMain\\.handle\\('${CHANNEL}',[\\s\\S]*?\\n  \\}\\)\\n\\}`).exec(
    source
  )
  if (!handler) {
    throw new Error(`ai_gateway_lifecycle.ts: 抽不到 ${CHANNEL} 的 handler（写法变了？）`)
  }
  const keys = [...handler[0].matchAll(/positive\(body\.([A-Za-z_$][\w$]*)\)/g)].map((m) => m[1])
  if (keys.length === 0) throw new Error('ai_gateway_lifecycle.ts: handler 里一个 body.* 都没读到')
  return [...new Set(keys)].sort()
}

describe(`${CHANNEL} — 载荷键名 main ↔ renderer 对撞`, () => {
  test('renderer 发的键 ≡ main 读的键', () => {
    // 两侧都抽真源；任一侧改键名而另一侧没跟上 → 这条红（它是唯一会红的地方）。
    expect(readKeys()).toEqual(sentKeys())
  })

  test('抽到的就是二元组本身（不是抽了个空数组自欺）', () => {
    // 防「抽取器返回 [] == [] 恒绿」：键集必须正好是 T3 的二元组。
    expect(sentKeys()).toEqual(['groupId', 'threadId'])
  })
})
