// `mailagent://` deeplink 的**跨进程载荷形状**（issue #68）。
//
// 生产者 = `electron/main/deeplink.ts::parseDeeplink`；消费者 = renderer 的
// `shared/router-instance.tsx::useDeeplinkRouter`。此前 renderer 侧 inline 抄了一份同
// shape，注释写着「renderer 不能 import main 模块」—— 那是对的（tsconfig 分项目，
// renderer 不含 electron/main），但结论不该是"抄一份"：把类型放进两边都能引的 `shared/`
// 即可。少一个 kind 时 renderer 的 switch 会静默 drop 掉那条 deeplink（灵动岛点了没反应，
// 不报错）。
//
// 纯类型模块，零运行时导出 —— 打进 renderer bundle 的字节数为 0。

export interface DeeplinkTarget {
  kind: 'email' | 'calendar' | 'kanban' | 'llm' | 'settings'
  /** email internal_id (kind==='email') */
  id?: number
  /** calendar view / settings tab (kind==='calendar'|'settings') */
  view?: string
}
