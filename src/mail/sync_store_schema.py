"""SyncStore schema DDL constants, shared types, and migration helpers.

Extracted from ``src/mail/sync_store.py`` in Wave 0 so DDL definitions and
cross-domain schema constants live separately from SyncStore runtime methods.
All public symbols are re-exported from ``src.mail.sync_store`` for backward
compatibility.
"""

import sqlite3
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from enum import Enum
from typing import Any, Dict, NamedTuple, Optional, TypedDict

from loguru import logger

from src.matters.models import (
    MATTER_ITEM_EXECUTOR_KINDS,
    MatterActorKind,
    MatterAttentionKind,
    MatterAttentionSeverity,
    MatterAttentionState,
    MatterHealth,
    MatterItemDispatchState,
    MatterItemExecProfile,
    MatterItemKind,
    MatterItemStatus,
    MatterPriority,
    MatterProgressKind,
    MatterAccessPolicy,
    MatterRelationType,
    MatterResourceKind,
    MatterResourceSubscriptionState,
    MatterResourceSummarySource,
    MatterRunStatus,
    MatterRunTrigger,
    MatterStakeholderTier,
    MatterStatus,
    MatterTagColor,
    MatterTagShape,
    MatterUpdateReviewStatus,
    sql_check_clause,
)
# 统一执行台账的两个值域单源 (零依赖叶子, 见该模块头注): agent_run_log 的 status
# CHECK 与 agent_run_step 的 kind CHECK 引它们, 不手抄字符串。反向 import
# (run_log → sync_store) 是循环, 故表 DDL 归本文件、读写归那边。
from src.agents.run_log import AGENT_RUN_LOG_STATUS_VALUES, AGENT_RUN_STEP_KINDS
from src.contacts.taxonomy import (
    CONTACT_FUNCTION_VALUES,
    CONTACT_GENDER_VALUES,
    CONTACT_KIND_VALUES,
    CONTACT_MANAGER_SRC_VALUES,
    CONTACT_SENIORITY_VALUES,
    CONTACT_SUGGESTION_STATUS_VALUES,
    CONTACT_SUGGESTION_TYPE_VALUES,
)
# 通知中心值域单源 (零依赖叶子, 见该模块头注): notification 表的三处 CHECK 引它,
# 不手抄字符串。src/notify/__init__.py 为空 ⇒ 这条 import 不拖 feishu/island 依赖链。
from src.notify.center_models import (
    NOTIFICATION_CATEGORY_VALUES,
    NOTIFICATION_SEVERITY_VALUES,
    NOTIFICATION_STATE_VALUES,
)
from src.mail.email_address import derive_sender_email


# ==================== llm_processing DDL 单源 (v37) ====================
# 🔴 唯一权威 DDL —— 两个消费方共用, 改列/索引只动这里:
#   ① SyncStore._init_database_impl (v37 起版本化建表, 首启即建 —— 主路径);
#   ② src/llm_agent/store.py LLMProcessingStore._ensure_schema (幂等双保险,
#      LLM Agent 启用时独立实例化仍自建表)。
# import 方向必须是 llm_agent → mail (runner.py 已依赖 src.mail.*), 反向 import
# 会触发 src/llm_agent/__init__.py 重依赖链 → 循环 import。
LLM_PROCESSING_TABLE_DDL = """
    CREATE TABLE IF NOT EXISTS llm_processing (
        internal_id INTEGER PRIMARY KEY,
        notion_page_id TEXT,
        mailbox TEXT,
        status TEXT,
        retry_count INTEGER DEFAULT 0,
        next_retry_at REAL,
        last_error TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        latency_ms INTEGER,
        labels_json TEXT,
        created_at REAL,
        updated_at REAL
    )
"""
LLM_PROCESSING_INDEX_DDLS = (
    "CREATE INDEX IF NOT EXISTS idx_llm_status ON llm_processing(status)",
    "CREATE INDEX IF NOT EXISTS idx_llm_retry "
    "ON llm_processing(next_retry_at) WHERE status='failed'",
)


# ==================== Matters DDL single source (v45) ====================
# v57 (设计稿 H3§5.4 资料版本轨迹): 一行 = 一份**已被取代的**资料版本快照。
#
# 🔴 为什么只存历史、不存当前版本: 当前版本就是 `resource` 行自己 (revision /
# content_hash / sum 三组列)。把它也写进本表 = 同一事实两处存, 必然漂移; 读侧把
# 「resource 行 + 本表」拼成完整轨迹, 当前行由 UI 标「当前」。
#
# 🔴 为什么存不了历史正文: 原文在外部系统, 本地只有有限缓存。能留档的就是这几样 ——
# 当时读到的是哪一版 (revision/content_hash)、什么时候被取代 (superseded_at)、
# 以及**当时我们自己写的那份摘要** (sum/sum_src/sum_at 三件套照 v56 原样搬)。摘要是
# 可被覆盖的单值, 覆盖即永久丢失, 留档它正是本表存在的理由。
#
# 唯一写者 = `MatterService.fetch_url_resource` 检出到新 content_hash 的那一刻
# (resource 的 revision/content_hash/last_checked_at 全仓也只有它写)。
# `diff_text` = 这一版**被取代时**变了什么的一句话, 由跟进 Agent 写在提案的
# `resource.diff` 里、接受时回填 (service `_apply_new_resource_link`); 没人给就留
# NULL —— 服务端不按字数差之类的机械指标编一句出来充数。
RESOURCE_VERSION_TABLE_DDL = f"""CREATE TABLE IF NOT EXISTS resource_version (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_id INTEGER NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
        revision TEXT NULL,
        content_hash TEXT NULL,
        superseded_at INTEGER NOT NULL,
        diff_text TEXT NULL,
        sum TEXT NULL,
        sum_src TEXT NULL CHECK (sum_src IS NULL OR sum_src {sql_check_clause(MatterResourceSummarySource)}),
        sum_at INTEGER NULL
    )"""

