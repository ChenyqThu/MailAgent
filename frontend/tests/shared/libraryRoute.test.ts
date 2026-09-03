// @vitest-environment happy-dom
//
// 资料库域路由的注册形状（P1-L8）。钉三件事：
//
//   · `/library` 真的在路由树里 —— registry 的 rail / ⌘K jump 落点都指着它，没注册
//     就是「点了哪也不去」（TanStack 匹配不到时落 NotFound，不报错）。
//   · 深链 `?file=` 被 `validateSearch` 收成**数字**：`deeplink.ts` 走的是
//     `router.history.push('/library?file=7')`，query 里天然是字符串，不收就会以字符串
//     形态流到 `useSearch` 的消费方。
//   · `libraryFileHref()` 拼出来的串 ≡ 路由自己 build 出来的 href —— 这两处是同一个深链
//     的两种写法（一个手拼、一个走路由器），漂了就是「回执里的『打开』按钮点了没反应」。
import { describe, expect, test } from 'vitest'

import { libraryFileHref } from '../../src/shared/components/library/deeplink'
import { router } from '../../src/shared/router-instance'

describe('/library 路由注册', () => {
  test('域路由可解析；导轨 / ⌘K 的落点不带 search', () => {
    const loc = router.buildLocation({ to: '/library' })
    expect(loc.href).toBe('/library')
    expect(router.matchRoutes(loc).map((m) => m.routeId)).toContain('/library')
  })

  test('深链 `?file=` 收成正整数；垃圾值不会以数字形态漏给消费方', () => {
    const searchOf = (file: unknown): unknown =>
      (
        router.matchRoutes(
          router.buildLocation({
            to: '/library',
            search: { file } as unknown as { file: number }
          })
        ).at(-1)?.search as { file?: unknown } | undefined
      )?.file

    expect(searchOf(7)).toBe(7)
    // 手写 href（deeplink.ts 走 history.push）进来时 `file` 是字符串 —— validateSearch
    // 的活就是把它收成数字。
    expect(searchOf('7')).toBe(7)

    // 🔴 垃圾值不断言「整条丢掉」：TanStack 的根路由对 search 是透传的，子路由的
    // validateSearch 只做**叠加**，丢掉的键仍会以原始形态留在 match.search 里。
    // 真正要钉的是「不会出现一个假的 id」—— 写成无条件 `Number(...)` 就会漏个 NaN 出去。
    for (const bad of ['', 'abc', '0', '-3', '1.5', 'null']) {
      expect(typeof searchOf(bad), bad).not.toBe('number')
    }
  })

  test('libraryFileHref() ≡ 路由 build 出来的 href（回执「打开」按钮的落点）', () => {
    expect(router.buildLocation({ to: '/library', search: { file: 42 } }).href).toBe(
      libraryFileHref(42)
    )
  })
})
