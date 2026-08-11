# MailAgent Matters — Batch Grill Log (Rounds 1–10)

> status: accepted discovery record
> scope: Q1–Q116
> rule: user answers are authoritative; normalized decisions below supersede provisional recommendations in PRD v0.1 where they conflict.

## Round 1 — Product contract (Q1–Q7)

| Q | User answer | Normalized decision |
|---|---|---|
| Q1 | B, with project-like C cases | Matter is a durable business work object. It may span long-running initiatives such as a software release or GTM, as long as it retains one coherent goal/state/completion judgment; no separate Project object in v1. |
| Q2 | A | Single-user, single-host/local-first. Other devices use MailAgent remote access to the same host; no multi-device replication. |
| Q3 | B | Primary outcome: work continuity and prevention of missed follow-ups. |
| Q4 | A | Product vocabulary: MailAgent Matters / 事项; domain object `Matter`. |
| Q5 | B | Email-first, not email-only. Matter can exist without email. |
| Q6 | B | Official business state comes from user-confirmed fields and Accepted Updates; agent outputs are proposals by default. |
| Q7 | B | V1 = Observe + Assist. Autonomous Act is future scope. |

## Round 2 — Structure and lifecycle (Q8–Q16)

| Q | User answer | Normalized decision |
|---|---|---|
| Q8 | A | Flat Matter model in v1. Large initiatives live inside one Matter using Items; no formal Project hierarchy. |
| Q9 | C, used only as needed | Typed Items are available but optional. Agent recommends only the structure useful for the specific Matter. |
| Q10 | B | Statuses: Inbox, Planned, Active, Waiting, Blocked, Monitoring, Done, Canceled. Waiting details are structured attributes, not extra statuses. |
| Q11 | B | Small built-in Matter type vocabulary plus free tags; types do not alter the base workflow model. |
| Q12 | A + gbrain enrichment | Actual accountable owner is the MailAgent user. Stakeholders represent other people; Person identity uses internal UUID and email as the primary practical identity. gbrain enriches people metadata. |
| Q13 | B | Matter dates: target date, hard deadline, next review; Items may have their own dates. |
| Q14 | B | Priority, Health, and Attention are separate dimensions. Attention is derived. |
| Q15 | A | Resources and Matters are strict many-to-many. Relation is stored once and queried in both directions. |
| Q16 | A | Fixed core schema + tags + notes in MVP. No arbitrary custom fields. |

## Round 3 — Creation, identity, duplicates, lifecycle closure (Q17–Q25)

| Q | User answer | Normalized decision |
|---|---|---|
| Q17 | B | User-authorized creation. Background agents may suggest but do not silently create formal Matters. |
| Q18 | B | Split into another Matter when a branch has its own lifecycle/goal/state/completion, not merely because it is large. |
| Q19 | C | Create-from-email supports current message or entire thread; entire thread is the default. Thread drift is handled manually when it occurs. |
| Q20 | A | Only title is mandatory for creation. Other fields can be agent-prefilled and completed later. |
| Q21 | B | Use internal key plus stable human-readable public ID such as `MAT-0184`. |
| Q22 | B | Duplicate detection suggests likely existing Matters before/after creation; never blocks or auto-merges. |
| Q23 | A | No batch multi-resource creation in v1. Three supported creation paths: Matters workspace, Main Agent conversation, email-detail quick create. |
| Q24 | B | Formal merge supported. Split is implemented as selecting Items/Resources and moving/linking them to a new Matter. |
| Q25 | B | Done/Canceled are business states; Archive is separate view/lifecycle organization; Reopen is supported. Delete is separate. |

## Round 4 — Resource graph and knowledge boundaries (Q26–Q35)