MATTER_TABLE_DDLS = (
    """CREATE TABLE IF NOT EXISTS matter_seq (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL UNIQUE CHECK (public_id LIKE 'MAT-%'),
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        background TEXT NOT NULL DEFAULT '',
        goal TEXT NOT NULL DEFAULT '',
        matter_type TEXT NULL CHECK (matter_type IS NULL OR length(trim(matter_type)) > 0),
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
        goal_checks_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(goal_checks_json)),
        status TEXT NOT NULL DEFAULT 'inbox' CHECK (status {sql_check_clause(MatterStatus)}),
        health TEXT NOT NULL DEFAULT 'unknown' CHECK (health {sql_check_clause(MatterHealth)}),
        priority TEXT NOT NULL DEFAULT 'p1' CHECK (priority {sql_check_clause(MatterPriority)}),
        owner_id TEXT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        due_at INTEGER NULL,
        waiting_context_json TEXT NULL CHECK (waiting_context_json IS NULL OR json_valid(waiting_context_json)),
        next_attention_at INTEGER NULL,
        attention_reason TEXT NULL,
        last_activity_at INTEGER NULL,
        latest_accepted_update_id INTEGER NULL,
        current_summary TEXT NULL,
        summary_at INTEGER NULL,
        summary_by_kind TEXT NULL CHECK (summary_by_kind IS NULL OR summary_by_kind {sql_check_clause(MatterActorKind)}),
        summary_by_id TEXT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        archived_at INTEGER NULL,
        archived_by_kind TEXT NULL CHECK (archived_by_kind IS NULL OR archived_by_kind {sql_check_clause(MatterActorKind)}),
        archived_by_id TEXT NULL,
        deleted_at INTEGER NULL,
        deleted_by_kind TEXT NULL CHECK (deleted_by_kind IS NULL OR deleted_by_kind {sql_check_clause(MatterActorKind)}),
        deleted_by_id TEXT NULL,
        purge_after INTEGER NULL,
        agent_profile_id TEXT NULL,
        agent_enabled INTEGER NOT NULL DEFAULT 1 CHECK (agent_enabled IN (0, 1)),
        matter_instructions TEXT NULL,
        schedule_json TEXT NULL CHECK (schedule_json IS NULL OR json_valid(schedule_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(latest_accepted_update_id) REFERENCES matter_update(id) ON DELETE SET NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter_item (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind {sql_check_clause(MatterItemKind)}),
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        description TEXT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        status TEXT NULL CHECK (status IS NULL OR status {sql_check_clause(MatterItemStatus)}),
        priority TEXT NULL CHECK (priority IS NULL OR priority {sql_check_clause(MatterPriority)}),
        owner_kind TEXT NULL CHECK (owner_kind IS NULL OR owner_kind {sql_check_clause(MatterActorKind)}),
        owner_id TEXT NULL,
        waiting_on_stakeholder_id INTEGER NULL REFERENCES matter_stakeholder(id) ON DELETE SET NULL,
        due_at INTEGER NULL,
        completed_at INTEGER NULL,
        checklist_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(checklist_json)),
        source_resource_id INTEGER NULL REFERENCES resource(id) ON DELETE SET NULL,
        source_locator_json TEXT NULL CHECK (source_locator_json IS NULL OR json_valid(source_locator_json)),
        created_by_kind TEXT NOT NULL CHECK (created_by_kind {sql_check_clause(MatterActorKind)}),
        created_by_id TEXT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        deleted_at INTEGER NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        exec_profile TEXT NULL CHECK (exec_profile IS NULL OR exec_profile {sql_check_clause(MatterItemExecProfile)}),
        CHECK (kind = 'action' OR (
            status IS NULL AND priority IS NULL AND owner_kind IS NULL AND owner_id IS NULL
            AND waiting_on_stakeholder_id IS NULL AND due_at IS NULL AND completed_at IS NULL
            AND checklist_json = '[]'
        ))
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        happened_at INTEGER NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind {sql_check_clause(MatterActorKind)}),
        actor_id TEXT NULL,
        source TEXT NOT NULL,
        resource_id INTEGER NULL REFERENCES resource(id) ON DELETE SET NULL,
        item_id INTEGER NULL REFERENCES matter_item(id) ON DELETE SET NULL,
        update_id INTEGER NULL REFERENCES matter_update(id) ON DELETE SET NULL,
        reverses_event_id INTEGER NULL REFERENCES matter_event(id) ON DELETE SET NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL DEFAULT '{{}}' CHECK (json_valid(payload_json)),
        created_at INTEGER NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter_update (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        review_status TEXT NOT NULL CHECK (review_status {sql_check_clause(MatterUpdateReviewStatus)}),
        summary TEXT NULL,
        from_event_id INTEGER NULL REFERENCES matter_event(id) ON DELETE SET NULL,
        to_event_id INTEGER NULL REFERENCES matter_event(id) ON DELETE SET NULL,
        anchored_matter_version INTEGER NOT NULL CHECK (anchored_matter_version >= 1),
        official_state_version INTEGER NULL CHECK (official_state_version IS NULL OR official_state_version >= 1),
        original_proposal_json TEXT NOT NULL DEFAULT '{{}}' CHECK (json_valid(original_proposal_json)),
        reviewed_result_json TEXT NULL CHECK (reviewed_result_json IS NULL OR json_valid(reviewed_result_json)),
        changes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changes_json)),
        accepted_change_ids_json TEXT NULL CHECK (accepted_change_ids_json IS NULL OR json_valid(accepted_change_ids_json)),
        citations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations_json)),
        confidence REAL NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        agent_run_id INTEGER NULL,
        is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
        stale_at INTEGER NULL,
        stale_reason TEXT NULL,
        created_by_kind TEXT NOT NULL CHECK (created_by_kind {sql_check_clause(MatterActorKind)}),
        created_by_id TEXT NULL,
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER NULL,
        reviewed_by_kind TEXT NULL CHECK (reviewed_by_kind IS NULL OR reviewed_by_kind {sql_check_clause(MatterActorKind)}),
        reviewed_by_id TEXT NULL,
        accepted_at INTEGER NULL,
        rejected_at INTEGER NULL,
        review_reason TEXT NULL,
        -- v71: 这份提案是哪一次行动项派发交付的 (`matter_item_dispatch.id`)。
        -- accept / reject 时按它把那次派发结算成 done / canceled。
        -- 🔴 有意**不加 FK**: 与 matter_item_dispatch 分属两个 DDL 常量组 (那张表只从 v71
        -- 块建一次, 本组却会被 v44..v50 各块对老库整组重放) —— 跨组 FK 会把重放顺序变成
        -- 一个新的约束面。抄 matter_run.async_job_id 的先例 (同样跨组、同样无 FK)。
        item_dispatch_id INTEGER NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS resource (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind {sql_check_clause(MatterResourceKind)}),
        provider TEXT NOT NULL CHECK (provider = lower(trim(provider)) AND length(provider) > 0),
        external_key TEXT NOT NULL CHECK (length(trim(external_key)) > 0),
        canonical_url TEXT NULL,
        title TEXT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{{}}' CHECK (json_valid(metadata_json)),
        sum TEXT NULL,
        sum_src TEXT NULL CHECK (sum_src IS NULL OR sum_src {sql_check_clause(MatterResourceSummarySource)}),
        sum_at INTEGER NULL,
        revision TEXT NULL,
        content_hash TEXT NULL,
        permission_state TEXT NULL,
        sync_state TEXT NULL,
        access_policy TEXT NOT NULL DEFAULT 'allowed' CHECK (access_policy {sql_check_clause(MatterAccessPolicy)}),
        last_checked_at INTEGER NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter_resource (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        resource_id INTEGER NOT NULL REFERENCES resource(id) ON DELETE RESTRICT,
        relation_type TEXT NULL,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        added_by_kind TEXT NOT NULL CHECK (added_by_kind {sql_check_clause(MatterActorKind)}),
        added_by_id TEXT NULL,
        confidence REAL NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        provenance_json TEXT NOT NULL DEFAULT '{{}}' CHECK (json_valid(provenance_json)),
        confirmed_at INTEGER NULL,
        sub_state TEXT NOT NULL DEFAULT 'none' CHECK (sub_state {sql_check_clause(MatterResourceSubscriptionState)}),
        deleted_at INTEGER NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter_tag (
        name TEXT PRIMARY KEY,
        color TEXT NOT NULL DEFAULT '{MatterTagColor.ACCENT}'
            CHECK (color {sql_check_clause(MatterTagColor)}),
        shape TEXT NOT NULL DEFAULT '{MatterTagShape.CIRCLE}'
            CHECK (shape {sql_check_clause(MatterTagShape)}),
        created_at INTEGER NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS matter_resource_rejection (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        resource_key TEXT NOT NULL,
        rejected_at INTEGER NOT NULL,
        evidence_fingerprint TEXT NOT NULL,
        reason TEXT NULL,
        UNIQUE (matter_id, resource_key)
    )""",
    # v52 (dogfood 轮 2 W-C): 全局干系人库。身份 = 归一 email（lower+trim, UNIQUE）——
    # 没有 email 的干系人**不入全局库**（没有可靠身份键, 按名字合并必然误并同名人）,
    # 只作 per-matter 行存在（matter_stakeholder.contact_id 保持 NULL）。
    # display_name / organization 是「全局一份」的基本信息; 角色/等待/备注仍归各事项行。
    """CREATE TABLE IF NOT EXISTS matter_contact (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_normalized TEXT NOT NULL UNIQUE
            CHECK (email_normalized = lower(trim(email_normalized)) AND length(email_normalized) > 0),
        display_name TEXT NULL,
        organization TEXT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter_stakeholder (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        person_key TEXT NOT NULL,
        display_name TEXT NULL,
        email_normalized TEXT NULL,
        organization TEXT NULL,
        role TEXT NULL,
        relationship TEXT NULL,
        is_waiting_on INTEGER NOT NULL DEFAULT 0 CHECK (is_waiting_on IN (0, 1)),
        tier TEXT NOT NULL DEFAULT 'normal' CHECK (tier {sql_check_clause(MatterStakeholderTier)}),
        sort_order INTEGER NOT NULL DEFAULT 0,
        last_contact_at INTEGER NULL,
        source_resource_id INTEGER NULL REFERENCES resource(id) ON DELETE SET NULL,
        contact_id INTEGER NULL REFERENCES matter_contact(id) ON DELETE SET NULL,
        deleted_at INTEGER NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter_relation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        target_matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        relation_type TEXT NULL CHECK (relation_type IS NULL OR relation_type {sql_check_clause(MatterRelationType)}),
        confidence REAL NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        provenance_json TEXT NOT NULL DEFAULT '{{}}' CHECK (json_valid(provenance_json)),
        confirmed_at INTEGER NULL,
        deleted_at INTEGER NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (source_matter_id <> target_matter_id)
    )""",
    """CREATE TABLE IF NOT EXISTS matter_search_document (
        matter_id INTEGER PRIMARY KEY REFERENCES matter(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        current_summary TEXT NOT NULL DEFAULT '',
        status_text TEXT NOT NULL DEFAULT '',
        items_text TEXT NOT NULL DEFAULT '',
        stakeholders_text TEXT NOT NULL DEFAULT '',
        notes_text TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
    )""",
    """CREATE VIRTUAL TABLE IF NOT EXISTS matter_fts USING fts5(
        title, description, current_summary, status_text, items_text,
        stakeholders_text, notes_text, tokenize='trigram'
    )""",
    # v46 (P4): matter 跟进 Agent run 账本 (contracts §2.11)。async_job_id 跨表逻辑引用
    # async_jobs.job_id (同库无 FK — async_jobs 建表不在本 DDL 组, 且 job 行可被清理);
    # chat_session_id 跨 CHAT_DB 逻辑引用。matter_update.agent_run_id 语义 = 本表 id
    # (D1 冻结; v44 时代注释里的「跨库指向 async_jobs.job_id」作废, 该列彼时零消费方)。
    f"""CREATE TABLE IF NOT EXISTS matter_run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        agent_profile_id TEXT NULL,
        async_job_id INTEGER NULL,
        chat_session_id INTEGER NULL,
        trigger_kind TEXT NOT NULL CHECK (trigger_kind {sql_check_clause(MatterRunTrigger)}),
        trigger_payload_json TEXT NOT NULL DEFAULT '{{}}' CHECK (json_valid(trigger_payload_json)),
        idempotency_key TEXT NOT NULL UNIQUE,
        input_watermark_json TEXT NOT NULL DEFAULT '{{}}' CHECK (json_valid(input_watermark_json)),
        output_watermark_json TEXT NULL CHECK (output_watermark_json IS NULL OR json_valid(output_watermark_json)),
        status TEXT NULL CHECK (status IS NULL OR status {sql_check_clause(MatterRunStatus)}),
        model TEXT NULL,
        usage_json TEXT NULL CHECK (usage_json IS NULL OR json_valid(usage_json)),
        cost_usd REAL NULL CHECK (cost_usd IS NULL OR cost_usd >= 0),
        error_json TEXT NULL CHECK (error_json IS NULL OR json_valid(error_json)),
        queued_at INTEGER NOT NULL,
        started_at INTEGER NULL,
        completed_at INTEGER NULL,
        cancel_requested_at INTEGER NULL,
        canceled_at INTEGER NULL,
        coalesced_trigger_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter_attention (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id),
        kind TEXT NOT NULL CHECK (kind {sql_check_clause(MatterAttentionKind)}),
        subject_key TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open' CHECK (state {sql_check_clause(MatterAttentionState)}),
        severity TEXT NOT NULL CHECK (severity {sql_check_clause(MatterAttentionSeverity)}),
        why TEXT NOT NULL,
        recurrence_no INTEGER NOT NULL DEFAULT 1,
        first_opened_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL,
        snoozed_until INTEGER NULL,
        resolved_at INTEGER NULL,
        dismissed_at INTEGER NULL,
        cleared_at INTEGER NULL,
        last_notified_at INTEGER NULL,
        payload_json TEXT NULL CHECK (payload_json IS NULL OR json_valid(payload_json))
    )""",
    # 🔴 追加在**末尾**: v45 迁移块按下标取用本元组 (`MATTER_TABLE_DDLS[2]` / `[3]`),
    # 往中间插一条会把那两处静默指到别的表上。
    RESOURCE_VERSION_TABLE_DDL,
)

