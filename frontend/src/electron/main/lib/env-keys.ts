// Sprint 18 — managed `.env` keys whitelist (SSoT).
//
// `env:get` filters its return shape to MANAGED_ENV_KEYS; `env:set` hard-
// rejects any key not in MANAGED_ENV_KEYS with E_INVALID_KEY. Two reasons:
//
//   1. Pydantic's BaseSettings(extra='ignore') silently drops stray keys —
//      a typo writes "NOTIN_TOKEN=..." to .env, Python ignores it, mail-sync
//      keeps using the old value, user sees "didn't save" with zero error.
//      Whitelist catches typos at the IPC boundary.
//   2. Many ENV keys are gray-rollout flags / internal tuning knobs
//      (BODY_DUAL_WRITE_ENABLED / LLM_PREFER_SQLITE_BODY / INIT_BATCH_SIZE /
//      APPLESCRIPT_TIMEOUT 等). Exposing those via env:set would let users
//      break the gray-rollout state. Sprint 18 Tier 1 + Advanced = 42 keys;
//      remaining ~50 ENV keys stay invisible.
//
// Maintaining: add a key here AND surface it in a Tab (PR D / PR F). Two gates
// now hold the two halves of that sentence:
//   • frontend/tests/main/env_keys_ui_coverage.test.ts — 正向: 任何在 UI 里被读/写的
//     env 键必须在此白名单 (渲染一个 env:set 会 E_INVALID_KEY 的输入框 = 用户填了、
//     点保存、失败或静默丢失)。
//   • tests/config/test_managed_env_keys_parity.py — 两份手抄白名单 (这里 ↔ 后端
//     src/api/routers/settings.py `_MANAGED_ENV_KEYS`) 对账, 防「远程能改桌面不能」。
// 反向 (白名单有键但无 Tab UI) 仍**不**强制 —— 白名单可以先行, UI 后落。