| Q | User answer | Normalized decision |
|---|---|---|
| Q26 | B | Local `MatterResource` is the relationship SSoT. Optional future reverse-link mirroring to external systems is allowed but non-authoritative. |
| Q27 | D | Resource handling is provider-specific under one cache/reference abstraction. Notion and Confluence are one collaborative-doc class. Bugzilla is a generic URL in v1. |
| Q28 | B | Deterministic identity continuity may auto-link; semantic relevance only creates suggestions. |
| Q29 | B | Email-thread association is an active/pauseable subscription rule; future replies auto-link while active. |
| Q30 | B | Use a small fixed set of relation roles plus `pinned`. |
| Q31 | B | Three-layer agent/chat context: always-on Matter state, pinned/hot summaries, on-demand retrieval. |
| Q32 | B | User Pinned resources are durable; Agent Hot set is dynamic. |
| Q33 | C | Context gaps are first-class, preferably represented as Open Question with `information_gap` kind. |
| Q34 | B | Agent discovers stakeholder candidates; user confirms and can correct them. |
| Q35 | B | Local Person identity is durable; gbrain is an enrichment provider, not a runtime dependency or Matter-state SSoT. |

## Round 5 — Follow-up Agent and Update loop (Q36–Q49)

| Q | User answer | Normalized decision |
|---|---|---|
| Q36 | A | At most one Primary follow-up Agent per Matter in v1. |
| Q37 | B | Reuse existing Custom Agent Profile + Matter binding; do not create a new isolated agent runtime. |
| Q38 | A | V1 triggers are manual + schedule only. Resource-change/event triggers are deferred. |
| Q39 | B | Incremental watermark model; compare changes since last successful run/accepted update rather than re-summarizing all history. |
| Q40 | B | Review a Proposal as one update, with per-change toggles/editing and Accept All. |
| Q41 | B | Deterministic facts/events can auto-write; business interpretation/state/action changes require proposal unless explicitly user-commanded. |
| Q42 | B | Unified Item base model with small type-specific state vocabularies. |
| Q43 | B | Action supports one lightweight checklist level; no recursive task tree. |
| Q44 | B | Agent may propose Action completion with evidence; user acceptance closes it. |
| Q45 | B | `description` = user-maintained purpose; `current_summary` = latest accepted state narrative. Manual summary edits create a Manual Update. |
| Q46 | B | Every verifiable change fact requires source binding; inferences require reason + supporting sources. |
| Q47 | B | No-change run is recorded but creates no Matter Update and no notification. |
| Q48 | B | Append-only underlying activity; UI separates business timeline from system/run activity. |
| Q49 | B | Notify only for Attention-worthy conditions. V1 starts with app notification surfaces. |

## Round 6 — Schedule, review, attention, chat (Q50–Q63)

| Q | User answer | Normalized decision |
|---|---|---|
| Q50 | B | Schedule belongs to Matter-Agent binding, not Agent Profile. |
| Q51 | B | Reuse MailAgent structured Schedule Contract and schedule builder semantics. |
| Q52 | B | New Matter does not silently enable automation; system/agent can recommend Agent + schedule for one-click enable. |
| Q53 | B | Matter Waiting means the critical path is waiting. If useful active work remains, top-level status can remain Active. |
| Q54 | A | One primary Matter-level Waiting context; parallel waits live on Actions. |
| Q55 | B | Proposal review has both Matter-local entry and global Needs Review workspace. |
| Q56 | B | Accepted/rejected/edited review feedback is durable context so the Agent does not repeat stale mistakes. |
| Q57 | B | Attention is a set of auditable signals, aggregated into a Matter-level Needs Attention state/count. |
| Q58 | B + Dismiss | Attention supports Resolve, Snooze, and Dismiss. Dismiss semantics finalized in Q64. |
| Q59 | B, system notification considered | App badge + Needs Attention/Review + in-app notification center. Native system notification may also be used. |
| Q60 | B | Matter can have multiple Chat Sessions anchored to the same Matter; latest/default session opens normally. |
| Q61 | B | Explicit user requests can directly execute reversible local Matter writes with audit; destructive/high-impact operations require preview/confirm. External writes keep existing approval policy. |
| Q62 | B | Agent may recommend schedule changes; user must approve. |
| Q63 | B | Temporary schedule override windows deferred; user manually changes schedule when needed. |