MATTER_INDEX_DDLS = (
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_matter_public_id ON matter(public_id)",
    "CREATE INDEX IF NOT EXISTS idx_matter_live_status ON matter(status, priority, due_at) WHERE deleted_at IS NULL AND archived_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_attention ON matter(next_attention_at) WHERE deleted_at IS NULL AND next_attention_at IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_archived ON matter(archived_at DESC) WHERE deleted_at IS NULL AND archived_at IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_trash ON matter(deleted_at DESC) WHERE deleted_at IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_updated ON matter(updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_matter_item_live ON matter_item(matter_id, kind, position, id) WHERE deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_item_action_status ON matter_item(matter_id, status, due_at) WHERE kind='action' AND deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_item_source ON matter_item(source_resource_id) WHERE source_resource_id IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_matter_event_dedupe ON matter_event(dedupe_key)",
    "CREATE INDEX IF NOT EXISTS idx_matter_event_timeline ON matter_event(matter_id, happened_at DESC, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_matter_event_kind ON matter_event(matter_id, kind, happened_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_matter_event_resource ON matter_event(resource_id, happened_at DESC) WHERE resource_id IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_update_review ON matter_update(matter_id, review_status, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_matter_update_range ON matter_update(matter_id, from_event_id, to_event_id)",
    "CREATE INDEX IF NOT EXISTS idx_matter_update_run ON matter_update(agent_run_id) WHERE agent_run_id IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_update_stale ON matter_update(matter_id, is_stale, created_at DESC) WHERE review_status='pending'",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_provider_key ON resource(provider, external_key)",
    "CREATE INDEX IF NOT EXISTS idx_resource_kind ON resource(kind)",
    "CREATE INDEX IF NOT EXISTS idx_resource_canonical_url ON resource(canonical_url) WHERE canonical_url IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_resource_sync_state ON resource(sync_state, last_checked_at) WHERE sync_state IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_matter_resource_live ON matter_resource(matter_id, resource_id) WHERE deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_resource_group ON matter_resource(matter_id, pinned DESC, relation_type, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_matter_resource_reverse ON matter_resource(resource_id, matter_id) WHERE deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_resource_subscription ON matter_resource(resource_id, sub_state) WHERE deleted_at IS NULL AND sub_state IN ('active','paused')",
    "CREATE INDEX IF NOT EXISTS idx_matter_resource_rejection_matter ON matter_resource_rejection(matter_id, rejected_at DESC)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_matter_stakeholder_person ON matter_stakeholder(matter_id, person_key) WHERE deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_stakeholder_email ON matter_stakeholder(email_normalized) WHERE email_normalized IS NOT NULL AND deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_stakeholder_waiting ON matter_stakeholder(matter_id, is_waiting_on) WHERE deleted_at IS NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_matter_relation_live ON matter_relation(source_matter_id, target_matter_id, relation_type) WHERE deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_relation_source ON matter_relation(source_matter_id, relation_type) WHERE deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_relation_target ON matter_relation(target_matter_id, relation_type) WHERE deleted_at IS NULL",
    # v46 (P4): matter_run 索引 (contracts §2.11)。uq_matter_run_one_active partial
    # unique = 单活跃 run 的数据库最终防线 (worker started_at CAS 撞它 → E_RUN_ACTIVE)。
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_matter_run_idempotency ON matter_run(idempotency_key)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_matter_run_one_active ON matter_run(matter_id) WHERE started_at IS NOT NULL AND completed_at IS NULL AND canceled_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_run_history ON matter_run(matter_id, queued_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_matter_run_async_job ON matter_run(async_job_id) WHERE async_job_id IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_matter_attention_active ON matter_attention(matter_id, kind, subject_key) WHERE state IN ('open','snoozed')",
    "CREATE INDEX IF NOT EXISTS idx_matter_attention_state ON matter_attention(state, matter_id)",
)

# v52 (dogfood 轮 2 W-C): stakeholder→contact 关联索引。🔴 有意**不进** MATTER_INDEX_DDLS ——
# v44-v50 各迁移块会对老库整组重放 MATTER_INDEX_DDLS, 而 contact_id 列要到 v52 的 ALTER
# 才存在, 放进组里会把 v45..v51 老库的升级梯子当场炸掉 ("no such column"); 只能在 v52 块
# (ALTER 之后) 建。新库同样走满迁移梯子 (current_version=0), 所以也会经 v52 块拿到它。
MATTER_STAKEHOLDER_CONTACT_INDEX_DDL = (
    "CREATE INDEX IF NOT EXISTS idx_matter_stakeholder_contact "
    "ON matter_stakeholder(contact_id) WHERE contact_id IS NOT NULL"
)

# v57 (资料版本轨迹): 轨迹表的读面只有一种 —— 「某份资料的历史版本, 新的在前」。
# 🔴 同 v52 的理由**不进** MATTER_INDEX_DDLS: v44/v45/v46/v49/v50 各块会对老库整组
# 重放 MATTER_INDEX_DDLS, 而 resource_version 表要到那些块里的 MATTER_TABLE_DDLS 才
# 建 —— 组内顺序碰巧成立不等于安全 (v52 就是这样炸的), 只在 v57 块 (建表之后) 建。
RESOURCE_VERSION_INDEX_DDL = (
    "CREATE INDEX IF NOT EXISTS idx_resource_version_trail "
    "ON resource_version(resource_id, superseded_at DESC, id DESC)"
)


# ==================== Contact Directory DDL single source (v54) ====================
# 通讯录三表 (task 08-13 contact-directory WP1, PRD §3.2)。🔴 独立成组, **不进**
# MATTER_TABLE_DDLS / MATTER_INDEX_DDLS —— 既是域边界 (通讯录是跨域「人」引用库,
# 不是 matters 子件, 代码归 src/contacts/), 也是 v52 索引教训的直接应用: matters
# 各迁移块会对老库整组重放 MATTER_*_DDLS, 本组只从 v54 块执行 (新库满梯子同样经
# v54 拿到), 老库升级梯子对 v44..v53 全部中间版本无重放炸点。
# CHECK 值域经 sql_check_clause 引自 src/contacts/taxonomy.py (枚举唯一权威,
# 不手抄 —— 仓规「第二处手抄先消灭镜像」)。
CONTACT_TABLE_DDLS = (
    # ① 人 (人级代理主键 —— 身份锚在 contact_email, 本体不含 email 列)。
    #    🎨 设计增补列 (role_title / function / seniority / manager 两列) 随 v54
    #    一次建齐, 不留二次迁移 (PRD §7-WP1)。kind_locked_at = owner 改判 kind 后
    #    L0 启发式不再翻转的锁 (镜像 identity_locked_at 的语义粒度)。
    f"""CREATE TABLE IF NOT EXISTS contact (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        display_name TEXT NULL,
        formal_name TEXT NULL,
        organization TEXT NULL,
        department TEXT NULL,
        contact_info_json TEXT NULL CHECK (contact_info_json IS NULL OR json_valid(contact_info_json)),
        notes TEXT NULL,
        name_variants_json TEXT NULL CHECK (name_variants_json IS NULL OR json_valid(name_variants_json)),
        role_title TEXT NULL,
        function TEXT NULL CHECK (function IS NULL OR function {sql_check_clause(CONTACT_FUNCTION_VALUES)}),
        seniority TEXT NULL CHECK (seniority IS NULL OR seniority {sql_check_clause(CONTACT_SENIORITY_VALUES)}),
        gender TEXT NULL CHECK (gender IS NULL OR gender {sql_check_clause(CONTACT_GENDER_VALUES)}),
        manager_contact_id INTEGER NULL REFERENCES contact(id) ON DELETE SET NULL,
        manager_src TEXT NULL CHECK (manager_src IS NULL OR manager_src {sql_check_clause(CONTACT_MANAGER_SRC_VALUES)}),
        kind TEXT NOT NULL DEFAULT 'person' CHECK (kind {sql_check_clause(CONTACT_KIND_VALUES)}),
        kind_locked_at INTEGER NULL,
        is_self INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)),
        hidden_at INTEGER NULL,
        identity_locked_at INTEGER NULL,
        identity_locks_json TEXT NULL CHECK (identity_locks_json IS NULL OR json_valid(identity_locks_json)),
        profile_json TEXT NULL CHECK (profile_json IS NULL OR json_valid(profile_json)),
        profile_updated_at INTEGER NULL,
        profile_mail_count INTEGER NULL,
        profile_model TEXT NULL,
        profile_status TEXT NULL CHECK (
            profile_status IS NULL OR profile_status IN ('ok','skipped','failed','running')
        ),
        profile_attempted_at INTEGER NULL,
        profile_error TEXT NULL,
        mail_count INTEGER NOT NULL DEFAULT 0,
        sent_to_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NULL,
        last_seen_at INTEGER NULL,
        -- v69 日历第三源的聚合缓存 (src/contacts/calendar_scan.py 全量重算, 非增量)。
        -- 🔴 时间列与本表其余时间列同单位 = epoch **毫秒** (calendar_event 存的是
        -- epoch 秒 REAL, 边界处换算) —— 前端把 contact 的时间列一律按 ms 渲染。
        meeting_count INTEGER NOT NULL DEFAULT 0,
        last_met_at INTEGER NULL,
        next_meeting_at INTEGER NULL,
        merged_into INTEGER NULL REFERENCES contact(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )""",
    # ② email 锚点 (一人多邮箱; 全表 UNIQUE = 一个地址只属于一个人)。
    """CREATE TABLE IF NOT EXISTS contact_email (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
        email_normalized TEXT NOT NULL UNIQUE
            CHECK (email_normalized = lower(trim(email_normalized)) AND length(email_normalized) > 0),
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        former_at INTEGER NULL,
        mail_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NULL,
        last_seen_at INTEGER NULL,
        created_at INTEGER NOT NULL
    )""",
    # ③ 人-邮件账本。挂 contact_email 不挂 contact: 合并 = 改锚点归属, 账本零搬。
    #    email_metadata 行被删 (merge guard / INSERT OR REPLACE 的 REPLACE 路径)
    #    时账本行 CASCADE 清掉, 聚合缓存靠校准自愈 (PRD §4.2 merge guard 边界)。
    """CREATE TABLE IF NOT EXISTS contact_email_link (
        email_id INTEGER NOT NULL REFERENCES contact_email(id) ON DELETE CASCADE,
        internal_id INTEGER NOT NULL REFERENCES email_metadata(internal_id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('sender', 'to', 'cc')),
        seen_at INTEGER NULL,
        PRIMARY KEY (email_id, internal_id, role)
    )""",
)

CONTACT_INDEX_DDLS = (
    "CREATE INDEX IF NOT EXISTS idx_contact_email_contact ON contact_email(contact_id)",
    "CREATE INDEX IF NOT EXISTS idx_link_email ON contact_email_link(email_id, seen_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_link_mail ON contact_email_link(internal_id)",
)

# v67: contact **表本体**的三条索引 (v54 建表起一直是零索引 —— 列表 SCAN c + TEMP
# B-TREE, 详情的 reports/peers 两腿各 SCAN r 一次)。
#   · idx_contact_known  → 默认视图那组等值/IS NULL 条件 + 密度序的第一列
#                          (EQP: SEARCH c USING INDEX … + LAST 3 TERMS 局部排序)
#   · idx_contact_manager→ 详情 reports 腿 `WHERE manager_contact_id = ?`
#   · idx_contact_org    → 详情 peers 腿 `WHERE organization = ?`
# 🔴 有意**不进** CONTACT_INDEX_DDLS: 那一组会被 v54 块对老库执行, 而它是「三表刚
# 建完」的语境; 本组只从 v67 块执行 (新库走满梯子同样经 v67 拿到)。同 v52 教训 ——
# 组内顺序碰巧成立不等于安全 (见 MATTER_STAKEHOLDER_CONTACT_INDEX_DDL 头注)。
# 形状是 (索引名, DDL) 而不是裸 DDL 串: `_migration_guard_index` 要按名字复查
# sqlite_master, 名字**写在 DDL 旁边**比从 DDL 里 split 出来安全 (抽错了会静默把
# 「真失败」当成「已在位」放过去)。
CONTACT_V67_INDEXES = (
    (
        "idx_contact_known",
        "CREATE INDEX IF NOT EXISTS idx_contact_known "
        "ON contact(kind, is_self, hidden_at, sent_to_count DESC)",
    ),
    (
        "idx_contact_manager",
        "CREATE INDEX IF NOT EXISTS idx_contact_manager ON contact(manager_contact_id)",
    ),
    (
        "idx_contact_org",
        "CREATE INDEX IF NOT EXISTS idx_contact_org ON contact(organization)",
    ),
)


# ==================== folder_pref DDL single source (v62) ====================
# 已同步文件夹的 per-folder 配置 (图标 + 通知开关 + AI 开关)。🔴 独立成组, **不进**
# MATTER_*_DDLS / CONTACT_*_DDLS —— 理由同 CONTACT_TABLE_DDLS 头注: 那两组会被各自
# 域的多个迁移块对老库整组重放, 混进去就等于给 v44..v61 每一个中间版本加一个新的
# 炸点。本组只从 v62 块执行一次 (新库走满梯子同样经 v62 拿到)。
#
# 🔴 **顺序不进这张表** (owner 2026-08-19 拍板)。`SYNC_FOLDERS` 的**数组序**刚在
# commit 7ec4b554 升格为「用户自定义显示顺序」, 而它同时是「哪些文件夹要同步」的
# 成员表 —— 一个数组同时承载成员与顺序, 且被 Electron 主进程与远程 web 共读同一份
# `.env`。folder_pref 再存一列 sort_order 就是同一个事实存两处, 两个 writer
# (PUT /folder/whitelist 写 .env vs 本表写 DB) 迟早对不上, 且没有哪一侧能当权威。
# 边界因此划死: **成员 + 顺序归 SYNC_FOLDERS 数组; 本表只管 icon + 两个开关**。
# 想统一的话正确方向是「顺序整个搬进 DB、SYNC_FOLDERS 退回纯白名单」——那是另一个
# 决定, 需要同时改 .env 消费侧与远程 web, 不是在这里加一列。
#
# 列语义 (🔴 两个开关的极性与缺省**相反**, 抄自 new_watcher 的两个 gate):
#   imap_name      PK = IMAP 原始名 (modified-UTF7, 如 `DMS&VvpO9lPRXgM-`)。**不是**
#                  显示名 —— 显示名会撞 (不同父目录下可以各有一个 `Archive`), 且与
#                  SYNC_FOLDERS 白名单同一把钥匙。
#   mailbox_label  = decode_imap_utf7(imap_name), 即 `email_metadata.mailbox` 的值。
#                  **派生列**, 唯一写入点是 _folder_pref_label() —— 存它是因为运行时
#                  gate 手里只有 mailbox 显示名, 反向 encode 回 imap_name 要赌
#                  encode(decode(x)) == x (非规范编码下不成立)。带索引供热读。
#   icon           lucide kebab 短串 (如 `folder-check`)。**后端当不透明短串存**,
#                  不做枚举校验 —— 可选集是纯前端词汇, 抄到 Python 就多一处跨语言
#                  镜像、按仓规还得再建一道一致性闸; 认不出的值前端已有兜底。
#                  NULL = 没设过 (与「设成某个值」区分)。
#   notify_enabled 白名单 opt-in, 缺省 **0 = 不推飞书** (对齐 FOLDER_NOTIFY_ENABLED)。
#   llm_disabled   黑名单 opt-out, 缺省 **0 = 跑 LLM** (对齐 FOLDER_LLM_DISABLED)。
#                  🔴 与 UI 的「AI 分类」开关**反向**: UI 开 = llm_disabled 0。
FOLDER_PREF_TABLE_DDLS = (
    """CREATE TABLE IF NOT EXISTS folder_pref (
        imap_name TEXT PRIMARY KEY,
        mailbox_label TEXT NOT NULL,
        icon TEXT NULL,
        notify_enabled INTEGER NOT NULL DEFAULT 0,
        llm_disabled INTEGER NOT NULL DEFAULT 0,
        updated_at REAL NOT NULL DEFAULT 0
    )""",
)

FOLDER_PREF_INDEX_DDLS = (
    # 热读入口: gate 手里只有 mailbox 显示名 (见 mailbox_label 列注)。
    "CREATE INDEX IF NOT EXISTS idx_folder_pref_label ON folder_pref(mailbox_label)",
)


# ==================== Contact governance suggestion DDL (v64) ====================
# 独立于 v54 CONTACT_TABLE_DDLS：v55-v63 老库必须在 v64 梯子拿到本表；塞进
# v54 组会让表的版本归属错位，并让中间版本升级路径漏建。
CONTACT_SUGGESTION_TABLE_DDLS = (
    f"""CREATE TABLE IF NOT EXISTS contact_suggestion (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type {sql_check_clause(CONTACT_SUGGESTION_TYPE_VALUES)}),
        contact_ids_json TEXT NOT NULL CHECK (json_valid(contact_ids_json)),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
        evidence_fingerprint TEXT NOT NULL,
        confidence REAL NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status {sql_check_clause(CONTACT_SUGGESTION_STATUS_VALUES)}),
        block_reason TEXT NULL,
        created_at INTEGER NOT NULL,
        decided_at INTEGER NULL
    )""",
)
CONTACT_SUGGESTION_INDEX_DDLS = (
    "CREATE INDEX IF NOT EXISTS idx_contact_suggestion_status_created "
    "ON contact_suggestion(status, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_contact_suggestion_evidence_fingerprint "
    "ON contact_suggestion(evidence_fingerprint)",
)


# ==================== Notification center DDL (v68) ====================
# 统一通知中心的持久化条目表 (task 08-20-notification-center, design §2)。
# 🔴 独立成组, **不进** MATTER_TABLE_DDLS / MATTER_INDEX_DDLS / CONTACT_*_DDLS ——
# 那几组会被各自域的多个旧迁移块 (v44/v45/v46/v49/v50/v54/v64 …) 对老库整组重放,
# 且 MATTER_TABLE_DDLS 还有下标依赖 (v45 块按 [2]/[3] 取用); 混进去等于给
# v44..v67 每一个中间版本各加一个新炸点。本组只从 v68 块执行一次 (新库走满迁移
# 梯子同样经 v68 拿到) —— v52 索引教训的直接应用。
# CHECK 值域经 sql_check_clause 引自 src/notify/center_models.py (零依赖叶子,
# 枚举唯一权威), 不手抄字符串。
#
# 列语义 (完整表在 design §2.3):
#   dedupe_key    去重键, 各信源自定 (如 `agent_run:{job_id}`)。**活跃期内唯一**,
#                 重复触发走计次 (recurrence_no+1) 而不是刷屏开新行。
#   recurrence_no 第几次。跨代续接: resolved 之后再来会开新行, 计数从上一代 +1。
#   state         open/snoozed/resolved/dismissed。🔴 **已读是独立轴 read_at**,
#                 不是 state 的一个值 —— 「看过了」与「处理完了」分开 (PRD 基线 2)。
#   snoozed_until 毫秒。到期唤醒是**读侧口径** (state='snoozed' 且已过期视同 open,
#                 见 design §8.d), 没有后台 tick 会把 state 改回 open。
#   *_at          全部毫秒整数 (clock_ms 注入, 同 matters), **不是** time.time() 秒。
NOTIFICATION_TABLE_DDLS = (
    f"""CREATE TABLE IF NOT EXISTS notification (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK (category {sql_check_clause(NOTIFICATION_CATEGORY_VALUES)}),
        source TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info' CHECK (severity {sql_check_clause(NOTIFICATION_SEVERITY_VALUES)}),
        state TEXT NOT NULL DEFAULT 'open' CHECK (state {sql_check_clause(NOTIFICATION_STATE_VALUES)}),
        dedupe_key TEXT NOT NULL,
        recurrence_no INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        payload_json TEXT NULL CHECK (payload_json IS NULL OR json_valid(payload_json)),
        first_created_at INTEGER NOT NULL,
        last_event_at INTEGER NOT NULL,
        read_at INTEGER NULL,
        snoozed_until INTEGER NULL,
        resolved_at INTEGER NULL,
        dismissed_at INTEGER NULL
    )""",
)

NOTIFICATION_INDEX_DDLS = (
    # 去重的数据库最终防线: 同 dedupe_key 同时最多一条活跃行。🔴 partial 条件里的
    # 「活跃」口径必须与 publish 的判据**逐字一致** (照抄 uq_matter_attention_active)。
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_active_dedupe "
    "ON notification(dedupe_key) WHERE state IN ('open','snoozed')",
    # 列表面: tab 过滤 + 时间排序。
    "CREATE INDEX IF NOT EXISTS idx_notification_list "
    "ON notification(category, state, last_event_at)",
    # 未读数: partial index 只覆盖未读活跃行 (铃铛徽标是最高频读)。
    "CREATE INDEX IF NOT EXISTS idx_notification_unread "
    "ON notification(category) WHERE read_at IS NULL AND state IN ('open','snoozed')",
)


# ==================== matter_progress DDL (v70) ====================
# curated 进展条目 (task 08-25-matter-progress-curated, design §1)。「进展」从
# `matter_event` 的降级映射换成独立的 curated lane: 目标 / 里程碑 / 关键进展 / 关键信号 /
# 决议, 由用户与 Agent 共同维护; 操作日志继承原来那套按天分组的呈现, 数据面一字不动。
#
# 🔴 独立成组, **不进** MATTER_TABLE_DDLS / MATTER_INDEX_DDLS —— 那两组会被 v44/v45/
# v46/v49/v50 各块对老库整组重放, 且 MATTER_TABLE_DDLS 还有下标依赖 (v45 块按 [2]/[3]
# 取用)。混进去 = 给 v44..v69 每一个中间版本各加一个新炸点 (v52 索引教训)。本组只从
# v70 块执行一次, 新库走满迁移梯子同样经 v70 拿到。
#
# 列语义:
#   kind        五类叙事词表, CHECK 引 `src/matters/models.py::MatterProgressKind` 单源。
#               🔴 与 matter_item 的 milestone / decision 同名不同物 (见该枚举 docstring)。
#   title       一句话主句 (「Simon 回邮确认 Q4 预算」)。非空是硬约束 —— 一条没有主句的
#               进展在时间轴上就是一个读不懂的点。
#   body        可选展开正文。
#   happened_at **叙事**时间 (这件事什么时候发生), 与 created_at (什么时候被记下来) 是两
#               回事: 补记上周的进展时两者相差好几天, 合成一列就没法按事情发生的顺序读。
#               🔴 epoch **毫秒** (matters 域全域单位, §2.2 三道门), 秒值恒拒不换算。
#   source      与 matter_event.source 同词表 (自由文本, 无 CHECK)。
#   refs_json   证据链, `[{"type": ...}]`。归一走 models.normalize_progress_refs (有意宽松)。
#   deleted_at  软删 —— undo 路径与 matter_item 同形 (删了还能恢复, 事件里留得下痕迹)。
MATTER_PROGRESS_TABLE_DDLS = (
    f"""CREATE TABLE IF NOT EXISTS matter_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind {sql_check_clause(MatterProgressKind)}),
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        body TEXT NULL,
        happened_at INTEGER NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind {sql_check_clause(MatterActorKind)}),
        actor_id TEXT NULL,
        source TEXT NOT NULL,
        refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(refs_json)),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        deleted_at INTEGER NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )""",
)

MATTER_PROGRESS_INDEX_DDLS = (
    # 唯一读面: 「某事项的进展, 按叙事时间倒序」。id DESC 是同毫秒内的稳定次序 ——
    # 一次导入补记多条时没有它, 两次读的顺序可能不一样。
    "CREATE INDEX IF NOT EXISTS idx_matter_progress_live "
    "ON matter_progress(matter_id, happened_at DESC, id DESC) WHERE deleted_at IS NULL",
)


# ============ matter_item_dispatch DDL (v71) ============
# 行动项执行契约 (task 08-25-l4-batch3-item-execution-contract, design §1.1)。派发 = 把一条
# 行动项交给一个执行器 (现阶段恒 agent) 跑一轮 headless run, 状态机由服务端 CAS 推进。
#
# 🔴 为什么是**新表**而不是给 matter_item 加执行状态列: matter_item 有一条表级 CHECK
# 「非 action 的 kind 上述业务列必须全 NULL」, 而 SQLite 改不了 CHECK —— 往里加执行态列要
# 重建整张表。派发史本来也该逐行留下 (一条行动项可以派很多轮), 与 matter_run 同构:
# 执行行独立于工作对象。matter_item 只加一列 `exec_profile` (additive, 不进那条 CHECK 名单)。
#
# 🔴 独立成组, **不进** MATTER_TABLE_DDLS / MATTER_INDEX_DDLS —— 那两组会被 v44/v45/v46/
# v49/v50 各块对老库整组重放, 且 MATTER_TABLE_DDLS 还有下标依赖 (v45 块按 [2]/[3] 取用);
# 混进去 = 给 v44..v70 每一个中间版本各加一个新炸点 (v52 索引教训)。范式抄 v70 matter_progress。
#
# 列语义:
#   state          七值执行态, CHECK 引 `models.MatterItemDispatchState` 单源。与业务态
#                  (`matter_item.status`) 分两列, 理由见该枚举 docstring。
#   executor_kind  现在恒 'agent'; 'user' 是 R6 的语义预留, 加它的那一批同时接流程。
#   executor_id    'matter_followup' (内建跟进 Agent) 或某个 custom agent 的 report_agent.id。
#   exec_profile   **派发时从 item 冻结**的执行档 (抄审批 stash 冻结 contextMode 的先例):
#                  owner 中途改了 item 的默认档, 已经在跑的这一轮仍按派发时那档结算。
#   question_json  当前这一问 (`{question, options?}`); 回答后清空。
#   answers_json   问答史 `[{question, answer, at}]`, 多轮反问逐条追加 —— 下一轮 run 的
#                  prompt 要把它全带上, 否则 agent 会把同一个问题再问一遍。
#   update_id      交付落成的提案 (`matter_update.id`)。🔴 **不加 FK**: matter_update 属
#                  MATTER_TABLE_DDLS 那一组 (会被老块重放), 跨组建 FK 会让老库的重放顺序
#                  变成一个新的约束面 —— 抄 matter_run.async_job_id 的先例 (同样无 FK)。
#   async_job_id   当前 / 最近一轮 run 的 async_jobs 行 (孤儿收敛靠它 JOIN)。
#   attempt_count  第几轮 (派发 = 1, 每次回答 +1)。同时是 job 幂等键的组成部分。
#   ended_at       **终态判据**: done / failed / canceled 三态写它。partial unique 只拦
#                  `ended_at IS NULL` 的行 ⇒ 终态后同一条行动项可以再派。
#   全部时间列是 epoch **毫秒** (matters 域全域单位, 三道门 fail-closed, 秒值恒拒)。
MATTER_ITEM_DISPATCH_TABLE_DDLS = (
    f"""CREATE TABLE IF NOT EXISTS matter_item_dispatch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES matter_item(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state {sql_check_clause(MatterItemDispatchState)}),
        executor_kind TEXT NOT NULL CHECK (executor_kind {sql_check_clause(MATTER_ITEM_EXECUTOR_KINDS)}),
        executor_id TEXT NOT NULL CHECK (length(trim(executor_id)) > 0),
        exec_profile TEXT NOT NULL CHECK (exec_profile {sql_check_clause(MatterItemExecProfile)}),
        question_json TEXT NULL CHECK (question_json IS NULL OR json_valid(question_json)),
        answers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(answers_json)),
        update_id INTEGER NULL,
        async_job_id INTEGER NULL,
        attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
        error_json TEXT NULL CHECK (error_json IS NULL OR json_valid(error_json)),
        idempotency_key TEXT NULL,
        created_by_kind TEXT NOT NULL CHECK (created_by_kind {sql_check_clause(MatterActorKind)}),
        created_by_id TEXT NULL,
        dispatched_at INTEGER NOT NULL,
        awaiting_since INTEGER NULL,
        delivered_at INTEGER NULL,
        ended_at INTEGER NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )""",
)

MATTER_ITEM_DISPATCH_INDEX_DDLS = (
    # 一条行动项同时只允许一个活跃派发 —— 数据库最终防线 (service 的存在性检查撞它 →
    # E_DISPATCH_ACTIVE)。终态行 ended_at 非空, 不占坑。
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_item_dispatch_one_active "
    "ON matter_item_dispatch(item_id) WHERE ended_at IS NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_item_dispatch_idem "
    "ON matter_item_dispatch(idempotency_key) WHERE idempotency_key IS NOT NULL",
    # 跨事项读面:「现在有哪些派发在等我 / 挂了」(/today 例外面的第四源)。
    # 🔴 **不加** `WHERE ended_at IS NULL`: `failed` 本身就是终态 (写了 ended_at), 加了
    # 那句话这个索引就服务不了例外面最要紧的那一半 —— 挂掉的派发。
    "CREATE INDEX IF NOT EXISTS idx_item_dispatch_state "
    "ON matter_item_dispatch(state, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_item_dispatch_matter "
    "ON matter_item_dispatch(matter_id, id)",
)

# 提案 → 派发的回钩索引 (accept/reject 时按它把 dispatch 结算成 done / canceled)。
# 🔴 与 MATTER_STAKEHOLDER_CONTACT_INDEX_DDL 同一条理由**不进** MATTER_INDEX_DDLS:
# `matter_update.item_dispatch_id` 列要到 v71 的 ALTER 才存在, 放进那组会把 v45..v70 老库
# 的升级梯子当场炸掉 ("no such column")。只能在 v71 块 (ALTER 之后) 建。
MATTER_UPDATE_ITEM_DISPATCH_INDEX_DDL = (
    "CREATE INDEX IF NOT EXISTS idx_matter_update_item_dispatch "
    "ON matter_update(item_dispatch_id) WHERE item_dispatch_id IS NOT NULL"
)


# ==================== agent_run_log / agent_run_step DDL (v73) ====================
# 统一 agent 执行台账 (task 08-27-l4-tab-workspace P4a, research/r10 §4.2)。不走 gateway
# 的成员 (报告 / 联系人画像 / 项目周报) 没有 session transcript, 详细过程记录落这里:
# 一次执行 = agent_run_log 一行, 一个节点 = agent_run_step 一行, 前端把步骤合成与会话
# 同形态的 transcript (design §8.1 的 trig/think/tool/out 四类节点)。
#
# 🔴 独立成组, **不进** CONTACT_TABLE_DDLS / MATTER_* / CONTACT_SUGGESTION_* 任何老组
# —— 那几组会被 v54 / v63 / v64 等旧块对老库整组重放, 混进去等于给每一个中间版本各加
# 一个新炸点 (v52 索引教训)。本组只从 v73 块执行一次 (新库走满迁移梯子同样经 v73 拿到)。
#
# 列语义:
#   agent_id      report_agent.id 命名空间 (run_sources.py 那套; 画像=contact_profile_agent,
#                 周报=project_progress_sync, 报告=daily_email_digest 等)。🔴 事项域的
#                 `matter:` / `matter_item:` 命名空间恒不写进来 (团队页排除纪律)。
#   status        `src.agents.run_state.AGENT_RUN_STATES` 9 值域的**子集** (CHECK 引
#                 `src.agents.run_log.AGENT_RUN_LOG_STATUS_VALUES`, 不发明词表 ——
#                 前端 RunStateBadge 零映射直接吃)。
#   kind          trig|think|tool|out (design §8.1 定死)。🔴 词表保留 think 是给未来开
#                 extended thinking 留位 —— 本批任何写入方都不写 think 行 (Python 腿
#                 没开 thinking, 没有数据就不造思考块)。
#   payload_json  tool: {input, output_preview} / out: {report_id,...}; 解析后经 steps
#                 端点透出, 坏 JSON 读侧落 None。
#   ok            1|0|NULL; 0 → 前端标 ✗ + fail 色。
#   *_at          epoch **毫秒** (对齐 ai_chat_sessions / v72 惯例)。🔴 与 async_jobs 的
#                 time.time() **秒**不是一回事 —— 投影成 run 历史行时在 API 边界换算
#                 (`agent_runs._run_log_item`), 表内不留两种单位。
AGENT_RUN_LOG_TABLE_DDLS = (
    f"""CREATE TABLE IF NOT EXISTS agent_run_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NULL,
        status TEXT NOT NULL CHECK (status {sql_check_clause(AGENT_RUN_LOG_STATUS_VALUES)}),
        trigger_kind TEXT NULL,
        trigger_detail TEXT NULL,
        summary TEXT NULL,
        model TEXT NULL,
        input_tokens INTEGER NULL,
        output_tokens INTEGER NULL,
        error TEXT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS agent_run_step (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES agent_run_log(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind {sql_check_clause(AGENT_RUN_STEP_KINDS)}),
        name TEXT NULL,
        detail TEXT NULL,
        payload_json TEXT NULL,
        ok INTEGER NULL,
        ms INTEGER NULL,
        created_at INTEGER NOT NULL
    )""",
)

AGENT_RUN_LOG_INDEX_DDLS = (
    # 读面①: 某成员「最近 N 次, 倒序」。id DESC 是同毫秒内的稳定次序。
    "CREATE INDEX IF NOT EXISTS idx_agent_run_log_recent "
    "ON agent_run_log(agent_id, started_at DESC, id DESC)",
    # 读面②: 一次执行的步骤按 seq 取 (稳定次序, 同毫秒不靠 id)。
    "CREATE INDEX IF NOT EXISTS idx_agent_run_step "
    "ON agent_run_step(run_id, seq)",
)


#: ``upsert_folder_pref`` 的"这个字段不改"哨兵。不能用 ``None`` —— ``icon=None`` 是
#: **合法值** (清除图标, 回到前端兜底), 与"不改"必须分得开。
_UNSET: Any = object()


class FolderGates(NamedTuple):
    """一个文件夹的两个运行时开关 (``SyncStore.get_folder_gates`` 的返回)。

    ``row_exists=False`` = folder_pref 里没有这个文件夹的行 → caller **回退 env
    frozenset** (`FOLDER_NOTIFY_ENABLED` / `FOLDER_LLM_DISABLED`), 与 v31
    project_progress 行热读的 ``row_exists`` 回退语义同构。

    🔴 这两个字段的缺省值不是"关掉两个功能", 而是各自 gate 的**原有缺省**:
    notify_enabled=False → 自定义文件夹不推飞书 (白名单未 opt-in);
    llm_disabled=False → 自定义文件夹照跑 LLM (黑名单未 opt-out)。
    """

    row_exists: bool = False
    notify_enabled: bool = False
    llm_disabled: bool = False


# ==================== kos_ingest_log DDL 单源 (v41, issue #59) ====================
# 🔴 唯一权威 DDL —— 三个消费方共用, 改列/索引只动这里:
#   ① SyncStore._init_database_impl (v41 起版本化建表, 无条件幂等 —— 主路径;
#      D2: schema 与 MAILAGENT_KOS_INGEST_ENABLED 解耦, 开关翻转时 DB 版本一致);
#   ② src/kos/bulk_ingest.py KOSBulkIngester._ensure_log_table (幂等双保险,
#      bulk 可对任意 --db-path 独立跑, 那个库未必被 SyncStore 迁移过);
#   ③ src/kos/ingest_log.py 台账读写 (假设 schema 已就位, 不自建)。
# import 方向必须是 kos → mail (bulk_ingest 已依赖 src.repository → src.mail.*),
# sync_store 反向 import src.kos 会拖进 producer/client (httpx) 依赖链。
#
# status 值域 (跨 lane 契约, 见 .trellis/tasks/07-25-kos-issue-59-llm-dashboard/prd.md R1):
#   pushed  — put_page 成功
#   failed  — 瞬时失败, 等待重试扫描 (next_retry_at 排程)
#   dead    — 超重试上限 / 永久类错误码 (需人工介入, 手动 bulk --retry-failed 可捞)
#   skipped — priority floor / 未标注 / 未配置 / dry-run 过滤 (与失败区分)
#   pending — 等 LLM 标签就位后由重试扫描首推 (issue #64 Lane A deferred first-push,
#             分钟级瞬态; retry_count 在此状态下 = 已检查轮数)
KOS_INGEST_LOG_TABLE_DDL = """
    CREATE TABLE IF NOT EXISTS kos_ingest_log (
        internal_id INTEGER PRIMARY KEY,
        slug TEXT,
        status TEXT,
        chunks INTEGER,
        error TEXT,
        pushed_at REAL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at REAL,
        error_code TEXT,
        source TEXT
    )
"""
# 老库该表可能已被 bulk_ingest 惰性建成 6 列旧形状 → ALTER 补列 (PRAGMA 判断后幂等)。
KOS_INGEST_LOG_RETRY_COLUMNS = {
    "retry_count": "INTEGER NOT NULL DEFAULT 0",
    "next_retry_at": "REAL",
    "error_code": "TEXT",
    "source": "TEXT",
}
# 重试扫描的调度索引 (status='failed' AND next_retry_at <= now)。
KOS_INGEST_LOG_INDEX_DDL = (
    "CREATE INDEX IF NOT EXISTS idx_kos_ingest_retry "
    "ON kos_ingest_log(status, next_retry_at) WHERE status='failed'"
)


def ensure_kos_ingest_log_schema(cursor) -> None:
    """kos_ingest_log 建表 + 补列 + 建索引, 全幂等 (v41 migration 与 bulk 双入口共用)。

    顺序敏感: 索引引用 next_retry_at, 必须先补列再建索引 (老库旧形状缺该列时
    先建索引会 no such column)。
    """
    cursor.execute(KOS_INGEST_LOG_TABLE_DDL)
    cols = {row[1] for row in cursor.execute("PRAGMA table_info(kos_ingest_log)").fetchall()}
    for _col, _typ in KOS_INGEST_LOG_RETRY_COLUMNS.items():
        if _col not in cols:
            cursor.execute(f"ALTER TABLE kos_ingest_log ADD COLUMN {_col} {_typ}")
            logger.info(f"kos_ingest_log schema: +{_col}")
    cursor.execute(KOS_INGEST_LOG_INDEX_DDL)


class UpdateAfterFetchResult(Enum):
    """``update_after_fetch`` 的结果三态（2026-07-14 幽灵行事故后引入）。

    老实现返回 bool 且三个调用点都不看返回值 —— message_id 撞 UNIQUE 被静默吞掉,
    是幽灵行永久卡死的病根之一。调用方必须区分 DUPLICATE(中止本封) 与 FAILED。

    OK: 元数据已写入。
    DUPLICATE: 目标 message_id 已被另一条 **已 synced** 的行(真身)占用 → 当前行是
        重复行(幽灵行), 已被 **物理删除**(CASCADE 清 body/attachment/outbox, 见
        _resolve_message_id_conflict)。调用方必须中止本封邮件的后续同步(行已不存在)。
    FAILED: 写入失败 —— DB 错误, 或 message_id 撞上一条 **未** synced 的行(无法判定
        谁是真身 → 按铁律谁都不动, 留人工处置)。调用方不得静默吞掉。
    """

    OK = 'ok'
    DUPLICATE = 'duplicate'
    FAILED = 'failed'


def _local_tz():
    """返回 IANA ``ZoneInfo`` (含 DST 规则). 优先 /etc/localtime 软链, fallback fixed offset.

    mail.app SQLite radar 用 ``datetime(ts, 'unixepoch', 'localtime')`` 转 Unix
    timestamp 成本地 naive 字符串 — 跟 mail.app GUI 显示给用户的时间一致. 关键是同一封
    邮件在不同月份 (DST vs 标准时间) tz 偏移不同, 不能用 ``datetime.now().astimezone()``
    硬拿当前 offset (会让所有历史邮件用今天的 DST 状态, 跨边界时错 1h).

    用 ``zoneinfo.ZoneInfo("America/Los_Angeles")`` 这种 IANA zone 自动按每个 datetime
    的具体日期决定 PDT (-07) / PST (-08).
    """
    try:
        from zoneinfo import ZoneInfo
        import os
        import re
        # macOS /etc/localtime -> /var/db/timezone/zoneinfo/America/Los_Angeles
        link = os.readlink("/etc/localtime")
        m = re.search(r"zoneinfo/(.+)$", link)
        if m:
            return ZoneInfo(m.group(1))
    except Exception:
        pass
    # Fallback: 当前时刻的固定 offset (跨 DST 边界时 ~1h 误差)
    return datetime.now().astimezone().tzinfo or timezone.utc


def _storage_message_id(value: Optional[str]) -> Optional[str]:
    """持久化边界: 空 / 纯空白 message_id 一律归一为 ``None``, **绝不写空字符串**.

    🔴 2026-08-11 事故 (davmail 丢邮件调查中经 codex review 发现的第三个 bug):
    ``message_id`` 列是 ``TEXT UNIQUE``, 而两条写入路径都是 ``INSERT OR REPLACE``
    (``_save_email_v3`` / ``save_emails_batch``)。davmail 侧
    ``_normalize_message_id`` 把缺失的 Message-ID 归一成 **空字符串** 而非 None,
    于是:

    1. 空串在 merge guard 的 ``if message_id:`` 门前 falsy → 跳过 merge 保护;
    2. 落到 ``INSERT OR REPLACE`` 时撞 UNIQUE('') → SQLite **删掉冲突的老行**再插新行;
    3. **不抛异常**, ``save_email`` 返回 ``True``。

    结果是**老邮件整行被静默删除** (连 ``notion_page_id`` 一起 → Notion 端孤儿页),
    而不是新邮件写失败 —— 所以「检查 save_email 返回值」这类修法拦不住它。
    实测: 空串两封后库里只剩第二封; NULL 两封则共存 (SQLite UNIQUE 允许多个 NULL)。

    ⚠️ 归一放在**持久化边界**而非各产出点: 产出点有 davmail batch parser /
    header parser / imap_folder_reader 等多处 (其中两处已各自 ``or None``,
    两处没有), 只在边界收口才能覆盖未来新增的调用方。
    """
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _normalize_date_received_iso(value: Optional[str]) -> Optional[str]:
    """把 date_received 归一成 ISO 8601 (UTC 偏移) 字符串.

    输入支持:
    - 已是 ISO with tz: ``2026-05-22T14:30:00+08:00`` → ``2026-05-22T06:30:00+00:00``
    - ISO naive: ``2026-01-27T23:01:25`` → 按系统本地 tz 解释后转 UTC
    - space-separated naive (mail.app SQLite radar 用 ``datetime(ts, 'unixepoch',
      'localtime')`` 输出, 是**系统本地 tz** naive): ``2026-05-19 04:23:53`` →
      按本地 tz (含 DST) 解释后转 UTC
    - RFC 822 (旧 davmail 兜底): ``Fri, 22 May 2026 14:30:00 +0800`` → ISO 8601 UTC
    - 空 / 解析失败: 原样返回 (上层别 break)

    Sprint 16 cutover: ``_local_tz()`` 动态拿系统 tz 而非硬编码 ``+08:00`` —
    上一版本 hard-code 北京时区导致 PDT 用户的 5148 行被标错 tz.

    07-07 排序 tz 归一: 统一 ``astimezone(utc)`` — 排序全链路是词法字符串比较
    (SQL TEXT ORDER BY + localeCompare), 保留原始/本地偏移会让 ``10:54+08:00``
    字典序压过 ``05:58+00:00``。davmail 侧 ``_normalize_date_iso`` 同口径;
    不同改会在应急回切 AppleScript 时重新混入非 UTC 偏移行。

    ⚠️ 归一放在**持久化边界**而非各产出点 (同 ``_storage_message_id`` 纪律)。
    ``email_metadata.date_received`` 只有三条写入边界, 三条都过本函数::

        _save_email_v3      — 单封 INSERT OR REPLACE (正向 sync / 草稿镜像 / 对账)
        save_emails_batch   — initial_sync 的 executemany 批量写
        update_after_fetch  — 动态 SET (date_received 在 allowed_fields 里)

    存量收敛 (老版本写进来的非 UTC 行) 走
    ``mailagent admin repair-date-tz`` / ``src.cleanup.date_received``。
    """
    if not value:
        return value
    s = value.strip()
    if not s:
        return value
    local_tz = _local_tz()
    # 已是 ISO with tz (T 加 +HH:MM / -HH:MM / Z) → 同一绝对时刻, 偏移表示归一 UTC
    if "T" in s and (s.endswith("Z") or "+" in s[10:] or "-" in s[10:]):
        try:
            return datetime.fromisoformat(s).astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError):
            return s
    # ISO naive: 2026-01-27T23:01:25
    if "T" in s and len(s) >= 19:
        try:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                # 加 system tz (含 DST 自动识别)
                dt = dt.replace(tzinfo=local_tz)
                # 但 Python tzinfo 加上去不一定带 DST, 用 astimezone re-resolve 一次
                dt = dt.astimezone(local_tz)
            return dt.astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError):
            pass
    # space-separated: 2026-05-19 04:23:53
    if " " in s and len(s) >= 19 and s[10] == " ":
        try:
            dt = datetime.fromisoformat(s.replace(" ", "T", 1))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=local_tz)
                dt = dt.astimezone(local_tz)
            return dt.astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError):
            pass
    # RFC 822 fallback (e.g. davmail 早期 path / 万一漏掉 normalize)
    try:
        dt = parsedate_to_datetime(s)
        if dt is None:
            return value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=local_tz)
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return value


