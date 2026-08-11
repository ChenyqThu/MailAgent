# MailAgent Matters — Complete PRD Working Package

> Generated 2026-08-07. Working discovery artifact; not approved for implementation.

This combined file mirrors the repository-ready multi-file package.


---


<!-- BEGIN README.md -->

# MailAgent Matters PRD System

> status: working draft
> version: 0.1
> date: 2026-08-07
> module name (working): **MailAgent Matters / 事项工作台**
> implementation status: **not approved for implementation**
> source task: `.trellis/tasks/08-07-mailagent-matters/`

This package is the repository-ready working PRD system for the proposed Matters module.

It is intentionally split into small documents rather than one giant PRD:

| File | When to read | Purpose |
|---|---|---|
| `info.md` | Start here | Scope, document status, workflow, terminology |
| `prd.md` | Product review | Master product requirements and product contract |
| `design-tree.md` | During grilling | Decision tree, prerequisites, current frontier |
| `decision-log.md` | After every answer round | Accepted decisions and rationale |
| `requirements-catalog.md` | Planning and QA | Requirement IDs, priority, status, acceptance links |
| `domain-model.md` | Product + backend design | Matter, resource, action, update, event and run boundaries |
| `ux-ia.md` | UX design | Navigation, workspace, detail view and interaction flows |
| `agent-followup.md` | Agent design | Follow-up agent, triggers, update proposal and review loop |
| `architecture-plan.md` | Technical design | Fit with existing MailAgent architecture and workstreams |
| `data-api-contracts.md` | API/schema design | Conceptual persistence, REST, tools and event contracts |
| `security-trust.md` | Security review | Human authority, approvals, provenance and injection defense |
| `delivery-roadmap.md` | Delivery planning | Phases, gates, dependencies and rollout |
| `acceptance-evals.md` | Product acceptance | Metrics, eval sets, reliability and release criteria |
| `research/repo-fit.md` | Engineering discovery | Existing capabilities to reuse and constraints |
| `research/industry-patterns.md` | Product research | Comparable patterns and lessons, not a feature checklist |
| `grill/rounds.md` | Interview session | Batch-grill rounds, questions and answer capture |

## Working rules

1. This is a **working task artifact**, not current-system truth.
2. Unsettled decisions are marked `OPEN`, `PROVISIONAL`, or `TBD-Dxxx`.
3. Recommendations are defaults, not accepted decisions.
4. Each grilling answer updates the decision log first, then dependent documents.
5. Implementation must not start until:
   - the decision-tree frontier is empty;
   - the user confirms shared understanding;
   - the MVP scope and acceptance gates are explicitly approved.
6. Once shipped, stable current-system behavior should move into
   `docs/reference/matters/`; historical process material should be archived.

## Current product hypothesis

> MailAgent Matters turns fragmented email handling into continuous work tracking.
> A Matter is a persistent, stateful work object that gathers related email,
> meetings, documents, people, actions and decisions. A bounded follow-up agent
> periodically or eventfully checks changes, proposes a sourced status update,
> and helps the user advance the work from the same Matter-scoped chat.

## Current document state

The package contains a complete **structure and first-pass draft**, but not a
finalized PRD. Foundational product decisions are deliberately left open for
the batch-grill process.


<!-- END README.md -->


---


<!-- BEGIN info.md -->

# Matters task information

> status: active discovery
> owner: product owner / repository owner
> date opened: 2026-08-07
> implementation gate: closed

## 1. Why this task exists

MailAgent currently excels at processing an individual email or running a
bounded agent task. The missing layer is continuity: related emails, meetings,
documents, decisions, people and follow-ups do not have a durable business
object that preserves the current state of the work.

The proposed Matters module introduces that object.

## 2. Working product vocabulary

| Term | Working definition |
|---|---|
| Matter / 事项 | A durable unit of work that needs continued understanding or follow-up |
| Resource / 关联资料 | Email, thread, event, document, attachment, URL, ticket, report or session linked to a Matter |
| Action / 行动项 | A concrete next step inside a Matter |
| Stakeholder / 干系人 | A person, team or organization relevant to the Matter |
| Event / 时间线事件 | An immutable fact recorded on the Matter timeline |
| Update / 状态更新 | A point-in-time, sourced interpretation of the Matter's state |
| Agent binding / Agent 绑定 | The relationship between a Matter and a configured follow-up agent |
| Run / 跟进运行 | One execution of the follow-up process |
| Attention / 待关注 | A derived indication that human attention is currently needed |

All terms are provisional until the naming and object-boundary decisions close.

## 3. Document maturity labels

- `OPEN`: user decision required.
- `PROVISIONAL`: recommended design drafted, but not yet accepted.
- `SETTLED`: explicitly accepted during grilling.
- `FACT`: discovered from the current environment or repository.
- `DEFERRED`: deliberately outside the agreed release.
- `REJECTED`: considered and declined.

## 4. Batch-grill update protocol

After each user answer round:

1. Normalize answers into atomic decisions.
2. Record the user answer and rationale in `decision-log.md`.
3. Recompute the design tree.
4. Update affected PRD sections and requirement statuses.
5. Ask the complete new frontier in one batch.
6. Do not ask downstream questions whose prerequisites remain open.
7. Do not implement or create a delivery branch before final confirmation.

## 5. Product assumptions already supported by the request

These are treated as stated needs, not final design decisions:

- Work arrives through many fragmented email tasks.
- Related work currently lacks a durable aggregate context.
- Each Matter should be able to hold title, introduction, status, type and
  independent storage.
- Context may include stakeholders, emails, documents, attachments, links,
  calendar events and meeting notes.
- A follow-up agent may run periodically, find new related information and
  produce a latest-state summary and timeline.
- Each Matter should have an independent visual workspace and a scoped chat.
- The main agent should be able to create and update Matters through tools or APIs.


<!-- END info.md -->


---


<!-- BEGIN prd.md -->

# MailAgent Matters — Master PRD

> status: working draft, not approved
> version: 0.1
> date: 2026-08-07
> audience: product owner, design, agent architecture, backend, frontend, QA
> related: `design-tree.md`, `requirements-catalog.md`, `decision-log.md`

---

## 0. Executive summary

MailAgent Matters is a proposed email-first, agent-native work continuity layer.

Today, the user can process an email, ask an agent to understand it, and draft a
response. That interaction is effective but transient. Work that spans multiple
threads, meetings, documents and weeks repeatedly loses its aggregate context.

A Matter provides a durable home for that work. It owns its current state,
actions, stakeholders, related resources, immutable timeline and accepted
status updates. A Matter-scoped agent can detect changes, retrieve supporting
context and propose a sourced update. Matter Chat allows the user to work with
the main agent while automatically carrying the correct Matter scope and tools.

### Product promise

> From handling one email to advancing one piece of work.

### Working one-line definition

> A Matter is a persistent work object that gathers the evidence, state and next
> steps of one ongoing piece of work, with a bounded agent that helps keep it current.

The definition remains `PROVISIONAL` until product-boundary decisions close.

---

## 1. Problem statement

### 1.1 Current behavior

A typical workflow is:

1. A new email arrives.
2. The user asks an agent to interpret or answer it.
3. The user acts on that isolated request.
4. The chat ends.
5. A later related email, meeting or document requires the context to be rebuilt.

### 1.2 User pain

- Related work is fragmented across messages, threads, meetings and pages.
- The current state is often implicit in memory rather than stored explicitly.
- “What changed?”, “who are we waiting for?” and “what is next?” require manual reconstruction.
- A long-running issue can disappear simply because no recent email arrived.
- Separate agent sessions lack one durable business anchor.
- The user repeatedly explains background, stakeholders and prior decisions.
- Existing email state does not express the state of the larger work.
- Follow-up reminders are time-based but not context-aware.

### 1.3 Opportunity

MailAgent already sits where the work enters, can search the local email corpus,
can access calendars and knowledge sources, and has an agent/runtime boundary.
A Matter layer can connect these capabilities without attempting to replace a
general project-management suite.

---

## 2. Product outcomes

### 2.1 Goals

| ID | Goal |
|---|---|
| G1 | Preserve continuity across multiple emails, meetings, documents and agent sessions |
| G2 | Make the current state, recent change, blockers, waiting state and next action visible |
| G3 | Reduce repeated context reconstruction for the user and the agent |
| G4 | Detect stale or materially changed work without creating notification noise |
| G5 | Let the main agent create, query and update Matters through a first-class tool surface |
| G6 | Keep agent conclusions sourced, reviewable and reversible |
| G7 | Reuse MailAgent's local-first SSoT, search, chat, scheduling, approval and connector boundaries |
| G8 | Leave room for future controlled execution without making autonomous external writes an MVP requirement |

### 2.2 Non-goals for the initial product

The module is not initially intended to:

- replace Jira, Asana, Linear, Notion or a full project portfolio system;
- add sprints, resource allocation, time tracking or complex workflow builders;
- create a Matter for every email;
- treat chat history as the canonical business state;
- silently send email, edit external documents or close external tickets;
- require all external resources to be copied into a new local document store;
- provide enterprise multi-user collaboration unless explicitly pulled into v1;
- make an LLM summary the only representation of current state.

### 2.3 Candidate north-star

`PROVISIONAL`

**Healthy active Matter rate**: the percentage of open Matters that, within
their freshness policy, have:

