// Barrel re-export for the MailApi data-layer types (E4 §6.2 split).
// The type definitions live in ./types/<domain>.ts; this file is a pure
// re-export surface so the 123+ consumers keep importing from
// '@shared/api/types' unchanged. isolatedModules requires `export type`
// for every re-exported type (TS1205); all 193 exports here are types.

export type {
  EmailMeta,
  EmailDetail,
  EmailBody,
  SearchHit,
  AttachmentMeta,
  ResyncResult,
  SearchResult,
  ContactSuggestion
} from './types/core'
export type {
  AIPriority,
  EnrichedEmailMeta,
  MailboxSummary,
  AIFields,
  ListOpts,
  BodyOpts,
  SearchOpts,
  ResyncOpts,
  CreateDraftOpts,
  CreateDraftResult,
  SetReplySuggestionOpts,
  SetReplySuggestionResult,
  LlmRunOpts,
  UpdateFlagOpts,
  ComposeMode,
  ComposeImportance,
  ComposeWireMode,
  ComposeAttachmentRef,
  StagedAttachment,
  UploadComposeAttachmentOpts,
  ComposeDraftOpts,
  SendEmailOpts,
  DraftPlanOpts,
  DraftPlanResult,
  EmailFlagOpts,
  EmailApi,
  NlToDslResult
} from './types/email'
export type {
  TargetLang,
  TranslationSegment,
  TranslationCache,
  TranslateBatchResult,
  AiApi
} from './types/translate'
export type { JobType, JobStatus, JobEnqueueResult, JobRecord, JobsApi } from './types/jobs'
export type {
  FolderInfo,
  FolderTreeNode,
  FolderDiscoverResult,
  FolderWhitelistResult,
  FolderSetWhitelistResult,
  FolderManageResult,
  FolderCleanupResult,
  FolderApi
} from './types/folder'
export type { LlmStatsData, LlmSelfTestData, LlmUpstreamModelsData, LlmApi } from './types/llm'
export type {
  AdminHealthData,
  AdminStatsData,
  DeadLetterItem,
  DeadLetterListOpts,
  CleanupDeadLetterOpts,
  DavMailHealthData,
  SystemAlertItem,
  SystemAlertsData,
  AdminApi
} from './types/admin'
export type {
  RecurringInviteItem,
  RecurringDiscoverOpts,
  RecurringReplayOpts,
  CalendarExpandOpts,
  CalendarEventSource,
  CalendarEventAttendee,
  CalendarEventOccurrence,
  CalendarEventDetail,
  CalendarSyncStateItem,
  EmailCalendarLink,
  EventSourceEmail,
  EventsListOpts,
  EventGetOpts,
  SyncNowOpts,
  EventReplayOpts,
  RsvpResponse,
  EventRsvpOpts,
  EventStatusCode,
  EventAttendeeInput,
  EventCreateOpts,
  EventUpdateOpts,
  EventDeleteOpts,
  CalendarApi
} from './types/calendar'
export type {
  SecretSlot,
  SecretsStatus,
  PersistentSettings,
  PingResult,
  SettingsApi,
  NotionWriteApi,
  AttachmentApi,
  EnvSnapshot,
  EnvSetResult,
  EnvApi,
  ServiceTarget,
  ServiceRestartResult,
  ServiceStatus,
  ServicesApi,
  PromptSlot,
  PromptInfo,
  PromptContent,
  PromptWriteResult,
  PromptsApi,
  NotionAgentConfig,
  NotionAgentDoctorCheck,
  NotionAgentListItem,
  NotionAgentApi
} from './types/settings'
export type {
  AgentRunMatchedRule,
  AgentRunSpec,
  HeadlessAgentResult,
  ChatBackendKind,
  ChatMessageRole,
  ChatMessageStatus,
  ChatMessage,
  ChatAnchorType,
  ChatSession,
  ChatSessionListItem,
  ChatToolCallStatus,
  ChatConfirmationTier,
  ChatToolCall,
  AgentProfileDoc,
  AgentProfileHistoryEntry,
  SkillSummary,
  ExecPolicyRule,
  CreatePolicyRuleInput,
  SkillEntrypoints,
  SkillPackPreview,
  SkillConfirmResult,
  SkillUninstallResult,
  SkillSecretMeta,
  CompileUserMdResult,
  GlobalApprovalMode,
  ChatApi
} from './types/chat'
export type { SearchAgentPhase, SearchAgentInput, SearchAgentResult } from './types/search-agent'
export type {
  IslandConnectionState,
  IslandStatus,
  IslandAppearancePayload,
  IslandAIDraftStartPayload,
  IslandAIDraftStreamPayload,
  IslandAIDraftReadyPayload,
  IslandApi
} from './types/island'
export type { UpdaterState, UpdaterStatus, UpdaterApi } from './types/updater'
export type {
  SseEventType,
  SseEvent,
  EventsConnectionState,
  EventsStatus,
  EventsApi
} from './types/events'
export type {
  ReportTone,
  ReportCadence,
  ReportStatus,
  ReportHeaderBlock,
  ReportOverviewBlock,
  ReportStat,
  ReportStatRowBlock,
  ReportSectionBlock,
  ReportEmailSource,
  ReportEmailItemBlock,
  ReportKeyPointsBlock,
  ReportCalloutBlock,
  ReportKosContextBlock,
  ReportActionSuggestionBlock,
  ReportTrendPoint,
  ReportTrendBlock,
  ReportDividerBlock,
  ReportUnknownBlock,
  ReportBlock,
  ReportDoc,
  ReportCounts,
  ReportListItem,
  ReportDetail,
  ReportSchedule,
  CustomAgentTrigger,
  CustomAgentToolPolicy,
  CustomAgentBudget,
  ReportAgentConfig,
  ReportConfigPatch,
  ReportAgentCreateInput,
  AgentRunState,
  AgentRunHistoryItem,
  ReportRunResult,
  ProjectProgressRunItem,
  AgentRunPendingCount,
  AgentRunToolOption,
  AgentRunToolOptions,
  ChatOpennessFlags,
  ReportApi
} from './types/report'
export type { MailApi } from './types/mail-api'
