# 附录 A：建议契约

## A.1 Session Query

```ts
export interface SessionQueryInput {
  query?: string;
  origin?: 'interactive' | 'agent' | 'im' | 'all';
  agentId?: string;
  agentJobId?: string;
  triggerId?: string;
  triggerKind?: 'manual' | 'cron' | 'schedule' | 'email_filter' | 'calendar_event_change' | 'calendar_before_start';
  createdAfter?: number;
  createdBefore?: number;
  archived?: boolean;
  starred?: boolean;
  limit?: number;
}

export interface SessionSearchHit {
  session: ChatSessionSummary;
  snippets: Array<{
    messageId: number;
    role: string;
    snippet: string;
    createdAt: number;
  }>;
  run?: {
    state: string;
    outcome?: string | null;
    approvalState?: string | null;
    finishedAt?: number | null;
    error?: string | null;
  };
}
```

## A.2 Trusted Agent Identity

```ts
export interface HeadlessAgentIdentity {
  agentId: string;
  agentTitle: string;
  jobId: number;
  sessionId: number;
}
```

必须从服务端 spec 与 `createAgentSession` 结果构造。

## A.3 Multi Trigger v2

```ts
export interface TriggerSetV2 {
  v: 2;
  triggers: CustomAgentTriggerV2[];
}

export interface TriggerBaseV2 {
  id: string;
  enabled: boolean;
  kind: string;
}

export interface EmailFilterTriggerV2 extends TriggerBaseV2 {
  kind: 'email_filter';
  subjectPattern?: string;
  senderPattern?: string;
  folders?: string[];
  threadIds?: string[];
}

export interface CalendarEventChangeTriggerV2 extends TriggerBaseV2 {
  kind: 'calendar_event_change';
  titlePattern?: string;
  organizerPattern?: string;
  attendeePattern?: string;
  calendarIds?: string[];
}

export interface CalendarBeforeStartTriggerV2 extends TriggerBaseV2 {
  kind: 'calendar_before_start';
  leadSeconds: number;
  titlePattern?: string;
  organizerPattern?: string;
  attendeePattern?: string;
  calendarIds?: string[];
}
```

## A.4 Custom Agent Call

```ts
export interface CustomAgentCallInput {
  agent_id: string;
  instruction: string;
  context_note?: string;
  source_session_id?: number;
  email_internal_ids?: number[];
  email_thread_ids?: string[];
  calendar_event_ids?: string[];
  notion_refs?: Array<{
    connector_id: string;
    object_id: string;
    object_type?: string;
  }>;
  report_ids?: string[];
  /** Model-asserted in manual_chat; affects only the outer call card and is audited. */
  user_requested?: boolean;
}

export type CustomAgentCallResult =
  | {
      status: 'completed';
      agent_id: string;
      agent_title: string;
      job_id: number;
      session_id: number;
      final_answer: string;
      truncated: boolean;
      references: AgentCallReference[];
      duration_ms: number;
      usage?: Record<string, number | null>;
    }
  | {
      status: 'queued' | 'running' | 'waiting_approval';
      agent_id: string;
      agent_title: string;
      job_id: number;
      session_id: number;
      summary?: string;
    }
  | {
      status: 'failed' | 'stopped';
      agent_id: string;
      agent_title: string;
      job_id: number;
      session_id?: number;
      error: { code: string; message: string };
    };

export interface AgentCallReference {
  type: 'session' | 'report' | 'notion' | 'email' | 'calendar';
  id: string | number;
  title?: string;
}
```

调用等待时间不是公开输入：第一版内部固定 `CUSTOM_AGENT_CALL_WAIT_MS = 180_000`。`user_requested` 不能改变子 Agent 权限或内部审批。

## A.5 Plan Tool

```ts
export interface PlanUpdateInput {
  goal: string;
  steps: Array<{
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'unavailable';
    note?: string;
  }>;
}
```

约束：最多建议 12 个 step；ID 在同一计划中唯一；无外部副作用。

## A.6 Compact Metadata

```ts
export interface CompactMessageMetadata {
  kind: 'compact';
  version: 1;
  compactedThroughMessageId: number;
  firstKeptMessageId: number;
  tokensBefore: number | null;
  estimatedTokensAfter: number | null;
  model: string;
  reason: 'manual' | 'threshold' | 'overflow';
  valid: boolean;
  createdAt: number;
}
```

## A.7 Follow-up Queue

```ts
export interface QueuedInput {
  id: number;
  sessionId: number;
  runId: string | null;
  mode: 'follow_up' | 'steering';
  content: string;
  status: 'queued' | 'claimed' | 'sent' | 'canceled' | 'restored';
  createdAt: number;
  updatedAt: number;
  deliveredMessageId?: number | null;
}
```

第一版只产生 `follow_up`；预留 `steering` 值但不启用真正 Tool-boundary 语义。

## A.8 Skill Trust Rule

```ts
export interface SkillTrustRule {
  id: string;
  skillName: string;
  packageHash: string;
  entrypoint: string;
  argvPattern?: string[];
  cwdScope?: string[];
  readScopes?: string[];
  writeScopes?: string[];
  networkMode: 'off' | 'gated';
  secretNames: string[];
  trustedAt: number;
  revokedAt?: number | null;
}
```

## A.9 Agent Plugin Import Result

```ts
export interface AgentPluginImportResult {
  plugin: {
    name: string;
    version?: string;
    source: string;
  };
  skills: Array<{
    path: string;
    status: 'ready' | 'invalid' | 'unsupported';
    draftId?: string;
    errors?: string[];
  }>;
  mcpServers: Array<{
    name: string;
    status: 'detected_not_imported' | 'invalid';
    errors?: string[];
  }>;
}
```