- a current accepted state;
- either a concrete next action or an explicit waiting/monitoring reason;
- no unresolved high-severity update proposal older than its review SLA.

The final metric depends on the product-success decision.

---

## 3. Target users and jobs

### 3.1 Primary user hypothesis

`OPEN — D002`

A single knowledge worker who receives a large amount of email-based work and
uses MailAgent as a local personal work system.

### 3.2 Candidate jobs-to-be-done

1. **Capture continuity**
   - When an email starts or advances an ongoing piece of work,
   - I want to add it to a durable Matter,
   - so later emails and conversations retain the full context.

2. **Recover state quickly**
   - When I return to work after days or weeks,
   - I want to see the current state, last meaningful change and next step,
   - so I do not reconstruct the history manually.

3. **Avoid missed follow-up**
   - When a Matter is waiting or quiet,
   - I want the system to notice meaningful staleness or change,
   - so important work does not disappear from attention.

4. **Work with a scoped agent**
   - When I ask a question or request an action inside a Matter,
   - I want the main agent to use the Matter context and bounded tools,
   - so I do not repeat the background and the agent does not search indiscriminately.

5. **Trust the update**
   - When the agent says that something changed,
   - I want to inspect the evidence and approve consequential state changes,
   - so the Matter remains trustworthy.

---

## 4. Product principles

| Principle | Meaning |
|---|---|
| Matter, not mailbox task | The object represents the work, not merely one message |
| Email-first, not email-only | Email is the dominant entry point; a Matter may include or originate elsewhere |
| Structured state over prose-only memory | Status, actions, waiting state and evidence remain queryable |
| Accepted truth over latest model output | Agent output is a proposal until policy says otherwise |
| Incremental change over repeated full summarization | Runs process new evidence since a watermark |
| Evidence before confidence | Factual changes require navigable source references |
| Local resilience | The workspace remains useful when external services are unavailable |
| Bounded agency | Tool availability and approval are system decisions, not content instructions |
| No notification without value | No-change runs do not create user-visible updates |
| Reversible automation | Associations and accepted updates remain auditable and reversible |

These principles are recommendations; human-authority and automation choices
remain open design decisions.

---

## 5. Core product object

### 5.1 Matter

A Matter is expected to contain:

- identity: title, description, type, owner;
- workflow: status, health, priority, due date and attention state;
- context: related resources and stakeholders;
- execution: actions, waiting states and decisions;
- history: immutable timeline events and status updates;
- agent: binding, trigger policy, run history and proposed changes;
- interaction: one or more Matter-scoped chat sessions.

### 5.2 Matter versus quick email work

`OPEN — D001`

Recommended boundary:

- A one-off email that can be resolved immediately remains an email task.
- A piece of work becomes a Matter when it needs continuity across time,
  sources, people, actions or future follow-up.
- Matter creation should be optional and low-friction, not mandatory for inbox triage.

### 5.3 Matter hierarchy

Initial recommendation:

- No nested projects in MVP.
- Actions live inside a Matter.
- Related Matters may be represented later through typed relationships.
- Parent/child Matters are deferred until real examples prove the need.

---

## 6. Lifecycle model

### 6.1 Candidate workflow status

`PROVISIONAL`

```text
Inbox
  -> Active
  <-> Waiting Internal
  <-> Waiting External
  <-> Blocked
  <-> Monitoring
  -> Done

Any non-terminal state -> Canceled
Done / Canceled -> Reopen -> Active
```

### 6.2 Candidate health

Health is separate from workflow status:

```text
Unknown | On Track | At Risk | Off Track
```

A Matter can therefore be `Waiting External` and still `On Track`, or `Active`
and `At Risk`.

### 6.3 Attention

Attention is derived rather than manually used as a second workflow status.

Candidate causes:

- action overdue;
- waiting period exceeded;
- due date approaching;
- accepted state stale;
- new high-priority linked email;
- meeting ended without captured outcome;
- follow-up run failed;
- health degraded;
- pending proposal requires user review.

### 6.4 Completion

`TBD`

The design must settle:

- whether completion requires all open actions closed;
- whether the agent can propose or automatically infer completion;
- whether completed Matters continue monitoring for reopening signals;
- retention and archive behavior.

---

## 7. Scope and functional requirements

The canonical catalog is `requirements-catalog.md`. The major capabilities are:

### 7.1 Capture and creation

- Create manually from the workspace.
- Create from the current email or selected email set.
- Add the current email/thread to an existing Matter.
- Create through main-agent tools and API.
- Offer related-Matter suggestions.
- Preserve the source and rationale of creation.

### 7.2 Matter workspace

- List, filter, sort and search Matters.
- Provide focused views: Needs Attention, Active, Waiting, Blocked,
  Monitoring, Due Soon, Stale and Completed.
- Support list/table first; Kanban is a candidate secondary view.
- Show fast local state before remote-resource refresh.

### 7.3 Matter detail

The page should expose:

- title, description, status, health, priority and dates;
- current accepted summary;
- latest meaningful changes;
- next actions, blockers, open questions and decisions;
- chronological timeline;
- linked resources and stakeholders;
- follow-up agent configuration and run status;
- Matter-scoped chat.

### 7.4 Resource linking

Candidate resource kinds:

```text
email
email_thread
calendar_event
notion_page
meeting_note
attachment
local_file
url
bug_or_ticket
chat_session
report
other
```

Requirements:

- many-to-many Matter/resource relationships;
- stable provider identity and deduplication;
- explicit relation type;
- manual, deterministic and agent-suggested association sources;
- confidence, provenance and confirmation state;
- unlinking never deletes the source object.

### 7.5 Stakeholders

A stakeholder record may include:

- person/team/organization identity;
- Matter-specific role;
- whether an action or response is currently expected;
- last contact or activity;
- source of the association.

### 7.6 Actions

Actions should support at least:

```text
open | in_progress | waiting | done | canceled
```

with title, description, owner, waiting target, due date, priority and source.

The relationship with external task systems remains open.

### 7.7 Timeline

The timeline is append-only and includes user, system and agent events.

Examples:

- Matter created;
- resource linked/unlinked;
- email received/sent;
- meeting held;
- document revision detected;
- status/health changed;
- action created/completed;
- note added;
- agent run started/completed;
- update proposed/accepted/rejected.

### 7.8 Status updates

An Update is an immutable point-in-time interpretation of Matter state.

Candidate content:

- current state;
- what changed;
- proposed workflow status and health;
- decisions;
- blockers;
- open questions;
- next actions;
- stakeholder changes;
- resource suggestions;
- citations and confidence.

The current accepted summary is materialized from an accepted Update, not
overwritten directly by each run.

### 7.9 Matter Chat

- Add `matter` as a chat anchor.
- Inject structured Matter state, not an unbounded resource dump.
- Scope search to linked resources by default.
- Expand to global search only on explicit user request or policy.
- Pre-bind Matter ID to Matter tools.
- Allow multiple sessions while keeping one Matter as the durable state owner.

### 7.10 Main-agent and external tool surface

The main agent should be able to:

- list/search/get Matters;
- create a Matter;
- update fields and status;
- link/unlink resources;
- add/update actions;
- add notes;
- assign/configure a follow-up agent;
- run follow-up now;
- review/accept/reject proposals;
- archive/reopen Matters.

The exact approval tier is an open decision.

### 7.11 Follow-up agent

Candidate triggers:

```text
manual
schedule
new_linked_email
resource_changed
calendar_event_ended
stale
due_date_approaching
status_changed
```

A run should:

1. read the previous successful watermark;
2. determine changed evidence;
3. no-op cheaply when there is no meaningful change;
4. retrieve only required Matter-scoped context;
5. compare against the latest accepted Update;
6. produce structured output with citations;
7. persist run telemetry and proposals;
8. notify only when attention or review is required.

---

## 8. User experience

Detailed IA is in `ux-ia.md`.

### 8.1 Top-level navigation

Working recommendation:

```text
Inbox | Calendar | Matters | Agents | Reports | ...
```

### 8.2 Workspace views

Initial recommended views:

- Needs Attention
- Active
- Waiting
- Blocked
- Monitoring
- Due Soon
- Stale
- Completed

### 8.3 Detail layout

Working layout:

```text
Header: title / status / health / priority / agent / next run / due

Main:
  Current state
  Recent changes
  Actions / blockers / decisions
  Timeline

Side rail:
  Emails
  Documents
  Meetings
  People
  Links and attachments

Bottom or dock:
  Matter Chat
```

Chat should be an operating surface, not the canonical record itself.

---

## 9. Automation and human authority

`OPEN — D006, D007`

Recommended policy:

- Human-authored description is never silently overwritten.
- Accepted state is authoritative.
- Agent runs create proposals by default.
- Deterministic derived fields may update automatically.
- External writes obey existing per-tool approval and policy boundaries.
- Send, delete, close and irreversible operations are never enabled merely
  because an external resource instructed the model to do so.

Proposed operating modes:

| Mode | Behavior |
|---|---|
| Observe | Read, detect change, summarize; no state mutation beyond run/event records |
| Assist | Propose state/action changes and drafts; user reviews consequential changes |
| Act | Execute explicitly authorized tools under per-tool policy and audit |

Whether all three are user-visible modes is open.

---

## 10. Data and architecture direction

Detailed planning is in `architecture-plan.md` and `data-api-contracts.md`.

Working recommendation:

