// Typed TanStack Query key factory — the single source for query-key literals
// (P2-8). Before this, ~150 keys were hand-typed string arrays scattered across
// ~50 files; the only latent-drift case (`['chat','allSessions']` typed
// identically in three files) had no compile-time guard.
//
// Every builder returns an `as const` tuple BYTE-IDENTICAL to the literal it
// replaces — element order / case / singular-vs-plural are load-bearing for
// TanStack's prefix matching, so this file changes nothing at runtime; it only
// gives the keys one authoritative, typed home.
//
// Coordination with the two pre-existing single sources:
//   • emailInvalidation.ts owns EMAIL_QUERY_ROOT + EMAIL_SUPPLEMENT_TAG (it is
//     the SSE-routing classifier authority with its own test suite). The
//     `emails.*` builders here CONSUME those constants — one definition, no
//     import cycle. emailInvalidation's own directive literals (mailboxes /
//     pinnedIds / folder / email-detail) stay there, covered by its tests.
//   • useCalendarEvents.ts's CALENDAR_*_KEY consts now re-export the calendar
//     builders below instead of defining their own literals.

import { EMAIL_QUERY_ROOT, EMAIL_SUPPLEMENT_TAG } from './emailInvalidation'

export const qk = {
  // 'emails' — primary mailbox list + 4 enrichment supplements. Tag literals
  // ('cross' / 'pinned-supplement' / 'thread-batch' / 'thread-enriched') come
  // from EMAIL_SUPPLEMENT_TAG so the classifier and the builders can never drift.
  emails: {
    all: () => [EMAIL_QUERY_ROOT] as const,
    // sortKey/sortDir 在 key 里: 排序已下沉 SQL, 换排序 = 换一份结果集,
    // 不进 key 会让切排序命中旧缓存 (看上去「点了没反应」)。
    list: (
      view: string,
      customMailbox: string | null,
      activeMailbox: string,
      fetchLimit: number,
      sortKey: string,
      sortDir: string
    ) =>
      [EMAIL_QUERY_ROOT, view, customMailbox, activeMailbox, fetchLimit, sortKey, sortDir] as const,
    cross: (crossMailbox: string | null, fetchLimit: number) =>
      [EMAIL_QUERY_ROOT, EMAIL_SUPPLEMENT_TAG.cross, crossMailbox, fetchLimit] as const,
    pinnedSupplement: (pinnedList: readonly number[]) =>
      [EMAIL_QUERY_ROOT, EMAIL_SUPPLEMENT_TAG.pinnedSupplement, pinnedList] as const,
    threadBatch: (threadKey: readonly string[]) =>
      [EMAIL_QUERY_ROOT, EMAIL_SUPPLEMENT_TAG.threadBatch, threadKey] as const,
    threadEnriched: (threadMemberIds: readonly number[]) =>
      [EMAIL_QUERY_ROOT, EMAIL_SUPPLEMENT_TAG.threadEnriched, threadMemberIds] as const
  },

  // 'email' — single-email families. `detail` is a prefix that also invalidates
  // ai / body / translation for that id.
  email: {
    detail: (id: number | null) => ['email', id] as const,
    ai: (id: number | null) => ['email', id, 'ai'] as const,
    /** 只要 meta（主题 / 发件人 / 日期），不要正文 —— 画像证据角标 hover 时懒查。
     *  挂在 `['email', id, …]` 前缀下，跟着 detail 的失效一起过期。 */
    meta: (id: number | null) => ['email', id, 'meta'] as const,
    translation: (id: number | null, lang: string) => ['email', id, 'translation', lang] as const,
    body: (id: number | null, format: string) => ['email', id, 'body', format] as const,
    bodyPreview: (id: number | null, format: string) =>
      ['email', id, 'body-preview', format] as const,
    threadCount: (threadId: string | null) => ['email', threadId, 'thread-count'] as const,
    thread: (threadId: string | null) => ['email', 'thread', threadId] as const
  },

  mailboxes: () => ['mailboxes'] as const,
  pinnedIds: () => ['pinnedIds'] as const,

  // 'chat' — session list + per-session messages + /chat/config flag probes.
  chat: {
    allSessions: () => ['chat', 'allSessions'] as const,
    // P4a 团队页 — origin='agent' 会话清单。🔴 尾段 'agent' 与 ChatsTab 内联组合的
    // `[...qk.chat.allSessions(), 'agent']` 字面量一致（共享缓存），别改任何一段。
    agentOriginSessions: () => ['chat', 'allSessions', 'agent'] as const,
    // P4b 团队页 — origin='team' 会话清单（人以 agent 身份开的交互式会话；CHAT_DB v29）。
    teamOriginSessions: () => ['chat', 'allSessions', 'team'] as const,
    // L4 群聊 — origin='group' 会话清单（custom agents 群聊；CHAT_DB v30）。
    groupOriginSessions: () => ['chat', 'allSessions', 'group'] as const,
    agentUnread: () => ['chat', 'agentUnread'] as const,
    messages: (sessionId: string | number) => ['chat', 'messages', sessionId] as const,
    /** L4 批次3 — 一条行动项名下的会话（执行历史反查，`GET /chat/sessions/all?itemId=`）。
     *  挂 'chat' 前缀而不是 'matters'：数据源是 ai_chat.db 的会话行，事项域的写不改变它。 */
    itemSessions: (itemId: number) => ['chat', 'itemSessions', itemId] as const,
    queuedInput: (sessionId: number | null) => ['chat', 'queuedInput', sessionId] as const,
    kosAvailable: () => ['chat', 'kosAvailable'] as const,
    config: (flag: string) => ['chat', 'config', flag] as const,
    // L4 群聊 g1 — 群设置 / 群成本指标（serve-api `/chat/sessions/{id}/group-config|metrics`）。
    groupConfig: (sessionId: number) => ['chat', 'groupConfig', sessionId] as const,
    groupMetrics: (sessionId: number) => ['chat', 'groupMetrics', sessionId] as const,
    /** L4 群聊 g1 — 服务端编排下「这个群此刻有没有成员在发言」（gateway `/api/ai/run/active`
     *  探针，30s 兜底轮询；真正的即时刷新走 `chat:turn-persisted` 广播）。 */
    groupRunActive: (sessionId: number) => ['chat', 'groupRunActive', sessionId] as const
  },

  /** L4 群聊 g1 — labs 实验开关（owner_settings，`GET/PUT /api/agent/labs`）。设置页与群聊
   *  视图共读同一份缓存：在实验室里一开，切回群聊就是新模态。 */
  labsFlags: () => ['agent', 'labs'] as const,

  folder: {
    all: () => ['folder'] as const,
    discover: () => ['folder', 'discover'] as const,
    whitelist: () => ['folder', 'whitelist'] as const,
    // per-folder 配置 (v62, folder_pref)。设置页与侧边栏文件夹树共读同一份缓存。
    prefs: () => ['folder', 'prefs'] as const
  },

  calendar: {
    events: () => ['calendar', 'events'] as const,
    agenda: () => ['calendar', 'agenda'] as const,
    syncStatus: () => ['calendar', 'syncStatus'] as const,
    names: () => ['calendar', 'names'] as const,
    event: () => ['calendar', 'event'] as const,
    eventDetail: (icalUid?: string, recurrenceId?: string | null, source?: string) =>
      ['calendar', 'event', icalUid, recurrenceId, source] as const,
    sourceEmail: (icalUid?: string) => ['calendar', 'sourceEmail', icalUid] as const,
    // 阶段 2.2 — 邮件详情邀请卡片: emailCalendarLink 反查 + 邀请窗口冲突查询。
    // inviteConflicts 挂在 'events' 前缀下, 日历写后/同步后的 events 族
    // invalidate 顺带刷新冲突 chip。
    emailLink: (internalId: number) => ['calendar', 'email-link', internalId] as const,
    inviteConflicts: (fromIso: string, toIso: string) =>
      ['calendar', 'events', 'invite-conflict', fromIso, toIso] as const,
    // 收尾批 (Lane G) — 周期系列邀请 (is_recurring 且无 recurrence_id) 查
    // [现在, +60d] 窗口的下一次 occurrence, 替代显示 master 首次时间。
    nextOccurrence: (icalUid: string) =>
      ['calendar', 'events', 'next-occurrence', icalUid] as const,
    recurring: () => ['calendar', 'recurring'] as const,
    recurringSince: (since: string) => ['calendar', 'recurring', since] as const,
    recurringStatus90d: (recurringSince: string) =>
      ['calendar', 'recurring', 'status-90d', recurringSince] as const
  },

  settings: {
    all: () => ['settings'] as const,
    secretsStatus: () => ['settings', 'secrets-status'] as const
  },

  skills: () => ['skills'] as const,
  skillSecrets: (skillName: string) => ['skillSecrets', skillName] as const,
  skillConfig: (skillName: string) => ['skillConfig', skillName] as const,

  notionAgent: {
    config: () => ['notionAgent', 'config'] as const,
    models: () => ['notionAgent', 'models'] as const,
    agents: () => ['notionAgent', 'agents'] as const
  },

  standingDocs: {
    list: () => ['standingDocs', 'list'] as const
  },

  policy: {
    rules: (agentId: string) => ['policy', 'rules', agentId] as const,
    skillEntrypoints: () => ['policy', 'skill-entrypoints'] as const
  },

  execPolicy: {
    rules: () => ['execPolicy', 'rules'] as const
  },

  llm: {
    upstreamModels: (provider: string) => ['llm', 'upstream-models', provider] as const,
    stats: () => ['llm', 'stats'] as const,
    statsDays: (days: number) => ['llm', 'stats', days] as const,
    // task 07-12 P3 — Settings「模型服务」区（provider 管理 + per-provider 模型行）。
    providers: () => ['llm', 'providers'] as const,
    providerModels: (providerId: string) => ['llm', 'providers', providerId, 'models'] as const
  },

  // issue #59 — KOS 入库台账（LLM Dashboard 底部「知识库入库」区）。
  kos: {
    stats: () => ['kos', 'stats'] as const,
    statsDays: (days: number) => ['kos', 'stats', days] as const
  },

  admin: {
    stats: () => ['admin', 'stats'] as const,
    deadLetter: () => ['admin', 'deadLetter'] as const,
    systemAlerts: () => ['admin', 'systemAlerts'] as const,
    health: () => ['admin', 'health'] as const,
    davmailHealth: () => ['admin', 'davmailHealth'] as const
  },

  agentRuns: {
    all: () => ['agent-runs'] as const,
    list: (agentId: string | null, limit: number) =>
      ['agent-runs', agentId ?? 'all', limit] as const,
    toolOptions: () => ['agent-runs', 'tool-options'] as const,
    pendingCount: () => ['agent-runs', 'pending-count'] as const,
    pausedPending: () => ['agent-runs', 'list', 'paused_pending'] as const,
    // 08-31 — 一次 run_log 执行的过程节点（transcript 合成源）。挂 `agent-runs` 前缀，
    // run 台账失效时步骤跟着刷。
    runLogSteps: (runLogId: number) => ['agent-runs', 'run-log', runLogId, 'steps'] as const
  },

  agent: {
    skillsRegistry: () => ['agent', 'skills', 'registry'] as const
  },

  aiGateway: {
    health: (gatewayBaseUrl: string | null) => ['ai-gateway', 'health', gatewayBaseUrl] as const,
    approvalPending: (
      gatewayBaseUrl: string | null,
      sessionId: string | number | null,
      islandRefreshNonce: number
    ) => ['ai-gateway', 'approval-pending', gatewayBaseUrl, sessionId, islandRefreshNonce] as const,
    // harness-chat lane A B1 — detached-run truth probe (GET /api/ai/run/active). refreshNonce keys
    // the settle-driven re-probe (same discipline as approvalPending's islandRefreshNonce).
    runActive: (
      gatewayBaseUrl: string | null,
      sessionId: string | number | null,
      refreshNonce: number
    ) => ['ai-gateway', 'run-active', gatewayBaseUrl, sessionId, refreshNonce] as const
  },

  agentApprovalPending: (sessionId: string | number | null) =>
    ['agent-approval-pending', sessionId] as const,

  compose: {
    plan: (id: number) => ['compose', 'plan', id] as const,
    planMode: (id: number, mode: string) => ['compose', 'plan', id, mode] as const,
    draftEdit: (id: number) => ['compose', 'draft-edit', id] as const
  },

  report: {
    list: () => ['report', 'list'] as const,
    listCadence: (cadence: string) => ['report', 'list', cadence] as const,
    // codex MEDIUM-2 — per-agent latest report (agentId filter + limit:1), independent of the
    // paginated list first page so a low-frequency agent's card never falsely shows "no report".
    latest: (agentId: string) => ['report', 'latest', agentId] as const,
    // P4a 团队页 — 某报告 agent 的最近 N 份（记录列时间线数据源）。挂在 ['report','list']
    // 前缀下：runNow / delete 的 LIST_KEY invalidate 顺带刷新它。
    listByAgent: (agentId: string, limit: number) =>
      ['report', 'list', 'by-agent', agentId, limit] as const,
    config: () => ['report', 'config'] as const,
    get: (reportId: string | null) => ['report', 'get', reportId] as const
  },

  // task 08-27 P4c 今日页 — `GET /api/today`（只出「待回邮件」+「下一个硬时间点」）。
  // 另外四节复用各自既有 key 族（agentRuns / matters / calendar.agenda / report.list），
  // 它们自带 SSE 定向失效，本 key 只管这一条。
  today: {
    all: () => ['today'] as const,
    aggregate: (tz: string) => ['today', 'aggregate', tz] as const
  },

  projectProgressRuns: (limit: number) => ['project-progress-runs', limit] as const,

  // P4a 团队页 — AI 邮件预处理的「最近被分类的邮件」清单（listEnriched 投影，
  // llm_processing 无 per-run 概念，执行面按邮件逐封列）。
  team: {
    preprocessRecent: (limit: number) => ['team', 'preprocess-recent', limit] as const
  },

  // 08-01 PR4 — MCP connector 设置面。`connectorTools` 挂在 `connectors` 前缀下：连接/断开/
  // sync 之后 invalidate `['connectors']` 一处，工具清单跟着刷（TanStack 前缀匹配）。
  connectors: () => ['connectors'] as const,
  connectorTools: (id: string) => ['connectors', id, 'tools'] as const,
  // 08-06 Connectors 配置台 — built-in 工具审批档全量负载（GET /api/agent/tool-prefs）。
  // 写端点回同形状 → setQueryData 原地覆盖，不走 invalidate。
  toolApprovalPrefs: () => ['tool-approval-prefs'] as const,
  // 08-05 WP-12 — 预置目录 + BYOK key 状态。同挂 `connectors` 前缀：连接/断开/清除配置
  // 之后 invalidate 一处，目录里的「已配置 / 已被取代」跟着刷。
  connectorCatalog: () => ['connectors', 'catalog'] as const,

  palette: {
    search: (normalised: string) => ['palette', 'search', normalised] as const
  },

  mention: {
    search: (normalised: string) => ['mention', 'search', normalised] as const
  },

  matters: {
    all: () => ['matters'] as const,
    list: (q?: string) => (q ? (['matters', 'list', q] as const) : (['matters', 'list'] as const)),
    paletteSearch: (normalised: string) => ['matters', 'palette-search', normalised] as const,
    detail: (publicId: string) => ['matters', 'detail', publicId] as const,
    resources: (publicId: string) => ['matters', 'detail', publicId, 'resources'] as const,
    stakeholders: (publicId: string) => ['matters', 'detail', publicId, 'stakeholders'] as const,
    // W-C 全局干系人库两个 key（contacts / contactEmailCandidates）已随通讯录 WP3 退役
    // —— 干系人 picker 改用顶层 `qk.contacts.list(…)`（与通讯录工作台共享缓存）。
    // G-15 / G-14 —— 全部挂在 detail 前缀下：一次事项写入 invalidate `detail(id)` 就连带刷新
    // 关系、候选与附件（候选依赖 link 集合，关系依赖两端事项）。
    relations: (publicId: string) => ['matters', 'detail', publicId, 'relations'] as const,
    resourceCandidates: (publicId: string) =>
      ['matters', 'detail', publicId, 'resource-candidates'] as const,
    resourceAttachments: (publicId: string) =>
      ['matters', 'detail', publicId, 'resource-attachments'] as const,
    /** 「关联资料」弹窗里的邮件搜索。**不复用** `qk.palette.search` —— 那份 limit / staleTime
     *  都不一样，共享会互相污染缓存。 */
    resourcePickerMail: (normalised: string) =>
      ['matters', 'resource-picker', 'mail', normalised] as const,
    /** 「关联事项」弹窗里的事项候选。🔴 **不用** `list(q)` —— 空搜索时它与工作台主列表
     *  `list()` 是同一个 key，而两边 limit 不同（这里 12 / 主列表 100），谁后回来谁就把对方
     *  的缓存覆盖掉，主列表当场只剩 12 条。同 `resourcePickerMail` 的理由与形状。 */
    relationPicker: (normalised: string) => ['matters', 'relation-picker', normalised] as const,
    // P3 — bounded matter projection injected into the Matter Chat snapshot. Under the same
    // ['matters','detail',id] prefix so a matter write invalidates it with everything else.
    contextSnapshot: (publicId: string) =>
      ['matters', 'detail', publicId, 'context-snapshot'] as const,
    chatSessions: (matterInternalId: number) =>
      ['matters', 'chat-sessions', matterInternalId] as const,
    resourceLookup: (provider: string, keys: readonly string[]) =>
      ['matters', 'links', provider, ...keys] as const,
    captureCandidates: (q: string) => ['matters', 'capture-candidates', q] as const,
    /** 焦点页「待审阅 · Agent 更新提案」的**跨事项**聚合。
     *
     *  🔴 它结构上**不可能**被 `detail(id)` 前缀覆盖（跨事项，没有 id 可挂）。0818 之前这个
     *  键是在 `MattersWorkspace` 里内联拼的，而 `MatterDetail.refresh()` 只失效 detail 前缀
     *  —— 于是在详情里接受一条提案，焦点页那份缓存永不失效，已接受的提案继续挂着
     *  （staleTime 15s + 组件不重挂 ⇒ 不 refetch）。收进工厂 + 收进 `refreshMatter()`
     *  的清单，两件事一起做才算修好；内联拼键 = 下一个没人失效得到的缓存。 */
    pendingUpdates: () => ['matters', 'pending-updates'] as const,
    /** 例外面第四源：**跨事项**的「等我回答 / 挂了」派发（task 08-25 批次 3）。
     *  与 `pendingUpdates` 同一处境 —— 跨事项、没有 id 可挂，任何 detail 前缀都覆盖不到它，
     *  所以它也必须显式列进 `refreshMatter()` 的清单。 */
    itemDispatches: () => ['matters', 'item-dispatches'] as const,
    config: () => ['matters', 'config'] as const
  },

  // 通讯录（Contact Directory WP2）。顶层 `contacts` 段是人物库的唯一 key 域
  // （matters 域的旧 `qk.matters.contacts()` 已随 WP3 退役）。子资源挂
  // ['contacts','detail',id,…] 前缀：一次联系人写入 invalidate detail(id) 连带刷新
  // 关联邮件/事项。
  contacts: {
    all: () => ['contacts'] as const,
    list: (view: string, q: string, sort: string) => ['contacts', 'list', view, q, sort] as const,
    // 工作台主列表的分页版（keyset cursor）。与上面 `list` **分开的 key**：同一份数据
    // 两种形状（单页 vs pages 数组），共用一个 key 会让 useQuery 与 useInfiniteQuery
    // 互相读到对方的缓存结构。前缀仍是 ['contacts','list'] ⇒ 写侧那一次 invalidate
    // 照旧同时命中两者。
    listPaged: (view: string, q: string, sort: string) =>
      ['contacts', 'list', 'paged', view, q, sort] as const,
    detail: (contactId: number) => ['contacts', 'detail', contactId] as const,
    mails: (contactId: number, role: string) =>
      ['contacts', 'detail', contactId, 'mails', role] as const,
    matters: (contactId: number) => ['contacts', 'detail', contactId, 'matters'] as const,
    progress: () => ['contacts', 'backfill-progress'] as const,
    config: () => ['contacts', 'config'] as const,
    // WP6 画像总闸（同一个 /chat/config 端点的另一个字段）。挂 config 前缀，
    // invalidate ['contacts','config'] 一次连带刷新两个 flag 投影。
    profileConfig: () => ['contacts', 'config', 'profile'] as const,
    // WP4 互链: 邮件详情头批量精确解析。key 吃**排序后**的地址集（调用方负责
    // 归一去重 + sort，保证同一封邮件的地址集合稳定命中缓存）。
    resolve: (emails: readonly string[]) => ['contacts', 'resolve', ...emails] as const,
    // WP4 ⌘K「人」组（镜像 qk.matters.paletteSearch 的形状）。
    paletteSearch: (normalised: string) => ['contacts', 'palette-search', normalised] as const,
    // WP7 治理队列：status 进 key —— 抽屉同时开着 pending 与 blocked 两条查询
    // （服务端 `list_suggestions` 只收单个 status）。前缀 ['contacts','suggestions']
    // 一次失效两条。
    suggestions: (status: string) => ['contacts', 'suggestions', status] as const,
    // WP7 胶囊徽标 + 抽屉脚（待审数 / 最近扫描时间 / flag 态，一个端点拿全）。
    agentStatus: () => ['contacts', 'agent-status'] as const,
    // WP7 治理 agent 的系统提示词（agent_config.db 的 `contact_agent` 文档）。
    agentPrompt: () => ['contacts', 'agent-prompt'] as const,
    // 组织架构框架（同机制的另一个 profile doc `contact_org_frame`）。
    orgFrame: () => ['contacts', 'org-frame'] as const,
    // v2 工作台「运行」tab：治理扫描历史（limit 进 key —— 换条数就是另一份结果集）。
    agentHistory: (limit: number) => ['contacts', 'agent-history', limit] as const,
    // v2 工作台「运行」tab：画像批处理今日汇总（另一个 agent 行的只读镜子）。
    profileDailySummary: () => ['contacts', 'profile-daily-summary'] as const
  },

  contactSuggest: (debounced: string, exclude: readonly string[]) =>
    ['contactSuggest', debounced, exclude] as const,

  attachment: {
    // Attachment-only list for one email (no body read) — thread-wide
    // attachment aggregation (ThreadAttachmentBar) fans one of these out per
    // thread member. Shares React-Query cache with anything else on the id.
    list: (id: number) => ['attachment', id, 'list'] as const,
    dataUrl: (id: string | number) => ['attachment', id, 'dataUrl'] as const
  },

  // 统一通知中心（08-20-notification-center M1）。`all()` 是失效前缀 —— SSE
  // `notification.changed` 与写操作成功后都失效这一个 key，list/unreadCount 挂在
  // 它下面跟着过期。
  notifications: {
    all: () => ['notifications'] as const,
    // 🔴 category **不进 key**：面板恒拉全类目那一份，切 tab 是纯前端过滤
    // （notificationModel::filterByTab）。按 tab 分键等于 5 份缓存各自冷 fetch、
    // 各自白屏，而 All 的那一份本来就含全部类别。
    list: (state: string) => ['notifications', 'list', state] as const,
    unreadCount: () => ['notifications', 'unread-count'] as const
  }
} as const
