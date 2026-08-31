import type { AdminApi } from './admin'
import type { CalendarApi } from './calendar'
import type { ChatApi } from './chat'
import type { ConnectorApi } from './connector'
import type { EmailApi } from './email'
import type { EventsApi } from './events'
import type { FeedbackApi } from './feedback'
import type { FolderApi } from './folder'
import type { IslandApi } from './island'
import type { JobsApi } from './jobs'
import type { KosApi } from './kos'
import type { LlmApi } from './llm'
import type { ReportApi } from './report'
import type {
  AttachmentApi,
  EnvApi,
  NotionAgentApi,
  NotionWriteApi,
  PromptsApi,
  ServicesApi,
  SettingsApi
} from './settings'
import type { TodayApi } from './today'
import type { AiApi } from './translate'
import type { UpdaterApi } from './updater'

export interface MailApi {
  email: EmailApi
  /** D2b — async_jobs 长任务查询 (batch resync 进度轮询; backfill UI 未来复用)。 */
  jobs: JobsApi
  /** 多文件夹同步管理: folder discover / whitelist / 文件夹 CRUD / cleanup (davmail-only)。 */
  folder: FolderApi
  attachment: AttachmentApi
  ai: AiApi
  chat: ChatApi
  /** 08-01 阶段 1 PR4 — MCP connector 设置面 (连接 / 授权 / 工具清单与开关)。 */
  connector: ConnectorApi
  llm: LlmApi
  /** issue #59 — KOS 入库台账统计 (LLM Dashboard「知识库入库」区)。 */
  kos: KosApi
  notion: NotionWriteApi
  /** Sprint 6 — admin dashboard data. */
  admin: AdminApi
  /** Sprint 6 — recurring meeting list. */
  calendar: CalendarApi
  /** Sprint 6 — SettingsPage IPC surface (keytar + persistent settings). */
  settings: SettingsApi
  /** Sprint 8 — electron-updater bridge (current version + check / download / install). */
  updater: UpdaterApi
  /** Sprint 9 — ping-island bridge (status + appearance broadcast + AI draft envelopes). */
  island: IslandApi
  /** Sprint 16 — SSE events bridge (replaces 5s polling). */
  events: EventsApi
  /** Sprint 18 §PR B — repo-root .env read/write. Settings tabs use this to
   *  persist managed ENV keys directly to the file Python services read. */
  env: EnvApi
  /** Sprint 18 §PR B — pm2 restart/status bridge. Wired to the
   *  RestartBanner (PR E) "立即重启" CTA after env:set returns
   *  restartRequired=true. */
  services: ServicesApi
  /** LLM prompt file CRUD (inbox / sent markdown). */
  prompts: PromptsApi
  /** Notion Agent CLI config — read/edit the bound Custom Agent + default
   *  model in ~/.notionagents/notion_account.json. */
  notionAgent: NotionAgentApi
  /** Sprint 20 — 报告 Agent (/agents 页): list/get 直读 sync_store.db,
   *  runNow/getConfig/setConfig 经 `mailagent report` CLI fork. */
  report: ReportApi
  /** task 08-27 P4c — 今日页聚合读（只出「待回邮件」与「下一个硬时间点」两块，
   *  其余四节走各自现成端点）。 */
  today: TodayApi
  /** task 08-27 P4a — 快捷反馈。**Electron-only 可选面**（截图 / 诊断包 / 绕 CSP 提交
   *  都只有主进程做得到）；远程 web 不实现，入口按它在不在决定显不显示。 */
  feedback?: FeedbackApi
}
