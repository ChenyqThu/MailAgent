# MailAgent Matters — Final Shared Understanding

> status: awaiting-user-confirmation
> discovery: complete through Batch Grill Round 12 / Q130
> implementation: NOT AUTHORIZED until explicit confirmation

## 1. Product definition

**MailAgent Matters / 事项** is an email-first, agent-native continuous work-management layer. A Matter is a durable business outcome/problem/request/decision/initiative that can span many emails, meetings, collaborative documents, URLs, people, actions and state updates.

The product promise is: **从处理一封邮件，升级为推进一件事情。**

A Matter may be tiny (one Action + one Note) or may hold a months-long release/GTM initiative as long as it still has one coherent goal, current state and completion judgment. It is not a generic Project Management replacement and does not introduce a separate Project hierarchy in MVP.

## 2. Product boundary

- Single-user, single-host, local-first SSoT. Other devices use MailAgent Remote Web against the same host; there is no multi-device data replication.
- Email is the primary capture surface but not a requirement. A Matter may originate from Main Agent, blank creation, email, meeting, collaborative document or URL.
- Matter is first-class in main navigation, global search and Main Agent tools.
- No multi-user collaboration/RBAC, arbitrary custom fields, recursive task hierarchy, autonomous external Act mode, historical bulk Matter generation, external backlink mirroring, or full Project hierarchy in MVP.

## 3. Domain model

### Matter

Core fields include stable public ID (`MAT-xxxx`), title, description, type, status, priority, health, target/deadline/review dates, primary waiting context, current summary, attention state, Primary Agent binding and lifecycle metadata.

Status vocabulary: `Inbox`, `Planned`, `Active`, `Waiting`, `Blocked`, `Monitoring`, `Done`, `Canceled`. Archive is separate from business status; Done/Canceled can reopen.

Priority, Health and Attention are independent:
- Priority = importance.
- Health = trajectory (`Unknown`, `On Track`, `At Risk`, `Off Track`).
- Attention = derived auditable signals explaining why the user should act now.

### Matter Items

A lightweight unified item base supports the types actually needed by a Matter:
- Action
- Milestone
- Decision
- Blocker
- Open Question / Information Gap
- Note

Empty item types do not appear. Action supports one checklist level, not recursive subtasks.

### People / Stakeholders

A local Person has internal UUID and normalized email as the main practical identity, with name/title/company/avatar enrichment from gbrain and other directories. `MatterStakeholder` stores Matter-specific role, contribution summary, waiting relationship and contact context. Stakeholders are suggested by Agent and confirmed/correctable by the user.

### Resource graph

Resources and Matters are strict many-to-many through one locally authoritative relation. Resource categories include email/message/thread, calendar event, collaborative document (Notion/Confluence), attachment/local file, generic URL and other supported references.

Identity is deterministic provider + stable external ID; semantic similarity never defines identity.

Matter-to-Matter relations are lightweight typed links (`related_to`, `depends_on/blocks`, `follow_up_of`, `supersedes`) with no hierarchy roll-up.

## 4. Creation and capture

Three primary paths:
1. Matters workspace → create → associate/enrich later.
2. Main Agent conversation → explicit user instruction creates Matter and may search/link context.
3. Email detail Matter icon → quick Create Matter / Add to Matter.

Only title is mandatory. Email quick-create defaults to the full thread while allowing current-message scope. Thread association is a pauseable subscription for future replies.

No multi-select/batch creation in MVP. Duplicate detection suggests an existing Matter but never blocks or silently merges.

## 5. Resource knowledge and context

Local MatterResource is relationship SSoT. External backlinks are future optional mirrors only.

Resource storage is reference/cache based. External providers remain content SSoT; MailAgent may maintain revision/hash/freshness and limited cached text. Broken or permission-lost resources remain historically visible.

Automatic formal association is allowed only for deterministic identity continuity. Semantic discoveries become Suggested Resources and require confirmation.

User `Pinned` resources are durable. Agent `Hot` resources are dynamic.