## Round 7 — Workspace and notifications (Q64–Q77)

| Q | User answer | Normalized decision |
|---|---|---|
| Q64 | B | Dismiss closes the current Attention Signal; a materially new/threshold-crossing signal may be created later. |
| Q65 | B | V1 includes optional macOS native notifications for important Matter attention/review events, in addition to in-app surfaces. |
| Q66 | A | Matters is a first-level main navigation destination. |
| Q67 | B | Default page is Focus/Overview; empty state contains onboarding guidance. |
| Q68 | B | Ship fixed system Views (Focus, Needs Attention, Needs Review, Active, Waiting, Planned, Monitoring, All, Done, Archived). No custom view builder in v1. |
| Q69 | B | Default is compact list. PRD specifies content/behavior/requirements; detailed visual design and mockups are delegated to a design agent. |
| Q70 | B | Deterministic Attention-aware ranking with user-selectable alternative sorts. |
| Q71 | B | Detail IA: business-state main area + Context side rail, responsive to narrow windows. |
| Q72 | B | Separate Business Timeline, Updates, and Activity/Runs projections over the underlying event/run data. |
| Q73 | A | Resources group by stable type; Pinned content first; expand for full list. |
| Q74 | B | Item sections are dynamically shown only when useful/non-empty. |
| Q75 | A | Email detail gets one Matter icon/popover with Create Matter, Add to Matter, and existing links. |
| Q76 | B | Common fields inline-edit; complex configuration uses drawer/dialog. |
| Q77 | B | Matter is first-class in unified search/Cmd+K; index Matter structured content, not duplicated linked-resource full text. |

## Round 8 — Agent context, retrieval and Main Agent tools (Q78–Q90)

| Q | User answer | Normalized decision |
|---|---|---|
| Q78 | B | Follow-up Agent is Matter-first but may search outward when needed; newly found semantic results remain candidate evidence/resources. |
| Q79 | B | Matter Chat defaults to current-Matter scope but natural language can explicitly expand to global search. |
| Q80 | B | Each binding supports lightweight `matter_instructions`, subordinate to system/tool safety. |
| Q81 | B | Matter cannot override model/tool permissions in v1; those remain on Agent Profile. |
| Q82 | B | External-resource refresh uses cheap revision/hash checks first, reads changed content, and avoids heavy work on no-change runs. |
| Q83 | B | Scheduled Agent can search for unlinked resources when context gaps or verification needs justify it; results become suggestions. |
| Q84 | B | Rejected resource suggestions are remembered; materially new evidence may justify resurfacing. |
| Q85 | B | Scheduled runs are forcibly Observe + Assist even if the bound Agent Profile has stronger tools. |
| Q86 | B | Main Agent receives a stable bounded first-class Matter tool surface, not one generic catch-all tool. |
| Q87 | B | Matter reference resolution uses current context then search; if multiple plausible candidates remain, ask the user rather than guess. |
| Q88 | B | Matter Chat may explicitly read other Matters for comparison without implicitly linking or merging them. |
| Q89 | B | Chat history is not official Matter knowledge. Only explicit writes, accepted updates, resources and deterministic events become durable state. |
| Q90 | B | Chat attachments are session-local by default; user can promote them to formal Matter Resources. |

## Round 9 — Persistence, data integrity and APIs (Q91–Q102)

