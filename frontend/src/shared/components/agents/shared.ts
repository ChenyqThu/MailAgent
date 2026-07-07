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

// 远程 web 下 env 写只读（镜像 AiTab.isWeb）：env:set 在 HttpApi 是 notImplemented，
// 故启用/模型控件禁用；persona / 文档勾选 / 身份文档编辑走 HTTP row/profile 端点，仍可编辑。
export const IS_WEB =
  (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
  'web'

// LLM_AGENT_ENABLED 存的是 'true'/'1' 视作开（镜像 EnvField toggle 解析）。
export function envFlagOn(raw: string): boolean {
  return raw === 'true' || raw === '1'
}