Meeting-note matching follows the same rule: explicit UID/meeting identity may auto-link; heuristic time/title/attendee/content matches are only suggestions.

## 6. Matter workspace and UX behavior

Matters is a first-level navigation destination.

Default landing surface is Focus/Overview with empty-state guidance. System views include Needs Attention, Needs Review, Active, Waiting, Planned, Monitoring, All, Done and Archived.

Default listing is a compact, information-dense list with deterministic attention-aware ranking; detailed visual layout/mockups are delegated to the design agent.

Matter detail uses a business-state main area + Context side rail, exposing current summary, changes, next actions, blockers/questions, dynamic Item sections, stakeholders, pinned/hot resources, grouped emails/meetings/docs/links and Matter Chat.

Business Timeline, Updates and Activity/Runs are separate UI projections over append-only history and run data.

## 7. Matter Chat and Main Agent

Matter can have multiple chat sessions anchored to the same Matter. Chat defaults to Matter-local context but may explicitly expand to global search or inspect another Matter.

Chat history is not formal Matter knowledge. Only explicit tool writes, accepted updates, deterministic events and formal resources become durable state. Chat attachments are temporary unless promoted to a Matter Resource.

Main Agent receives bounded first-class Matter tools for list/search/get, create/update, item operations, resource linking, notes, Agent/schedule configuration, Run Now, timeline and updates. Natural language reference resolution uses current context/search and asks when materially ambiguous.

Explicit user requests may directly execute reversible local Matter writes with audit. Destructive/high-impact local actions require preview/confirmation. External writes keep existing MailAgent approval policy.

## 8. Primary Follow-up Agent

Each Matter has at most one Primary follow-up Agent in MVP, implemented by binding to an existing Custom Agent Profile rather than creating a second Agent runtime.

The binding owns Matter-specific instructions, enablement and schedule; model and tool permissions stay on the Agent Profile. Matter schedule reuses the existing structured Schedule Contract.

MVP triggers are only `manual` and `schedule`. Resource-change/event triggers are deferred.

Scheduled runs are always **Observe + Assist**, even if the underlying profile has stronger abilities. They may read/search/refresh/record deterministic facts, generate resource suggestions, Update Proposals and Attention. They may not autonomously send mail, edit external docs, close external tickets or silently change formal business state.

Runs use incremental watermarks: inspect what changed since the last successful run/accepted update, perform cheap provider revision checks first, retrieve changed/relevant content on demand, and avoid full-history re-summarization.

Matter-first search may expand outward when a Context Gap, verification need or Matter instruction justifies it. New semantic discoveries remain candidate resources.

## 9. Update / review semantics

`description` is user-maintained purpose/context. `current_summary` is the current accepted state narrative.

Deterministic facts/events may auto-record. Business interpretation requires an Update Proposal unless the user explicitly instructed the write.

A Proposal is reviewed as one update with per-change toggles/editing and Accept All. Agent original proposal and final user-edited accepted form are both preserved. Rejected/edited feedback becomes future Agent context.

Proposals are anchored to a Matter version/watermark. If evidence/state changes later, the Proposal is marked stale and conflicting old values cannot silently apply.

Action completion proposed by Agent requires evidence and acceptance. All verifiable change facts carry source references; accepted historical conclusions preserve compact citation snapshots sufficient to explain what evidence was seen at that time.

No-change runs remain visible as run history but create no Matter Update or notification.

## 10. Attention and notifications

Attention is a collection of auditable signals such as waiting overdue, action overdue, deadline near, health degraded, update needs review, run failed or critical context gap.

Signals support Resolve, Snooze and Dismiss. Dismiss closes the current signal instance, not the category forever. Notification dedupe follows signal lifecycle and re-alerts only on meaningful escalation/re-emergence.

MVP surfaces:
- main-nav badge
- Focus / Needs Attention / Needs Review
- in-app notification center
- macOS native notification for high-value/high-severity events by default

Routine review/suggestions remain in-app. Native notification is user-configurable and relies on macOS Focus/DND rather than a second MailAgent quiet-hours engine.

## 11. Persistence and integrity