| Q | User answer | Normalized decision |
|---|---|---|
| Q91 | A | Matter domain data lives in MailAgent's main business SQLite SSoT; chat and agent-profile data remain in their existing domains. |
| Q92 | B | Resource identity is deterministic provider + stable external identity; URL uses canonicalized URL identity. |
| Q93 | B | Do not become an external version archive. Keep latest cache/revision and preserve evidence snapshots needed to explain accepted historical conclusions. |
| Q94 | B | Timeline/event log is append-only; corrections are new events/reversals. |
| Q95 | B | Use optimistic concurrency/versioning across UI, Remote Web, Chat and background runs. |
| Q96 | B | Local FTS/search indexes structured Matter text and Items/people/notes; linked resource bodies remain in their own search systems. |
| Q97 | B | Stable domain service/API is the common interface for UI, Remote Web, Main Agent; CLI/MCP are thin optional wrappers. |
| Q98 | B | Remote Web operates the same local API/SQLite on the host; no cloud replica. |
| Q99 | B | Broken/deleted/permission-lost Resources remain linked with availability state and preserved history. |
| Q100 | B | Two-stage deletion: soft delete/Trash then explicit permanent deletion. Original external/mail/calendar sources are not deleted. |
| Q101 | B | Unlink changes current relation but preserves historical link/unlink events and old accepted citations. |
| Q102 | B | Matter participates in local backup/restore and supports human-readable Markdown/JSON export; linked source bodies are references by default. |

## Round 10 — Safety, failure and evidence (Q103–Q116)

| Q | User answer | Normalized decision |
|---|---|---|
| Q103 | B | Transient run failures retry with bounded exponential backoff under one idempotency key; final failure creates Attention. |
| Q104 | B | Only one follow-up run per Matter at a time; later runs queue/coalesce. |
| Q105 | B | User can cancel an active run; no fake rollback of already-observed deterministic facts. |
| Q106 | B | Partial provider outage produces `completed_with_warnings` where safe; absence of access must never be interpreted as no change. |
| Q107 | B | Accepted Updates preserve compact citation snapshots: resource/revision/locator/evidence/observed_at. |
| Q108 | B | All external/resource content is untrusted data. It cannot alter tool policy, instructions or represent user authorization. |
| Q109 | B | Resource supports Agent access policy: allowed / metadata-only / excluded. |
| Q110 | B | Confidence may be stored internally; UI emphasizes evidence/reason and may use qualitative uncertainty, not pseudo-precise percentages. |
| Q111 | B | Proposals are version/watermark-aware and become stale when relevant data changes; stale conflicts cannot silently apply. |
| Q112 | B | Preserve both original agent proposal and user's accepted/edited result. |
| Q113 | B | Attention notifications deduplicate over a signal lifecycle and re-notify only on meaningful escalation/re-emergence. |
| Q114 | A | V1 relies on macOS Focus / Do Not Disturb rather than adding MailAgent-specific quiet hours. |
| Q115 | B | Every headless run has system-level step/tool/time/context/retrieval budgets; user does not configure token budgets. |
| Q116 | B | Trash with a default retention window and Restore / Delete permanently actions. Exact retention duration is implementation/product-default detail. |

## Cross-round settled product contract

1. **Matter is the persistent unit of work; Items are subordinate work structure.** A Matter may be short and simple or may carry a software release/GTM initiative for months.
2. **Single-user, single-host local SSoT.** Remote Web is a client of the same host.
3. **Human-approved business state.** Scheduled agents observe, gather, explain and propose; they do not silently make consequential business-state changes or external writes.
4. **Resource graph is many-to-many and locally authoritative.** Identity continuity may auto-link; semantic relevance stays suggestive.
5. **Agent context is layered and retrieval-driven.** No full-history/full-resource prompt stuffing.
6. **Every accepted factual change remains evidence-backed and historically explainable.** Timeline is append-only; evidence snapshots survive source drift.
7. **Main Agent and Matter Chat operate Matters as first-class domain objects.** Chat itself is not official state.
8. **The workspace prioritizes focus and attention, not database browsing.** Visual styling/mockups are a downstream design-agent responsibility.


## Round 11 — Cross-Matter/resource edge semantics and MVP-adjacent boundaries (Q117–Q123)