- Store Matter domain state in the local operational SQLite store.
- Keep external systems authoritative for their own objects.
- Persist stable references, metadata, hashes/revisions, cached excerpts and
  permission/sync state rather than cloning every external document.
- Reuse the existing agent run queue, schedule semantics, AI Gateway,
  approval system, search, connectors and chat persistence.
- Add `matter` as an additive chat anchor.
- Keep Matter domain services in Python; expose typed tools through the AI Gateway.
- Treat email/document content as untrusted input throughout context construction.

This direction depends on the target collaboration/deployment decision.

---

## 11. Notifications

Notification behavior is not yet finalized.

Recommended rule:

A run is silent when it finds no meaningful change. Notify only for:

- new user review required;
- health degradation;
- overdue or newly blocked action;
- failed high-priority run;
- explicit digest preference;
- a user-configured waiting or freshness threshold.

The workspace's Needs Attention view remains the primary queue; notifications
should not become another noisy inbox.

---

## 12. Metrics and evaluation

See `acceptance-evals.md`.

Candidate product metrics:

- healthy active Matter rate;
- time to recover current state;
- percentage of open Matters with a next action or explicit wait reason;
- stale Matter count;
- update proposal acceptance and edit rates;
- resource suggestion precision;
- sourced-claim rate;
- no-change run ratio and cost;
- duplicate Matter rate;
- automation reversal rate.

---

## 13. Delivery strategy

See `delivery-roadmap.md`.

Recommended implementation sequence:

1. Product contract and decision closure.
2. Matter domain and local manual UX.
3. Resource linking, actions and timeline.
4. Matter-scoped Chat and tools.
5. Manual read-only follow-up runs.
6. Scheduled/event-driven proposals.
7. Intelligent association and meeting-note matching.
8. Attention, notifications and portfolio summaries.
9. Controlled external execution.
10. Collaboration only if pulled into scope.

---

## 14. MVP candidate

`PROVISIONAL`

```text
Create a Matter from an email
-> manually link related resources
-> maintain status and actions
-> chat inside the Matter
-> run a read-only follow-up agent manually or on schedule
-> receive a sourced Update proposal
-> accept it as the latest official state
-> see the Matter in Needs Attention when review or follow-up is required
```

Explicitly excluded from this candidate MVP:

- silent external writes;
- automatic creation for every email;
- multi-agent orchestration;
- project hierarchy;
- multi-user collaboration;
- generic workflow builder;
- universal knowledge graph.

---

## 15. Release acceptance summary

A release must demonstrate:

1. A Matter can aggregate multiple email threads and non-email resources.
2. A resource can be linked to multiple Matters.
3. Matter detail shows current accepted state, actions, timeline and evidence.
4. Matter Chat retrieves Matter context without sending all resource bodies every turn.
5. Agent factual changes navigate to sources.
6. No-change runs create no user-visible update.
7. Repeated runs are idempotent.
8. Agent output cannot silently overwrite human-authored description or accepted state.
9. External writes remain behind tool policy and approval.
10. Local Matter history remains accessible when an external provider is unavailable.

The final acceptance list will be generated after the design tree is closed.


<!-- END prd.md -->


---


<!-- BEGIN design-tree.md -->

# Matters design tree

> status: active
> purpose: ensure no important decision is silently assumed
> rule: only ask decisions whose prerequisites are settled

## 1. Status vocabulary

- `OPEN`: decision not yet answered.
- `FRONTIER`: open and all prerequisites are settled; ask now.
- `BLOCKED`: waiting on another decision or environment research.
- `SETTLED`: explicitly accepted.
- `DEFERRED`: intentionally outside the agreed scope.
- `FACT`: environment or repository fact, not a preference question.

## 2. Tree

```text
D000 Product contract
├── D001 Matter unit and threshold
├── D002 Target user / collaboration scope
├── D003 Primary product outcome and success metric
├── D004 Product name and user-facing vocabulary
├── D005 Email-first versus email-only boundary
├── D006 Human authority over official state
└── D007 Automation ceiling for first release

D100 Lifecycle and state [requires D001, D003, D006]
├── D101 Workflow statuses
├── D102 Health model
├── D103 Waiting semantics
├── D104 Attention derivation
├── D105 Completion / reopen / archive
├── D106 Priority and due-date semantics
└── D107 Matter types and custom fields

D200 Capture and identity [requires D001, D005]
├── D201 Manual / suggested / automatic creation
├── D202 Duplicate detection
├── D203 Matter identifier and title generation
├── D204 Create-from-email behavior
├── D205 Bulk capture
└── D206 Merge / split semantics

D300 Resource graph [requires D001, D005, D201]
├── D301 Resource kinds
├── D302 Many-to-many and relation types
├── D303 Stable identity and deduplication
├── D304 Manual versus suggested linking
├── D305 Auto-link confidence thresholds
├── D306 Content caching and refresh
├── D307 Permission loss / deleted source behavior
├── D308 Meeting-to-note matching
└── D309 Cross-Matter resource visibility

D400 Actions, decisions and stakeholders [requires D001, D100]
├── D401 Action state model
├── D402 Action ownership
├── D403 Waiting-on person/action model
├── D404 External task-system relationship
├── D405 Decisions and open questions
├── D406 Stakeholder identity
└── D407 Dependencies between Matters

D500 Workspace UX [requires D001, D100, D200]
├── D501 Top-level navigation
├── D502 Default workspace view
├── D503 List versus Kanban
├── D504 Detail information hierarchy
├── D505 Timeline grouping and filtering
├── D506 Resource side rail
├── D507 Quick capture from Inbox
├── D508 Command palette / keyboard flows
├── D509 Mobile / remote web expectations
└── D510 Accessibility and localization

D600 Matter Chat [requires D001, D300, D400]
├── D601 Chat anchor and session model
├── D602 Context composition
├── D603 Default search scope
├── D604 Pinned versus retrieved context
├── D605 Context freshness
├── D606 Chat writes to Matter
├── D607 Multiple sessions and canonical summary
└── D608 Cross-Matter questions

D700 Follow-up agent [requires D006, D007, D300, D400]
├── D701 Dedicated versus shared agent profile
├── D702 Observe / Assist / Act modes
├── D703 Trigger types
├── D704 Follow-up cadence
├── D705 Watermark and change detector
├── D706 Structured output contract
├── D707 Proposal review workflow
├── D708 No-change behavior
├── D709 Failure/retry behavior
├── D710 Model/tool/cost policy
├── D711 Multiple agents per Matter
└── D712 Agent handoff and ownership

D800 Notification and attention [requires D104, D700]
├── D801 Notification-worthy events
├── D802 Channels
├── D803 Digest versus immediate
├── D804 Snooze and review SLA
└── D805 Quiet hours and rate limits

D900 Data and architecture [requires D002, D300, D600, D700]
├── D901 Matter SSoT placement
├── D902 Local-first/offline expectations
├── D903 External-resource cache policy
├── D904 Event log and snapshot strategy
├── D905 Chat schema migration
├── D906 Search/index strategy
├── D907 Sync and conflict policy
├── D908 Retention/export/delete
└── D909 Multi-device/team topology

D1000 API and tool surface [requires D100, D200, D300, D400, D700]
├── D1001 REST resource model
├── D1002 Main-agent read tools
├── D1003 Main-agent write tools
├── D1004 Approval tiers
├── D1005 Idempotency and optimistic concurrency
├── D1006 CLI/MCP exposure
├── D1007 Webhook/event exposure
└── D1008 Versioning and compatibility

D1100 Security and trust [requires D006, D007, D300, D700, D1000]
├── D1101 Untrusted content boundaries
├── D1102 Provenance and citations
├── D1103 External write authorization
├── D1104 Sensitive resource visibility
├── D1105 Audit and rollback
└── D1106 Headless-run capability floors

D1200 MVP and rollout [requires D000-D1100 relevant branches]
├── D1201 MVP scenario
├── D1202 Phase boundaries
├── D1203 Migration and feature flag
├── D1204 Dogfood cohort
├── D1205 Release metrics
├── D1206 Failure rollback
└── D1207 Documentation promotion to current truth
```

## 3. Current settled facts

| ID | Status | Fact |
|---|---|---|
| F001 | FACT | The user wants a durable object that aggregates related email, documents, meetings, people and context |
| F002 | FACT | The user wants periodic or recurring agent follow-up |
| F003 | FACT | The user wants a Matter-specific workspace with status, summary, timeline, resources and chat |
| F004 | FACT | The main agent must be able to create and update the object through tools/APIs |
| F005 | FACT | The current MailAgent repository already has chat, custom agents, scheduling, local operational data, search and connector boundaries that may be reused |

## 4. Round 1 frontier

The first batch is the root frontier. No downstream lifecycle, UX, schema or
agent-implementation choice should be finalized before these close.

| ID | Status | Question theme |
|---|---|---|
| D001 | FRONTIER | What exactly deserves to become a Matter? |
| D002 | FRONTIER | Is v1 personal/local or collaborative/team? |
| D003 | FRONTIER | What is the primary product outcome? |
| D004 | FRONTIER | Is “Matters / 事项” the accepted product vocabulary? |
| D005 | FRONTIER | Is the module email-first but source-agnostic? |
| D006 | FRONTIER | What constitutes official state? |
| D007 | FRONTIER | How autonomous may the first release be? |

## 5. Completion rule

The grilling session is complete only when:

