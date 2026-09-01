// 配置页骨架的「外壳语境」。
//
// 团队页成员详情已有一条 52px 页头（头像 + 成员名 + 视图档），骨架页头再渲染一遍同名
// 标题就是两条标题栏叠着 —— 名字说两遍，纵向还白吃掉一截。embedded 就是这件事的判据：
// 外层已经在显示这位成员是谁，骨架页头退成一条动作栏（只留角色副标题 + 启用/试运行/保存）。
//
// 🔴 默认 false 是有意的：独立挂载的语境（新建入口 CustomAgentCreateView 没有外层页头、
// 配置页组件测试直接渲染表单）必须自带标题，否则页面没有名字。只有 AgentSettingsView
// —— 团队页成员详情这一个挂载点 —— 才把它翻成 true。
//
// 🔴 独立 .ts 叶子：组件文件导出非组件值会破 react-refresh 的 Fast Refresh 边界
//（同 inputStyle.ts 的理由）。
import { createContext } from 'react'

export type SettingsChrome = {
  /** true = 外层页头已在显示成员名 → 骨架页头不再重复渲染标题。 */
  embedded: boolean
}

export const SettingsChromeContext = createContext<SettingsChrome>({ embedded: false })
