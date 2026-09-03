// 通知条目 deep-link 的**单源解析器**（task 08-20-notification-center 步骤 7；design §6.4）。
//
// 载荷来自后端 `payload_json.link`，是判别 union。这里做「解析 + 白名单」，以及 route /
// session 两型的**落地单源**（`navigate` 由调用方传进来 —— `useNavigate` 是 hook，且
// TanStack Router 的 `to` 是字面量联合类型：解析器返回收窄后的字面量，落地函数用 switch
// 逐个字面量 navigate，全程零 `as any`）。其余型的落地动作仍在组件里。
//
// 🔴 未知 type / 字段缺失 / 路由不在白名单 → 返回 null，条目点击**只标已读不跳转**（前向
// 兼容：新版后端加了新 link 型，老前端不炸也不乱跳）。白名单只列信源真会发的目标
// （`run_worker.py` 的 `/agents`、`job_worker.py` / `service.py` /
// `davmail_watchdog.py` 的 `/admin/kanban`）—— 加信源时同步加档，不预留空位。
//
// M2 批 B5 补齐 design §6.4 表里的另外四型（report / contact_queue / matter /
// updater_restart）。它们的落地动作各不相同（两个走 store-intent、一个走现成的 matters
// 通道、一个直调 updater IPC），但**解析**这一步仍然只有这一处。

// 允许的 route 目标（值 = TanStack Router 的路由 path 字面量）自 task 08-24-l4-nav-shell
// Step R 起**从 nav registry 派生**（标了 `notificationRoute` 的那几条），不再在这里手抄
// 一份 path 清单 —— 它与侧栏 / ⌘K 是同一批入口，抄第二份就会在改路由时漏掉一边。
// 🔴 白名单**只转录现状三条**，不借机扩面：加档 = 给那条 entry 标 `notificationRoute`
// + 确认真有信源会发它。
import {
  NOTIFICATION_ROUTE_TARGETS,
  type NotificationRouteTarget
} from '@shared/navigation/registry'
// 只引类型：本模块运行时不依赖 router。
import type { useNavigate } from '@tanstack/react-router'

import type { ChatSession } from '@shared/api/types'
import { navigateToTeamRecord } from '@shared/components/agents/navigation'
import { isMatterScopedAgentId } from '@shared/components/agents/team/teamTimeline'
import { clampSettingsTab } from '@shared/lib/settingsTabs'
import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'

export { NOTIFICATION_ROUTE_TARGETS, type NotificationRouteTarget }

export type NotificationLink =
  /** agent 执行终态（`run_worker.py`）。`agentId` 自 09-02 起随 `agent_run` /
   *  `contact_governance` 两类 job 一起发 —— 有它就直达团队页那位成员的那条记录；缺席的
   *  （生产库里的老行、matter 系 job）由 `openNotificationSession` 回查会话再判归宿。 */
  | { type: 'session'; sessionId: number; agentId?: string }
  /** 群聊回复（electron main `appendGroupMessage` 的通知投影）→ 对话域「群聊」分段的那个群。
   *  与 `session` 分开：那一型的落点是 AI 分段的主 agent 会话面或团队页记录档，塞个群 id
   *  进去两边都落空白。 */
  | { type: 'group'; sessionId: number }
  /** 群里某个**话题**的回复（T3）→ 那个群 + 打开那个话题面。与 `group` 分开：只带群 id 会落到
   *  主时间线，而话题回复不在主时间线上（它们在另一条会话里），用户点了通知等于什么都没看到。
   *  两个 id 都是会话 id（话题也是一行 `ai_chat_sessions`），命名空间同一个。 */
  | { type: 'thread'; groupId: number; threadId: number }
  | { type: 'route'; to: NotificationRouteTarget; search: Record<string, unknown> | null }
  /** 报告完成（`reports/worker.py`）→ `/reports/$reportId`（08-27 P3 前是
   *  `/agents?tab=reports` + store-intent）。 */
  | { type: 'report'; reportId: string }
  /** 通讯录治理建议（`governance.py`）→ 打开工作台抽屉的「待审建议」tab。 */
  | { type: 'contact_queue' }
  /** 事项提案 / 关注信号（`run_service.py` / `matters/worker.py`）→ 打开那件事。 */
  | { type: 'matter'; publicId: string }
  /** 应用更新就绪（Electron main 的 updater）→ 重启装更新。 */
  | { type: 'updater_restart' }
  /** 资料库文件（`src/notify/library_signals.py::notify_library_file_written`，目前
   *  唯一信源是 agent 无人值守写完 `agent-docs/`）→ 深链 `/library?file={id}`（design
   *  09-02-library-knowledge-base §9.5）：进域 + 展开所在文件夹 + 选中文件；文件
   *  `missing`/`trashed` 时进域并 toast，落地页自己判。落地单源
   *  `library/deeplink.ts::navigateToLibraryFile`（`NotificationPanel.tsx::activate`
   *  消费）——借道 `router.history.push` 而不是 `navigate({ to: '/library' })`，因为
   *  `/library` 由另一批单独注册，注册前 `to` 字面量过不了 typecheck。 */
  | { type: 'library'; fileId: number }