- no node remains `OPEN`, `FRONTIER` or unintentionally `BLOCKED`;
- every deferred branch has an explicit reason and revisit condition;
- the requirements catalog contains no unowned `TBD`;
- the user explicitly confirms shared understanding.

Until then, this package remains a discovery artifact and implementation is gated.


<!-- END design-tree.md -->


---


<!-- BEGIN decision-log.md -->

# Matters decision log

> status: active
> append after every grill round
> accepted decisions override recommendations in all other documents

## Record template

```text
### Dxxx — Decision title
- Status:
- Date:
- User answer:
- Normalized decision:
- Recommendation at time of decision:
- Rationale:
- Consequences:
- Affected documents:
- Revisit trigger:
```

## Decisions

No product decisions have been accepted yet.

## Provisional recommendations, not decisions

| ID | Recommendation |
|---|---|
| D001 | A Matter is a durable unit of work that requires continuity; one-off email handling remains outside it |
| D002 | Ship single-user/local-first first, with schema room for future sharing |
| D003 | Optimize for reliable state recovery and missed-follow-up prevention, not generic task volume |
| D004 | Use “MailAgent Matters” as the module name and “事项” as the Chinese UI noun |
| D005 | Make email the primary capture surface but allow a Matter to exist without email |
| D006 | User-confirmed state and accepted Updates are official; agent output is a proposal by default |
| D007 | MVP supports Observe and Assist; external Act remains bounded by explicit tool policies and approvals |


<!-- END decision-log.md -->


---


<!-- BEGIN requirements-catalog.md -->

# Matters requirements catalog

> status: first-pass catalog
> source of truth for requirement IDs and priority
> decision status is not implementation status

## 1. Priority vocabulary

- `P0`: required for the agreed MVP.
- `P1`: next product increment.
- `P2`: later expansion.
- `TBD`: depends on grilling.
- `OUT`: explicitly out of scope.

## 2. Product and lifecycle

| ID | Requirement | Priority | Decision dependency | Acceptance outline |
|---|---|---:|---|---|
| MAT-PROD-001 | Represent an ongoing piece of work independently from a single email or chat | P0 | D001 | Matter survives resource and session changes |
| MAT-PROD-002 | Preserve a user-authored description separately from generated current state | P0 | D006 | Agent run cannot silently overwrite description |
| MAT-LIFE-001 | Support an explicit workflow status | P0 | D101 | Status transitions validated and audited |
| MAT-LIFE-002 | Keep health separate from status | TBD | D102 | Waiting Matter may still be On Track |
| MAT-LIFE-003 | Derive Needs Attention with reason and timestamp | P0 | D104 | Every attention item explains why |
| MAT-LIFE-004 | Support completion, cancel, reopen and archive semantics | P0 | D105 | History is retained across reopen |

## 3. Capture and identity

| ID | Requirement | Priority | Dependency | Acceptance outline |
|---|---|---:|---|---|
| MAT-CAP-001 | Create a Matter manually | P0 | D201 | Valid title creates durable record |
| MAT-CAP-002 | Create a Matter from an email | P0 | D204 | Source email is linked with provenance |
| MAT-CAP-003 | Add current email/thread to an existing Matter | P0 | D204 | Does not duplicate resource identity |
| MAT-CAP-004 | Create/update via main-agent tools | P0 | D1002-D1004 | Tool result reflects committed state |
| MAT-CAP-005 | Suggest related existing Matters before creating duplicates | P1 | D202 | Suggestion is explainable and dismissible |
| MAT-CAP-006 | Merge and split Matters without losing audit history | P1 | D206 | Links/actions/events are rehomed with trace |

## 4. Resource context

| ID | Requirement | Priority | Dependency | Acceptance outline |
|---|---|---:|---|---|
| MAT-RES-001 | Link multiple resources of multiple provider types | P0 | D301 | Email, event, document and URL supported |
| MAT-RES-002 | Use many-to-many Matter/resource relations | P0 | D302 | One email can belong to multiple Matters |
| MAT-RES-003 | Store stable identity and deduplicate links | P0 | D303 | Repeated linking is idempotent |
| MAT-RES-004 | Preserve link provenance, confidence and confirmation | P0 | D304-D305 | User can see why it is linked |
| MAT-RES-005 | Unlink without altering the original resource | P0 | D302 | Source remains untouched |
| MAT-RES-006 | Detect remote revision/permission/deletion state | P1 | D306-D307 | Broken links are explicit, not silently missing |
| MAT-RES-007 | Suggest meeting-note links | P1 | D308 | Low-confidence match requires confirmation |

## 5. Work structure

| ID | Requirement | Priority | Dependency | Acceptance outline |
|---|---|---:|---|---|
| MAT-ACT-001 | Create and manage actions inside a Matter | P0 | D401 | Open and completed actions are queryable |
| MAT-ACT-002 | Represent waiting on a person or event | P0 | D403 | Waiting reason and expected date are visible |
| MAT-ACT-003 | Record decisions and open questions | P0/P1 | D405 | Items appear in summary and timeline |
| MAT-STK-001 | Associate stakeholders with Matter-specific roles | P0 | D406 | Same person may have different roles per Matter |

## 6. Timeline and updates

| ID | Requirement | Priority | Dependency | Acceptance outline |
|---|---|---:|---|---|
| MAT-TIME-001 | Keep an append-only Matter timeline | P0 | D904 | Events are ordered, attributable and deduplicated |
| MAT-UPD-001 | Persist immutable status Update records | P0 | D706-D707 | Previous accepted updates remain readable |
| MAT-UPD-002 | Require source references for factual changes | P0 | D1102 | Claim can navigate to supporting resource |
| MAT-UPD-003 | Materialize current state from latest accepted Update | P0 | D006-D707 | Rejecting proposal leaves official state unchanged |
| MAT-UPD-004 | No-change run creates no user-visible Update | P0 | D708 | Silent terminal run is auditable |

## 7. Workspace and chat

| ID | Requirement | Priority | Dependency | Acceptance outline |
|---|---|---:|---|---|
| MAT-UX-001 | Provide top-level Matters workspace | P0 | D501 | Navigation opens local list |
| MAT-UX-002 | Provide Needs Attention view | P0 | D104-D502 | List explains attention reason |
| MAT-UX-003 | Provide Matter detail with state, actions, timeline and resources | P0 | D504-D506 | Core state visible without opening chat |
| MAT-UX-004 | Provide Inbox quick capture and link flows | P0 | D507 | Create/link in no more than agreed interaction count |
| MAT-CHAT-001 | Add Matter as a first-class chat anchor | P0 | D601 | Sessions reopen with same Matter identity |
| MAT-CHAT-002 | Build bounded structured Matter context | P0 | D602-D605 | No unbounded resource dump |
| MAT-CHAT-003 | Scope retrieval to Matter by default | P0 | D603 | Global expansion is explicit |
| MAT-CHAT-004 | Let chat update Matter through audited tools | P0 | D606-D1004 | Writes respect policy and optimistic concurrency |

## 8. Follow-up agent

| ID | Requirement | Priority | Dependency | Acceptance outline |
|---|---|---:|---|---|
| MAT-AGT-001 | Bind at least one follow-up agent to a Matter | P0 | D701 | Binding is visible and editable |
| MAT-AGT-002 | Support manual Run now | P0 | D703 | Run state and result are persisted |
| MAT-AGT-003 | Support structured recurring schedule | P0/P1 | D703-D704 | Preview and backend occurrences match |
| MAT-AGT-004 | Process only changes after a successful watermark | P0 | D705 | Re-run does not duplicate events |
| MAT-AGT-005 | Produce structured sourced output | P0 | D706 | Output validates against schema |
| MAT-AGT-006 | Support review/accept/reject of proposals | P0 | D707 | Decision updates official state atomically |
| MAT-AGT-007 | Persist run cost, tools, errors and timing | P0 | D709-D710 | Run is debuggable |
| MAT-AGT-008 | Allow event-triggered follow-up | P1 | D703 | New linked email can trigger bounded run |
| MAT-AGT-009 | Support controlled external execution | P2 | D702-D1004-D1103 | Every action is policy-authorized and idempotent |

## 9. API, reliability and security

| ID | Requirement | Priority | Dependency | Acceptance outline |
|---|---|---:|---|---|
| MAT-API-001 | Expose typed REST CRUD and query endpoints | P0 | D1001 | API errors are stable and versioned |
| MAT-API-002 | Expose main-agent read and write tools | P0 | D1002-D1004 | Tool catalog has parity tests |
| MAT-REL-001 | Make link and run operations idempotent | P0 | D1005 | Retried request produces one result |
| MAT-REL-002 | Use optimistic concurrency for user/agent writes | P0 | D1005 | Stale update is rejected or merged explicitly |
| MAT-SEC-001 | Treat external resource text as untrusted | P0 | D1101 | Content cannot expand capabilities |
| MAT-SEC-002 | Keep external writes behind policy/approval | P0 | D1103 | No approval bypass via prompt content |
| MAT-SEC-003 | Keep full audit and rollback data | P0 | D1105 | Before/after and actor are inspectable |
| MAT-OFF-001 | Keep local Matter history usable during connector outage | P0 | D902-D903 | Cached record opens without remote provider |

## 10. Completeness tracking

The catalog is complete only after every requirement has:

- a settled priority;
- a decision owner;
- an acceptance test or eval;
- a planned delivery phase;
- a security classification where relevant.


