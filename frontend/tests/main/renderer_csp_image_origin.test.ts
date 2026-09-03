// 跨构件一致性闸 — 防「出图成功但恒裂图」回归。
//
// 背景 (0903 dogfood): generate_image 生成的图片由 ai-gateway 的只读路由供给
// (GET /api/ai/generated/:id)，renderer 用 `<img src>` 直接加载 `absoluteImageUrl()` 拼出的
// loopback 地址。renderer 的 CSP 里 `connect-src` 早就放行了 `http://127.0.0.1:*`（chat 的
// fetch 全靠它），但 `<img>` 走的是 **img-src**，两条指令互不覆盖 —— 于是图片落盘正常、
// 下载正常，页面上却恒是裂图，且 CSP 拦截不产生任何运行时异常。
//
// 闸的判据不是「img-src 里有没有那串字面量」（那只是把 HTML 抄一遍，改了也不会红），而是
// **absoluteImageUrl 会产出的 origin 必须被 img-src 承认**：origin 从 flags.ts 的源码里抽，
// 白名单从 index.html 的 CSP 里抽，两边任一处漂移都红。
//
// 纯静态读两个源文件 + 正则抽取，不 import 运行时模块（避开 electron / window mock）。
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
// frontend/tests/main → 上溯两级到 frontend/。
const FRONTEND = resolve(HERE, '..', '..')

/** renderer CSP 的 img-src 白名单条目。抽取失败必须红 —— 抽不到比抽错更容易被当成「通过」。 */
function imgSrcDirective(): string[] {
  const html = readFileSync(resolve(FRONTEND, 'src/electron/renderer/index.html'), 'utf8')
  const csp = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(html)
  expect(csp, 'renderer index.html 里没抽到 CSP meta').not.toBeNull()
  const directive = (csp as RegExpExecArray)[1]
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('img-src '))
  expect(directive, 'CSP 里没抽到 img-src 指令').toBeDefined()
  return (directive as string).slice('img-src '.length).split(/\s+/).filter(Boolean)
}

/** resolveAiGatewayBaseUrl 拼 loopback 地址用的 origin 前缀（`http://127.0.0.1:${port}`）。 */
function gatewayOriginPrefix(): string {
  const src = readFileSync(resolve(FRONTEND, 'src/shared/assistant/runtime/flags.ts'), 'utf8')
  const m = /return `(https?:\/\/[^$`]+)\$\{/.exec(src)
  expect(m, 'flags.ts 里没抽到 gateway loopback origin 模板').not.toBeNull()
  return (m as RegExpExecArray)[1]
}

/** CSP source-expression 的宿主匹配（本闸只需支持 `scheme://host:*` 与 `scheme://host:port`）。 */
function admits(entry: string, originPrefix: string): boolean {
  if (entry.endsWith(':*')) return `${entry.slice(0, -1)}` === originPrefix
  return entry === `${originPrefix}${entry.slice(originPrefix.length)}` && entry.startsWith(originPrefix)
}

describe('renderer CSP 放行 ai-gateway 的图片 origin', () => {
  test('img-src 承认 absoluteImageUrl 会产出的 loopback origin', () => {
    const prefix = gatewayOriginPrefix() // 'http://127.0.0.1:'
    const entries = imgSrcDirective()
    expect(
      entries.some((entry) => admits(entry, prefix)),
      `img-src ${JSON.stringify(entries)} 不承认 ${prefix}<port> —— generate_image 的图会被 CSP 拦成裂图`
    ).toBe(true)
  })

  test('connect-src 的放行不能替代 img-src（两条指令互不覆盖）', () => {
    // 这条锁住上面那条测试的**前提**：img-src 是独立指令，不会继承 connect-src / default-src。
    // 若哪天有人把 img-src 整条删掉指望 default-src 兜底，上面的抽取会失败并红在这里。
    const html = readFileSync(resolve(FRONTEND, 'src/electron/renderer/index.html'), 'utf8')
    expect(html).toContain('img-src ')
    expect(html).toContain('connect-src ')
  })
})