/** All keys the renderer is allowed to read AND write through env:* IPC. */
export const MANAGED_ENV_KEYS = [
  // — Accounts (PR D AccountsTab)
  'NOTION_TOKEN',
  'EMAIL_DATABASE_ID',
  'CALENDAR_DATABASE_ID',
  // Notion OAuth 接入 (task 08-20) —— 「连接 Notion」成功后 main 侧与 token/两库 ID
  // 一起原子 patch 写入的 workspace 展示信息 (AccountsTab 已连接态显示 workspace 名)。
  // 非 secret 明文; Python 不读 (display-only)。🔴 NOTION_REFRESH_TOKEN 有意不存在
  // (prd 拍板不落盘, 401 一律重新授权)。
  'NOTION_WORKSPACE_ID',
  'NOTION_WORKSPACE_NAME',
  // 选中的两个 data source id (task 08-20 Lane 5)。Notion 2025-09-03 起 database 是容器、
  // schema 在 data source；库选择器按 data source 粒度选, 而 Python 侧解析历来盲取
  // data_sources[0] —— 一个 database 含多个 data source 时会写错数据源。OAuth 把选中的
  // data source id 与两库 ID 一起原子写入, Python resolve_data_source_id 优先读它。
  // 非 secret 明文; 单 data source 库留空即老行为。
  'EMAIL_DATA_SOURCE_ID',
  'CALENDAR_DATA_SOURCE_ID',
  'USER_EMAIL',
  'MAIL_ACCOUNT_NAME',
  'MAIL_INBOX_NAME',
  'MAIL_SENT_NAME',
  'MAIL_ACCOUNT_URL_PREFIX',

  // — DavMail backend (Onboarding 向导 davmail 分支 + legacy 迁移)。config.py 的
  // davmail Field 全集。向导写连接配置 (host/port/poc 模式/cipher), legacy 继承时
  // managed-filter 也要带过来 —— 之前缺这些 key 导致 davmail 老用户迁移丢配置 →
  // 后端起不来。DAVMAIL_POC_CIPHER_KEY / DAVMAIL_CIPHER_KEY 都是 secret。
  // 注: 后端 config.py 当前读 env=DAVMAIL_POC_CIPHER_KEY; 旧文档/报错曾用 DAVMAIL_CIPHER_KEY,
  // 两个都纳入白名单避免继承时丢 (后端是否 alias 二者见 roadmap follow-up)。
  'DAVMAIL_HOST',
  'DAVMAIL_IMAP_PORT',
  'DAVMAIL_SMTP_PORT',
  'DAVMAIL_POC_CIPHER_KEY',
  'DAVMAIL_CIPHER_KEY',
  'DAVMAIL_POC_MODE',
  'DAVMAIL_FETCH_TIMEOUT_SEC',
  'DAVMAIL_UID_BACKFILL_ENABLED',
  'DAVMAIL_UID_BACKFILL_BATCH_SIZE',
  'DAVMAIL_UID_BACKFILL_SLEEP_SEC',
  'DAVMAIL_DRAFTS_FOLDER',
  'DAVMAIL_SENT_FOLDER',
  'DAVMAIL_ARCHIVE_SENT',
  'DAVMAIL_POLL_INTERVAL_SEC',
  'DAVMAIL_CALDAV_PORT',
  // IMAP 文件夹视图上限 → 写进 davmail.properties 的 davmail.folderSizeLimit
  // (AccountsTab davmail 面板; 大邮箱不配会让每次 SELECT/STATUS 经 EWS 全量枚举)。
  'DAVMAIL_FOLDER_SIZE_LIMIT',
  // Drafts sync toggle (davmail-only) — AccountsTab davmail 面板的草稿箱同步开关。
  // config.py drafts_sync_enabled Field (默认 true), 普通 boolean key 非 secret。
  'DRAFTS_SYNC_ENABLED',
  // 入向已读回收开关 (davmail-only, issue #60) — AccountsTab davmail 面板的
  // 「别处已读同步」开关。config.py inbound_read_reconcile_enabled Field
  // (默认 false, validation_alias=此键), 普通 boolean key 非 secret。
  // INTERVAL_SEC 不进白名单 (不给用户暴露, 见 AccountsTab 内注释)。
  // DAVMAIL_ROOT 有意不进白名单 (audit §3.2 改判): 普通用户不知道 davmail 装在哪,
  // 裸路径输入框只是把「找不到设置」换成「不知道填啥」; 正解 = DavMail 状态行加
  // 自动探测 + 一键写入 (需后端探测逻辑, 排后续版本)。
  'MAILAGENT_INBOUND_READ_RECONCILE_ENABLED',

  // — Sync (PR D SyncTab)
  'SYNC_DATE_MODE',
  'SYNC_START_DATE',
  'SYNC_LOOKBACK_DAYS',
  'SYNC_MAILBOXES',
  'RADAR_POLL_INTERVAL',
  'REVERSE_SYNC_INTERVAL',
  'CALENDAR_SYNC_MODE',
  'CALENDAR_PAST_DAYS',
  'CALENDAR_FUTURE_DAYS',
  'CALENDAR_CALDAV_SYNC_ENABLED',
  // CalDAV 同步节奏与窗口 (AccountsTab 日历面, CALENDAR_CALDAV_SYNC_ENABLED 下方三个
  // EnvField)。这三个键长期只在后端 settings.py `_MANAGED_ENV_KEYS` 里有 → 远程 web 能
  // 改、桌面 App 上 env:get 读回空且 env:set 抛 E_INVALID_KEY (控件渲染着但存不进去)。
  // 两份白名单现由 tests/config/test_managed_env_keys_parity.py 对账, UI↔白名单缺口由
  // frontend/tests/main/env_keys_ui_coverage.test.ts 兜住。
  'CALENDAR_CALDAV_SYNC_POLL_INTERVAL_SEC',
  'CALENDAR_CALDAV_SYNC_WINDOW_PAST_DAYS',
  'CALENDAR_CALDAV_SYNC_WINDOW_FUTURE_DAYS',
  // 会前提醒提前量 (Lane 2 #4, 分钟, 默认 10)。纯偏好、零风险、一眼懂 —— 最典型
  // 不该藏的一类。挂 CalendarSyncWorker 60s poll (davmail CalDAV 路径), AccountsTab
  // 日历面 davmail 分支; 无岛 / PING_ISLAND_ENABLED 关时静默 fail-open。
  'CALENDAR_REMINDER_LEAD_MINUTES',

  // — 多文件夹同步窗口 (SyncTab「自定义文件夹同步」区)。config.py folder_sync_past_days
  // / folder_sync_max_messages Field。SYNC_FOLDERS 白名单本身走 folder whitelist API
  // (后端 dotenv 写, 不经 env:set), 故不在此列。
  'FOLDER_SYNC_PAST_DAYS',
  'FOLDER_SYNC_MAX_MESSAGES',
  // FOLDER_NOTIFY_ENABLED / FOLDER_LLM_DISABLED 有意不进白名单 (audit §3.2 改判):
  // 值是 mailbox 显示名 JSON 数组, 裸文本框手写必错; 正解 = 文件夹选择 UI 里
  // per-folder 两个勾 (通知 / 跑 AI), 排后续版本。

  // — Backend selection (Onboarding 向导 backend 选择)。config.py 的 Field,
  // 值域 'applescript' | 'davmail' | 'outlook_com' (Sprint 16 dual-backend cutover;
  // task 08-12 加第三值 outlook_com, win-only, 平台过滤单源 @shared/lib/mailBackend)。
  // 向导写入, 默认 applescript (零依赖)。
  'MAILAGENT_BACKEND',

  // — Daily digest (Ping Island Phase 3 每日巡检)。config.py Field, boolean toggle,
  // 默认 false。向导插件勾选项之一 (plugins.digest → 这里)。
  'MAILAGENT_DAILY_DIGEST_ENABLED',
  // 巡检钟点 (Lane 2 #3)。开关此前只在向导有 UI、钟点全无 UI = 半个功能 ——
  // IslandUpdatesTab「每日巡检」区补齐两者。逗号分隔小时 (本机时区), 默认 9,18。
  'MAILAGENT_DAILY_DIGEST_HOURS',

  // — Report agents (Lane 2 #10, AgentsTab 报告区总闸)。config.py Field 默认 false。
  // 启动条件 = 本 flag OR 任一 report 行 enabled (service.py:737, OR 语义) —— flag 开 =
  // worker 常驻, 之后启用报告行**不用再重启**; flag 关 = 首次启用某报告后需重启一次。
  // 同型的 PROJECT_PROGRESS_SYNC_ENABLED 早有 UI (Agents 页抽屉), 它此前没有。
  'MAILAGENT_REPORT_AGENT_ENABLED',

  // — AI Agent (PR D AiTab)
  'LLM_AGENT_ENABLED',
  'LLM_API_BASE',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_TRANSLATE_BASE_URL',
  'LLM_TRANSLATE_API_KEY',
  'LLM_TRANSLATE_MODEL',
  'LLM_FALLBACK_MODELS',
  // Hot-read by serve-api via dotenv_values — changing this does NOT require
  // a backend restart (AiTab handleToggleModel intentionally skips
  // markRestartRequired). Must be writable so the multi-select dropdown can
  // persist the enabled set via env:set.
  'LLM_ENABLED_MODELS',
  'LLM_CONTEXT_PAGE_ID',
  'LLM_INBOX_PROMPT_PATH',
  'LLM_SENT_PROMPT_PATH',
  'LLM_CACHE_ENABLED',
  'LLM_CACHE_TTL',
  // memory.md auto-capture 抽取模型 (task 07-01 #1). config.py pydantic singleton
  // (memory_capture_model, default claude-haiku-4-5) → 改动需重启 serve-api 生效
  // (EnvField markRestartRequired), 同 LLM_MODEL. CustomAiSection 的记忆抽取模型下拉写它.
  'MEMORY_CAPTURE_MODEL',
  // AI 记忆双开关 (Lane 2 #8, 隐私级意图「AI 要不要记住我说的话」——此前能选抽取模型、
  // 却关不掉记忆, 是倒置的)。两个都默认 ON (2026-07-02 cutover), 显式 false 应急回退;
  // EnvField defaultOn 让未设时如实显示为开。CAPTURE = Node gateway 启动 envBool 读一次
  // → restart-required (同 MAILAGENT_OPENNESS_WEB_TOOLS); RETRIEVAL = serve-api chat.py
  // 每请求 dotenv_values 热读 → hotReload (保存即生效, 不拉重启横幅)。
  'MAILAGENT_MEM0_CAPTURE',
  'MAILAGENT_MEM0_RETRIEVAL',

  // — Web search (agent web_search provider). Tavily key (逗号分隔多 key 额度轮换);
  // 留空 → 回落 DuckDuckGo. IntegrationsTab「Web 搜索」Section 经 env:set 写 app .env;
  // web.py _do_search 热读 .env (dotenv_values), 保存即生效无需重启后端 (EnvField
  // hotReload 跳过 markRestartRequired); .env 缺键时回落 get_settings().tavily_api_key.
  // TAVILY_API_KEY 入 SECRET_ENV_KEYS 脱敏.
  'TAVILY_API_KEY',

  // — 联网能力开关 (task 07-07 R4a)。原为 main-env-only flag（gateway 启动 envBool 读一次,
  // ai_gateway_lifecycle.ts webToolsEnabled）→ Settings 系统能力区「联网」卡改真开关后纳入白名单,
  // 好让用户从 UI 开关 web_fetch/web_search。默认 ON（E3 cutover），显式 false 应急回退。
  // gateway 启动读一次；翻它需退出重开 App，mail-sync 重启横幅对此无效。
  // 非 secret（普通 boolean flag）。
  'MAILAGENT_OPENNESS_WEB_TOOLS',

  // — 飞书会话上网开关 (08-01 阶段 2 PR4, grill Q19=A)。**Node 单载体** main-env-only flag
  // (ai_gateway_lifecycle.ts `imWebEnabled` = envBool('MAILAGENT_IM_WEB_ENABLED', false)) →
  // 设置-AI「飞书对话」区 ImFeishuSection 的真开关，故必须在册。默认 OFF (网页内容不可信,
  // 且飞书账号被盗 ≠ 电脑被盗) → EnvField/Switch 未设时如实显示为关。restart-required
  // (gateway 启动读一次)。非 secret。🔴 总闸 MAILAGENT_IM_FEISHU **有意不在册** ——
  // 灰度期由 env 手动管理 (双载体, 翻它要同时重启 serve 与 app), UI 只显示状态不给开关。
  'MAILAGENT_IM_WEB_ENABLED',

  // — Labs 默认 OFF 灰度 flag。cutover 默认 ON 后须从 Labs 撤条目。
  // 外部 MCP 连接器：Python serve-api + Electron gateway 双载体；完整生效需重启 serve/
  // serve-api 并退出重开 App。Labs 行内按钮只负责两路后端重启，App 侧按文案手动重开。
  'MAILAGENT_MCP_CONNECTORS',
  // 技能目录注入系统提示：Electron gateway 单载体，默认 OFF；需退出重开 App。
  'MAILAGENT_SKILL_CATALOG_PROMPT',
  // 五层记忆自动整理：Python pydantic 启动读取，默认 OFF；需重启后端。
  'MAILAGENT_MEMORY_LAYERS',
  // AG-UI 镜像端点：Electron gateway 单载体，默认 OFF；需退出重开 App。
  'MAILAGENT_AG_UI_MIRROR',
  // — Notifications (PR D NotificationsTab)
  'FEISHU_NOTIFY_ENABLED',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_CHAT_ID',
  'ALERT_ENABLED',
  'ALERT_FEISHU_WEBHOOK_URL',
  'ALERT_FEISHU_WEBHOOK_SECRET',
  'ALERT_LEVELS',

  // — Integrations (PR D IntegrationsTab)
  'PROJECT_PROGRESS_SYNC_ENABLED',
  'PROJECT_PROGRESS_AUTO_SYNC_ENABLED',
  'PROJECT_PROGRESS_DATABASE_ID',
  'PROJECT_PROGRESS_FILTER_BU',
  'PROJECT_PROGRESS_SUBJECT_PATTERN',
  'PROJECT_PROGRESS_SENDER',
  // 附件 OCR (Lane 2 #9)。macOS Vision 本地识别图片/扫描件 PDF → 可搜索; 无网络出口。
  // config.py Field 默认 true → EnvField defaultOn; IntegrationsTab 附件处理区。
  // 显式 false = 图片/扫描件回「不支持」现状。
  'MAILAGENT_ATTACHMENT_OCR_ENABLED',
  'STATS_REPORT_URL',
  'STATS_REPORT_INTERVAL',
  'STATS_REPORT_TOKEN',
  'DASHBOARD_PASSWORD',
  'MAILAGENT_CLI_API_KEY',

  // — Realtime & Storage (PR D RealtimeStorageTab + PR F Advanced)
  'REDIS_EVENTS_ENABLED',
  'REDIS_URL',
  'BODY_DUAL_WRITE_ENABLED',
  'MAILAGENT_SSE_ENABLED',
  'LOG_LEVEL',
  'MAILAGENT_OUTBOX_POLL_INTERVAL_SEC',
  'MAILAGENT_OUTBOX_MAX_ATTEMPTS',
  'MAILAGENT_OUTBOX_CONCURRENCY',
  // 防休眠保活 (Lane 2 #5, RealtimeStorageTab「防休眠」区)。ENABLED 默认 false;
  // DIM (保活时调暗屏幕) 默认 true → defaultOn。⚠️ davmail 模式下 service.py:94-98
  // 自动禁用 keep-alive (IMAP/SMTP 不需要 UI session) —— helper 文案如实说明,
  // 不然对生产主路径 (davmail) 用户就是又一个「改了什么都不发生」的假开关。
  'KEEP_ALIVE_ENABLED',
  'KEEP_ALIVE_DIM',

  // — KOS (Jarvis KOS v2 producer/consumer integration)。boolean toggle 默认
  // false + KOS 对接三件套: endpoint (KOS_MCP_BASE) + OAuth client_id/secret。
  // IntegrationsTab 的 KOS Section 经 env:set 写 app .env; KOS_OAUTH_CLIENT_SECRET
  // 入 SECRET_ENV_KEYS → env:get 读取脱敏 (renderer 永不见明文, 同其它 secret)。
  // 其余两项非密钥明文。(MAILAGENT_AGENT_HARNESS 已随 legacy harness 退役, S3。)
  'MAILAGENT_KOS_CONSUMER_ENABLED',
  'MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED',
  'MAILAGENT_KOS_INGEST_ENABLED',
  'MAILAGENT_KOS_TIME_DECAY_ENABLED',
  'KOS_MCP_BASE',
  'KOS_OAUTH_CLIENT_ID',
  'KOS_OAUTH_CLIENT_SECRET',
  // issue #64 — producer (推送邮件入库) 用的是**另一套**凭据, 不是上面两个
  // KOS_OAUTH_CLIENT_*。v1.19.1 引入它们时只写进了 .env.example, 而 .env.example
  // 只对新装用户有效 ⇒ 每个从 ≤v1.19.0 升上来且开了入库的用户都必然缺这两个键、
  // 必然看不到「知识库入库」看板, 且没有任何 UI 入口可补。这里纳入白名单 +
  // IntegrationsTab KOS Section「高级」里给 EnvField, 让它可见可填。
  // MAILAGENT_BULK_CLIENT_SECRET 入 SECRET_ENV_KEYS → env:get 脱敏 (同
  // KOS_OAUTH_CLIENT_SECRET); CLIENT_ID 是明文 ID, 同 KOS_OAUTH_CLIENT_ID 不脱敏。
  'MAILAGENT_BULK_CLIENT_ID',
  'MAILAGENT_BULK_CLIENT_SECRET',
  // 入库范围两半 (Lane 2 #2, issue #49 病根的产品面)。floor = 只推重要度 ≥ 某档
  // (五值 select, 默认 normal); require_labeled = AI 从未标注过的邮件算不算数
  // (默认 false = 未标注按 normal 放行, 历史邮件 ~89% 走这条默认分支)。只放一个,
  // 用户看到 floor=normal 会以为已在过滤。REQUIRE_LABELED=true + LLM 分类关 =
  // 静默死锁 (一封都推不进、零报错) → IntegrationsTab 有联动警告, 非静态文案。
  // 🔴 默认值都不动 —— 翻默认会让存量用户入库量骤降 ~89% (无声破坏性变更)。
  'KOS_INGEST_PRIORITY_FLOOR',
  'KOS_REQUIRE_LABELED',

  // — Island (PR D IslandUpdatesTab)
  'PING_ISLAND_ENABLED',
  'ISLAND_SOCKET_PATH',
  // 邮件弹卡范围 (Lane 2 #1 —— 全批最该暴露的一个: 直接决定被打扰频率)。
  // important (默认) = 仅 AI 判定紧急/重要弹卡; all = 每封新邮件都弹 (旧行为)。
  // 二选一 select, 默认经 placeholder 如实展示; service.py 启动传入 → restart-required。
  'ISLAND_MAIL_NOTIFY_SCOPE',
  // 岛外观 (Lane 2 #10 追加项): 主题色六选一 (coral/cobalt/teal/rose/slate/olive,
  // .env.example:627 权威枚举) + 明暗二选一。App 本体有完整主题设置、唯独岛只能改
  // 文件——纯外观偏好零风险。envelope metadata 透传 Swift; service.py 启动传入 →
  // restart-required。默认 coral / dark 经 placeholder 如实展示。
  'ISLAND_ACCENT',
  'ISLAND_THEME',

  // — Remote Access (serve-api / RemoteAccessTab). V2 远程访问从 dogfood (手动
  // nohup serve-api) 收尾成生产态: serve-api 进程纳入打包 app 的
  // BackendLifecycleManager。这 5 个字段是 RemoteAccessTab 经 env:set 写 app .env
  // 的全集, 全部非 secret:
  //   - MAILAGENT_REMOTE_ACCESS_ENABLED: gate flag, !=='false' 即开 (默认开,
  //     bind loopback 零攻击面)。serveApiEnabled() 读它决定是否 spawn serve-api。
  //   - CF_AUDIENCE: Cloudflare Access Application "Audience" tag (公开应用标识非密钥)。
  //     auth.py 模块 import 期读它做 JWT aud 校验; 空则 serve-api 拒起 (软门控前提)。
  //   - CF_TEAM_DOMAIN: xxx.cloudflareaccess.com 团队域名 (JWKS issuer)。
  //   - MAILAGENT_API_PORT: 本地 API 端口 (默认 8200, bind 127.0.0.1)。
  //   - MAILAGENT_API_ALLOWED_EMAIL: 允许访问的邮箱 (留空=USER_EMAIL)。
  // CF_AUDIENCE 是 application tag 非密钥, 不入 SECRET_ENV_KEYS。改这些字段后需
  // 重启 serve-api 生效 (RestartBanner / Tab 内重启按钮触发)。
  'MAILAGENT_REMOTE_ACCESS_ENABLED',
  'CF_AUDIENCE',
  'CF_TEAM_DOMAIN',
  'MAILAGENT_API_PORT',
  'MAILAGENT_API_ALLOWED_EMAIL',

  // feat/auto-update re-review (codex, trust boundary) — AUTO_UPDATE_ENABLED is
  // intentionally NOT a managed key: it's the master safety gate for proactive
  // updater behavior, read directly via process.env in handlers/updater.ts.
  // Keeping it out of this list means env:set can never flip it from the renderer
  // before P6 notarization (enabling auto-update on an ad-hoc build → can't install).

  // — Advanced / readonly display (PR F RealtimeStorageTab disclosure).
  // These two land here so `env:get` returns them for read-only rendering,
  // but EnvField control="readonly" never calls env:set on them, so the
  // whitelist branch in `env:set` returns "no change" if anything ever
  // tries (renderer code shouldn't, this is belt + suspenders).
  'SSE_LOCAL_HOST',
  'SSE_LOCAL_PORT'
] as const