<!-- END requirements-catalog.md -->


---


<!-- BEGIN domain-model.md -->

# Matters domain model

> status: conceptual draft
> no physical schema is approved

## 1. Aggregate boundary

Recommended aggregate:

```text
Matter
├── Current fields
├── Actions
├── Stakeholders
├── Resource links
├── Accepted update pointer
├── Agent binding
└── Version

Append-only supporting records:
├── MatterEvent
├── MatterUpdate
└── MatterRun
```

The Matter is the owner of business continuity. Email, calendar, Notion and
tickets remain independent source-domain objects.

## 2. Entities

### 2.1 Matter

Candidate fields:

```text
id
public_id
title
description
type
status
health
priority
owner_id
primary_agent_id
automation_mode
followup_rule
due_at
next_attention_at
attention_reason
last_activity_at
last_agent_run_at
latest_accepted_update_id
current_summary
source
version
created_at
updated_at
archived_at
```

### 2.2 Resource

A provider-neutral identity for a linked source object:

```text
id
kind
provider
external_key
canonical_url
title
metadata
revision
content_hash
permission_state
sync_state
last_checked_at
created_at
updated_at
```

Suggested uniqueness: `(provider, external_key)`.

### 2.3 MatterResource

```text
matter_id
resource_id
relation_type
pinned
added_by
confidence
provenance
confirmed_at
created_at
```

The relation is many-to-many.

### 2.4 Stakeholder

```text
id
matter_id
person_key
display_name
email
organization
role
relationship
is_waiting_on
last_contact_at
source_resource_id
created_at
updated_at
```

### 2.5 Action

```text
id
matter_id
title
description
status
priority
owner_kind
owner_id
waiting_on_stakeholder_id
due_at
source_resource_id
created_by
version
created_at
updated_at
completed_at
```

### 2.6 MatterEvent

Append-only timeline fact:

```text
id
matter_id
kind
happened_at
actor_kind
actor_id
resource_id
dedupe_key
payload
created_at
```

### 2.7 MatterUpdate

Immutable state interpretation:

```text
id
matter_id
review_status
from_event_id
to_event_id
summary
proposed_status
proposed_health
changes
decisions
blockers
questions
next_actions
citations
confidence
agent_run_id
created_at
reviewed_at
accepted_at
rejected_at
```

### 2.8 MatterRun

```text
id
matter_id
agent_id
async_job_id
chat_session_id
trigger_kind
trigger_payload
input_watermark
output_watermark
status
model
usage
cost_usd
error
started_at
completed_at
```

## 3. Invariants

Recommended invariants:

1. Matter title is non-empty.
2. User-authored description and machine-generated summary are different fields.
3. Official current state changes only through an audited mutation.
4. Accepted Updates are immutable.
5. A resource link cannot imply ownership of the original resource.
6. Re-linking the same provider object is idempotent.
7. Timeline event dedupe keys are stable across retry.
8. A Run may emit zero or one primary Update proposal.
9. Every factual Update change references at least one source or is marked inference.
10. External resource content cannot modify tool policy or approval policy.
11. Optimistic versioning protects concurrent user and agent updates.

## 4. Open model questions

- Can a Matter have multiple owners?
- Are actions local-only or syncable to external task providers?
- Are decisions first-class rows or typed timeline items?
- Is a waiting condition a Matter field, an Action, or both?
- Does one Matter bind one agent or a set of role-specific agents?
- Do Matter relationships include parent/child in v1?
- What is retained after archive or delete?


<!-- END domain-model.md -->


---


<!-- BEGIN ux-ia.md -->

# Matters UX and information architecture

> status: conceptual
> final flows depend on lifecycle and capture decisions

## 1. Navigation hypothesis

```text
Inbox
Calendar
Matters
Agents
Reports
...
```

“Matters” is a top-level work surface, not a subview under Agents.

## 2. Workspace

Candidate sections:

```text
Needs Attention
Active
Waiting
Blocked
Monitoring
Due Soon
Stale
Completed
All
```

### Recommended default

Needs Attention, because the module's value is deciding what requires action
rather than displaying every tracked object equally.

### Candidate layouts

- Table/list: recommended primary view.
- Kanban by status: candidate secondary view.
- Compact portfolio pulse: P1.
- Saved filters: P1.

Candidate list columns:

```text
Matter
Status
Health
Next action / waiting reason
Last meaningful change
Due
Agent / next run
Attention reason
```

## 3. Matter detail

### 3.1 Header

- title and public ID;
- status, health, priority;
- owner and follow-up agent;
- due date;
- last meaningful activity;
- next scheduled run;
- archive / more menu.

### 3.2 Main content

- current accepted state;
- “what changed” since previous update;
- actions;
- blockers;
- decisions;
- open questions;
- timeline.

### 3.3 Side rail

Grouped linked resources:

- Emails and threads
- Meetings and notes
- Documents
- People
- Links and attachments
- Reports and chat sessions

### 3.4 Matter Chat

Recommended placement:

- docked bottom panel or right-side expandable panel;
- full-page mode available;
- not the canonical record;
- visible context chips show what is currently included.

## 4. Inbox flows

### 4.1 Current email

Candidate actions:

```text
Create Matter
Add to Matter
View related Matters
Create action
Mark waiting for reply
Ask agent where this belongs
```

### 4.2 Multiple selected emails

Candidate actions:

- create one Matter from selected emails;
- add selected emails to one Matter;
- ask the agent to group them into candidate Matters;
- reject duplicate or weak candidates.

## 5. Update review

Recommended card:

```text
Update proposal
- Proposed status and health
- What changed, each with source link
- New/changed actions
- Blockers and open questions
- Agent confidence and run details

Actions:
Accept
Edit and accept
Reject
Review sources
```

## 6. Timeline

Candidate event grouping:

- group low-value system events by day;
- keep user decisions, state changes and messages individually visible;
- distinguish factual source events from agent interpretations;
- support filters by event type and resource.

## 7. Empty and failure states

Required cases:

- Matter with no linked resource;
- external provider offline;
- resource access revoked;
- agent not configured;
- run failed;
- no new change;
- proposal conflicts with a user edit;
- duplicate Matter suspected;
- archived Matter receives a new related email.

## 8. UX decisions still blocked

- Default navigation and view depend on target-user scope.
- Visible workflow statuses depend on lifecycle decisions.
- Create flow depends on automatic-creation policy.
- Mobile/remote-web behavior depends on deployment scope.
- Multi-user ownership, comments and presence depend on collaboration scope.


<!-- END ux-ia.md -->


---


<!-- BEGIN agent-followup.md -->

# Matters follow-up agent design

> status: proposed behavior contract
> implementation choices remain gated

## 1. Role

The follow-up agent does not own the Matter. It observes evidence, performs
bounded retrieval and proposes or applies changes according to policy.

## 2. Candidate operating modes

### Observe

- read linked and permitted resources;
- detect material change;
- summarize and cite;
- persist run telemetry and no-op outcome;
- no consequential Matter or external mutations.

### Assist

- all Observe capabilities;
- propose status, health, actions, links and drafts;
- consequential changes enter review.

### Act

- all Assist capabilities;
- execute explicitly permitted Matter or external tools;
- respect per-tool approval, idempotency and audit;
- no capability expansion from resource text.

The product may expose these as modes or keep them as internal capability profiles.

## 3. Trigger contract

Candidate trigger kinds:

```text
manual
schedule
new_linked_email
resource_changed
calendar_event_ended
stale
due_date_approaching
status_changed
```

Structured schedule semantics should be reused rather than reimplemented.

## 4. Run pipeline

```text
claim run
-> load authoritative Matter spec
-> load last successful watermark
-> gather changed resource metadata/events
-> cheap material-change check
-> no-op if nothing relevant
-> construct trusted Matter state + fenced untrusted evidence
-> retrieve additional Matter-scoped context as needed
-> compare with latest accepted Update
-> produce validated structured output
-> persist Run and proposal
-> derive attention
-> notify only when policy says it matters
```

## 5. Proposed run input

```json
{
  "matterId": 42,
  "trigger": {
    "kind": "schedule",
    "firedAt": "2026-08-07T16:00:00Z"
  },
  "watermark": {
    "eventId": 981,
    "resourceRevisions": {
      "email:42856": "r3",
      "notion:abc": "2026-08-06T10:15:00Z"
    }
  },
  "officialStateVersion": 17,
  "latestAcceptedUpdateId": 88,
  "policy": {
    "mode": "assist",
    "allowedTools": [],
    "maxRunSeconds": 120
  }
}
```

## 6. Proposed output schema

```json
{
  "currentState": "string",
  "whatChanged": [
    {
      "kind": "fact|inference",
      "description": "string",
      "sourceIds": ["email:42856"],
      "confidence": 0.92
    }
  ],
  "statusProposal": "waiting_internal",
  "healthProposal": "at_risk",
  "healthReason": "string",
  "decisions": [],
  "blockers": [],
  "openQuestions": [],
  "nextActions": [],
  "stakeholderChanges": [],
  "resourceSuggestions": [],
  "drafts": [],
  "materialChange": true,
  "overallConfidence": 0.88
}
```

## 7. Review policy recommendation

- Facts and derived low-risk metadata may be appended automatically.
- Official status, health and new actions are proposal-first in MVP.
- A user may edit before accepting.
- Accept performs one atomic, version-checked mutation.
- Reject preserves the proposal and rationale for audit.
- A proposal becomes superseded when a newer accepted Update covers its event range.