#: v58 回填的分块大小 (keyset 分页 + executemany)。
SENDER_EMAIL_BACKFILL_CHUNK = 2000


def _backfill_sender_email(cursor) -> int:
    """v58: 给存量行补 ``sender_email``。返回真正写了值的行数。

    幂等: 判据是 ``sender_email IS NULL``, 已回填的行不再进候选; 重入接着上次没做完
    的部分做, 结果与一次跑完一致。派生失败 (返回 None) 的行**不写**, 于是它们每次
    重入都会被重新扫一遍 —— 代价是纯 CPU (无 UPDATE), 换来"以后修好派生器再跑一次
    就能补上"的性质。

    🔴 **keyset 分页 (``internal_id > ?``) 而不是 ``WHERE sender_email IS NULL LIMIT``**:
    后者对「派生结果为 None 的行」永远不推进 → 死循环。

    🔴 分块是为了**有界内存 + 批量 UPDATE** (executemany), **不**在块间 commit:
    整条迁移梯子是单事务 (半程失败随连接回收 ROLLBACK、db_version 停在旧值下次重跑),
    中途 commit 会把前面几块尚未落 version 的 DDL 一并提交。启动耗时的大头是逐行
    Python 解析 + 逐行 UPDATE, executemany 分块已经把它压掉 (活库 13014 行秒级)。
    """
    written = 0
    last_id = -1
    while True:
        rows = cursor.execute(
            "SELECT internal_id, sender FROM email_metadata "
            "WHERE internal_id > ? AND sender_email IS NULL "
            "ORDER BY internal_id LIMIT ?",
            (last_id, SENDER_EMAIL_BACKFILL_CHUNK),
        ).fetchall()
        if not rows:
            break
        last_id = rows[-1][0]
        updates = [
            (email, row[0])
            for row in rows
            if (email := derive_sender_email(row[1])) is not None
        ]
        if updates:
            cursor.executemany(
                "UPDATE email_metadata SET sender_email = ? WHERE internal_id = ?",
                updates,
            )
            written += len(updates)
        if len(rows) < SENDER_EMAIL_BACKFILL_CHUNK:
            break
    return written


