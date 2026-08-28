// 主标签面包屑第二段的页面侧接线（task 08-27-l4-tab-workspace P2 收口）。
//
// 契约（design.md §三）：主标签的文本是「{域名} / {第二段}」，第二段由**当前承载页**
// 自己提供（日历给月份、对话给会话名、设置给分节名…）。store 里只有一个
// `mainBreadcrumb`，切承载时 `setMainPage` 自动清成 null —— 所以页面**不需要**在卸载
// 时清，传 null 即单段（TabStrip 不显分隔符）。
//
// 🔴 `page` 参数不是装饰，守卫是这个 hook 存在的理由：路由 → mainPage 的收敛挂在
// RootLayout 的 `useTabRouteSync`，而 React 的 effect 是**自下而上**跑的 —— 进一个承载
// 时页面的 effect 先跑（写第二段），RootLayout 的 `setMainPage` 后跑（换承载 ⇒ 清第二
// 段），没有守卫就恒被清成单段。守成「等 mainPage 落到本承载再写」之后，setMainPage
// 落地会让 `isCurrent` 由 false 翻 true，effect 再跑一次把第二段补上。

import { useEffect } from 'react'

import { useTabWorkspace, type MainPage } from './tab-workspace'

/** 当前承载页声明自己的面包屑第二段。`null` = 单段。
 *  同值不写（store 的 setMainBreadcrumb 自己早退），可以放心每次 render 传现算的字符串。 */
export function useMainBreadcrumb(page: MainPage, text: string | null): void {
  const isCurrent = useTabWorkspace((s) => s.mainPage === page)
  useEffect(() => {
    if (!isCurrent) return
    useTabWorkspace.getState().setMainBreadcrumb(text)
  }, [isCurrent, text])
}