## 8. No-change behavior

A no-change run:

- records terminal success and the checked watermark;
- does not create a visible Update;
- does not notify;
- does not refresh “last meaningful activity”;
- may update “last checked” and run health.

## 9. Failure behavior

Required distinctions:

- source temporarily unavailable;
- authentication required;
- permission lost;
- model/tool timeout;
- invalid structured output;
- optimistic concurrency conflict;
- approval paused;
- partial resource refresh.

Retry must be idempotent and must not duplicate events, actions or external writes.

## 10. Open questions

- One dedicated agent per Matter or shared reusable agent profiles?
- Is a default built-in Matter agent sufficient for MVP?
- Which triggers are MVP versus P1?
- What counts as material change?
- Can the agent auto-accept high-confidence changes?
- Does completion stop schedules automatically?
- How are paused approvals surfaced in Needs Attention?
- Are multiple role-specific agents needed later?


<!-- END agent-followup.md -->


---


<!-- BEGIN architecture-plan.md -->

# Matters architecture plan

> status: recommended integration plan
> not an implementation specification

## 1. Architectural intent

Add a Matter domain layer without replacing MailAgent's existing email,
calendar, chat, agent-runtime or connector services.

Recommended top-level flow:

```text
Electron / Web UI
  -> Matters API client
  -> Python Matter domain services
       -> local operational SQLite
       -> existing email/calendar repositories
       -> resource adapters/connectors
       -> async job / agent run queue
  -> AI SDK Gateway
       -> Matter tools
       -> Matter-scoped chat
       -> follow-up run orchestration
```

## 2. Reuse candidates

- Local SQLite SSoT and existing migration discipline.
- Existing email metadata/body/attachment repositories and full-text search.
- Calendar event store and schedule-rule evaluator.
- AI SDK Gateway for multi-step tools, approval and UIMessage streaming.
- Existing chat session/message persistence.
- Custom-agent run queue, authoritative spec pull and run telemetry.
- Connector registry and per-tool permission/approval model.
- Existing untrusted-content fencing patterns.
- A2UI tool-result components.
- Existing notifications only after Matter attention semantics are stable.

## 3. Proposed code boundaries

```text
src/matters/
  models.py
  repository.py
  service.py
  identity.py
  resources.py
  timeline.py
  updates.py
  attention.py
  agent_spec.py
  api_models.py

src/api/routers/matters.py

frontend/src/shared/api/
  matters.ts
  types/matter.ts

frontend/src/shared/components/matters/
  MattersWorkspace.tsx
  MatterDetail.tsx
  MatterHeader.tsx
  MatterTimeline.tsx
  MatterResources.tsx
  MatterActions.tsx
  MatterUpdateReview.tsx

frontend/src/ai-gateway/tools/
  matters.ts

frontend/src/shared/assistant/context/
  matterContextSnapshot.ts
```

Exact locations should follow a repository review at implementation planning time.

## 4. Chat integration

Candidate additive change:

```text
ChatAnchorType:
  email | matter | general
```

The Matter ID type should be chosen to minimize cross-language schema churn.
One candidate is an integer internal key plus stable text public ID.

Context construction should use:

1. trusted structured Matter state;
2. accepted latest Update;
3. open actions and key stakeholders;
4. pinned resource metadata/excerpts;
5. changed events since last interaction;
6. on-demand retrieval from linked resources.

It should not concatenate all linked content into every prompt.

## 5. Agent-run integration

Recommended pattern:

- Matter service creates an authoritative run specification.
- Existing async-job infrastructure claims work.
- Gateway pulls spec using job ID and claim token.
- Trigger kind determines context mode.
- Tool policy is resolved server-side and fail-closed.
- Run output returns to the Matter service for validation and atomic proposal creation.

## 6. Events and indexing

Candidate event sources:

- direct user mutations;
- linked email arrival/change;
- calendar event update/end;
- connector resource revision;
- agent run lifecycle;
- proposal review.

Search indexes should cover:

- Matter title/description/current summary;
- action titles;
- stakeholder identity;
- linked resource titles/metadata;
- optionally accepted Update text.

Global content search remains in source-specific search systems; Matter search
uses links to scope retrieval.

## 7. Feature flag and rollout

Candidate flags:

```text
MAILAGENT_MATTERS_ENABLED
MAILAGENT_MATTER_AGENT_ENABLED
MAILAGENT_MATTER_AUTO_SUGGEST_ENABLED
MAILAGENT_MATTER_EVENT_TRIGGERS_ENABLED
```

A single root flag plus nested capability flags is recommended during dogfood.

## 8. Architecture decisions blocked by product decisions

- Local-only versus team sync.
- Database location and cross-device topology.
- Ownership and permissions.
- Automatic versus proposal-only state mutations.
- External document cache depth.
- Multiple Matter agents.
- public API exposure and remote authentication.


<!-- END architecture-plan.md -->


---


<!-- BEGIN data-api-contracts.md -->

# Matters data and API contracts

> status: conceptual, not stable
> naming and fields must follow settled product decisions

## 1. Conceptual tables

```text
matter
resource
matter_resource
matter_stakeholder
matter_action
matter_event
matter_update
matter_run
matter_relation          # deferred unless relationships enter scope
```

## 2. Candidate REST surface

```text
GET    /api/matters
POST   /api/matters
GET    /api/matters/{id}
PATCH  /api/matters/{id}
POST   /api/matters/{id}/archive
POST   /api/matters/{id}/reopen

GET    /api/matters/{id}/resources
POST   /api/matters/{id}/resources
DELETE /api/matters/{id}/resources/{resourceId}

GET    /api/matters/{id}/actions
POST   /api/matters/{id}/actions
PATCH  /api/matters/{id}/actions/{actionId}

GET    /api/matters/{id}/timeline
POST   /api/matters/{id}/notes

GET    /api/matters/{id}/updates
POST   /api/matters/{id}/updates/{updateId}/accept
POST   /api/matters/{id}/updates/{updateId}/reject

GET    /api/matters/{id}/runs
POST   /api/matters/{id}/runs
```

## 3. Candidate main-agent tools

### Read

```text
matter_list
matter_search
matter_get
matter_get_timeline
matter_get_resources
matter_get_actions
matter_get_updates
matter_suggest_related_resources
```

### Write

```text
matter_create
matter_create_from_email
matter_update
matter_set_status
matter_set_health
matter_link_resource
matter_unlink_resource
matter_add_action
matter_update_action
matter_add_note
matter_assign_agent
matter_set_schedule
matter_run_now
matter_accept_update
matter_reject_update
matter_archive
matter_reopen
```

The final catalog should avoid overlapping atomic tools if a smaller,
well-typed surface is easier for the model to use reliably.

## 4. Candidate mutation contract

Every mutation should carry or derive:

```text
actor
source
idempotency_key
expected_version
reason
approval_reference
```

Response:

```json
{
  "ok": true,
  "matter": {},
  "version": 18,
  "events": [1004],
  "warnings": []
}
```

A stale `expected_version` should fail with an explicit conflict rather than
silently overwrite a concurrent user edit.

## 5. Resource reference contract

Candidate reference:

```json
{
  "kind": "email",
  "provider": "mailagent",
  "externalKey": "email:42856",
  "relationType": "correspondence",
  "title": "VPN rollout date",
  "canonicalUrl": null,
  "revision": "row:42856:updated:...",
  "addedBy": "user",
  "confidence": 1.0,
  "provenance": {
    "source": "email_detail",
    "reason": "created_from_email"
  }
}
```

## 6. Event contract

```json
{
  "id": 1004,
  "matterId": 42,
  "kind": "resource_linked",
  "happenedAt": "2026-08-07T12:00:00Z",
  "actor": {"kind": "user", "id": "owner"},
  "resourceId": 91,
  "dedupeKey": "matter:42:resource:91:linked",
  "payload": {}
}
```

## 7. Update review contract

Accepting an Update should:

1. validate proposal state and Matter version;
2. apply chosen status/health/action mutations;
3. mark the Update accepted;
4. update `latest_accepted_update_id`;
5. materialize current summary;
6. append audit events;
7. commit atomically.

## 8. Versioning

Before public exposure:

- REST errors require stable codes.
- Tool names and JSON schemas require parity tests.
- Additive response fields are permitted.
- Renames/removals require explicit migration.
- Cross-language enum vocabularies require one source of truth or parity gates.


<!-- END data-api-contracts.md -->


---


<!-- BEGIN security-trust.md -->

# Matters security and trust model

> status: mandatory design input
> no automation mode may bypass these floors

## 1. Trust classes

| Data | Trust treatment |
|---|---|
| Matter IDs, validated status enums, server policy | Trusted system data |
| User-authored Matter description | Trusted as user intent, not as capability policy |
| Email bodies and attachments | Untrusted content |
| Notion pages and meeting notes | Untrusted content |
| External URLs and ticket text | Untrusted content |
| Agent summaries and proposals | Model output requiring validation |
| Tool results | Trusted only to the level of the executing domain service |
| Approval records | Trusted server-side authorization evidence |

## 2. Human authority

Recommended floor:

- Human-authored description is not overwritten by generated text.
- Official status/health changes are audited.
- Agent proposal and accepted state are distinct records.
- User rejection does not erase the proposal or its evidence.
- A later agent run does not silently reverse a human decision.