#: v61 迁移认得的两个段落小标题 (行首整行, 允许行尾空白)。
#: 只有 2026-08-18 那一版 UI (存活约两小时, 见 DB_VERSION v61 注记) 写出过这种形状。
_V61_HEADINGS = {"## 背景": "background", "## 目标": "goal"}


def split_legacy_matter_description(text: str) -> tuple[str, str]:
    """v61: 老 ``matter.description`` 整串 → ``(background, goal)``。

    规则 (owner 裁决): **默认全部算背景**, 目标留空。唯一例外是那一版短命 UI 写出的
    ``## 背景`` / ``## 目标`` 小标题形状 —— 那种行首整行小标题按段拆开, 否则会把两段
    连着标题一起塞进背景。小标题之前的散文归背景 (它本来就是交代来龙去脉的)。

    🔴 幂等: 拆完两侧都不再含小标题 ⇒ 再跑一次落进"无小标题"分支、
    ``(background, '')`` 原样返回。调用侧另有 ``goal = ''`` 的前置条件兜底。
    """
    sections: dict[str, list[str]] = {"background": [], "goal": []}
    current = "background"
    buffer: list[str] = []
    saw_heading = False

    def flush() -> None:
        nonlocal buffer
        if buffer:
            sections[current].append("\n".join(buffer))
        buffer = []

    for line in (text or "").split("\n"):
        heading = _V61_HEADINGS.get(line.rstrip())
        if heading is None:
            buffer.append(line)
            continue
        flush()
        saw_heading = True
        current = heading
    flush()

    if not saw_heading:
        return text or "", ""
    return (
        "\n\n".join(chunk.strip() for chunk in sections["background"] if chunk.strip()),
        "\n\n".join(chunk.strip() for chunk in sections["goal"] if chunk.strip()),
    )