Matter domain data belongs in MailAgent's main business SQLite SSoT. Chat sessions and Agent Profiles remain in their existing data domains.

Timeline/events are append-only. Corrections are new reversal/correction events. All writes use optimistic concurrency because Mac UI, Remote Web, Chat and background Agent are concurrent local actors.

Only one follow-up Run per Matter may be active at a time; subsequent runs queue/coalesce. Runs support Cancel, bounded retry/backoff, idempotency keys and system-level execution/tool/context budgets.

Provider outages degrade explicitly (`completed_with_warnings`) when safe. Missing access is never interpreted as no change.

Resource availability/access state is preserved. Unlinking a resource changes current context but never destroys historical link events or accepted citations.

Delete uses Trash/soft-delete with restore and later explicit permanent deletion. It never deletes original mail/calendar/external-source content merely because a Matter is deleted.

## 12. Security boundary

All external content — mail, attachments, docs, URLs — is untrusted data. Resource content cannot expand tool permissions, override system/Matter instructions, or count as user authorization.

Each Resource may be Allowed, Metadata-only or Excluded from Agent content access.

Scheduled Agent has an enforced Observe+Assist capability ceiling independent of prompt text or bound profile power.

## 13. Search, API and remote access

Matter is indexed locally by ID/title/description/current summary/Items/Stakeholder fields/Notes. Linked resource bodies remain indexed/searchable in their native systems rather than duplicated into Matter FTS.

A stable Matter domain service/API is shared by Mac UI, Remote Web and Main Agent. CLI/MCP can be thin wrappers where useful.

Remote Web operates the exact same host-local Matter API and SQLite data. No cloud replica/offline remote copy is introduced.

## 14. MVP release contract

MVP must prove the complete continuous-work loop, not merely CRUD:

**Capture → organize context → scheduled/manual follow-up → detect change → evidence-backed Proposal → human review → updated current state → Attention when needed → continue.**

MVP includes duplicate candidates, Agent discovery of unlinked resources, Context Gaps and on-demand URL fetch.

Formal Merge UI and heuristic meeting-note matching may immediately follow MVP without blocking the first usable release. Markdown/JSON export is immediate P1; reliable backup/restore is a release gate.

No autonomous external Act mode in MVP.

## 15. Rollout and release gates

Roll out behind a feature flag and dogfood with real host-local Matters before enabling the first-level navigation by default.

Required Agent eval gates:
- Matter-scope correctness
- citation correctness
- real change detection / no fabricated changes
- proposal quality
- zero unauthorized scheduled writes
- idempotency
- prompt-injection resistance
- correct degraded-provider behavior

Performance targets:
- list/filter/search P95 < 300 ms
- opening local Matter state P95 < 500 ms
- local field/Item write feedback < 300 ms
- remote-provider refresh never blocks first paint

Agent runs prioritize observability, cancellation and bounded execution over a fixed wall-clock SLA.

## 16. Success definition

North star: **Healthy Active Matter Rate** — the share of unfinished Matters that have a recent trustworthy state plus either a clear next action, a clear waiting reason, or a clear Monitoring condition.

Supporting metrics include stale-Matter rate, overdue-wait rate, Update acceptance/edit rate, resource-suggestion acceptance rate, Agent no-op rate and missed-follow-up incidents.

## 17. Explicit roadmap exclusions / later phases

Later, not MVP:
- autonomous Act mode / pre-authorized external execution
- multi-agent Matter teams
- parent/child Project hierarchy and roll-ups
- arbitrary custom fields and user-built workflow schemas
- historical automatic Matter discovery/import
- external backlink mirroring
- resource event triggers
- temporary schedule override windows
- native structured Bugzilla/Jira/Todoist-like provider synchronization
- custom saved Views / full database view builder
- multi-user collaboration/RBAC

## 18. Completion state

The Batch Grill design tree has been recomputed after Q130. No unresolved product-decision frontier remains; remaining details are implementation/design tasks or explicitly deferred roadmap items.

**Implementation planning remains blocked until the user explicitly confirms this Shared Understanding.**