## 3. Prompt injection defense

- Fence all external resource text.
- Separate trusted Matter state from untrusted evidence.
- Never treat resource instructions as system or tool policy.
- Do not let linked URLs trigger fetch or write automatically without policy.
- Keep capability and approval evaluation outside the model prompt.
- Sanitize A2UI payloads and rendered external text.
- Bound context and tool-result sizes.
- Record injection warnings for review and telemetry.

## 4. External writes

External writes must have:

- a registered typed tool;
- an allowed capability class;
- provider authentication;
- Matter/agent policy authorization;
- required user approval;
- idempotency key;
- auditable input and output;
- retry rules appropriate to reversibility.

Email send, ticket close/delete, calendar RSVP/delete and external document
mutation are considered consequential by default.

## 5. Provenance

Every factual agent change should record:

```text
claim kind: fact | inference | recommendation
source IDs
source revision
retrieved at
confidence
run ID
```

The UI must distinguish a sourced fact from an inference.

## 6. Conflict and rollback

- Use optimistic versions for Matter and Action mutations.
- Preserve before/after state for consequential changes.
- Keep accepted Updates immutable.
- Support reverting to a prior accepted state without deleting intervening history.
- Merge/split operations need explicit trace records.
- External actions that cannot be reversed must be labeled as such before approval.

## 7. Privacy and deletion

Open decisions:

- export format;
- archive versus delete;
- cached external content retention;
- behavior after provider access revocation;
- whether headless agents may access historical chat or identity context;
- team-sharing and remote-web exposure.

## 8. Security acceptance floors

- Zero capability expansion from untrusted content.
- Zero silent irreversible external operations.
- Zero official factual claims without a source or inference label.
- Zero duplicate external side effects under retry.
- Full run and mutation audit available to the owner.


<!-- END security-trust.md -->


---


<!-- BEGIN delivery-roadmap.md -->

# Matters delivery roadmap

> status: provisional sequencing
> implementation remains gated by shared-understanding confirmation

## Phase 0 — Product contract

Outputs:

- closed design tree for MVP-relevant branches;
- accepted vocabulary and object boundary;
- approved MVP story;
- final requirements and non-goals;
- architecture decision records;
- eval and rollout plan.

Exit gate: user explicitly confirms shared understanding.

## Phase 1 — Local Matter domain

Scope:

- persistence and migrations;
- Matter CRUD;
- lifecycle and optimistic versioning;
- workspace list;
- Matter detail;
- actions, stakeholders, notes and timeline;
- feature flag.

No background agent required.

## Phase 2 — Resource association

Scope:

- email/thread linking;
- generic URL/document/event references;
- resource identity/deduplication;
- Inbox create/add flows;
- link provenance and confirmation;
- local search and filters.

## Phase 3 — Matter Chat and tools

Scope:

- Matter chat anchor;
- Matter context snapshot;
- Matter-scoped retrieval;
- main-agent read/write tools;
- A2UI cards;
- approval and conflict handling.

## Phase 4 — Manual follow-up agent

Scope:

- built-in or bound agent;
- Run now;
- authoritative run spec;
- watermark/change detector;
- structured sourced proposal;
- review/accept/reject;
- run telemetry and no-change behavior.

## Phase 5 — Scheduled and event-driven follow-up

Scope:

- structured schedule reuse;
- new-linked-email and stale triggers;
- attention derivation;
- retry, failure and paused-approval UX;
- notification policy.

## Phase 6 — Intelligent association

Scope:

- related Matter suggestions;
- resource suggestions;
- duplicate detection;
- meeting-note matching;
- merge/split.

## Phase 7 — Controlled action

Scope:

- draft generation;
- approved external document/ticket/email operations;
- tool-specific idempotency and rollback semantics;
- Act mode if product decisions support it.

## Phase 8 — Portfolio and collaboration

Candidate later scope:

- portfolio pulse and cross-Matter briefs;
- typed Matter relationships;
- multi-agent roles;
- sharing, comments, membership and permissions;
- remote/team synchronization.

## Workstream gates

Every phase requires:

- product acceptance criteria;
- data migration and rollback;
- security review;
- cross-language schema parity where applicable;
- dogfood telemetry;
- documentation update plan.


<!-- END delivery-roadmap.md -->


---


<!-- BEGIN acceptance-evals.md -->

# Matters acceptance and evaluation plan

> status: first-pass
> final thresholds depend on MVP and product-success decisions

## 1. Product acceptance scenarios

### A. Create and recover context

Given a user is reading an email that begins a multi-step work item,
when they create a Matter,
then the email is linked, provenance is recorded, and the Matter can be reopened
later with state, actions and history intact.

### B. Aggregate multiple sources

Given a Matter already exists,
when the user links another email thread, calendar event and Notion page,
then each remains independently navigable and the same resource may also be
linked to another Matter.

### C. Matter-scoped chat

Given a user asks a question inside a Matter,
the agent uses structured Matter state and retrieves relevant linked resources,
without injecting all linked bodies into every turn.

### D. Sourced follow-up

Given new linked evidence appeared after the last watermark,
when the follow-up agent runs,
then each factual change includes source references and a validated proposal is created.

### E. No-change run

Given no material change,
when a scheduled run executes,
then it records success/check time but creates no visible Update and no notification.

### F. Human conflict

Given the user edits the Matter after a run starts,
when the run attempts to apply or accept a proposal using an old version,
then the system detects the conflict rather than overwriting the user.

### G. External outage

Given a provider is unavailable,
when the user opens a Matter,
then local state, timeline and cached resource metadata remain available and the
provider failure is explicit.

## 2. Reliability tests

- resource-link idempotency;
- event dedupe under job retry;
- run watermark replay;
- optimistic concurrency;
- duplicate schedule firing;
- partial connector failure;
- invalid model JSON;
- approval pause/resume;
- app restart during run;
- archive/reopen with new evidence;
- source access revoked.

## 3. Agent eval set

Build a fixture suite covering:

- one-off email that should not become a Matter;
- long-running customer issue across threads;
- internal approval waiting state;
- meeting plus Notion minutes;
- conflicting source statements;
- irrelevant similar email;
- duplicate Matter candidates;
- no-change week;
- health degradation;
- completion and later reopening;
- malicious prompt injection in email/document text.

Evaluate:

- change detection recall/precision;
- resource linking precision;
- factual claim source coverage;
- status/health proposal accuracy;
- action extraction quality;
- duplicate Matter recommendation precision;
- no-change discipline;
- tool-policy compliance;
- cost and latency.

## 4. Candidate release thresholds

`PROVISIONAL`

- 100% factual change items have valid source IDs or are labeled inference.
- 0 unauthorized external writes.
- 0 duplicate side effects in retry tests.
- 100% no-change fixtures create no visible Update.
- >= 90% high-confidence resource suggestions accepted in dogfood sample before auto-link is considered.
- Matter list and local detail P95 under an agreed local latency threshold.
- All schedule preview/backend parity fixtures pass.
- All cross-language enums/tool schemas pass parity tests.

## 5. Product telemetry

- active Matter count;
- healthy active Matter rate;
- Matter creation source;
- time from capture to first clear next action;
- update acceptance/edit/rejection;
- stale and waiting age;
- attention reasons;
- suggestion acceptance;
- no-change run ratio;
- run duration, tools, tokens and cost;
- conflict and rollback events;
- archived/reopened rate.

## 6. Final release gate

A release cannot be approved until:

- decision-tree MVP branches are settled;
- all P0 requirements have tests;
- security floors pass;
- dogfood shows acceptable signal-to-noise;
- user confirms the product matches the intended work model.


<!-- END acceptance-evals.md -->


---


<!-- BEGIN research/repo-fit.md -->

# Repository-fit research notes

> status: environment facts and integration hypotheses
> verify again immediately before implementation

## 1. Relevant current capabilities

The current repository already provides important foundations:

- local operational SQLite as the source of truth for email metadata, bodies,
  attachments and calendar data;
- full-text email and attachment search;
- Electron UI and local/remote chat surfaces;
- an AI SDK Gateway for tool loops, approvals and structured UI messages;
- Custom Agents with manual, schedule and email-related triggers;
- a shared structured schedule contract with timezone/DST semantics;
- asynchronous agent runs with authoritative spec retrieval and audit;
- connector registration and permission boundaries;
- Notion/KOS and external-resource access paths;
- A2UI-style tool result rendering;
- notification and report infrastructure.

## 2. Gaps the Matters module must fill

- no first-class durable work object above email/chat;
- no Matter-specific SSoT;
- no generic resource-link graph around one piece of work;
- no accepted/proposed state-update distinction for ongoing work;
- no Matter-scoped chat anchor;
- no watermark-based follow-up contract tied to a Matter;
- no unified timeline across email, events, documents, actions and agent runs;
- no Needs Attention computation for ongoing work.

## 3. Recommended reuse boundaries

| Existing capability | Reuse | Do not overload |
|---|---|---|
| Email repository/search | Retrieve and link source evidence | Do not add a single `matter_id` column to email as the whole relation model |
| Chat DB/runtime | Add Matter anchor and sessions | Do not use chat transcript as Matter state |
| Custom Agent runtime | Run scheduling, queue, policy, telemetry | Do not store Matter domain state in agent config |
| Schedule contract | Recurrence evaluation and preview | Do not create another recurrence implementation |
| Connector layer | Fetch/update external resources | Do not let connector content define authorization |
| Reports | Possible portfolio/digest output later | Do not model every Matter Update as a generic report |
| KOS | Optional broad knowledge retrieval | Do not make KOS memory the canonical current Matter state |