class SyncStoreMigrationError(RuntimeError):
    """数据库迁移真失败 / 版本不兼容 (E0-WP3 迁移守卫)。

    抛出场景:
    1. ALTER/索引迁移块的 except 分支复查发现目标对象仍缺失 (真失败, 非「列已存在」)
       —— 中断 _init_database, **不写 db_version**, 下次启动自动重试;
    2. 降级守卫: 库里的 db_version > 代码 DB_VERSION (库来自更新版本的 app),
       拒绝启动防旧代码静默降级新库。
    调用方 (src/service.py EmailNotionSyncApp.__init__) 捕获后 fail-fast 退出。
    """



def _folder_pref_seed_rows() -> list:
    """v62 播种源: 两个 env 键 (mailbox **显示名**) → folder_pref 行 (imap **原始名** PK)。

    返回 ``[(imap_name, mailbox_label, notify_enabled:int, llm_disabled:int), ...]``，
    **只含配置非默认的文件夹** —— 全默认的不占行, "行缺失 = 默认" 与 gate 的回退语义
    自洽 (见 SyncStore.get_folder_gates)。

    🔴 跨名字空间的那一步: `FOLDER_NOTIFY_ENABLED` / `FOLDER_LLM_DISABLED` 存的是
    `email_metadata.mailbox` 里的显示名, 而本表 PK 是 IMAP 原始名。映射**不连 IMAP**
    (迁移里发 LIST 是死路: 阻塞、要网络、davmail 没起就炸), 而是拿 `SYNC_FOLDERS` 里
    每个 imap_name 过一遍 ``decode_imap_utf7`` —— 这正是 davmail 抓完邮件写
    `email_metadata.mailbox` 时走的同一条路径 (davmail_backend `_fetch_custom_folder`
    的 ``label = decode_imap_utf7(imap_name)``), 所以映射结果与两个 gate 的匹配口径
    逐字一致, 不引入第三种名字。

    env 里有、SYNC_FOLDERS 里没有的名字**无法播种** (没有 imap_name 可当 PK), 打
    warning 列出来 —— 那些文件夹本来就没在同步, 两个 gate 也永远碰不到它们。

    🔴 极性相反, 别抄反: notify 是**白名单** (在名单里 → notify_enabled=1),
    llm 是**黑名单** (在名单里 → llm_disabled=1)。
    """
    from src.config import config as _settings
    from src.mail.backend.imap_client import parse_folder_csv_or_json
    from src.mail.backend.imap_utf7 import decode_imap_utf7

    notify_names = set(parse_folder_csv_or_json(getattr(_settings, "folder_notify_enabled", "") or ""))
    llm_names = set(parse_folder_csv_or_json(getattr(_settings, "folder_llm_disabled", "") or ""))
    if not notify_names and not llm_names:
        return []

    rows = []
    matched: set = set()
    for imap_name in parse_folder_csv_or_json(getattr(_settings, "sync_folders", "") or ""):
        if imap_name.upper() == "INBOX":
            continue  # 收件箱走主路径, 不是自定义文件夹 (两个 gate 也不管它)
        label = decode_imap_utf7(imap_name)
        notify = 1 if label in notify_names else 0
        llm_disabled = 1 if label in llm_names else 0
        matched.update({label} & (notify_names | llm_names))
        if notify or llm_disabled:
            rows.append((imap_name, label, notify, llm_disabled))

    unmapped = sorted((notify_names | llm_names) - matched)
    if unmapped:
        logger.warning(
            f"v62 migration: {unmapped} 出现在 FOLDER_NOTIFY_ENABLED / FOLDER_LLM_DISABLED "
            f"但不在 SYNC_FOLDERS 里 —— 无 imap_name 可作主键, 不播种 "
            f"(这些文件夹本来就没在同步, 两个 gate 也碰不到)"
        )
    return rows