/** 非空字符串字段的统一取法（reportId / publicId 都是不透明 id，只校验形状）。 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 正整数会话 id 的统一取法（session / group / thread 三型共用同一道守卫）。 */
function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function resolveNotificationLink(
  payload: Record<string, unknown> | null | undefined
): NotificationLink | null {
  if (!payload) return null
  const link = payload.link
  if (!isRecord(link)) return null

  if (link.type === 'session') {
    // 后端 `_session_id_of` 拿不到会话时发的是 route 退化型；这里再守一道 0/负数/非整数。
    const sessionId = positiveInt(link.sessionId)
    if (sessionId === null) return null
    // 空串 / 非字符串的 agentId 一律当没有（落地时会去回查会话），不带一个查不到成员的
    // 空 id 上路 —— 那会让「跳过去什么都没选中」看起来像功能坏了。
    const agentId = nonEmptyString(link.agentId)
    return agentId === null
      ? { type: 'session', sessionId }
      : { type: 'session', sessionId, agentId }
  }

  if (link.type === 'group') {
    const sessionId = positiveInt(link.sessionId)
    if (sessionId === null) return null
    return { type: 'group', sessionId }
  }

  if (link.type === 'thread') {
    // 🔴 两个 id 都要在：只有群 id 落地会打开主时间线，而话题回复根本不在主时间线上 ——
    // 与其跳到一个看不见那条回复的地方，不如返 null（只标已读、不跳）。
    const groupId = positiveInt(link.groupId)
    const threadId = positiveInt(link.threadId)
    if (groupId === null || threadId === null) return null
    return { type: 'thread', groupId, threadId }
  }

  if (link.type === 'route') {
    const to = link.to
    if (typeof to !== 'string') return null
    if (!(NOTIFICATION_ROUTE_TARGETS as readonly string[]).includes(to)) return null
    return {
      type: 'route',
      to: to as NotificationRouteTarget,
      search: isRecord(link.search) ? link.search : null
    }
  }

  if (link.type === 'report') {
    const reportId = nonEmptyString(link.reportId)
    return reportId === null ? null : { type: 'report', reportId }
  }

  // 无参数型：判 type 就够，不校验别的字段（后端往载荷里多塞字段不该让链接失效）。
  if (link.type === 'contact_queue') return { type: 'contact_queue' }
  if (link.type === 'updater_restart') return { type: 'updater_restart' }

  if (link.type === 'matter') {
    const publicId = nonEmptyString(link.publicId)
    return publicId === null ? null : { type: 'matter', publicId }
  }

  if (link.type === 'library') {
    const fileId = positiveInt(link.fileId)
    return fileId === null ? null : { type: 'library', fileId }
  }

  return null
}

type NavigateFn = ReturnType<typeof useNavigate>

/**
 * route 型链接的落地 switch —— **单源**（task 08-24-l4-nav-shell Step B，Step R check ①）。
 * 此前 NotificationPanel 与 router-instance（系统通知点击）各手抄一份，且两份都漏了
 * `/settings` case：kos ingest_log 的死信通知（`/settings?tab=integrations`）过得了白名单
 * 却落不了地，点了只标已读哪也不去。收敛成一份 + `default: never` 穷尽闸 ——
 * registry 白名单再加档而这里漏 case 时 typecheck 当场红，不再静默吞。
 *
 * search 逐 case clamp（TanStack validateSearch 的口径在类型层进不来，值层各路由
 * 自己还会再验一遍）。
 */
export function navigateNotificationRoute(
  navigate: NavigateFn,
  link: Extract<NotificationLink, { type: 'route' }>
): void {
  switch (link.to) {
    case '/agents':
      // 08-27 P3：`/agents` 的三 tab 拆成三个一级域，本路由不再有搜索参数 ——
      // 老载荷里带的 `search.tab`（`run_worker.py` 曾发 `{"tab":"agents"}`）直接忽略。
      void navigate({ to: '/agents' })
      return
    case '/admin/kanban':
      void navigate({ to: '/admin/kanban' })
      return
    case '/settings':
      void navigate({ to: '/settings', search: { tab: clampSettingsTab(link.search?.tab) } })
      return
    default: {
      const exhaustive: never = link.to
      return exhaustive
    }
  }
}

/**
 * session 型链接的落地单源（09-02 通知深链修正）。面板内点击与 macOS 系统通知点击共用
 * 这一处 —— 分三支，抄第二份必漂。
 *
 * 🔴 归宿判据：agent 干的活（headless run 的降级会话行 / 人以 agent 身份开的会话）在**团队页
 * 那位成员的记录档**里，不在对话域 AI 分段 —— 后者按 origin 组合过滤根本不列 origin='agent'
 * 的行，`requestOpenAgentSession` 把它塞进去只会「详情与左侧历史对不上」（owner 09-02 dogfood
 * 反馈的那一条）。
 *
 * `agentId` 缺席的老通知行（生产库 6 条）只能回查会话本身。`getSession` 由调用方注入，落地
 * 测试因此零网络；回查失败（网络断 / 行已删）不吞成「点了没反应」，退回 AI 分段那一支。
 */
export async function openNotificationSession(
  navigate: NavigateFn,
  link: Extract<NotificationLink, { type: 'session' }>,
  deps: { getSession(sessionId: number): Promise<ChatSession | null> }
): Promise<void> {
  if (link.agentId !== undefined) {
    navigateToTeamRecord(navigate, link.agentId, link.sessionId)
    return
  }
  const row = await deps.getSession(link.sessionId).catch(() => null)
  const agentId = row?.agent_id
  if (
    (row?.origin === 'agent' || row?.origin === 'team') &&
    agentId != null &&
    agentId.length > 0 &&
    // 事项域命名空间（`matter:` / `matter_item:`）的会话归事项页，团队页没有对应成员 ——
    // 判据复用 teamTimeline 的那一处，不在这里手抄第二份前缀表。
    !isMatterScopedAgentId(agentId)
  ) {
    navigateToTeamRecord(navigate, agentId, link.sessionId)
    return
  }
  requestOpenAgentSession(link.sessionId)
  void navigate({ to: '/sessions' })
}
