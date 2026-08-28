// @vitest-environment happy-dom
//
// 报告域路由的注册形状（08-27 P3）。钉两件事：
//
//   · `/reports` 与 `/reports/$reportId` 都真的在路由树里 —— registry 的
//     `navigateToReport` 与 rail 落点都指着它们，没注册就是「点了哪也不去」。
//   · 详情是 `/reports` 的**子路由**，匹配链里父路由仍在 ⇒ 切换报告时 ReportsPage
//     不卸载（清单的筛选档、滚动位置、已翻的分页都留着）。拍平成两条兄弟路由会让
//     每次换报告都重挂清单，行为退化但界面看着一样 —— 只有这条闸拦得住。
import { describe, expect, test } from 'vitest'

import { router } from '../../src/shared/router-instance'

describe('/reports 路由注册', () => {
  test('列表与详情都可解析，且详情匹配链里父路由仍在', () => {
    const loc = router.buildLocation({ to: '/reports/$reportId', params: { reportId: 'abc' } })
    expect(loc.href).toBe('/reports/abc')
    const matches = router.matchRoutes(loc)
    // 父路由也在匹配链里 = ReportsLayout 在详情路由下照常渲染（清单列不卸载）。
    expect(matches.map((m) => m.routeId)).toEqual(['__root__', '/reports', '/reports/$reportId'])
    expect(matches.at(-1)?.params).toEqual({ reportId: 'abc' })
    const listLoc = router.buildLocation({ to: '/reports' })
    expect(listLoc.href).toBe('/reports')
    expect(router.matchRoutes(listLoc).map((m) => m.routeId)).toContain('/reports')
  })
})
