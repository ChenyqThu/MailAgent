// Phase 2 — 全局设置搜索索引（⌘F 快速跳转到 8+1 Tab、子 section 与 envKey）。
//
// 纯数据 + 纯检索函数，不依赖 React 或 router，供 SettingsSearchBar 与单测直接复用。

import type { SettingsTab } from '@shared/lib/settingsTabs'

import { AI_TAB_ANCHOR_IDS } from './aiTabAnchors'

export interface SettingsSearchEntry {
  id: string
  tab: SettingsTab
  section?: 'connectors' | 'mcp'
  anchorId?: string
  /** 可选 i18n key；消费方用 `t(titleKey, { defaultValue: title })` 渲染。 */
  titleKey?: string
  title: string
  subtitleKey?: string
  subtitle?: string
  keywords: readonly string[]
}

export const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchEntry[] = [
  // ── 通用与外观 ──
  {
    id: 'general-appearance',
    tab: 'general',
    titleKey: 'settings.appearance',
    title: '外观、语言与主题',
    subtitle: 'Accent / Theme / Language / Glass',
    keywords: ['general', 'appearance', 'theme', 'accent', 'language', 'glass', 'font', 'diagnostics', '外观', '主题', '强调色', '语言', '玻璃', '字体', '诊断']
  },
  {
    id: 'general-tab-workspace',
    tab: 'general',
    titleKey: 'settings.general.tabWorkspace.title',
    title: '标签工作区',
    subtitle: 'Tab workspace & body typography',
    keywords: ['workspace', 'tabs', 'typography', 'body', '标签', '工作区', '正文']
  },

  // ── 账户与同步 ──
  {
    id: 'accounts-mail-source',
    tab: 'accounts',
    titleKey: 'settings.accounts.source.title',
    title: '邮件账户与 DavMail',
    subtitle: 'USER_EMAIL · DAVMAIL_HOST · IMAP · SMTP · CalDAV',
    keywords: [
      'accounts',
      'email',
      'imap',
      'smtp',
      'caldav',
      'davmail',
      'oauth',
      'USER_EMAIL',
      'DAVMAIL_HOST',
      'DAVMAIL_IMAP_PORT',
      'DAVMAIL_SMTP_PORT',
      'DAVMAIL_CALDAV_PORT',
      'MAIL_ACCOUNT_NAME',
      'SYNC_MAILBOXES',
      '邮箱',
      '账户',
      '签名',
      '邮件源'
    ]
  },
  {
    id: 'accounts-sync-window',
    tab: 'accounts',
    anchorId: 'settings-accounts-sync',
    titleKey: 'settings.sync.page.title',
    title: '邮件与日历同步频率',
    subtitle: 'SYNC_DATE_MODE · RADAR_POLL_INTERVAL · CALENDAR_SYNC_MODE',
    keywords: [
      'sync',
      'calendar',
      'radar',
      'poll',
      'SYNC_DATE_MODE',
      'SYNC_START_DATE',
      'SYNC_LOOKBACK_DAYS',
      'RADAR_POLL_INTERVAL',
      'REVERSE_SYNC_INTERVAL',
      'CALENDAR_SYNC_MODE',
      '同步',
      '日历',
      '轮询',
      '回溯天数'
    ]
  },
  {
    id: 'accounts-notion',
    tab: 'accounts',
    titleKey: 'settings.accounts.notion.title',
    title: 'Notion 数据库同步',
    subtitle: 'NOTION_TOKEN · EMAIL_DATABASE_ID · CALENDAR_DATABASE_ID',
    keywords: ['notion', 'NOTION_TOKEN', 'EMAIL_DATABASE_ID', 'CALENDAR_DATABASE_ID', 'database', '签名']
  },

  // ── 模型与 AI ──
  {
    id: 'ai-providers',
    tab: 'ai',
    anchorId: AI_TAB_ANCHOR_IDS.modelServices,
    titleKey: 'settings.providers.title',
    title: '模型服务与 Provider 管理',
    subtitle: 'OpenAI · Anthropic · DeepSeek · Doubao · Ollama · OpenRouter · 429 Pool',
    keywords: [
      'ai',
      'llm',
      'provider',
      'model',
      'openai',
      'anthropic',
      'claude',
      'gemini',
      'deepseek',
      'doubao',
      'volcengine',
      'ark',
      'ollama',
      'lmstudio',
      'openrouter',
      'groq',
      'mistral',
      'xai',
      'opencode',
      'api key',
      '429',
      'model catalog',
      '模型',
      '供应商',
      '密钥',
      '本地模型'
    ]
  },
  {
    id: 'ai-privacy-mask',
    tab: 'ai',
    anchorId: AI_TAB_ANCHOR_IDS.privacyMask,
    titleKey: 'settings.privacyMask.title',
    title: '出站隐私占位符脱敏',
    subtitle: 'API Key · 身份证 · 手机号 · 邮箱 · 自定义正则',
    keywords: [
      'privacy',
      'pii',
      'mask',
      'redact',
      'placeholder',
      'regex',
      'secret',
      '隐私',
      '脱敏',
      '占位符',
      '正则',
      'Fail-Closed'
    ]
  },
  {
    id: 'ai-usage-dashboard',
    tab: 'ai',
    anchorId: AI_TAB_ANCHOR_IDS.usage,
    titleKey: 'settings.usageDashboard.title',
    title: 'AI 用量与缓存命中率监控',
    subtitle: 'Token · Cost · Prompt Cache · probelog',
    keywords: [
      'usage',
      'token',
      'cost',
      'cache',
      'hit rate',
      'probelog',
      'diagnostics',
      '用量',
      '成本',
      '缓存命中率',
      '账单',
      '探测日志'
    ]
  },
  {
    id: 'ai-gateway',
    tab: 'ai',
    anchorId: AI_TAB_ANCHOR_IDS.gateway,
    titleKey: 'settings.ai.title',
    title: 'AI 网关与环境变量覆盖',
    subtitle: 'LLM_API_BASE · LLM_API_KEY',
    keywords: ['gateway', 'LLM_API_BASE', 'LLM_API_KEY', '网关']
  },
  {
    id: 'ai-translate',
    tab: 'ai',
    anchorId: AI_TAB_ANCHOR_IDS.translate,
    titleKey: 'settings.ai.translate.title',
    title: '翻译模型',
    subtitle: 'LLM_TRANSLATE_MODEL · LLM_TRANSLATE_BASE_URL',
    keywords: ['translate', 'LLM_TRANSLATE_MODEL', 'LLM_TRANSLATE_BASE_URL', '翻译']
  },
  {
    id: 'ai-image-gen',
    tab: 'ai',
    anchorId: AI_TAB_ANCHOR_IDS.imageGenModel,
    titleKey: 'settings.ai.imageGen.title',
    title: '生图模型',
    subtitle: 'Image generation model & provider',
    keywords: ['image', 'generation', '生图', '图片']
  },
  {
    id: 'ai-cache-title-compact',
    tab: 'ai',
    anchorId: AI_TAB_ANCHOR_IDS.cache,
    title: '提示词缓存、自动标题与上下文压缩',
    subtitle: 'Prompt Cache · Auto Title · Auto Compact',
    keywords: ['cache', 'prompt cache', 'auto title', 'compact', 'token', '缓存', '标题', '压缩']
  },
  {
    id: 'ai-agent-capabilities',
    tab: 'ai',
    anchorId: AI_TAB_ANCHOR_IDS.approval,
    title: 'Agent 审批、记忆、技能与飞书机器人',
    subtitle: 'Approval · Skills · Memory · Standing Docs · Exec Policy · Feishu IM',
    keywords: [
      'agent',
      'approval',
      'skills',
      'memory',
      'user.md',
      'standing',
      'exec',
      'feishu',
      '审批',
      '记忆',
      '技能',
      '飞书',
      '执行策略'
    ]
  },

  // ── 工具与 MCP ──
  {
    id: 'connectors-workbench',
    tab: 'connectors',
    section: 'connectors',
    titleKey: 'settings.connectorsTab.connectors',
    title: '工具与外部 MCP 连接器',
    subtitle: 'Built-in Connectors · Custom MCP Servers · Stdio / HTTP',
    keywords: ['connectors', 'tools', 'stdio', 'http', 'mcp server', 'plugin', '工具', '连接器', '外部工具']
  },
  {
    id: 'connectors-mcp-service',
    tab: 'connectors',
    section: 'mcp',
    anchorId: 'settings-connectors-mcp',
    titleKey: 'settings.connectorsTab.mcp',
    title: '对外 MCP 服务与 API Keys',
    subtitle: 'MCP Server · Bearer Tokens · Tool Scopes · Audit Log',
    keywords: ['mcp', 'api key', 'bearer', 'scope', 'audit', 'server', '对外服务', '审计', '密钥']
  },

  // ── 事项 ──
  {
    id: 'matters-config',
    tab: 'matters',
    titleKey: 'settings.matters.title',
    title: '事项工作台',
    subtitle: 'Matters workspace settings',
    keywords: ['matters', '事项']
  },

  // ── 通知与常驻 ──
  {
    id: 'notifications-feishu-alerts',
    tab: 'notifications',
    titleKey: 'settings.notifications.page.title',
    title: '通知、飞书推送与告警',
    subtitle: 'FEISHU_NOTIFY_ENABLED · ALERT_ENABLED · ALERT_LEVELS',
    keywords: [
      'notifications',
      'feishu',
      'alert',
      'webhook',
      'FEISHU_NOTIFY_ENABLED',
      'FEISHU_APP_ID',
      'ALERT_ENABLED',
      'ALERT_FEISHU_WEBHOOK_URL',
      '通知',
      '飞书',
      '告警'
    ]
  },
  {
    id: 'notifications-island-updates',
    tab: 'notifications',
    anchorId: 'settings-notifications-island',
    titleKey: 'settings.update.heading',
    title: '应用更新',
    subtitle: 'App Updater · GitHub Releases',
    keywords: [
      'update',
      'updater',
      'tray',
      'menubar',
      'release',
      '更新',
      '常驻',
      '菜单栏',
      '版本'
    ]
  },

  // ── 知识库与集成 ──
  {
    id: 'integrations-kos',
    tab: 'integrations',
    titleKey: 'settings.integrations.kos.title',
    title: '知识大脑 (KOS) 与 OAuth',
    subtitle: 'MAILAGENT_KOS_CONSUMER_ENABLED · KOS_MCP_BASE · OCR · Stats',
    keywords: [
      'integrations',
      'kos',
      'ocr',
      'cli',
      'stats',
      'MAILAGENT_KOS_CONSUMER_ENABLED',
      'KOS_MCP_BASE',
      'MAILAGENT_ATTACHMENT_OCR_ENABLED',
      'STATS_REPORT_URL',
      'MAILAGENT_CLI_API_KEY',
      '知识库',
      '集成',
      '附件'
    ]
  },

  // ── 存储与远程 ──
  {
    id: 'realtime-sse-storage',
    tab: 'realtime',
    titleKey: 'settings.realtime.page.title',
    title: '实时事件、Redis 与高级存储',
    subtitle: 'MAILAGENT_SSE_ENABLED · REDIS_URL · KEEP_ALIVE_ENABLED · LOG_LEVEL',
    keywords: [
      'realtime',
      'sse',
      'redis',
      'storage',
      'keepalive',
      'outbox',
      'MAILAGENT_SSE_ENABLED',
      'REDIS_EVENTS_ENABLED',
      'REDIS_URL',
      'KEEP_ALIVE_ENABLED',
      'LOG_LEVEL',
      '实时',
      '存储',
      '防休眠',
      '日志'
    ]
  },
  {
    id: 'realtime-remote-cloudflare',
    tab: 'realtime',
    anchorId: 'settings-realtime-remote',
    titleKey: 'settings.remote.page.title',
    title: '远程访问与 Cloudflare Access',
    subtitle: 'MAILAGENT_REMOTE_ACCESS_ENABLED · CF_AUDIENCE · CF_TEAM_DOMAIN · MAILAGENT_API_PORT',
    keywords: [
      'remote',
      'cloudflare',
      'cf',
      'access',
      'tunnel',
      'api',
      'MAILAGENT_REMOTE_ACCESS_ENABLED',
      'CF_AUDIENCE',
      'CF_TEAM_DOMAIN',
      'MAILAGENT_API_PORT',
      '远程',
      '访问',
      '隧道'
    ]
  },

  // ── 实验室 ──
  {
    id: 'labs-flags',
    tab: 'labs',
    titleKey: 'settings.labs.page.title',
    title: '实验室特性开关',
    subtitle: 'MAILAGENT_SKILL_CATALOG_PROMPT · MAILAGENT_MEMORY_LAYERS · MAILAGENT_AG_UI_MIRROR',
    keywords: [
      'labs',
      'experimental',
      'flags',
      'MAILAGENT_SKILL_CATALOG_PROMPT',
      'MAILAGENT_MEMORY_LAYERS',
      'MAILAGENT_AG_UI_MIRROR',
      '实验',
      '开关'
    ]
  }
]

/**
 * 按空白分词检索设置入口；空查询返回当前可见（含或不含 matters）全部索引项。
 */
export function searchSettingsItems(query: string, includeMatters: boolean): SettingsSearchEntry[] {
  const pool = SETTINGS_SEARCH_ITEMS.filter((item) => includeMatters || item.tab !== 'matters')
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return pool
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  return pool.filter((item) => {
    const haystack = [item.title, item.subtitle ?? '', item.tab, ...item.keywords]
      .join(' ')
      .toLowerCase()
    return tokens.every((tok) => haystack.includes(tok))
  })
}