def _migration_guard_columns(cursor, table: str, required_cols, label: str, err: Exception) -> None:
    """迁移 ALTER 块 except 分支的吞错修正 (E0-WP3)。

    历史 pattern: ``except sqlite3.OperationalError → logger.warning("skipped")``。
    因为 try 里已有 PRAGMA 预检挡掉「列已存在」, except 抓到的只会是真失败
    (disk I/O / malformed / locked …) —— 但旧代码吞掉后 db_version 照样前进, 永不重试。

    这里用 PRAGMA 复查目标列: 仍缺失 → raise SyncStoreMigrationError (中断迁移,
    version 不前进); 全部在位 → 维持旧行为 no-op warning (防御性保留, 理论上不可达)。

    注意: raise 沿栈展开时由 _init_database 外层兜底 close 连接 (事务内未 commit
    的部分随 close ROLLBACK); 版本写入在函数末尾从未执行, 下次启动以旧 version
    重跑 (各迁移块幂等, 重试安全)。
    """
    try:
        existing = {r[1] for r in cursor.execute(f"PRAGMA table_info({table})").fetchall()}
    except sqlite3.Error:
        existing = set()
    missing = sorted(set(required_cols) - existing)
    if missing:
        logger.error(
            f"{label}: ALTER 真失败, 目标列仍缺失 {missing} — 中断迁移, "
            f"db_version 不前进, 下次启动重试 ({err})"
        )
        raise SyncStoreMigrationError(
            f"{label}: columns still missing {missing} after migration failure: {err}"
        ) from err
    logger.warning(f"{label}: OperationalError 但目标列已全部在位, 按已迁移跳过 ({err})")