## 4. Likely cross-language consistency risks

- Matter status/health/type enums.
- Chat anchor vocabulary.
- Agent trigger kinds.
- Tool names and schemas.
- A2UI component names.
- approval tiers and capability classes.
- update-review status.
- resource kinds and relation types.

Each should have one source of truth or explicit parity tests.

## 5. Implementation discovery still required later

- exact SQLite schema version and migration owner at kickoff;
- current chat anchor constraints in all Python/TypeScript mirrors;
- current Custom Agent spec fields and safe reuse path;
- event-bus and async-job integration points;
- current connector catalog for Notion/Atlassian/Bugzilla-like providers;
- packaging impact of new migrations and UI routes;
- remote-web authentication implications if Matters is exposed remotely.

These are engineering facts to discover, not product questions for the user.


<!-- END research/repo-fit.md -->


---


<!-- BEGIN research/industry-patterns.md -->

# Industry patterns for Matters

> status: product pattern notes
> purpose: borrow proven interaction patterns without copying another product's object model

## 1. Email collaboration and ticketing products

Useful patterns:

- create work from a message;
- linked or related conversations;
- waiting/resolved semantics;
- custom fields and rules;
- ownership and response-state visibility.

Risk to avoid:

- treating the email conversation itself as the permanent work object.

## 2. CRM/entity timeline products

Useful patterns:

- one record page with properties and activity;
- automatic and manual relation linking;
- email, meetings, files, notes and tasks in one timeline;
- source-aware activity records.

Risk to avoid:

- turning every Matter into a CRM account/contact model.

## 3. Project-status products

Useful patterns:

- status and health as separate concepts;
- periodic immutable project updates;
- stale-update indicators;
- overview plus resources and milestones;
- portfolio pulse.

Risk to avoid:

- importing heavyweight project planning into small operational Matters.

## 4. AI teammate products

Useful patterns:

- agent participates inside an existing work object;
- bounded capability and explicit scope;
- work output is visible and auditable;
- agent does not replace ownership and governance.

Risk to avoid:

- presenting autonomy as a substitute for state integrity.

## 5. Open-source issue/helpdesk systems

Useful implementation references:

- status state machines;
- event/activity logs;
- resource relationships;
- list/filter/search patterns;
- API-first record models.

Risk to avoid:

- forcing all Matter types into a support-ticket workflow.

## 6. Synthesis

The strongest product combination is:

```text
email capture and waiting semantics
+ entity-style resource timeline
+ project-style status updates and health
+ bounded agent inside the work object
```

The differentiation is not the board. It is the persistent, sourced context and
follow-up loop across email, meetings, documents and agent interactions.


<!-- END research/industry-patterns.md -->


---


<!-- BEGIN grill/rounds.md -->

# Matters batch-grill rounds

> status: active
> method: ask the complete current frontier, then wait
> implementation remains blocked until final shared-understanding confirmation

## Answer format

The user may answer compactly:

```text
Q1 B
Q2 A, but ...
Q3 custom: ...
```

Free-form answers are equally valid.

## Round 1 — Product roots

Status: `ASKING`

Questions correspond to:

- D001 Matter unit and threshold
- D002 target user/collaboration
- D003 primary outcome
- D004 naming
- D005 source boundary
- D006 official-state authority
- D007 first-release automation ceiling

The exact question text is delivered in the conversation and copied here after
the user answers, together with normalized decisions.

## Future rounds

The next frontier will be recomputed from the answers. Likely branches include:

- lifecycle/status/health;
- capture and duplicate behavior;
- resource linking and meeting-note matching;
- actions, waiting and stakeholders;
- workspace/detail UX;
- Matter Chat context;
- follow-up agent, triggers and review;
- data topology;
- API/tool approvals;
- notifications;
- MVP and release gates.

This list is not a fixed questionnaire. Questions only enter a round when their
prerequisites are settled.


<!-- END grill/rounds.md -->

---

<!-- BEGIN ACCEPTED GRILL RECORD ROUNDS 1-10 -->

> **Important:** The original package above was generated before grilling. The accepted discovery record below supersedes any conflicting `OPEN`, `PROVISIONAL`, or provisional recommendation above.

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


---

# MailAgent Matters — Remaining Decision Frontier after Round 10

> status: active
> purpose: remaining user decisions only; environment/implementation facts must be researched rather than asked.

## Coverage status

Rounds 1–10 (Q1–Q116) have settled the product contract, lifecycle, capture, resource graph, item model, UX information architecture, chat semantics, agent automation boundary, persistence, APIs, trust model, failure behavior and evidence model.

The remaining user-decision frontier is intentionally compressed to roughly **12–16 decisions**, expected to fit in **at most two grill rounds**.

## Remaining high-leverage user decisions

### A. Final domain edge cases

1. **Meeting ↔ meeting-notes matching:** whether v1 needs an explicit candidate-matching flow for Calendar events to Notion/Confluence meeting notes, or whether both are simply linked manually/through Agent search.
2. **Relationships/dependencies between Matters:** whether v1 needs `related / blocks / blocked_by / supersedes` Matter-to-Matter links, or only cross-Matter lookup/comparison.
3. **External task/ticket systems:** confirm that Jira/Bugzilla/Todoist-like structured task synchronization is outside v1; generic URL/reference is sufficient.
4. **Agent reassignment:** expected history/behavior when changing the Primary Agent Profile bound to an existing Matter.

### B. Notification/product operating policy

5. **Immediate vs digest:** whether important Matter notifications are always immediate or whether Needs Review/Attention may also be summarized into a periodic digest.
6. **Default native-notification policy:** whether macOS native notification is opt-in, opt-out, or enabled only for High/Critical Attention by default.

### C. Scale and non-functional product targets

7. **Expected dogfood scale:** rough operating envelope for active Matters / archived Matters / resources per Matter. This drives performance acceptance, not hard product limits.
8. **Offline/cached behavior:** how much Matter detail should remain fully usable when connectors/gbrain are unavailable, beyond already-cached state.

### D. MVP / rollout contract

9. **One canonical MVP success scenario** to gate release.
10. **MVP boundary:** which pieces are P0 versus immediate P1 (e.g. native notification, merge, export, smart resource suggestions).
11. **Rollout:** feature flag/dogfood-first versus direct default-on for the single user.
12. **Release success metrics / eval gates:** minimum product + agent quality bars before declaring Matters usable.
13. **Failure rollback:** what should happen if scheduled agent automation proves noisy or unreliable after rollout.
14. **Documentation promotion:** when this discovery PRD becomes `docs/reference/matters/` current truth.

## Environment/implementation questions that will NOT be asked of the user

These are research/engineering tasks, not preference questions:

- Exact existing SQLite schema/migration version and best table module placement.
- Exact `ai_chat.db` anchor migration needed to add `matter`.
- Existing scheduler implementation details and reusable APIs.
- Existing Electron/native-notification wiring and packaging requirements.
- Existing Remote Web routing/auth behavior.
- Existing backup/restore mechanism and how Matter tables join it.
- Existing FTS/index utilities.
- Exact run retry defaults, timeouts, token/tool budgets and Trash retention default.
- Standard accessibility/localization behavior inherited from MailAgent design system.
- REST route naming, TypeScript/Python DTO placement and migration mechanics.

## Completion condition

After the remaining two rounds, the frontier should be empty except explicitly deferred roadmap items. Then the user is asked for one final **shared-understanding confirmation** before implementation planning begins.

<!-- END ACCEPTED GRILL RECORD ROUNDS 1-10 -->

---

# Discovery Closure — Rounds 11–12 and Final Shared Understanding

The Batch Grill completed through **Round 12 / Q130**. The full normalized decision record is in `grill-log-rounds-01-12.md`. The final agreed product contract awaiting explicit user confirmation is in `final-shared-understanding.md`.

## Round 11 accepted decisions

- Lightweight typed Matter-to-Matter relations; no hierarchy/status roll-up.
- Deterministic meeting↔notes identity may auto-link; heuristic matching only suggests.
- Generic URL is an on-demand fetchable untrusted Resource; no Bugzilla-specific provider/polling in MVP.
- Native macOS notifications default on only for high-value/high-severity events.
- No first-launch historical Matter generation.
- External backlink mirror is future scope.
- Backup/restore gates MVP; Markdown/JSON export is immediate P1.

## Round 12 accepted decisions

- MVP must contain the full continuous-work Agent loop, not just Matter CRUD.
- Duplicate candidates, outward resource discovery, Context Gaps and URL on-demand fetch are MVP; Merge UI and heuristic meeting-note candidate matching can follow immediately after.
- Feature-flagged real-data dogfood precedes default-on rollout.
- Dedicated Matter Agent evals are release gates.
- Healthy Active Matter Rate is the north-star metric.
- Hard local responsiveness targets apply; Agent runs are bounded/observable/cancelable rather than fixed-time SLA.
- Implementation planning begins only after explicit Final Shared Understanding confirmation.

## Discovery status

**Product-decision frontier: EMPTY.**

**Current gate: awaiting explicit user confirmation of `final-shared-understanding.md`.**