| Q | User answer | Normalized decision |
|---|---|---|
| Q117 | B | V1 supports lightweight typed Matter-to-Matter relations (`related_to`, `depends_on/blocks`, `follow_up_of`, `supersedes`) without project hierarchy or automatic status roll-up. |
| Q118 | B | Calendar meeting ↔ collaborative meeting-note linkage: deterministic identity matches may auto-link; heuristic matches (time/title/attendees/content) are suggestions requiring confirmation. |
| Q119 | B | Generic URL is an on-demand web Resource: retain URL/metadata, fetch readable content when needed, cache/hash/freshness as available, treat content as untrusted. No dedicated Bugzilla provider or URL polling in MVP. |
| Q120 | B | macOS native notifications are enabled by default only for high-value/high-severity events; ordinary review/suggestions remain in-app. User can disable or tune native notification severity. |
| Q121 | A | No automatic bulk historical Matter discovery on first launch. Existing work can be created on demand through Main Agent search; discovery of ongoing work is future scope. |
| Q122 | B | External backlink mirroring to Notion/Confluence is not MVP. Local MatterResource remains SSoT; mirror-back is future optional connector write behavior. |
| Q123 | B | Backup/restore is an MVP release gate. Human-readable Markdown/JSON export is immediate P1; schema/API must remain exportable from day one. |

## Round 12 — MVP, rollout, evaluation and completion gate (Q124–Q130)

| Q | User answer | Normalized decision |
|---|---|---|
| Q124 | B | MVP is the full continuous-work loop: workspace/detail, resources/items/stakeholders/timeline, Matter Chat, Main Agent tools, Primary follow-up Agent, manual+schedule, watermark diffing, Proposal/Review, Attention/Review surfaces, in-app + important native notifications, Remote Web same-host access, and global Matter search. |
| Q125 | B | MVP must include duplicate candidates, agent resource discovery, context gaps, and URL on-demand fetch. Formal Merge UI and heuristic meeting-note matching may land immediately after MVP without blocking first release. |
| Q126 | B | Roll out behind a feature flag and dogfood on real local data before making Matters a default first-level navigation surface. |
| Q127 | B | Matter-specific Agent evals are release gates: scope correctness, citation correctness, change detection/no-hallucinated-change, proposal quality, unauthorized-write prevention, idempotency, prompt-injection resistance, and degraded-provider behavior. |
| Q128 | B | North-star metric is Healthy Active Matter Rate; supporting metrics include stale rate, overdue waiting, update acceptance/edit rate, resource-suggestion acceptance, no-op rate, and missed follow-up incidents. |
| Q129 | B | Local UX has hard responsiveness targets (list/filter/search P95 <300ms; open local state P95 <500ms; local edits feedback <300ms). Remote refresh never blocks first paint. Agent runs need observability/cancel/budgets rather than a fixed seconds SLA. |
| Q130 | B | Discovery ends only after a Final Shared Understanding is produced and explicitly confirmed by the user; implementation planning begins only after that confirmation. |

## Final frontier recomputation after Round 12

No unresolved **product-decision** branch remains. Items previously listed after Round 10 that were not asked as standalone questions collapsed into settled decisions or engineering defaults:

- Primary Agent reassignment preserves historical runs/updates and changes only future binding behavior; this follows the append-only history + binding model and does not require a separate product mode.
- MVP has no periodic Matter digest. Routine review lives in Focus/Needs Review; native notification is reserved for high-value events per Q120. Digest delivery is a future enhancement.
- Operating scale targets are engineering/NFR validation for a single-user local SSoT, not a user-facing limit.
- Offline/degraded behavior is already defined by local cached Matter state plus Q99/Q106: existing Matter state remains usable; unavailable providers are explicitly marked and never interpreted as "no change".
- Noisy/unreliable automation can be disabled by turning off the Matter-Agent binding/schedule; data/history remain intact. This is a required safety control, not a new workflow choice.
- Documentation promotion follows repository DOC-GUIDE: discovery artifacts remain in `.trellis/tasks/`; only after implementation stabilizes does current truth move to `docs/reference/matters/`.

**Frontier status: EMPTY.** Awaiting explicit shared-understanding confirmation before implementation planning.