export type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number]

/** O(1) membership check. */
export const MANAGED_ENV_KEY_SET: Set<string> = new Set<string>(MANAGED_ENV_KEYS)

/** Keys whose values must NEVER cross IPC in plaintext. env:get redacts these
 *  to '***' (length > 0) or '' (unset). env:set accepts plaintext writes but
 *  doesn't log them. The renderer's password-input + write-only contract means
 *  users either type a new value or clear it; they can never read an existing
 *  secret back out — that's by design (DESIGN.md + SPRINT18-HANDOFF.md §pasta-
 *  prevention: a stolen renderer never has the secret). */
export const SECRET_ENV_KEYS: Set<string> = new Set<string>([
  'NOTION_TOKEN',
  'FEISHU_APP_SECRET',
  'ALERT_FEISHU_WEBHOOK_SECRET',
  'LLM_API_KEY',
  'LLM_TRANSLATE_API_KEY',
  'STATS_REPORT_TOKEN',
  'DASHBOARD_PASSWORD',
  'MAILAGENT_CLI_API_KEY',
  'DAVMAIL_POC_CIPHER_KEY',
  'DAVMAIL_CIPHER_KEY',
  // Tavily 搜索 key — IntegrationsTab「Web 搜索」Section 写, Python web.py 从 config
  // (get_settings) 读. 同其它 secret: env:get 脱敏不回 renderer。
  'TAVILY_API_KEY',
  // KOS (gbrain) OAuth client_secret — IntegrationsTab KOS Section 写, Python
  // KOSClient 从 .env 读 (os.getenv). 同其它 secret: env:get 脱敏不回 renderer。
  'KOS_OAUTH_CLIENT_SECRET',
  // KOS producer (bulk) client_secret — 与上面那个是两套凭据 (issue #64)。
  // make_bulk_kos_client() 从 .env 读 (os.getenv); 同样脱敏不回 renderer。
  'MAILAGENT_BULK_CLIENT_SECRET',
  // codex r4 [HIGH] — MANAGED (returned) URLs whose value embeds a credential,
  // so they're redacted, not sent in plaintext. Parity mirror of
  // settings.py `_SECRET_ENV_KEYS`. ALERT_FEISHU_WEBHOOK_URL's trailing path
  // segment IS the bot token; REDIS_URL can carry an inline password
  // (`redis://[:password@]host:port`). Both stay in MANAGED_ENV_KEYS above
  // (L107 / L127) so env:get still returns them — just redacted.
  'ALERT_FEISHU_WEBHOOK_URL',
  'REDIS_URL'
])

/** Keys the UI surfaces as readonly display only. env:set on these is
 *  rejected with E_INVALID_KEY (they're not in MANAGED_ENV_KEYS, so the
 *  default reject path catches them — this set exists for documentation
 *  + the Settings UI knowing to render them disabled). */
export const READONLY_DISPLAY_KEYS: Set<string> = new Set<string>([
  'SSE_LOCAL_HOST',
  'SSE_LOCAL_PORT'
])
