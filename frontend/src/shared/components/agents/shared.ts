// Sprint 20 — /agents 抽屉共享原子：从 AgentsTab.tsx 机械抽出的跨卡片 / 抽屉复用常量与
// 纯 helper（press scale / web 只读判定 / env flag 解析 / 文档名 / 专型行 agent id）。
// 组件类共享（Field）在 ./drawers/Field；本文件不导出组件（保 react-refresh 纪律）。

// 内联按钮缺 :active 伪类 → 用 pointer 事件落地 press scale（DESIGN §9.3 / make-interfaces #12）。
// scale 0.97 ≥ 0.95 红线；调用方须在 style 里把 transform 列进 transition（含 transform，禁 transition:all）。
export const PRESS_SCALE = 'scale(0.97)'
export function pressHandlers(scale = PRESS_SCALE): {
  onMouseDown: (e: React.MouseEvent<HTMLElement>) => void
  onMouseUp: (e: React.MouseEvent<HTMLElement>) => void
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => void
} {
  return {
    onMouseDown: (e) => {
      e.currentTarget.style.transform = scale
    },
    onMouseUp: (e) => {
      e.currentTarget.style.transform = 'none'
    },
    onMouseLeave: (e) => {
      e.currentTarget.style.transform = 'none'
    }
  }
}

// 可注入分类 system prompt 的身份文档（profile-doc 名）；后端默认播种 ['soul','user']。
export const PREPROCESS_DOCS = ['soul', 'agent', 'rules', 'user'] as const

// S5 W5a 「项目周报同步」专型行 —— 后端 DB v31 播种单行（id 固定、type='project_progress'）。
// 触发（enabled + sender/subject）存 report_agent row（enabled 列 + trigger_json，Settings 改即
// 生效）；总闸走全局 env PROJECT_PROGRESS_SYNC_ENABLED（.env，非 UI toggle）；执行走确定性 runner
// （xlsx→Notion），不进 gateway。
export const PROJECT_PROGRESS_AGENT_ID = 'project_progress_sync'

// WP6「联系人画像」专型行 —— 后端 DB v63 播种单行（id 固定、type='contact_profile'）。
// 与 project_progress 同款「单例行 + trigger_json 存字面配置」：这里存
// {fire_hour, daily_limit}（每日批处理时刻 + 每轮人数上限），运行时由
// `src/contacts/profile_config.py::get_contact_profile_agent_config` 行内热读。
// 2026-08-19 cutover 后 venue 恒启用；是否自动运行只看该行 enabled 与排程。
export const CONTACT_PROFILE_AGENT_ID = 'contact_profile_agent'

// 通讯录 agent 面 v2「通讯录治理」专型行 —— 后端 DB v65 播种单行（id 固定、
// type='contact_governance'）。与画像行同款「单例行 + trigger_json 存字面配置」，这里只存
// {fire_hour}（每日扫描时刻）—— 治理扫描一次跑完增量、不按人计费，没有第二个字段。
// 2026-08-19 cutover 后总闸恒启用（`MAILAGENT_CONTACT_AGENT_ENABLED` 已随五个 venue env
// 闸一起退役），是否自动运行只看该行 enabled 与排程 —— 不走 useEnvStore。
// 🔴 与治理台抽屉共用这一个常量（`components/contacts/ContactAgentDrawer.tsx` 的脚部跳转
// 用它点名要打开哪张卡的配置抽屉）。
export const CONTACT_GOVERNANCE_AGENT_ID = 'contact_governance_agent'

// 0813 主 Agent（默认助手）的编辑器派生/换一换种子 —— 主 agent 不走 id 派生外观（未配置时
// 落 OFFICIAL_ASSISTANT_AVATAR），种子只喂 shuffle 递进。卡片与抽屉共用同一个值，否则同一个
// 「换一换」在两处会走出两条不同的序列。
export const MAIN_ASSISTANT_SEED = 'main-assistant'

// 远程 web 下 env 写只读（镜像 AiTab.isWeb）：env:set 在 HttpApi 是 notImplemented，
// 故启用/模型控件禁用；persona / 文档勾选 / 身份文档编辑走 HTTP row/profile 端点，仍可编辑。
export const IS_WEB =
  (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
  'web'

// LLM_AGENT_ENABLED 存的是 'true'/'1' 视作开（镜像 EnvField toggle 解析）。
export function envFlagOn(raw: string): boolean {
  return raw === 'true' || raw === '1'
}

// ---- P4a 团队页成员标识（清单 / 记录面 / 配置页共用的接缝契约） ----

// 「AI 邮件预处理」专型行（后端播种单行，type='preprocess'）。搜索行不设常量：
// 消费侧一律按 `cfg.type === 'search'` 过滤（单例行 id 在 sync_store.py 播种，前端无需点名）。
export const EMAIL_PREPROCESS_AGENT_ID = 'email_preprocess_agent'

// 团队页成员引用：除主 Agent 外，内置专型 / 报告 / 自定义全部是 report_agent 行，
// 用行 id 即可寻址（分组与视图档由行的 type 派生，不进 ref）。
// 🔴 报告类（type='report'）是可变行集（日/周/月），不设 id 常量，恒按 type 过滤。
// 🔴 会话侧 `ai_chat_sessions.agent_id` 的 `matter:*` / `matter_item:*` 命名空间属事项域，
//    永不映射成 TeamMemberRef —— 聚合查询显式排除，不靠「查不到」侥幸。
export type TeamMemberRef = { kind: 'main' } | { kind: 'agent'; agentId: string }

/** 选中态 / 列表 key 用的稳定序列化（'main' 与 agent id 无碰撞：id 均为 snake_case）。 */
export function memberRefKey(ref: TeamMemberRef): string {
  return ref.kind === 'main' ? 'member:main' : `member:agent:${ref.agentId}`
}