def _migration_guard_index(cursor, index_name: str, label: str, err: Exception) -> None:
    """迁移「建索引」块 except 分支的吞错修正 (E0-WP3), 语义同 _migration_guard_columns。

    复查 sqlite_master: 索引仍缺失 → raise (真失败, version 不前进); 已在位 → no-op warning。
    """
    try:
        row = cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name=?", (index_name,)
        ).fetchone()
    except sqlite3.Error:
        row = None
    if row is None:
        logger.error(
            f"{label}: 迁移真失败, 索引 {index_name} 仍缺失 — 中断迁移, "
            f"db_version 不前进, 下次启动重试 ({err})"
        )
        raise SyncStoreMigrationError(
            f"{label}: index {index_name} still missing after migration failure: {err}"
        ) from err
    logger.warning(f"{label}: OperationalError 但索引 {index_name} 已在位, 按已迁移跳过 ({err})")


class SyncStoreStats(TypedDict, total=False):
    """同步存储统计信息类型定义"""
    total_emails: int
    by_status: Dict[str, int]
    by_mailbox: Dict[str, int]
    pending: int
    synced: int
    failed: int
    fetch_failed: int
    dead_letter: int
    skipped: int
    failure_queue: int
    last_max_row_id: int
    last_sync_time: Optional[str]
    db_size_bytes: int
    db_size_mb: float


class EmailMetadata(TypedDict, total=False):
    """邮件元数据类型定义"""
    internal_id: int  # v3 新增：主键
    message_id: Optional[str]  # v3：UNIQUE，AppleScript 成功后填充
    thread_id: Optional[str]
    in_reply_to: Optional[str]  # v40：直接父邮件 message_id（无尖括号），KOS Thread 链接用
    subject: str
    sender: str
    sender_name: str
    to_addr: str
    cc_addr: str
    date_received: str
    mailbox: str
    is_read: int  # SQLite boolean as int
    is_flagged: int
    sync_status: str  # 'pending' | 'fetch_failed' | 'synced' | 'failed' | 'skipped' | 'dead_letter'
    notion_page_id: Optional[str]
    notion_thread_id: Optional[str]
    sync_error: Optional[str]
    retry_count: int
    next_retry_at: Optional[float]  # v3 新增：下次重试时间（合并自 sync_failures）
    created_at: float
    updated_at: float
