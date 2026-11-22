"""SyncStore versioned schema migrations (v3 through v75).

Extracted from ``src/mail/sync_store.py`` in Wave 0.
Dependencies point strictly one way: ``sync_store -> sync_store_migrations -> sync_store_schema``.
"""

import json
import sqlite3
import time
from pathlib import Path

from loguru import logger

from src.matters.models import (
    MatterItemExecProfile,
    MatterResourceSummarySource,
    MatterStakeholderTier,
    sql_check_clause,
)
from src.matters.resource_identity import MatterError, normalize_resource_key
from src.mail.sync_store_schema import (
    AGENT_RUN_LOG_INDEX_DDLS,
    AGENT_RUN_LOG_TABLE_DDLS,
    CONTACT_INDEX_DDLS,
    CONTACT_SUGGESTION_INDEX_DDLS,
    CONTACT_SUGGESTION_TABLE_DDLS,
    CONTACT_TABLE_DDLS,
    CONTACT_V67_INDEXES,
    FOLDER_PREF_INDEX_DDLS,
    FOLDER_PREF_TABLE_DDLS,
    KOS_INGEST_LOG_RETRY_COLUMNS,
    LLM_PROCESSING_INDEX_DDLS,
    LLM_PROCESSING_TABLE_DDL,
    MATTER_INDEX_DDLS,
    MATTER_ITEM_DISPATCH_INDEX_DDLS,
    MATTER_ITEM_DISPATCH_TABLE_DDLS,
    MATTER_PROGRESS_INDEX_DDLS,
    MATTER_PROGRESS_TABLE_DDLS,
    MATTER_STAKEHOLDER_CONTACT_INDEX_DDL,
    MATTER_TABLE_DDLS,
    MATTER_UPDATE_ITEM_DISPATCH_INDEX_DDL,
    NOTIFICATION_INDEX_DDLS,
    NOTIFICATION_TABLE_DDLS,
    RESOURCE_VERSION_INDEX_DDL,
    RESOURCE_VERSION_TABLE_DDL,
    SyncStoreMigrationError,
    _backfill_sender_email,
    _folder_pref_seed_rows,
    _migration_guard_columns,
    _migration_guard_index,
    ensure_kos_ingest_log_schema,
    split_legacy_matter_description,
)

# 数据库版本，用于迁移检测
# v3 (2026-01): internal_id 主键 + 合并 sync_failures
# v4 (2026-05): 新增 email_body + email_attachment（body 作为一等公民进 SQLite，SSoT 切换）
# v5 (2026-05): 新增 email_body_fts FTS5 虚表 + insert/update/delete trigger + 首次 reindex
# v6 (2026-05): 新增 cli_checkpoints (长任务 checkpoint resume) + v4_rollout_stats (R-06 持久化)
# v7 (2026-05): 新增 island_dispatch (Island-Sprint 2 ping-island 派发审计 + 14d 评估指标)
# v8 (2026-05): email_metadata 增加 is_pinned + pinned_at（前端置顶持久化，Mail.app 无此概念，
#               仅在 SQLite + CLI 暴露；主进程独占写、Electron 前端 readonly 经 CLI 子进程 toggle）
# v9 (2026-05): email_metadata 增加 is_important（邮件原生重要性，由 reader._parse_importance
#               从 Importance / X-Priority / X-MSMail-Priority header 提取；前端 ❗ 角标用）
# v11 (Sprint 16, 2026-05): listEnriched 性能优化索引 (mailbox+sync_status+date_received /
#                          is_flagged partial / email_attachment(internal_id, is_inline)).
#                          纯加索引非破坏, 老 db 重启自动 CREATE INDEX IF NOT EXISTS.
# v10 (2026-05): email_outbox 表 —— Sprint 15 SQLite SSoT inversion 的基础设施。
#                所有 mutating 操作（前端 flag / processing_status 变更、Notion webhook 反向同步）
#                以 intent 形式落库，FanoutWorker 异步派发到 Mail.app + Notion。
#                Echo prevention: source='notion_webhook' + target='notion' 被强制 silent skip
#                避免回环。详见 SPRINT15-HANDOFF.md §3.3-§3.4。
# v12 (Sprint Immersive-Translate, 2026-05): email_translation 表 —— 沉浸式翻译缓存。
#                Path A (LLM 分类顺带, source='llm_agent') + Path B (用户点翻译, source='on_demand')
#                双路径写入同一表; segments_json 形状 [{src, tgt}] 统一. 单语言 (zh) 设计,
#                internal_id PK + FK CASCADE; 重新翻译先 DELETE 再 INSERT.
#                详见 frontend/archive/2026-05/SPRINT-IMMERSIVE-TRANSLATE-HANDOFF.md.
# v13 (Sprint 16 dual-backend, 2026-05): email_metadata 加 imap_uidvalidity / imap_uid /
#                backend_origin 三列, 支持 DavMail backend (IMAP) 与 AppleScript backend
#                共存. backend_origin='applescript' → internal_id = Mail.app ROWID (<10^9);
#                backend_origin='davmail' → internal_id = sync_state['davmail_next_internal_id']
#                自增 (起点 1_000_000_000, 永不与 ROWID 冲突). 通过 allocate_davmail_internal_id()
#                atomic 分配. 详见 plan §"主键 / 邮件标识策略" 方案 D +
#                docs/archive/2026-05/dual-backend-architecture-handoff.md.
# v15 (Calendar SSoT, 2026-05): 新增 calendar_event + calendar_sync_state 两表, 把日历事件
#                落地为 SQLite SSoT (前端日历视图 / CLI / Notion mirror 单一数据源).
#                calendar_event: PK=id AUTOINCREMENT + UNIQUE(ical_uid, recurrence_id, source);
#                source 三态 (caldav / email_ics / legacy_calendar_app) 灰度共存. 时间一律存
#                UTC epoch (REAL), 前端按 toLocaleString 转本地 TZ. 详见 plan
#                §"Phase 1.1 DB 升级" + frontend-view-silly-knuth.md.
# v17 (Folder Archive/Drafts, 2026-05): 曾新增 folder_email + folder_email_fts +
#                folder_sync_state 三表 (旧 FolderSyncWorker 展示链路)。该链路实测从未
#                工作 (folder_email 0 行), 多文件夹同步 (v22) 改走 email_metadata 主链路。
#                v23 (P6 cleanup) 已 DROP 这三表 + FTS 触发器, 见下方 v23 迁移块。
# v21 (async_jobs, C1 2026-06): 新增 async_jobs 表 (长任务统一 enqueue + 执行账本) +
#                ux_async_jobs_idempotency partial unique + ix_async_jobs_status。纯加表,
#                CREATE TABLE IF NOT EXISTS 对新/旧库均生效, 无 data migration。serve 进程内
#                JobWorker (灰度 MAILAGENT_ASYNC_JOBS_ENABLED) 消费。详见 C1 看板格。
# v23 (P6 folder_sync cleanup, 2026-06): DROP folder_email + folder_email_fts +
#                folder_sync_state 三表 + FTS 触发器 (旧 FolderSyncWorker 展示链路实测从未
#                工作)。多文件夹同步走 email_metadata 主链路 (v22)。幂等 DROP IF EXISTS。
# v24 (T7 CJK trigram, 2026-06): 新增并行 contentful FTS5 表 email_body_fts_trigram
#                (tokenize='trigram') + 4 个 trigger (insert/delete/update on email_body
#                + meta_update on email_metadata) + 幂等回填。主表 email_body_fts
#                (porter unicode61) 不动 → 英文零回归。trigram 表给中文子串搜索:
#                CJK >=3 字走 MATCH, =2 字走 trigram 表 LIKE 兜底 (MATCH <3 字符无召回)。
#                灰度开关 SEARCH_TRIGRAM_ENABLED 默认 False — flag=False 时搜索仍走主表
#                unicode61 + smart_query_transform (逐字节零回归), flag=True 才启用 CJK 路由。
#                幂等: CREATE ... IF NOT EXISTS + 回填 WHERE NOT EXISTS, 重跑不重复/不报错。
#                回滚: 关 flag 即回 unicode 路径; 彻底回退见下方 v24 迁移块注释 (DROP 4 trigger
#                + DROP email_body_fts_trigram, 主表不动)。
# v25 (T8 收件人全文化, 2026-06): 新增并行 contentful FTS5 表 email_recipient_fts
#                (to_addr, cc_addr, sender_name; tokenize='porter unicode61
#                remove_diacritics 2') + 3 个 trigger (insert / update_of /
#                delete on email_metadata) + 幂等回填。数据源是 email_metadata 三列 (与
#                body_fts 来自 email_body 不同, 故 trigger 直接挂 email_metadata)。
#                新增 to~:/cc~:/from~: 三个显式 FTS 列语法才查这张表 (裸词搜索一行不碰它,
#                天然零回归 —— ②保守语义)。主表 email_body_fts 不动。无 flag (纯新增 opt-in 语法)。
#                幂等: CREATE ... IF NOT EXISTS + 3 trigger IF NOT EXISTS + 回填
#                WHERE NOT EXISTS (current_version < 25 gate)。
#                回滚 (彻底回退 v25): 三个新语法只在 parser 显式列名出现时生效, 不影响裸词;
#                必要时:
#                  DROP TRIGGER IF EXISTS email_recipient_fts_insert;
#                  DROP TRIGGER IF EXISTS email_recipient_fts_update;
#                  DROP TRIGGER IF EXISTS email_recipient_fts_delete;
#                  DROP TABLE IF EXISTS email_recipient_fts;
#                主表 email_body_fts / email_body_fts_trigram 不动 → 回滚低风险。
# v26 (agentic 搜索 = 特化 Custom Agent, 2026-06): 复用 report_agent 表 (type 多态),
#                INSERT OR IGNORE 播种一行 type='search' 的搜索 agent (id='email_search_agent',
#                enabled=1, model/prompt NULL → 运行时回退默认, tools_json='["email_search_fulltext"]')。
#                **无 DDL** —— model/prompt/tools_json 列 v18 起就有。幂等: INSERT OR IGNORE
#                重跑不重复; 无 version gate, 靠 INSERT OR IGNORE 幂等 (与既有 report-agent seed 同模式)。
#                回滚 (回退 v26): DELETE FROM report_agent WHERE id='email_search_agent';
#                必要时降 db_version 即可 (无表结构变更, 删行无副作用)。
# v27 (AI 邮件预处理 Custom Agent, 2026-07, issue #31/#32 增量2): report_agent 加
#                context_docs_json 列 (JSON 数组 of profile-doc 名, 如 ["soul","user"]) +
#                INSERT OR IGNORE 播种一行 type='preprocess' 的预处理 agent
#                (id='email_preprocess_agent')。persona 复用 prompt 列、文档勾选存新列；
#                开关/模型走全局 env (LLM_AGENT_ENABLED/LLM_MODEL), 运行时对 persona/docs
#                NULL-safe 叠加 (不填=字节级回退现状)。ALTER 必须先于 seed (seed 引用新列)。
#                幂等: ALTER 前 PRAGMA 检查 + INSERT OR IGNORE。
#                回滚 (回退 v27): DELETE FROM report_agent WHERE id='email_preprocess_agent';
#                context_docs_json 列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
# v28 (删月报默认 seed, 2026-07, dogfood 反馈 #9): 删除 monthly_email_digest 默认行
#                (仅 enabled=0 且 prompt IS NULL 的未改默认态; 客制化用户行保留)。
#                v19 seed 块移除 monthly tuple (新库不再播种月报)。
#                回滚 (回退 v28): 月报行已删无法自动恢复; 需手动 INSERT 或降 db_version。
# v29 (预处理行级 fallback 拆分, 2026-07, dogfood R2 反馈 #2): report_agent 加
#                fallback_models_json 列 (JSON 数组 of 模型名)。NULL = 跟随全局
#                LLM_FALLBACK_MODELS (老用户升级零感知)、'[]' = 显式不设兜底、
#                数组 = 预处理专用 fallback 链。无 seed 变更 (种子行留 NULL=跟随全局)。
#                幂等: ALTER 前 PRAGMA 检查 (同 v27 context_docs_json 模式)。
#                回滚 (回退 v29): 列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
# v30 (Custom Agent 内核 S4 W1, 2026-07, flag MAILAGENT_CUSTOM_AGENTS_ENABLED 默认关):
#                report_agent 加 trigger_json (判别式 cron|email_filter) / tool_policy_json
#                (D6 allowed_tools 交集收窄) / budget_json。当前只执行 runs/day + runtime；
#                存量 max_steps 字段为向后兼容保留但忽略。
#                三列 (TEXT NULL, 无 seed —— type='custom' 行只由 owner 创建, W1 不播种)。
#                async_jobs 加 claim_token / spec_claimed_at 两列 (D2 fresh-spawn CAS one-shot;
#                W1 只建列, 端点在 W2)。全 additive TEXT NULL, 对既有行/调用零影响。
#                幂等: ALTER 前 PRAGMA 检查 (同 v27/v29 模式)。
#                回滚 (回退 v30): 五列可留 (旧代码无害, 全 NULL) 或手动 DROP; 必要时降 db_version。
# v31 (项目周报 sync 迁入 custom agent 框架, S5 W5a, 2026-07): report_agent 播种单例
#                type='project_progress' 行 (id='project_progress_sync')。**无 DDL** —— 复用
#                v30 的 trigger_json 列存触发配置 (email_filter 词汇: subject_pattern/sender_pattern,
#                但 project_progress 走 ProjectProgressDetector 子串-sender 匹配, 非 matcher 正则)。
#                enabled/trigger 从 env (PROJECT_PROGRESS_AUTO_SYNC_ENABLED / _SUBJECT_PATTERN /
#                _SENDER) 播种一次, 之后行权威 (Settings 可改); 总闸仍是 env PROJECT_PROGRESS_SYNC_ENABLED。
#                执行不进 async_jobs / gateway —— new_watcher hook 直调确定性 runner (P1: 框架不容纳
#                非 LLM 执行体, 项目周报只把触发配置搬进行, 执行仍 Python 直调)。
#                幂等: INSERT OR IGNORE (旧库已有则跳过、不覆盖用户改过的 enabled/trigger)。
#                回滚 (回退 v31): DELETE FROM report_agent WHERE id='project_progress_sync'; 必要时降 db_version。
# v32 (issue #19 产品化, 2026-07): report_agent 加 mark_read_after_processing INTEGER。
#                仅 type='preprocess' 使用：1 = AI 预处理完成后自动标已读，0 = 保持当前
#                未读状态。NULL / 缺列按 1 解释，升级迁移同时把 preprocess 行 NULL 回填 1，
#                保持既有行为零变化。幂等: ALTER 前 PRAGMA 检查 + UPDATE ... IS NULL。
#                回滚 (回退 v32): 列可留（旧代码无害）或手动 DROP；必要时降 db_version。
# v33 (issue #12, 2026-07): email_metadata 加 snippet TEXT，正文前 100 字符去规范化。
#                升级时从 email_body.body_markdown 一次性回填；后续正文提交事务同步刷新，
#                让列表查询彻底不 JOIN / 不读取 email_body blob。幂等: ALTER 前 PRAGMA
#                检查 + 仅回填 snippet IS NULL 行。SQLite substr(TEXT, 1, 100) 按字符截断。
#                回滚 (回退 v33): 列可留（旧代码无害）或手动 DROP；必要时降 db_version。
# v34 (日历 epic 阶段 2.1 P1-3, 2026-07): 新增 email_meeting 映射表 (internal_id PK →
#                ical_uid + method/recurrence_id/sequence/is_recurring)。邮件 .ics 的 uid
#                此前只进 Notion + recurring_series (仅周期会议), raw MIME 不持久化、.ics
#                附件被 reader skip → 无法事后解析, 邮件↔日历互跳 (按 ical_uid join
#                calendar_event) 必须落存储。写入方: new_watcher 会议检测 hook (每封含
#                invite 的新邮件) + recurring_invite.replay_one (手动 replay 顺路补写)。
#                升级回填: 从 recurring_series (series_uid + last_seen_message_id join
#                email_metadata.message_id) best-effort 回填, method 记 NULL (series 行
#                的 last_seen 可能是 REQUEST 或 CANCEL, 不可考)。存量非周期邀请不可回填。
#                幂等: CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE 回填。
#                回滚 (回退 v34): DROP TABLE email_meeting; 必要时降 db_version。
# v35 (日历 epic 5.1 #10 tzid 半步, 2026-07): calendar_event 加 tzid TEXT NULL —— DTSTART 的
#                TZID 参数归一 Olson 名 (DavMail 别名如 Asia/Beijing→Asia/Shanghai, 见
#                calendar_sync/_common.normalize_tzid)。NULL = 裸 Z/floating/全天 (现状 UTC 语义);
#                非空 = 双展开器 (Python expander / TS calendar-read) 按该时区墙钟展开 (DST 边界
#                occurrence 本地时刻不变), 写路径 (caldav_writer F1/F2) 以其决定 override 的
#                TZID 输出与 split UNTIL 的本地日界。无历史回填: NULL 行为 = 修复前语义, 下轮
#                全量 CalDAV sync 重新 upsert 自然补齐。
#                回滚 (回退 v35): 列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
# v36 (compose epic D1 草稿线程 linkage, 2026-07): email_metadata 加 3 列 (全可空,
#                仅 mailbox='草稿箱' 行使用): draft_source_internal_id INTEGER (原邮件行
#                internal_id, 反查得不到则 NULL) / draft_in_reply_to TEXT (原邮件
#                Message-ID, 去尖括号) / draft_references TEXT (空格分隔 msg-id 链,
#                含尖括号)。写入方: mail_write._mirror_draft_locally (compose 即时落库)
#                + davmail_backend.reconcile_drafts (对账自愈, 覆盖 webhook 等一切草稿
#                来源)。消费方: _prepare_draft 的 source_draft_id 复用 (从草稿发送时恢复
#                In-Reply-To/References/thread_id, 修 Bug A 丢线程)。无历史回填: 存量
#                草稿行 NULL = 修复前语义 (发送不带 threading), reconcile 只对新增行生效。
#                回滚 (回退 v36): 列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
# v37 (首启缺表修复, 2026-07): llm_processing 纳入 SyncStore 版本化建表。此前该表
#                只由 LLMProcessingStore._ensure_schema() 惰性创建 (LLM_AGENT_ENABLED
#                默认 false → 普通用户永不实例化), 而前端 email:listEnriched 无条件
#                LEFT JOIN llm_processing → 全新库首启即 `no such table` 崩邮件列表。
#                v37 起表 + 两索引 (idx_llm_status / idx_llm_retry partial) 由
#                _init_database_impl 无条件 CREATE IF NOT EXISTS (新/旧库均生效,
#                幂等, 无数据回填); DDL 单源 = 模块级 LLM_PROCESSING_TABLE_DDL /
#                LLM_PROCESSING_INDEX_DDLS, LLMProcessingStore._ensure_schema 引用
#                同常量作幂等双保险。bump 版本号用于前端 backend_lifecycle.ts
#                (EXPECTED_DB_VERSION=37 + REQUIRED_TABLES 含 llm_processing) 就绪
#                门控可依赖「>=37 ⇒ 表已建」。
#                回滚 (回退 v37): 表可留 (旧代码无害); 必要时降 db_version。
# v38 (task 07-22 预处理参考上下文源迁行存储, 2026-07): report_agent 加 context_source
#                TEXT。仅 type='preprocess' 使用：'standing_docs' | 'notion_context' 二选一
#                （分类 system prompt 只注入一种参考背景）。此前该二选一落在 env
#                LLM_PREPROCESS_CONTEXT_SOURCE (重启生效); 迁行后**保存即生效**, 对齐
#                model/fallback/context_docs 的行级热读 house style。升级 seed (一次性,
#                行落地后行权威, env 键降级为首次 seed 默认): env LLM_PREPROCESS_CONTEXT_SOURCE
#                显式合法值 → 写入行; 否则按 LLM_CONTEXT_PAGE_ID 非空 → 'notion_context',
#                空 → 'standing_docs' (与旧 _resolve_context_source 继承规则逐字一致 → 升级
#                前后注入形态零变化)。幂等: ALTER 前 PRAGMA 检查 + 仅回填 context_source IS
#                NULL 的 preprocess 行。回滚 (回退 v38): 列可留（旧代码按 NULL→继承派生, 无害）
#                或手动 DROP; 必要时降 db_version。
# v39 (task 07-22-1 附件 trigram 并行表, 2026-07): 新增 contentful FTS5 表
#                email_attachment_fts_trigram(filename, text_content, tokenize='trigram'),
#                rowid=attachment_id。镜像 v24 body trigram 方案②: 主表 email_attachment_fts
#                (unicode61, 仅 text_content) 不动 → 英文/已有附件搜索零回归; 新表解决①附件正文
#                中文非前缀子串 + ②文件名可搜 (中/英子串, 主表不索引 filename)。trigger 挂
#                email_attachment_text (与主表同源同 status gate: 仅 extracted+非空入索引),
#                filename 由子查询从 email_attachment 取。**本 PR 只建表/回填/触发器, 不接检索
#                路由 (PR4 才接)**。幂等: CREATE IF NOT EXISTS + 3 trigger + 回填 WHERE NOT
#                EXISTS (current_version < 39 gate)。回滚 (回退 v39): DROP 3 trigger + DROP 表,
#                主表不动 (纯 schema 未接路径, 删即回退); 必要时降 db_version。
# v40 (2026-07-23): email_metadata +in_reply_to (nullable TEXT, 存储无尖括号, 同 message_id
#                惯例) —— 直接父邮件 message_id (In-Reply-To 头), KOS payload Thread 链接反查用。
#                davmail/applescript 两条解析路径落库; 老行 NULL (forward-only, 无 backfill)。
#                回滚 (回退 v40): 列可留 (旧代码无害, 全 NULL) 或手动 DROP; 必要时降 db_version。
# v41 (issue #59 KOS 入库可靠性, 2026-07): kos_ingest_log 从 bulk_ingest 惰性建表升格为
#                版本化正式表 (镜像 v37 llm_processing 模式)。+4 列 retry_count NOT NULL
#                DEFAULT 0 / next_retry_at REAL / error_code TEXT / source TEXT
#                ('producer'|'bulk'), status 值域扩为 pushed/failed/dead/skipped, 调度索引
#                idx_kos_ingest_retry(status, next_retry_at) WHERE status='failed'。
#                D2: 无条件建表 (schema 与 MAILAGENT_KOS_INGEST_ENABLED 解耦, "字节级
#                inert" 只约束运行时行为不发请求/不写行, 不约束 schema 存在性)。
#                幂等: DDL 单源 = 模块级 KOS_INGEST_LOG_TABLE_DDL / _RETRY_COLUMNS /
#                _INDEX_DDL + ensure_kos_ingest_log_schema() (bulk _ensure_log_table 引用
#                同函数); 老库该表可能已被 bulk 惰性建成 6 列旧形状 → PRAGMA 判断后
#                ALTER 补列。无数据回填 (forward-only, 历史空洞仍由手动 bulk_ingest 补)。
#                回滚 (回退 v41): 表/列可留 (旧代码只写老 6 列, 无害); 必要时降 db_version。
# v42 (custom-agent epic W4, 2026-07): report_agent +avatar_json (nullable TEXT)。空值由前端
#                按 agent_id 确定性派生 shape/palette/variant；显式 JSON 保存用户在 custom
#                agent 编辑器选择的身份。纯展示元数据，不改变内置 agent 行为。
# v43 (harness optimization P2, 2026-08): report_agent +description TEXT。NULL/空 = 未设置；
#                wire 写侧 strip 并限制 1000 字符，读侧原样投影。additive ALTER，无回填。
#                回滚 (回退 v43): 列可留（旧代码无害）；必要时降 db_version。
# v44/v45 (Matters P1/P2): matter aggregate 基表 / resources+stakeholders+relations+search。
# v46 (Matters P4, 2026-08): matter_run 表 + 4 索引 (contracts §2.11, DDL 单源
#                MATTER_TABLE_DDLS/MATTER_INDEX_DDLS) + matter 加绑定四列
#                agent_profile_id/agent_enabled/matter_instructions/schedule_json
#                (schedule_json P5 预留零消费)。matter_update 提案列 v44 已建齐,
#                本版零动作; matter_update.agent_run_id 语义冻结 = matter_run.id (D1)。
#                回滚 (回退 v46): 表/列可留 (旧代码无消费点, 无害); 必要时降 db_version。
# v47 (Matters P5, 2026-08): matter_attention 表 + active/state 索引。
# v48 (Matters dogfood batch 2): mailagent email/thread external_key 归一；碰撞时
#                合并活跃 matter_resource、重指历史链接与资源外键，并回填邮件元数据。
# v49 (Matters P6-A): persistent resource-suggestion rejection memory.
# v52 (Matters dogfood 轮 2 W-C, 2026-08): 全局干系人库 matter_contact (身份 = 归一
#                email lower+trim UNIQUE) + matter_stakeholder +contact_id (additive
#                ALTER, ON DELETE SET NULL) + 关联索引 (🔴 不进 MATTER_INDEX_DDLS,
#                理由见 MATTER_STAKEHOLDER_CONTACT_INDEX_DDL)。seed 回填: 存量
#                stakeholder 行先归一 email (trim+lower, 空串→NULL), 再按 email 聚合
#                去重入 contact 表 (display_name/organization 取最近更新的非空行),
#                最后 UPDATE … WHERE contact_id IS NULL 回写关联。无 email 的行**有意
#                不入库** (没有可靠身份键, 按名字合并必然误并同名人), contact_id 恒
#                NULL。回滚 (回退 v52): DROP INDEX + DROP COLUMN contact_id + DROP
#                TABLE matter_contact; 列/表留着也无害 (旧代码零消费点)。
# v53 (Win outlook_com backend, task 08-12): email_metadata +entry_id TEXT ——
#                Outlook COM EntryID 缓存列 (镜像 imap_uid 的角色)。🔴 EntryID 会
#                漂移 (邮件移动文件夹后变), 只当**快路径缓存**不当锚; 稳定锚仍是
#                message_id UNIQUE, miss 时 Table API 按 PR_INTERNET_MESSAGE_ID
#                (DASL 0x1035001F) 反查 + 回写自愈 (与 davmail imap_uid 双路同构)。
#                NULL = 非 outlook_com 行 / 尚未回填, 无需回填 (缺省即语义)。
#                ⚠️ 本列在 feat/win-outlook-com worktree 分配; main 分支若并发
#                bump v53, merge 时需重编号本迁移块。
#                回滚 (回退 v53): 列留着无害 (旧代码零消费点)。
# v54 (Contact Directory WP1, task 08-13, 2026-08): 通讯录三表 contact /
#                contact_email / contact_email_link (DDL 单源 CONTACT_TABLE_DDLS /
#                CONTACT_INDEX_DDLS, 🔴 不进 MATTER_*_DDLS) + 迁 matter_contact →
#                contact (**id 保持**, 每行生成 contact_email is_primary=1) +
#                rebuild matter_stakeholder (FK contact_id 改指 contact, 镜像 v45
#                先例) + DROP matter_contact。聚合缓存列迁移期恒 0, 账本 backfill
#                不进 migration (由 src/contacts/scanner 从 watermark=0 增量消化)。
#                ⚠️ PRD 原编号 v53 已被上面的 outlook_com entry_id 占用 (worktree
#                并发 bump), 本块按其预告重编号为 v54。
#                回滚 (回退 v54): 新三表可留 (旧代码零消费点); 但 matter_contact
#                已 DROP、stakeholder FK 已改指 contact —— 回退版本的 matters 写面
#                会因缺表失败, 真要回退需从 backups/ 恢复库。
# v55 (Contact Directory WP2, task 08-13, 2026-08): contact +identity_locks_json
#                (字段级锁定 {field: epoch_ms}, 键域单源 src/contacts/taxonomy.py
#                CONTACT_LOCKABLE_FIELDS)。🔴 它是锁的**唯一真源**;
#                identity_locked_at 降级为聚合派生 (= 锁映射 MAX, 无锁 NULL),
#                由 src/contacts/service.py 单一写径维护, 供老读侧兼容。seed:
#                存量 identity_locked_at 非 NULL 的行折成
#                {"display_name": identity_locked_at} —— WP1 期的锁全部来自
#                matters 写穿改名, 语义就是 display_name 锁。
#                回滚 (回退 v55): 列留着无害 (旧代码零消费点)。
# v56 (Matters 资料摘要, task 08-12 design-alignment 批 M4, 2026-08): resource
#                +sum / +sum_src / +sum_at 三列 (设计稿 H3§6 的资料摘要数据层)。
#                sum = 资料内容概括 (1-3 句); sum_src ∈ mail|agent|NULL (CHECK 单源
#                src/matters/models.MatterResourceSummarySource); sum_at = 摘要生成
#                时刻 epoch ms (判过期用)。三列全 NULL = 「还没有摘要」空态。
#                存量行**有意不回填** (镜像 ingest_reason 先例): 邮件类摘要由
#                service._upsert_resource 在下次触到该资料时从 llm_processing 惰性
#                带入, migration 不做万行级 JOIN 卡首启 waitReady。无新索引 ——
#                读面都是按 id / (provider,external_key) 的行级取数, sum_src 筛选
#                等有真实查询面再建 (且 🔴 届时必须放 v-块内, 不进 MATTER_INDEX_DDLS,
#                v52 教训)。设计稿的 link{app,url} 两半 = 既有列 provider /
#                canonical_url, 零新增。
#                回滚 (回退 v56): 列留着无害 (旧代码零消费点)。
# v57 (Matters 资料版本轨迹, task 08-12 design-alignment 批 M7, 2026-08): 新表
#                resource_version (DDL 单源 RESOURCE_VERSION_TABLE_DDL, 已并进
#                MATTER_TABLE_DDLS **末尾**) + 1 索引 RESOURCE_VERSION_INDEX_DDL
#                (🔴 不进 MATTER_INDEX_DDLS, 理由见该常量注释 —— v52 教训)。
#                一行 = 一份被取代的资料版本快照 (revision/content_hash +
#                superseded_at + 当时的 sum/sum_src/sum_at + Agent 写的 diff_text)。
#                当前版本**有意不入表** (就是 resource 行自己)。
#                🔴 存量数据零回填、零 DML: 老库升上来时轨迹是空的, 因为历史版本
#                **从来没被记录过** —— 不能靠 resource 现值伪造一条"历史"出来
#                (那会把「唯一一次检出」谎报成「有过一版」)。第一条轨迹行由下一次
#                真的检出到新版本时产生。
#                回滚 (回退 v57): 表/索引留着无害 (旧代码零消费点); 真要清
#                DROP TABLE resource_version 即可, 不牵动 resource 行。
# v58 (sender 形态归一, task 08-14 WP-5 阶段 1, 2026-08): email_metadata
#                +sender_email (归一裸小写地址) + idx_email_sender_email。
#                🔴 与前面几条「有意不回填」的加列**不同**: 本列是纯派生值,
#                NULL 不是有意义的空态而是缺口 —— 老行不回填 = 三个消费者对
#                存量行继续瞎 (contacts 账本缺 68% 的发件人、出向漏 87%), 故
#                migration **必须**回填 (见 _backfill_sender_email)。
#                派生器单源 src/mail/email_address.py::derive_sender_email
#                (email.utils.getaddresses); 🔴 禁止在 SQL 里 substr/instr
#                再写一套 —— 那正是本 WP 要消灭的「第 N 个真源」。
#                sender 列**一字不改** (77 处后端引用 + 前端 parseSender 靠它
#                取显示名, 原地改写会让 ⌘K 结果里的发件人退化成 local part)。
#                回滚 (回退 v58): 列/索引留着无害 (旧代码零消费点); 列随时可由
#                sender 重算, 不是第二真源。
# v59 (通讯录「正式名」正名, task 08-14 WP-6 A, 2026-08): contact.name_en
#                → contact.formal_name (ALTER … RENAME COLUMN, SQLite ≥3.25)。
#                owner 拍板: 该字段的语义是**正式名 (不限语言)** —— 研发的正式名
#                是中文、外国同事的正式名是英文, 而常用名 (`display_name`, UI 已
#                叫「常用名」) 可能是英文名, 也可能是「x 工」「x 哥」。`name_en`
#                是**不诚实的命名**, 会诱导后来者写出「非 ASCII 就跳过」之类的
#                逻辑 —— 与本 task 的核心教训 (v58 `sender` 那条线: 同一列被不同
#                消费者按不同假设读) 同源, 故连列名一起改而不是只改 UI 文案。
#                🔴 两段迁移**都**必须做, 缺第二段 = 静默丢锁:
#                  ① 列改名 (探列幂等: 只在「有 name_en 且无 formal_name」时执行;
#                     fresh 库满梯子在 v54 块已按最新 DDL 建成 formal_name)。
#                  ② `identity_locks_json` 的**键**跟着改 —— 锁映射是 {字段名:
#                     epoch_ms}, 列改名不会自动改 JSON 键, 而
#                     `parse_identity_locks` 对词表外的键是**静默丢弃**, 不迁的话
#                     owner 早先锁住的正式名会无声解锁, 下一轮扫描就可能被自动
#                     提取覆盖。
#                回滚 (回退 v59): 🔴 **不能只降版本号** —— 旧代码读 `c.name_en`
#                会 OperationalError (no such column)。真要回退需手工
#                `ALTER TABLE contact RENAME COLUMN formal_name TO name_en` +
#                把锁键改回去, 或从 backups/ 恢复库。
# v60 (2026-08-18, S2): matter_stakeholder +tier +sort_order —— 干系人分层
#                （核心 / 非核心，非核心默认折叠）与用户自定义顺序。
#                🔴 `sort_order` 的语义是**用户拖出来的显示顺序**，读侧不得 `sorted()`
#                覆盖（同 `SYNC_FOLDERS` 数组序那条纪律）。回填按现有 id 序编号 ——
#                不是为了保顺序（全 0 时 id 兜底接管，顺序本来就不变），而是给第一次
#                拖拽一个有意义的基线。
#                回滚（回退 v60）: 旧代码不读这两列，**只降版本号是安全的**
#                （新列有 DEFAULT，旧 INSERT 照常）；真要清掉再 DROP COLUMN。
# v61 (2026-08-19): matter.description → matter.background + 新列 matter.goal ——
#                「背景」与「目标」拆成两个独立存储项。owner 推翻 08-18 那版
#                「合存单字段、靠 `## 背景` / `## 目标` 小标题分段」的方案, 理由是
#                避开解析的异常面: 一个字段两段语义, 读态 / 编辑态 / 保存 / 导出 /
#                Agent 写入五处都得同意同一套正则, 任何一处不同意就是静默串段。
#                🔴 为什么是 RENAME 而不是「加 background、留着 description」:
#                留着会得到一个名不副实的列, 漏改的引用点静默读到空背景; 改名让每一
#                处引用在运行期直接 OperationalError, 逼着全部跟改。
#                数据规则: 存量 `description` **原样搬进 background、goal 留空**;
#                唯一例外是那一版短命 UI (08-18 23:53 落地, 次日推翻) 写出的行首
#                整行小标题, 按段拆开落两列 (单源 split_legacy_matter_description,
#                本机活库实测 7 条事项 0 条带小标题, 别的安装可能有)。
#                幂等: 改名探列 (只在「有 description 且无 background」时执行);
#                拆段只挑 `goal = ''` 且真带小标题的行, 拆完两侧不再含小标题 ⇒ 重入
#                匹配 0 行。matter 表上没有涉及 description 的索引 / 触发器, RENAME
#                无冲突面 (MATTER_INDEX_DDLS 六条 matter 索引全是状态 / 时间列)。
#                🔴 `matter_search_document` / `matter_fts` 的 `description` 列
#                **有意不改名**: 它是检索文本桶不是 matter 行的镜像, 改名要重建
#                fts5 虚表 (fts5 不支持 RENAME COLUMN) 且会打断 `matched_fields`
#                这一层对外契约; 投影侧改喂 background + goal 两段。
#                回滚 (回退 v61): 🔴 **不能只降版本号** —— 旧代码读 `description`
#                会 OperationalError。真要回退需手工
#                `ALTER TABLE matter RENAME COLUMN background TO description`
#                (goal 列里的内容会就此失联, 需先手工并回 description), 或从
#                backups/ 恢复库。
# v62 (2026-08-19): 新表 folder_pref —— 已同步文件夹的 per-folder 配置 (图标 +
#                通知开关 + AI 开关)。DDL 单源 FOLDER_PREF_TABLE_DDLS /
#                FOLDER_PREF_INDEX_DDLS (🔴 不进 MATTER_*/CONTACT_* 两组, 理由见
#                该常量头注), 列语义与「顺序为什么不进这张表」也在那里。
#                数据规则: 从 `FOLDER_NOTIFY_ENABLED` / `FOLDER_LLM_DISABLED` 两个
#                env 键**播种一次** (v31 project_progress_sync 的同一手法), 之后
#                行是运行时权威 —— 两个 gate 改走行内热读, 改开关不再需要重启
#                mail-sync。env 键保留为「首次 seed + 行缺失时的回退」, 不退役
#                (裸 CLI / 未迁移库仍靠它)。
#                🔴 播种要跨一次**名字空间**: 两个 env 键存的是 mailbox **显示名**,
#                本表 PK 是 IMAP **原始名**。映射不连 IMAP (迁移里做 LIST 是死路),
#                而是拿 SYNC_FOLDERS 里的 imap_name 逐个 decode_imap_utf7 —— 这
#                正是 davmail 写 email_metadata.mailbox 时用的同一条路径, 所以
#                映射与 gate 的匹配口径逐字一致。env 里有、SYNC_FOLDERS 里没有的
#                名字**播不了种** (没有 imap_name 可做 PK), 打 warning 列出来。
#                🔴 两个键极性相反, 播种时别搞混: notify 是**白名单**
#                (在名单里 → notify_enabled=1), llm 是**黑名单** (在名单里 →
#                llm_disabled=1)。缺省两列都是 0, 但 0 的含义一个是「不推」一个
#                是「跑 LLM」。
#                幂等: 建表 IF NOT EXISTS; 播种 INSERT OR IGNORE (老库重放不覆盖
#                用户在 UI 改过的值)。重放结果不变。
#                回滚 (回退 v62): 旧代码完全不认识 folder_pref, **只降版本号是
#                安全的** (表留着不碍事, 两个 gate 回落 env frozenset = 升级前
#                行为); 要清干净再 `DROP TABLE folder_pref`。
# v63 (Contact Profile WP6, 2026-08-19): contact 增加 profile_status /
#                profile_attempted_at / profile_error 三列，承载 running/ok/skipped/failed
#                四态与最近尝试摘要；report_agent 播种 contact_profile_agent 专型行，
#                trigger_json 保存 fire_hour=4 / daily_limit=50，默认 disabled，model/prompt
#                空串表示跟随全局/使用内置 prompt。幂等: ALTER 前 PRAGMA 探列 +
#                INSERT OR IGNORE。回滚: DELETE FROM report_agent WHERE
#                id='contact_profile_agent'; 三列可留给旧代码忽略，或 SQLite 重建 contact
#                表移除后再手工降 db_version。
# v64 (2026-08-19): contact_suggestion 待审治理队列。
#                语义：Agent 只提带证据建议，owner 决定 adopt/ignore。
#                数据规则：JSON 全 json_valid；type/status 引 taxonomy 单源；
#                evidence_fingerprint 支撑同批证据去重。
#                幂等：CREATE TABLE/INDEX IF NOT EXISTS，重放结果不变。
#                回滚：旧代码忽略本表；彻底清理需 DROP TABLE 后手工降版本。
# v65 (2026-08-20): report_agent 播种 contact_governance_agent 专型行，
#                trigger_json 默认 fire_hour=5，enabled=0。INSERT OR IGNORE 保证重放
#                不覆盖 owner 已保存的启用、模型、提示词与排程。
# v66 (2026-08-20): contact 增加 gender TEXT NULL，非空只允许 male/female。
#                幂等：ALTER 前 PRAGMA 探列；旧库由 service 层同值域校验兜底。
# v67 (2026-08-20, 通讯录读路径性能): contact 表补三条索引 —— idx_contact_known /
#                idx_contact_manager / idx_contact_org。DDL 单源
#                `CONTACT_V67_INDEX_DDLS`（🔴 不进 `CONTACT_INDEX_DDLS`，理由见该
#                常量头注 = v52 的同一条教训）。
#                背景：contact 自 v54 建表起一条索引都没有，列表主查询 `SCAN c` +
#                TEMP B-TREE、详情的 reports/peers 两腿各扫一次全表。2495 行时无感，
#                线性增长无兜底；本批同时给列表加了 keyset 分页，LIMIT 要真能提前
#                收工就得有序可用的索引。
#                幂等：CREATE INDEX IF NOT EXISTS + `_migration_guard_index` 复查
#                sqlite_master（索引仍缺失才算真失败，version 不前进）。重放结果不变。
#                回滚（回退 v67）：索引是纯读优化，旧代码不认识也不受影响，**只降
#                版本号是安全的**；要清干净再 `DROP INDEX idx_contact_known` 等三条。
# v68 (2026-08-21, 统一通知中心 M1): 新表 notification —— 后台任务完成 / 待办 /
#                系统告警的**持久化**通知条目 (区别于 3 秒即逝的 toast)。DDL 单源
#                `NOTIFICATION_TABLE_DDLS` / `NOTIFICATION_INDEX_DDLS`
#                (🔴 不进 MATTER_*/CONTACT_* 两组, 理由见该常量头注 = v52 教训),
#                CHECK 值域引 `src/notify/center_models.py`。
#                语义: 通知中心是第一公民 (先落库, SSE 只当刷新信号), 断线 / 重启
#                后可回放; 灵动岛 / macOS 通知 / 飞书是后续阶段的投影目标, 本版本
#                一个都不动。
#                数据规则: 时间列全是**毫秒**整数 (与 matters 一致, 不是 time.time()
#                的秒); `read_at` 是与 state 正交的独立轴 (已读 ≠ 已处理);
#                同 `dedupe_key` 同时只允许一条活跃行 (state IN open/snoozed),
#                由 partial unique `uq_notification_active_dedupe` 兜底 —— 重复触发
#                走计次 (recurrence_no+1) 而不是开新行。无播种数据。
#                幂等: CREATE TABLE / CREATE INDEX IF NOT EXISTS, 表与索引同块
#                (新表首建, 无 v52 式「列还不存在」炸点)。重放结果不变。
#                回滚 (回退 v68): 旧代码完全不认识 notification 表, **只降版本号是
#                安全的** (表留着不碍事); 要清干净再 `DROP TABLE notification`。
#                🔴 revert 期间产生的通知**不补** —— 信源事件已经过去, 这是「先落库」
#                模型的自然边界。
# v69 (2026-08-24, L4 批次 1 · 通讯录日历第三源): contact 增加 meeting_count /
#                last_met_at / next_meeting_at 三列。写者唯一 =
#                `src/contacts/calendar_scan.py` (独立低频节拍, 全量重算)。
#                数据规则: 两个时间列是 epoch **毫秒** (与本表 first_seen_at /
#                last_seen_at 同单位), 尽管来源 `calendar_event.dtstart_utc` 是
#                epoch 秒 REAL —— 换算在扫描器边界做, 表内不留两种单位。
#                语义: 三列是**可全量重算的聚合缓存**, 不是第二真源 (镜像
#                mail_count / sent_to_count 的纪律); calendar_event 是可变表
#                (改期 / 取消 / 软删会回写既有行), 所以不用 watermark 增量。
#                幂等: ALTER 前 PRAGMA 探列 (三列各判各的), 重放结果不变。
#                回滚 (回退 v69): 旧代码不认识这三列, **只降版本号是安全的**
#                (列留着不碍事; SQLite 要清干净得重建 contact 表, 不值当)。
# v70 (2026-08-25, curated 进展 lane): 新表 matter_progress —— 事项的「进展」从
#                `matter_event` 的降级映射 (G-18 的 (b) 档) 换成独立的 curated 条目:
#                目标 / 里程碑 / 关键进展 / 关键信号 / 决议五类叙事节点, 由用户内联编辑
#                与事项 Agent 共同维护; 操作日志继承原来那套呈现, 数据面 (全量
#                `matter_event`, append-only) 一字不动。DDL 单源
#                `MATTER_PROGRESS_TABLE_DDLS` / `MATTER_PROGRESS_INDEX_DDLS`
#                (🔴 不进 MATTER_*/CONTACT_* 各组, 理由见该常量头注 = v52 教训),
#                kind 与 actor_kind 的 CHECK 引 `src/matters/models.py` 枚举。
#                语义: 进展是 curated 的 —— 默认**不**从操作事件降级生成, 没条目就是
#                空态, 不回落降级视图。三条写入口安全姿态照旧 (结构红线 §1): 用户直写 /
#                事项对话工具走 HITL / 定时跟进 run **只有提案通道** (change kind
#                `progress`, owner 接受时才落行)。每次写都 append 一条
#                progress_added|updated|removed|restored 审计事件。
#                数据规则: 时间列全是 epoch **毫秒**; `happened_at` (叙事时间) 与
#                `created_at` (记录时间) 是两回事, 不合成一列; 软删走 `deleted_at`
#                (undo 路径同 matter_item); 无播种数据 —— 存量事项升级后进展为空态,
#                🔴 **不拿历史事件回填** (那些是操作记录不是叙事节点, 回填 = 把系统
#                自己的动作谎报成人写下来的脉络, 正是本版本要终结的那件事)。
#                幂等: CREATE TABLE / CREATE INDEX IF NOT EXISTS, 表与索引同块
#                (纯新表首建, 无 v52 式「索引先于列」的错位面)。重放结果不变。
#                回滚 (回退 v70): 旧代码完全不认识 matter_progress, **只降版本号是
#                安全的** (表留着不碍事); 要清干净再 `DROP TABLE matter_progress`
#                —— 🔴 那会连人手写的进展一起没, 事件里只留得下「加过 / 改过」的痕迹。
# v71 (2026-08-25, 行动项执行契约): 新表 matter_item_dispatch —— 一条行动项可以被
#                派给一个执行器 (现阶段恒 agent) 跑一轮 headless run, 执行态由服务端
#                CAS 推进 (七值 queued/running/awaiting_input/proposed/done/failed/
#                canceled), 交付走既有提案机制。DDL 单源 MATTER_ITEM_DISPATCH_TABLE_DDLS
#                / _INDEX_DDLS (🔴 不进 MATTER_*/CONTACT_* 各组, 理由见该常量头注 =
#                v52 教训), state / exec_profile / created_by_kind 的 CHECK 引
#                `src/matters/models.py` 枚举。配套两列 additive ALTER:
#                `matter_item.exec_profile` (per-行动项执行档, NULL = propose_only) 与
#                `matter_update.item_dispatch_id` (提案 → 派发的回钩, 无 FK) + 一条
#                部分索引 MATTER_UPDATE_ITEM_DISPATCH_INDEX_DDL。
#                语义: 执行态与业务态 (`matter_item.status`) **分两列**, 有意不合成
#                (合成一列 = agent 忘改状态即静默永久卡死, 档案 07 §8b); 终态判据是
#                `ended_at IS NOT NULL` 而不是 state 值, partial unique 只拦活跃行 ⇒
#                终态后同一条行动项可以再派、历史逐行留下; 派发时把 item 的 exec_profile
#                **冻结**进派发行 (抄审批 stash 冻结 contextMode 的先例)。
#                数据规则: 时间列全是 epoch **毫秒**; 无播种数据 —— 存量行动项升上来
#                一条派发都没有 (它们从来没被派过, 回填等于编造执行史)。
#                幂等: CREATE TABLE / CREATE INDEX IF NOT EXISTS + 两处 ALTER 前 PRAGMA
#                探列, 重放结果不变。
#                回滚 (回退 v70): 旧代码完全不认识这张表与这两列, **只降版本号是安全的**
#                (表 / 列留着不碍事; 要清干净再 DROP TABLE matter_item_dispatch ——
#                两列 SQLite 得重建表才去得掉, 不值当)。
# v72 (2026-08-31, L4 团队页 P4a): 新表 contact_profile_run —— 联系人画像 Agent 的
#                执行台账 (一轮批处理落一行, 时间列 epoch 毫秒)。
#                ⚠️ **v73 已整表迁走**: 行搬进 agent_run_log 后 DROP, 本版本的迁移块
#                与 CONTACT_PROFILE_RUN_* DDL 常量、`src/contacts/profile_runs.py`
#                模块一并退役 (v73 块对「表不存在」的 <v72 老库直接跳过搬迁)。
# v73 (2026-08-31, L4 团队页 P4a run transcript): 新表 agent_run_log + agent_run_step
#                —— 统一 agent 执行台账。不走 gateway 的成员 (报告 / 联系人画像 /
#                项目周报) 没有 session transcript, 详细过程记录落这里, 前端把步骤
#                合成 trig/think/tool/out 的 transcript 形态 (design §8.1)。
#                DDL 单源 AGENT_RUN_LOG_TABLE_DDLS / _INDEX_DDLS (🔴 不进
#                CONTACT_*/MATTER_* 各组, 理由见该常量头注 = v52 教训); status 的
#                CHECK 引 `src/agents/run_log.py` 的值域元组 (9 值域子集, 不发明
#                词表), kind 的 CHECK 同引 (trig|think|tool|out)。
#                数据搬迁: v72 库的 contact_profile_run 全部行 INSERT..SELECT 进
#                agent_run_log (agent_id='contact_profile_agent', ok→completed /
#                noop→skipped / fail→failed, 时间列同为毫秒直搬, summary 按读侧
#                旧口径 `_profile_run_summary` 的三句话在 SQL CASE 里预生成),
#                然后 DROP TABLE contact_profile_run。<v72 老库没有这张表 →
#                sqlite_master 探测后跳过搬迁, 只建新表。
#                幂等: 建表 IF NOT EXISTS; 搬迁 + DROP 与版本号写入同一事务 ——
#                任何一步失败整体 ROLLBACK, 重跑从头再来, 不存在「搬了一半」。
#                回滚 (回退 v72): 旧代码读不到 contact_profile_run (已 DROP),
#                画像记录列空态但不炸; agent_run_log 留着不碍事。**已迁移的画像
#                台账行不会自动搬回去** —— 生产该表 2026-08-31 才建, 行数极少。
# v74 (2026-09-09, Notion 反馈批): 新表 today_reply_dismissal —— 今日页「无需回复」的
#                逐封人工决定 (operation_id 管撤销; 有意不挂 email_metadata 外键, 理由见
#                迁移块); email_metadata 加 sync_skip_reason (新 skipped 行记录原因, 老行
#                NULL = 未知)。纯增量: 回退 v73 时旧代码忽略二者。
# v75 (2026-11-20, 2 字 CJK 检索加速): 新增并行 unicode61 bigram FTS5 表
#                email_body_fts_cjk2(body_bg, subject_bg, sender_bg) 与
#                email_attachment_fts_cjk2(filename_bg, text_bg) 及删除/非 extracted
#                清理触发器; sync_state['cjk2_backfill_done'] 标记全量回填进度。
#                迁移期只建空表 (<50ms, 不阻塞 waitReady), 存量行由 cjk2_backfill_worker
#                后台分批回填; 未完成或缺失时自动回退 trigram LIKE 兜底。
#                回滚 (回退 v74): DROP TRIGGER/TABLE 即可, 主索引零改动。


def run_migrations(
    conn: sqlite3.Connection,
    cursor: sqlite3.Cursor,
    current_version: int,
    db_path: Path,
) -> bool:
    """Run all idempotent schema migrations from ``current_version`` up to current DB_VERSION.

    Returns False only when an unmigrated v2 database is detected (caller closes and exits
    without bumping ``db_version``); otherwise returns True.
    """
    if current_version < 3:
        # v3 需要迁移，检查是否已有 email_metadata 表
        cursor.execute("""
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='email_metadata'
        """)
        if cursor.fetchone():
            # 已有旧表，检查是否有 internal_id 列
            cursor.execute("PRAGMA table_info(email_metadata)")
            columns = {row[1] for row in cursor.fetchall()}
            if 'internal_id' not in columns:
                # 需要迁移但尚未迁移，记录警告
                logger.warning(
                    "SyncStore v2 detected, please run migration script: "
                    "python3 scripts/migrate_sync_store_v3.py"
                )
                # 继续使用旧表结构
                return False

    # v3 架构：email_metadata 表（internal_id 为主键）
    # v8: is_pinned / pinned_at —— 前端置顶 / pin 持久化
    # v9: is_important —— 邮件原生重要性（Importance / X-Priority header）
    # v51: ingest_reason —— 入库来源 provenance（飞书通知门控判据）
    # v58: sender_email —— sender 的归一裸小写地址（派生列，见 email_address.py）
    #
    # 🔴 message_id 是 TEXT UNIQUE 且写入走 INSERT OR REPLACE ⇒ **绝不能存空字符串**
    # （空串撞 UNIQUE 会静默删掉冲突的老行）。无 Message-ID 一律存 NULL，
    # 收口在 _storage_message_id()。
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS email_metadata (
            internal_id INTEGER PRIMARY KEY,
            message_id TEXT UNIQUE,
            thread_id TEXT,
            subject TEXT,
            sender TEXT,
            sender_name TEXT,
            to_addr TEXT,
            cc_addr TEXT,
            date_received TEXT,
            mailbox TEXT,
            is_read INTEGER DEFAULT 0,
            is_flagged INTEGER DEFAULT 0,
            sync_status TEXT DEFAULT 'pending',
            notion_page_id TEXT,
            notion_thread_id TEXT,
            sync_error TEXT,
            retry_count INTEGER DEFAULT 0,
            next_retry_at REAL,
            created_at REAL,
            updated_at REAL,
            is_pinned INTEGER DEFAULT 0,
            pinned_at REAL,
            is_important INTEGER DEFAULT 0,
            imap_uidvalidity INTEGER,
            imap_uid INTEGER,
            backend_origin TEXT DEFAULT 'applescript',
            snippet TEXT,
            draft_source_internal_id INTEGER,
            draft_in_reply_to TEXT,
            draft_references TEXT,
            in_reply_to TEXT,
            ingest_reason TEXT,
            entry_id TEXT,
            sender_email TEXT
        )
    """)

    # 创建索引
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_message_id
        ON email_metadata(message_id)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_thread
        ON email_metadata(thread_id)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_date
        ON email_metadata(date_received DESC)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_sync_status
        ON email_metadata(sync_status)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_mailbox
        ON email_metadata(mailbox)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_next_retry
        ON email_metadata(next_retry_at)
        WHERE sync_status IN ('fetch_failed', 'failed')
    """)

    # 线程头缓存表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS thread_head_cache (
            thread_id TEXT PRIMARY KEY,
            status TEXT DEFAULT 'not_found',
            checked_at REAL,
            note TEXT
        )
    """)

    # 周期会议系列元数据（用于滚动展开未来 occurrences）
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS recurring_series (
            series_uid TEXT PRIMARY KEY,
            rrule_str TEXT NOT NULL,
            exdates_json TEXT DEFAULT '[]',
            rdates_json TEXT DEFAULT '[]',
            master_dtstart TEXT NOT NULL,
            master_dtend TEXT NOT NULL,
            master_summary TEXT,
            master_organizer TEXT,
            master_organizer_email TEXT,
            master_location TEXT,
            master_description TEXT,
            master_tzid TEXT,
            master_is_all_day INTEGER DEFAULT 0,
            last_sequence INTEGER DEFAULT 0,
            last_seen_message_id TEXT,
            last_expanded_until TEXT,
            last_modified TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_recurring_series_expanded_until
        ON recurring_series(last_expanded_until)
    """)

    # 兼容性：保留 sync_failures 表（如果存在，用于迁移）
    # 新代码不再使用此表

    # === v4: email_body 表（邮件正文作为一等公民进 SQLite）===
    # 详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md §4.1
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS email_body (
            internal_id INTEGER PRIMARY KEY,
            message_id TEXT,
            body_html TEXT,
            body_markdown TEXT,
            body_format TEXT,
            body_size_bytes INTEGER,
            has_inline_images INTEGER DEFAULT 0,
            raw_mime_sha256 TEXT,
            fetched_at REAL NOT NULL,
            fetched_source TEXT NOT NULL,
            schema_version INTEGER DEFAULT 1,
            FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
        )
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_body_message_id
        ON email_body(message_id) WHERE message_id IS NOT NULL
    """)

    # === v4: email_attachment 表（附件元数据，二进制落本地 data/attachments/{internal_id}/）===
    # 详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md §4.2
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS email_attachment (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            internal_id INTEGER NOT NULL,
            content_id TEXT,
            filename TEXT NOT NULL,
            content_type TEXT,
            size_bytes INTEGER,
            is_inline INTEGER DEFAULT 0,
            local_path TEXT,
            sha256 TEXT,
            derived_from INTEGER,
            derived_format TEXT,
            notion_file_id TEXT,
            notion_block_id TEXT,
            created_at REAL NOT NULL,
            schema_version INTEGER DEFAULT 1,
            FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE,
            FOREIGN KEY (derived_from) REFERENCES email_attachment(id) ON DELETE SET NULL
        )
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_attachment_internal
        ON email_attachment(internal_id)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_attachment_cid
        ON email_attachment(content_id) WHERE content_id IS NOT NULL
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_attachment_sha256
        ON email_attachment(sha256) WHERE sha256 IS NOT NULL
    """)

    # === v5: email_body_fts FTS5 全文索引 ===
    # 详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md §3.3 + docs/archive/2026-05/phase2-handoff-to-phase3.md §5.1
    # 设计稿用 contentless (content='')，但实测 snippet() / SELECT 列内容均返回空 ——
    # contentless 不存原文，snippet 无法工作。改成 contentful（FTS 自带数据副本），
    # 索引大小翻倍但实测全量 6131 封后估算 < 100 MB，完全可接受（handoff §7.3）。
    # rowid = internal_id，便于和 email_metadata / email_body 互查。
    cursor.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS email_body_fts USING fts5(
            body_markdown,
            subject,
            sender,
            tokenize='porter unicode61 remove_diacritics 2'
        )
    """)

    # Trigger：email_body 写入/更新/删除时自动维护 FTS 索引
    # 注意：subject / sender 从 email_metadata join 取，trigger 触发时
    # metadata 行已存在（双写流程 metadata 先 commit）
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_body_fts_insert
        AFTER INSERT ON email_body BEGIN
            INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
            SELECT NEW.internal_id,
                   COALESCE(NEW.body_markdown, ''),
                   COALESCE((SELECT subject FROM email_metadata WHERE internal_id = NEW.internal_id), ''),
                   COALESCE((SELECT sender  FROM email_metadata WHERE internal_id = NEW.internal_id), '');
        END
    """)
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_body_fts_delete
        AFTER DELETE ON email_body BEGIN
            DELETE FROM email_body_fts WHERE rowid = OLD.internal_id;
        END
    """)
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_body_fts_update
        AFTER UPDATE ON email_body BEGIN
            DELETE FROM email_body_fts WHERE rowid = OLD.internal_id;
            INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
            SELECT NEW.internal_id,
                   COALESCE(NEW.body_markdown, ''),
                   COALESCE((SELECT subject FROM email_metadata WHERE internal_id = NEW.internal_id), ''),
                   COALESCE((SELECT sender  FROM email_metadata WHERE internal_id = NEW.internal_id), '');
        END
    """)
    # NS-5: 主表 email_body_fts 历史隐患 —— subject/sender 改在 email_metadata 上时
    # 主表 FTS 不更新 → 按 subject/sender 搜可能命中陈旧值。补 meta_update trigger
    # (与 email_body_fts_trigram_meta_update 对齐)。无条件 CREATE IF NOT EXISTS,
    # 每次 init 幂等创建, 无需 bump DB_VERSION。仅当该 internal_id 已有 body 行时才
    # re-sync (无 body → 无 FTS 行)。不做全量回填 (既有 stale 行罕见且 pre-existing,
    # 不值 7 万行 re-sync)。
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_body_fts_meta_update
        AFTER UPDATE OF subject, sender ON email_metadata
        WHEN EXISTS (SELECT 1 FROM email_body WHERE internal_id = NEW.internal_id)
        BEGIN
            DELETE FROM email_body_fts WHERE rowid = NEW.internal_id;
            INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
            SELECT NEW.internal_id,
                   COALESCE(b.body_markdown, ''),
                   COALESCE(NEW.subject, ''),
                   COALESCE(NEW.sender, '')
              FROM email_body b WHERE b.internal_id = NEW.internal_id;
        END
    """)

    # 首次启用 reindex：把已有 email_body 行推入 FTS（migration 友好，
    # 已存在行不会重复写：用 NOT EXISTS 防重，幂等）
    # current_version 是本次 _init_database 入口处读的旧版本
    if current_version < 5:
        cursor.execute("""
            INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
            SELECT b.internal_id,
                   COALESCE(b.body_markdown, ''),
                   COALESCE(m.subject, ''),
                   COALESCE(m.sender, '')
              FROM email_body b
              JOIN email_metadata m ON m.internal_id = b.internal_id
             WHERE NOT EXISTS (
                   SELECT 1 FROM email_body_fts WHERE rowid = b.internal_id
             )
        """)
        reindexed = cursor.rowcount or 0
        if reindexed:
            logger.info(f"v5 FTS5 reindex: {reindexed} email_body rows indexed")

    # === v6: cli_checkpoints (长任务 checkpoint / resume) ===
    # PR-4 RFC §5 长任务契约。PK (command, target_key) 保证两个同批
    # `email resync --range 53000-53100` 不会互相覆盖。
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS cli_checkpoints (
            command TEXT NOT NULL,
            target_kind TEXT NOT NULL,
            target_key TEXT NOT NULL,
            last_completed_internal_id INTEGER,
            succeeded INTEGER NOT NULL DEFAULT 0,
            failed INTEGER NOT NULL DEFAULT 0,
            aborted_at REAL,
            started_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            payload TEXT,
            PRIMARY KEY (command, target_key)
        )
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_cli_checkpoints_updated
        ON cli_checkpoints(updated_at DESC)
    """)

    # === v6: v4_rollout_stats (R-06 持久化, RFC §8 选项 A) ===
    # NotionSync 内存累计 (_route_hit / _route_miss / _route_error / latency),
    # 每 60s flush 一行 (window_seconds), admin stats 读最新行 + staleness.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS v4_rollout_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            flushed_at REAL NOT NULL,
            from_sqlite_hit INTEGER NOT NULL DEFAULT 0,
            fallback_miss INTEGER NOT NULL DEFAULT 0,
            fallback_error INTEGER NOT NULL DEFAULT 0,
            route_latency_p99_ms REAL NOT NULL DEFAULT 0,
            body_miss_internal_ids TEXT,
            window_seconds INTEGER NOT NULL DEFAULT 60
        )
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_v4_rollout_flushed_at
        ON v4_rollout_stats(flushed_at DESC)
    """)

    # === v7: island_dispatch (Island-Sprint 2 ping-island 派发审计) ===
    # 来源：frontend/ISLAND-PLUGIN.md §9 评估指标
    # dispatched_ok = 1 表示 socket 路径成功（即使 ping-island 没回 decision）
    # response_decision = 用户点的 option id（仅 expectsResponse=true 且用户回应才填）
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS island_dispatch (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sent_at REAL NOT NULL,
            event_type TEXT NOT NULL,
            session_key TEXT,
            dispatched_ok INTEGER NOT NULL DEFAULT 0,
            response_decision TEXT,
            response_latency_ms INTEGER,
            internal_id INTEGER
        )
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_island_dispatch_sent_at
        ON island_dispatch(sent_at DESC)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_island_dispatch_event_type
        ON island_dispatch(event_type)
    """)

    # === v8: email_metadata 增加 is_pinned + pinned_at ===
    # 旧 v7 库已经有 email_metadata 表（无 is_pinned 列）→ ALTER TABLE 补
    # 新建库走上面的 CREATE TABLE IF NOT EXISTS 已经带这俩列
    # PRAGMA 检测列是否存在 → 避免重复迁移失败（IF NOT EXISTS 对 ADD COLUMN 不可用）
    try:
        cursor.execute("PRAGMA table_info(email_metadata)")
        existing_cols = {r[1] for r in cursor.fetchall()}
        if 'is_pinned' not in existing_cols:
            cursor.execute(
                "ALTER TABLE email_metadata ADD COLUMN is_pinned INTEGER DEFAULT 0"
            )
            logger.info("v8 migration: added email_metadata.is_pinned")
        if 'pinned_at' not in existing_cols:
            cursor.execute(
                "ALTER TABLE email_metadata ADD COLUMN pinned_at REAL"
            )
            logger.info("v8 migration: added email_metadata.pinned_at")
    except sqlite3.OperationalError as e:
        # E0-WP3: PRAGMA 预检已挡「列已存在」, 这里只会是真失败 → 复查, 缺列即中断
        _migration_guard_columns(
            cursor, "email_metadata", {"is_pinned", "pinned_at"}, "v8 migration", e
        )

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_is_pinned
        ON email_metadata(is_pinned) WHERE is_pinned = 1
    """)

    # === v9: email_metadata 增加 is_important（邮件原生重要性）===
    # 旧 v8 库已有 email_metadata 表（无 is_important 列）→ ALTER TABLE 补。
    # 历史邮件（无 raw MIME 重解析）默认 0；后续 sync 的新邮件会写入真值。
    try:
        cursor.execute("PRAGMA table_info(email_metadata)")
        cols_v9 = {r[1] for r in cursor.fetchall()}
        if 'is_important' not in cols_v9:
            cursor.execute(
                "ALTER TABLE email_metadata ADD COLUMN is_important INTEGER DEFAULT 0"
            )
            logger.info("v9 migration: added email_metadata.is_important")
    except sqlite3.OperationalError as e:
        _migration_guard_columns(
            cursor, "email_metadata", {"is_important"}, "v9 migration", e
        )

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_is_important
        ON email_metadata(is_important) WHERE is_important = 1
    """)

    # === v10: email_outbox 表（Sprint 15 SQLite SSoT inversion）===
    # 所有 mutating 操作（flag / processing_status / 反向 webhook 同步）以 intent 落库，
    # FanoutWorker 异步派发到 Mail.app + Notion。详 SPRINT15-HANDOFF.md §3。
    # target='mailapp' | 'notion' —— 单 op 拆两条入队，每条独立失败重试
    # source='frontend' | 'notion_webhook' | 'cli' —— echo prevention 依据
    # status 状态机: pending → processing → done | failed → (retry) | dead_letter
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS email_outbox (
            outbox_id     INTEGER PRIMARY KEY AUTOINCREMENT,
            internal_id   INTEGER NOT NULL,
            op_type       TEXT NOT NULL,
            target        TEXT NOT NULL,
            payload_json  TEXT NOT NULL,
            source        TEXT,
            status        TEXT NOT NULL DEFAULT 'pending',
            attempts      INTEGER NOT NULL DEFAULT 0,
            last_error    TEXT,
            next_retry_at REAL,
            created_at    REAL NOT NULL,
            updated_at    REAL NOT NULL,
            CHECK (target IN ('mailapp','notion')),
            CHECK (status IN ('pending','processing','done','failed','dead_letter')),
            FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
        )
    """)
    # 调度索引：FanoutWorker poll_ready 主路径 (status, next_retry_at)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_outbox_pending
        ON email_outbox(status, next_retry_at)
        WHERE status IN ('pending','failed')
    """)
    # 邮件级查询索引（admin queue-depth / 调试用）
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_outbox_internal_id
        ON email_outbox(internal_id)
    """)
    # 派发分类索引（per-target 统计 / fanout 分流）
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_outbox_target_status
        ON email_outbox(target, status)
    """)

    # === v11 (Sprint 16): listEnriched 性能优化索引 ===
    # 前端 EmailList 5s 轮询全量 listEnriched (3 表 LEFT JOIN + COUNT 子查询),
    # 加上 SQLite WAL busy_timeout 阻塞主线程, 现进入卡顿. 加 3 个索引覆盖
    # listEnriched 的 WHERE + ORDER + 子聚合, p99 从 200-500ms 降到 10-30ms.
    # 纯加索引非破坏, IF NOT EXISTS 幂等; 老 db 重启即生效.

    # WHERE mailbox=? AND sync_status=? ORDER BY date_received DESC — 默认列表 view
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_meta_listing
        ON email_metadata(mailbox, sync_status, date_received DESC)
    """)
    # "已标旗" 虚拟入口 (Sidebar) 用; partial index 减小尺寸
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_meta_flagged_only
        ON email_metadata(date_received DESC)
        WHERE is_flagged = 1
    """)
    # attach_count LEFT JOIN 聚合 (handlers/email.ts:listEnriched)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_attachment_visible
        ON email_attachment(internal_id, is_inline)
    """)

    # === v12 (Sprint Immersive-Translate): email_translation 缓存表 ===
    # 沉浸式翻译双路径共享缓存层：
    #   - Path A (source='llm_agent'): LLM 邮件分类时 tool_use 同时返回
    #     translation_segments, LLMRunner 在 mark_success 后写入。
    #   - Path B (source='on_demand'): 用户点击 "翻译" 按钮触发的 batch
    #     翻译, 前端 translate.ts:translate:batch 写入。
    # 设计：单语言 (zh) — 用户主语言确定，无多语言并存需求；
    #       internal_id PK + FK CASCADE — 删邮件自动清缓存；
    #       segments_json 是 JSON 数组 [{src, tgt}, ...]，src 是原文段落
    #       verbatim (≤300 字符), tgt 是简体中文译文。前端 EmailBodyFrame
    #       用 textContent.includes(src) fuzzy 配对 DOM 节点注入译文。
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS email_translation (
            internal_id   INTEGER PRIMARY KEY,
            target_lang   TEXT NOT NULL DEFAULT 'zh',
            segments_json TEXT NOT NULL,
            model         TEXT,
            source        TEXT NOT NULL,
            created_at    REAL NOT NULL,
            updated_at    REAL NOT NULL,
            CHECK (source IN ('llm_agent','on_demand')),
            FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
        )
    """)
    # source 维度统计 (admin / debug 看 LLM 路径覆盖率)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_translation_source
        ON email_translation(source)
    """)

    # === v13 (Sprint 16 dual-backend): email_metadata 加 imap_uidvalidity / imap_uid /
    # backend_origin 三列, 支持 DavMail (IMAP) backend 与 AppleScript backend 单 driver
    # 显式切换. 详见 plan §"主键 / 邮件标识策略" 方案 D.
    try:
        cursor.execute("PRAGMA table_info(email_metadata)")
        cols_v13 = {r[1] for r in cursor.fetchall()}
        if 'imap_uidvalidity' not in cols_v13:
            cursor.execute(
                "ALTER TABLE email_metadata ADD COLUMN imap_uidvalidity INTEGER"
            )
            logger.info("v13 migration: added email_metadata.imap_uidvalidity")
        if 'imap_uid' not in cols_v13:
            cursor.execute(
                "ALTER TABLE email_metadata ADD COLUMN imap_uid INTEGER"
            )
            logger.info("v13 migration: added email_metadata.imap_uid")
        if 'backend_origin' not in cols_v13:
            cursor.execute(
                "ALTER TABLE email_metadata ADD COLUMN backend_origin TEXT DEFAULT 'applescript'"
            )
            logger.info("v13 migration: added email_metadata.backend_origin (default 'applescript')")
        # Sprint 15 D 块漏的 ALTER TABLE — update_local_flags(processing_status) 假设
        # email_metadata 有 processing_status 列, 但当时只加了写入路径没加 schema.
        # 顺手补上 (idempotent, 跟 v13 一并跑).
        if 'processing_status' not in cols_v13:
            cursor.execute(
                "ALTER TABLE email_metadata ADD COLUMN processing_status TEXT"
            )
            logger.info("v13 migration: added email_metadata.processing_status (Sprint 15 D backfill)")
    except sqlite3.OperationalError as e:
        _migration_guard_columns(
            cursor,
            "email_metadata",
            {"imap_uidvalidity", "imap_uid", "backend_origin", "processing_status"},
            "v13 migration",
            e,
        )

    # ==================== v14 migration: AI 字段提升为主表列 ====================
    # 把 ai_priority / ai_action 从 llm_processing.labels_json (JSON 间接查) 提升为
    # email_metadata 主表列, 让前端按这两个字段排序 / 过滤可走索引 (json_extract 不走).
    # labels_json 仍保留全量作 backup (其他 AI 字段如 ai_summary / key_points /
    # reply_suggestion_md / category / language 不进主表, 走 JSON 灵活扩展).
    # 主写路径: LLMProcessingStore.mark_success + upsert_external_labels(source='notion')
    try:
        cursor.execute("PRAGMA table_info(email_metadata)")
        cols_v14 = {r[1] for r in cursor.fetchall()}
        if 'ai_priority' not in cols_v14:
            cursor.execute(
                "ALTER TABLE email_metadata ADD COLUMN ai_priority TEXT"
            )
            logger.info("v14 migration: added email_metadata.ai_priority")
        if 'ai_action' not in cols_v14:
            cursor.execute(
                "ALTER TABLE email_metadata ADD COLUMN ai_action TEXT"
            )
            logger.info("v14 migration: added email_metadata.ai_action")
    except sqlite3.OperationalError as e:
        _migration_guard_columns(
            cursor, "email_metadata", {"ai_priority", "ai_action"}, "v14 migration", e
        )

    # 索引: imap_uid 反查 (DavMail backend fetch_email_by_id 快路径) — partial 减小尺寸
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_imap_uid
        ON email_metadata(imap_uidvalidity, imap_uid)
        WHERE imap_uid IS NOT NULL
    """)
    # backend_origin 分组统计 / 灰度对账用
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_backend_origin
        ON email_metadata(backend_origin)
    """)
    # v14: AI 字段索引 (partial - 仅非 NULL, 大幅减小索引尺寸)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_ai_priority
        ON email_metadata(ai_priority)
        WHERE ai_priority IS NOT NULL
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_ai_action
        ON email_metadata(ai_action)
        WHERE ai_action IS NOT NULL
    """)

    # 初始化 davmail internal_id 自增序列 (起点 1_000_000_000, 永不与 Mail.app ROWID 冲突).
    # SQLite INTEGER PRIMARY KEY 不能 ALTER 成 AUTOINCREMENT, 用 sync_state KV 维护.
    cursor.execute("""
        INSERT OR IGNORE INTO sync_state (key, value, updated_at)
        VALUES ('davmail_next_internal_id', '1000000000', ?)
    """, (time.time(),))

    # ==================== v15: Calendar SSoT (CalDAV → SQLite) ====================
    # 日历事件落地表 — 前端日历视图 + CLI calendar events 子命令 + Notion mirror
    # 单一数据源. PK=id (AUTOINCREMENT), 业务唯一性靠 UNIQUE(ical_uid, recurrence_id, source).
    # 同一 ical_uid 可能跨 source 各有一行 (灰度期 caldav / legacy_calendar_app 共存):
    #   - 'caldav': CalendarSyncWorker 从 DavMail CalDAV 拉的 (Phase 1 主路径)
    #   - 'email_ics': 预留枚举, 从未实现写入 (meeting_sync 只写 Notion +
    #     recurring_series; 详见 calendar-ops.md)
    #   - 'legacy_calendar_app': calendar_main.py / src/calendar/ 老 EventKit / AppleScript
    #     路径写入 (Phase 1 灰度期保留, 2-4 周对账后下线)
    # 时间字段全部 UTC epoch (REAL), 跨时区 / DST 统一; 前端 toLocaleString 转本地展示.
    # recurrence_id 为 NULL 表示主事件 (含 RRULE); 子事件 occurrence 跳脱时存非空.
    # rrule 字符串原样保留 (RFC 5545), 前端用 npm rrule lib 展开窗口内 occurrences.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS calendar_event (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ical_uid TEXT NOT NULL,
            recurrence_id TEXT,
            sequence INTEGER NOT NULL DEFAULT 0,
            calendar_name TEXT,
            summary TEXT,
            description TEXT,
            location TEXT,
            organizer TEXT,
            attendees_json TEXT,
            dtstart_utc REAL NOT NULL,
            dtend_utc REAL,
            is_all_day INTEGER NOT NULL DEFAULT 0,
            rrule TEXT,
            exdates_json TEXT,
            rdates_json TEXT,
            status TEXT,
            response_status TEXT,
            url TEXT,
            ics_raw TEXT,
            source TEXT NOT NULL DEFAULT 'caldav',
            notion_page_id TEXT,
            related_email_internal_id INTEGER,
            last_synced_at REAL NOT NULL,
            deleted_at REAL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            tzid TEXT,  -- v35: DTSTART TZID 归一 Olson 名 (NULL=裸 Z/floating/全天); 末列对齐 ALTER 追加位置
            CHECK (source IN ('caldav', 'email_ics', 'legacy_calendar_app'))
        )
    """)
    # 唯一约束 (ical_uid, recurrence_id, source) — SQLite UNIQUE 把 NULL 视为
    # 互不相等, 主事件 (recurrence_id IS NULL) 会绕过去重. 改用 COALESCE 空串
    # 让 NULL 也参与去重. Repository upsert 走 ON CONFLICT(ical_uid, COALESCE(...))
    # 命中此 index.
    cursor.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_event_unique
        ON calendar_event(ical_uid, COALESCE(recurrence_id, ''), source)
    """)
    # 时间窗口查询 (前端日/周/月 view) — partial index 跳过软删除行
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_calendar_event_dtstart
        ON calendar_event(dtstart_utc) WHERE deleted_at IS NULL
    """)
    # ical_uid 反查 (受邀链路 cross-source dedup)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_calendar_event_uid
        ON calendar_event(ical_uid)
    """)
    # Notion mirror 反查 (page_id → event)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_calendar_event_notion
        ON calendar_event(notion_page_id) WHERE notion_page_id IS NOT NULL
    """)
    # 邮件邀请反查 (email_ics source 关联到 internal_id)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_calendar_event_email
        ON calendar_event(related_email_internal_id)
        WHERE related_email_internal_id IS NOT NULL
    """)

    # CalDAV 增量 sync 状态 — 每个 calendar 一行, RFC 6578 sync-token + ctag
    # last_full_sync_at: 全量初始化时间戳 (worker 启动一次)
    # last_incremental_sync_at: 增量 tick 时间戳 (每轮 60s)
    # sync_token: RFC 6578 sync-collection token, 失败降级到 ctag 重读窗口
    # ctag: RFC 4791 calendar collection tag, 整库变更检测 (省 sync-token call)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS calendar_sync_state (
            calendar_name TEXT PRIMARY KEY,
            ctag TEXT,
            sync_token TEXT,
            last_full_sync_at REAL,
            last_incremental_sync_at REAL,
            last_error TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
    """)

    # ==================== v34: email_meeting 邮件↔日历 ical_uid 映射 ====================
    # 一封会议邀请邮件 ↔ 它携带的 vEvent UID (RFC 5545)。消费方按 ical_uid join
    # calendar_event (idx_calendar_event_uid) 实现双向互跳:
    #   方向 A: 邮件 internal_id → uid → 日历 master 行 (「查看日程」)
    #   方向 B: ical_uid → 来源邀请邮件 (drawer 反查, 多封时优先最新 METHOD:REQUEST)
    # PK=internal_id (icalendar_parser 单 invite 语义, 一封邮件最多一条);
    # method NULL = v34 回填行 (recurring_series.last_seen 不可考 REQUEST/CANCEL)。
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS email_meeting (
            internal_id INTEGER PRIMARY KEY,
            ical_uid TEXT NOT NULL,
            method TEXT,
            recurrence_id TEXT,
            sequence INTEGER NOT NULL DEFAULT 0,
            is_recurring INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
        )
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_email_meeting_uid
        ON email_meeting(ical_uid)
    """)

    # ==================== v37: llm_processing (LLM 分类处理记账) ====================
    # 历史缺陷 (首启缺表事故): 该表原本只由 LLMProcessingStore._ensure_schema()
    # 惰性创建 (LLM_AGENT_ENABLED=false 时永不实例化), 而前端 email:listEnriched
    # 无条件 LEFT JOIN llm_processing → 全新 userData 首启邮件列表整页崩。
    # v37 起纳入版本化建表 (新/旧库均 IF NOT EXISTS 幂等); DDL 单源 = 模块级
    # LLM_PROCESSING_TABLE_DDL / LLM_PROCESSING_INDEX_DDLS (store.py 引用同常量)。
    cursor.execute(LLM_PROCESSING_TABLE_DDL)
    for _llm_ddl in LLM_PROCESSING_INDEX_DDLS:
        cursor.execute(_llm_ddl)

    # ==================== v16: 附件文本索引 (PR-2b, Sprint 19 M2) ====================
    # 把 PDF / docx / pptx / xlsx 附件文本抽出 → FTS5 索引, 让 chat agent /
    # LLM tool 跨附件检索 ('合同条款里 redis timeout 提到过吗').
    # 跟 email_body_fts (Phase 3, v5 schema) 平行: contentful FTS5 +
    # 3 trigger 自动 sync, 但走单独表 email_attachment_text + email_attachment_fts.
    # extraction 由长驻 attachment_text worker 异步消费 (src/mail/
    # attachment_text_worker.py tick_loop, service.py 注册; CLI
    # `mailagent attachment extract` 共享同一消费逻辑), 不阻塞主 sync.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS email_attachment_text (
            attachment_id INTEGER PRIMARY KEY,
            text_content TEXT,
            text_size_bytes INTEGER NOT NULL DEFAULT 0,
            extractor TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN
                ('pending', 'extracted', 'failed', 'unsupported')),
            error_message TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            next_retry_at REAL,
            extracted_at REAL,
            truncated INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            FOREIGN KEY (attachment_id) REFERENCES email_attachment(id) ON DELETE CASCADE
        )
    """)
    # 状态分布查询 (worker 取 pending) + 失败重试调度
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_att_text_status
        ON email_attachment_text(status)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_att_text_retry
        ON email_attachment_text(next_retry_at)
        WHERE status IN ('pending', 'failed')
    """)

    # FTS5 standalone 虚表 — bm25 + snippet/highlight, rowid = attachment_id
    # 反查 email_attachment 拼上下文 (filename / email subject / sender / date).
    # 风格跟 email_body_fts (v5) 一致: standalone 模式 (无 content=) — trigger
    # 用 SQL DELETE/INSERT 而非 contentful 的 special 'delete' command. 索引
    # 大小翻倍但简单 + 跟现有 trigger 模式 1:1.
    cursor.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS email_attachment_fts USING fts5(
            text_content,
            tokenize='porter unicode61 remove_diacritics 2'
        )
    """)

    # 3 个 trigger 自动 sync email_attachment_text ↔ email_attachment_fts.
    # INSERT trigger: 只在 status='extracted' 且 text_content 非空时入 FTS
    # (pending/failed/unsupported 行不索引).
    # UPDATE trigger: 先删 + 重插, 防 status 翻转 (failed → extracted) 漏入索引.
    # DELETE trigger: CASCADE 链路 (email_metadata DELETE → email_attachment
    # CASCADE → email_attachment_text CASCADE → 这里触发清理 FTS).
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_attachment_fts_insert
        AFTER INSERT ON email_attachment_text
        WHEN NEW.status = 'extracted' AND NEW.text_content IS NOT NULL
        BEGIN
            INSERT INTO email_attachment_fts(rowid, text_content)
            VALUES (NEW.attachment_id, NEW.text_content);
        END
    """)
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_attachment_fts_update
        AFTER UPDATE ON email_attachment_text
        BEGIN
            DELETE FROM email_attachment_fts WHERE rowid = OLD.attachment_id;
            INSERT INTO email_attachment_fts(rowid, text_content)
            SELECT NEW.attachment_id, NEW.text_content
            WHERE NEW.status = 'extracted' AND NEW.text_content IS NOT NULL;
        END
    """)
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_attachment_fts_delete
        AFTER DELETE ON email_attachment_text
        BEGIN
            DELETE FROM email_attachment_fts WHERE rowid = OLD.attachment_id;
        END
    """)

    # === v39: email_attachment_fts_trigram (附件正文/文件名 CJK+子串搜索, 并行 trigram 表) ===
    # 设计来源: .trellis/tasks/07-22-1-trigram-cjk-trigram PR3 (镜像上面 v24 email_body_fts_trigram
    # 方案②)。主表 email_attachment_fts (porter unicode61, 仅 text_content) 不动 → 英文/已有附件
    # 搜索逐字节零回归; 这里新增并行 contentful FTS5 表用 tokenize='trigram' 解决:
    #   ① 附件正文中文非前缀子串 (unicode61 把连续 CJK 串当单一 token, '固件' 漏掉 '固件升级');
    #   ② 附件文件名可搜 (中/英子串 —— 主表根本不索引 filename)。
    # 实测硬约束: trigram MATCH <3 个 Unicode 字符无召回 (2 字中文靠 trigram 表 LIKE 兜底, 与
    # email_body_fts_trigram 一致)。**本 PR 只建表/回填/触发器闭环, 不接任何检索路由 (PR4 才接)**。
    #
    # contentful (非 contentless): 与 email_body_fts_trigram 一致, 存原文副本支持 2 字 LIKE 兜底
    # + snippet/排名。rowid = attachment_id, 与 email_attachment / email_attachment_text 互查。
    #
    # 数据源: filename 在 email_attachment 列、text_content 在 email_attachment_text 列。3 个
    # trigger 挂 email_attachment_text (与主表 email_attachment_fts 完全同源同 status gate: 仅
    # status='extracted' AND text_content IS NOT NULL 入索引), filename 由子查询从 email_attachment
    # 取 (附件行先于其 text 落地 → 子查询恒解析到)。filename 在 email_attachment 创建后不可变
    # (代码仅 UPDATE notion_file_id/notion_block_id, 从不改 filename) → 无需 filename meta_update
    # trigger (对齐主表保守语义, 不新增维护面)。
    #
    # 级联删除: email_metadata DELETE → email_attachment CASCADE → email_attachment_text CASCADE
    # → 本表 delete trigger 触发清理 FTS。实测 (SQLite 3.53.1, recursive_triggers 默认 off) FK
    # CASCADE 删 email_attachment_text 会触发其 AFTER DELETE trigger, INSERT OR REPLACE 再抽取
    # 也保持单行 —— 与主表 email_attachment_fts 用同一机制 (见其 v16 注记), PR3 迁移测试有 cascade
    # + 再抽取 parity case 锁死。
    #
    # 幂等: CREATE VIRTUAL TABLE IF NOT EXISTS + 3 trigger IF NOT EXISTS + 回填 WHERE NOT EXISTS
    # (current_version < 39 gate, 重跑不重复插)。
    #
    # 回滚 (彻底回退 v39): 本表纯 schema 不接任何检索路径, 直接删即可:
    #   DROP TRIGGER IF EXISTS email_attachment_fts_trigram_insert;
    #   DROP TRIGGER IF EXISTS email_attachment_fts_trigram_update;
    #   DROP TRIGGER IF EXISTS email_attachment_fts_trigram_delete;
    #   DROP TABLE IF EXISTS email_attachment_fts_trigram;
    # 主表 email_attachment_fts 不动 → 回滚零风险 (附件搜索继续走 unicode 主表)。
    cursor.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS email_attachment_fts_trigram USING fts5(
            filename,
            text_content,
            tokenize='trigram'
        )
    """)
    # INSERT trigger: 只在 status='extracted' 且 text_content 非空时入 FTS (同主表 WHEN 门)。
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_attachment_fts_trigram_insert
        AFTER INSERT ON email_attachment_text
        WHEN NEW.status = 'extracted' AND NEW.text_content IS NOT NULL
        BEGIN
            INSERT INTO email_attachment_fts_trigram(rowid, filename, text_content)
            SELECT NEW.attachment_id,
                   COALESCE((SELECT filename FROM email_attachment WHERE id = NEW.attachment_id), ''),
                   NEW.text_content;
        END
    """)
    # UPDATE trigger: 先删 + 重插, 防 status 翻转 (failed → extracted) 漏入索引 (同主表)。
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_attachment_fts_trigram_update
        AFTER UPDATE ON email_attachment_text
        BEGIN
            DELETE FROM email_attachment_fts_trigram WHERE rowid = OLD.attachment_id;
            INSERT INTO email_attachment_fts_trigram(rowid, filename, text_content)
            SELECT NEW.attachment_id,
                   COALESCE((SELECT filename FROM email_attachment WHERE id = NEW.attachment_id), ''),
                   NEW.text_content
            WHERE NEW.status = 'extracted' AND NEW.text_content IS NOT NULL;
        END
    """)
    # DELETE trigger: CASCADE 链路 (email_metadata DELETE → email_attachment CASCADE →
    # email_attachment_text CASCADE → 这里触发清理 FTS)。
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_attachment_fts_trigram_delete
        AFTER DELETE ON email_attachment_text
        BEGIN
            DELETE FROM email_attachment_fts_trigram WHERE rowid = OLD.attachment_id;
        END
    """)
    # 首次回填: 把已 extracted 的附件文本 (含 filename join) 推入 trigram FTS (幂等, WHERE NOT
    # EXISTS 防重; pending/failed/unsupported 行不索引, 与主表 email_attachment_fts 一致)。
    if current_version < 39:
        cursor.execute("""
            INSERT INTO email_attachment_fts_trigram(rowid, filename, text_content)
            SELECT t.attachment_id,
                   COALESCE(a.filename, ''),
                   t.text_content
              FROM email_attachment_text t
              JOIN email_attachment a ON a.id = t.attachment_id
             WHERE t.status = 'extracted'
               AND t.text_content IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM email_attachment_fts_trigram WHERE rowid = t.attachment_id
               )
        """)
        reindexed = cursor.rowcount or 0
        if reindexed:
            logger.info(
                f"v39 attachment trigram FTS5 reindex: {reindexed} extracted attachment "
                f"texts indexed (email_attachment_fts_trigram)"
            )

    # v18: 报告 Agent 系统 —— agent 配置表 + 报告产物表。
    # Python 后端 report_worker 写, Electron main (better-sqlite3) 直读展示。
    # report_agent: 可扩展向全自定义 agent（v1 固定 type=report）。
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS report_agent (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL DEFAULT 'report',
            enabled INTEGER NOT NULL DEFAULT 0,
            title TEXT,
            schedule_json TEXT,            -- {"cadence":"daily","hours":[9],"weekday":0,"day_of_month":1}
            window_hours INTEGER,
            prompt TEXT,                   -- NULL = 用内置默认 prompt
            model TEXT,                    -- NULL = 用 config.llm_model 默认
            tools_json TEXT,               -- 预留: agent 可用 tool 白名单
            kos_enrich INTEGER NOT NULL DEFAULT 0,
            trigger_mode TEXT,             -- daily: rolling_24h | natural_day（NULL=rolling_24h）
            timezone TEXT,                 -- IANA 时区（NULL=本地）; 仅 natural_day 用
            body_full_max INTEGER,         -- 遗留(v19 早期)，不再读写；带正文改 body_full_priorities
            body_full_priorities TEXT,     -- daily: JSON 数组 of priority label，命中则带正文（NULL=默认紧急+重要）
            updated_at REAL,
            context_docs_json TEXT,        -- v27: preprocess 用 JSON 数组 of profile-doc 名（NULL=默认 soul+user）
            fallback_models_json TEXT,     -- v29: preprocess 行级 fallback 链 JSON 数组（NULL=跟随全局 LLM_FALLBACK_MODELS）
            trigger_json TEXT,             -- v30: custom agent 触发判别式（{"v":1,"kind":"cron"|"email_filter",...}；NULL=非事件型，既有三 type 不用）
            tool_policy_json TEXT,         -- v30: custom agent 工具收窄（{"v":1,"allowed_tools":[...]}；NULL=不额外收窄）
            budget_json TEXT,              -- v30: custom agent 预算（runs/day + runtime；存量 max_steps 宽容忽略；NULL=全默认）
            mark_read_after_processing INTEGER, -- v32: preprocess 处理后自动标已读（NULL=默认 true）
            context_source TEXT,           -- v38: preprocess 参考上下文源 'standing_docs'|'notion_context'（NULL=按 LLM_CONTEXT_PAGE_ID 继承派生）
            avatar_json TEXT,              -- v42: 可选头像 shape/palette/variant JSON；NULL=按 agent id 派生
            description TEXT               -- v43: 可选 agent 描述；NULL=未设置
        )
    """)
    # report: ReportDoc 块模型 SSoT（blocks_json）+ 列表展示冗余字段。
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS report (
            id TEXT PRIMARY KEY,           -- "{agent_id}:{cadence}:{report_date}"
            agent_id TEXT NOT NULL,
            cadence TEXT,
            report_date TEXT,              -- slot 日期 "YYYY-MM-DD"
            window_start TEXT,
            window_end TEXT,
            status TEXT NOT NULL DEFAULT 'generating',  -- generating|ready|failed|skipped|empty
            blocks_json TEXT,              -- ReportDoc SSoT (前端直接渲染)
            counts_json TEXT,
            headline TEXT,                 -- 冗余: 列表展示用 (从 blocks 抽)
            model TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0,
            error TEXT,
            created_at REAL,
            generated_at REAL
        )
    """)
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_report_agent_date ON report(agent_id, report_date DESC)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_report_created ON report(created_at DESC)"
    )

    # async_jobs (C1): 长任务 (batch resync / backfill) 的统一 enqueue + 执行账本。
    # 与 email_outbox 同构 (sync-engine 队列): serve 进程内 JobWorker 串行 claim
    # (status queued→running 条件 UPDATE, 仿 fanout) + 执行 (复用 LongTaskContext) +
    # 写终态。idempotency_key partial unique → 弱网重发同一 job 不重复起 (返已有 job_id)。
    # checkpoint_internal_id 让 worker 崩溃重启后从断点续跑。不复用 email_outbox
    # (outbox=字段级 merge 幂等 intent; job=带 checkpoint/熔断/进度的过程, 语义不同)。
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS async_jobs (
            job_id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_type TEXT NOT NULL,                 -- resync | backfill_body | backfill_metadata | agent_run
            target_kind TEXT NOT NULL DEFAULT '',   -- range | ids | all (LongTaskContext target_kind)
            target_key TEXT NOT NULL DEFAULT '',     -- '53000-53100' / 'ids:1,2,3' / 'all'
            params_json TEXT NOT NULL DEFAULT '{}',  -- job_type 特定参数 (replace_existing / force / ...)
            status TEXT NOT NULL DEFAULT 'queued',   -- queued|running|succeeded|partial_failure|failed|aborted
            idempotency_key TEXT,                    -- hash(job_type+target+request_id); partial unique 防弱网重发
            progress_done INTEGER NOT NULL DEFAULT 0,
            progress_total INTEGER NOT NULL DEFAULT 0,
            checkpoint_internal_id INTEGER,          -- 最后完成的 unit internal_id (crash resume floor)
            result_json TEXT,                        -- 终态 summary (succeeded/failed/aborted counts)
            last_error TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            started_at REAL,
            finished_at REAL,
            claim_token TEXT,                        -- v30 (S4 D2): agent_run fresh-spawn 能力令牌 (worker 认领时生成)
            spec_claimed_at REAL                     -- v30 (S4 D2): spec pull CAS one-shot marker (NULL=未拉取; 防双 drain)
        )
    """)
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_async_jobs_idempotency "
        "ON async_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS ix_async_jobs_status ON async_jobs(status, job_id)"
    )

    # === v19: 旧 v18 库 report_agent 无新列 → ALTER 补。**必须在 seed 前**（下面 seed
    # 引用新列）；新库 CREATE 已含, PRAGMA 检查会跳过。
    if current_version < 19:
        try:
            _ra_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
            for _c, _t in (("trigger_mode", "TEXT"), ("timezone", "TEXT"), ("body_full_max", "INTEGER"), ("body_full_priorities", "TEXT")):
                if _c not in _ra_cols:
                    cursor.execute(f"ALTER TABLE report_agent ADD COLUMN {_c} {_t}")
            logger.info("v19 migration: report_agent +trigger_mode/timezone/body_full_max")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor,
                "report_agent",
                {"trigger_mode", "timezone", "body_full_max", "body_full_priorities"},
                "v19 migration",
                e,
            )

    # 种子: 日 / 周 / 月报三个独立 agent（enabled=0, prompt=NULL→内置默认）。幂等。
    # daily=rolling_24h 触发 + 预载 15 封正文；周 / 月报走层级聚合（读子报告，无窗口 /
    # 正文配置，trigger_mode/body_full_max 留 NULL）。
    _seed_cols = (
        "(id, type, enabled, title, schedule_json, window_hours, prompt, model, "
        "tools_json, kos_enrich, trigger_mode, timezone, body_full_priorities, updated_at)"
    )
    _seed_now = time.time()
    for _id, _title, _sched, _win, _trig, _bpri in (
        ("daily_email_digest", "邮件日报", '{"cadence": "daily", "hours": [9]}', 24,
         "rolling_24h", '["🔴 紧急", "🟡 重要"]'),
        ("weekly_email_digest", "邮件周报", '{"cadence": "weekly", "hours": [9], "weekday": 0}', 168, None, None),
        # monthly_email_digest 已从默认 seed 中删除 (v28, dogfood #9): 用户未改默认态由迁移块删除
    ):
        cursor.execute(
            f"INSERT OR IGNORE INTO report_agent {_seed_cols} "
            "VALUES (?, 'report', 0, ?, ?, ?, NULL, 'claude-opus-5', NULL, 0, ?, NULL, ?, ?)",
            (_id, _title, _sched, _win, _trig, _bpri, _seed_now),
        )

    # 旧库（v18→v19 升级）daily 行已存在 → 上面 INSERT OR IGNORE 跳过 → ALTER 新列仍 NULL。
    # 补默认（仅当 NULL，幂等自愈，覆盖已升到 v19 的库）：daily 走 rolling_24h + 紧急/重要
    # 带正文；timezone 留 NULL（rolling 不需要，natural_day 时前端兜底本地）。周 / 月报新列
    # NULL 是正确语义（层级聚合无触发模式 / 正文配置），不回填。
    cursor.execute(
        "UPDATE report_agent SET trigger_mode = 'rolling_24h' "
        "WHERE id = 'daily_email_digest' AND trigger_mode IS NULL"
    )
    cursor.execute(
        "UPDATE report_agent SET body_full_priorities = ? "
        "WHERE id = 'daily_email_digest' AND body_full_priorities IS NULL",
        ('["🔴 紧急", "🟡 重要"]',),
    )

    # === v20: email_outbox merge 原子化前置 —— partial unique index ===
    # B1: enqueue 的 read-modify-write merge 换成单条原子 UPSERT
    # (ON CONFLICT(internal_id,op_type,target) WHERE status='pending'
    #  DO UPDATE json_patch)，消「TS write_ops.ts 与 Python outbox.py 两份手抄
    # merge」+ 读-改-写竞态。建唯一索引前必须先合并历史竞态产生的重复 pending
    # 行 (同 key 多条 pending → 否则 CREATE UNIQUE INDEX 失败)。幂等：已迁移库
    # 重跑时无重复行 (索引已挡) → dedup no-op。
    if current_version < 20:
        try:
            _dup_groups = cursor.execute(
                """
                SELECT internal_id, op_type, target FROM email_outbox
                 WHERE status = 'pending'
                 GROUP BY internal_id, op_type, target HAVING COUNT(*) > 1
                """
            ).fetchall()
            for _iid, _op, _tgt in _dup_groups:
                _rows = cursor.execute(
                    """
                    SELECT outbox_id, payload_json FROM email_outbox
                     WHERE internal_id = ? AND op_type = ? AND target = ?
                       AND status = 'pending'
                     ORDER BY outbox_id ASC
                    """,
                    (_iid, _op, _tgt),
                ).fetchall()
                # 按 outbox_id 升序合并 payload (后写覆盖同 key)，保留最新 (max
                # outbox_id) 那行作聚合点 (与运行时 merge 进 latest 语义一致)。
                _merged: dict = {}
                for _r in _rows:
                    try:
                        _merged.update(json.loads(_r[1] or "{}"))
                    except json.JSONDecodeError:
                        pass
                _keep_id = _rows[-1][0]
                cursor.execute(
                    "UPDATE email_outbox SET payload_json = ? WHERE outbox_id = ?",
                    (
                        json.dumps(
                            _merged, ensure_ascii=False, sort_keys=True,
                            separators=(",", ":"),
                        ),
                        _keep_id,
                    ),
                )
                cursor.executemany(
                    "DELETE FROM email_outbox WHERE outbox_id = ?",
                    [(_r[0],) for _r in _rows[:-1]],
                )
            if _dup_groups:
                logger.info(
                    f"v20 migration: merged {len(_dup_groups)} duplicate "
                    f"outbox pending group(s) before unique index"
                )
            cursor.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_pending_intent
                ON email_outbox(internal_id, op_type, target)
                WHERE status = 'pending'
                """
            )
            logger.info("v20 migration: email_outbox partial unique index ready")
        except sqlite3.OperationalError as e:
            # E0-WP3: dedup/建索引真失败被吞会让 outbox 原子 UPSERT 的
            # ON CONFLICT 目标索引缺失 (运行时写路径全挂) → 复查, 缺即中断
            _migration_guard_index(cursor, "ux_outbox_pending_intent", "v20 migration", e)

    # === v22: 多文件夹同步 ===
    # per-folder 增量游标 = email_metadata 派生的 MAX(imap_uid) (复用 Sent 模式)；
    # per-folder UIDVALIDITY 存现有 sync_state KV 表 (key=folder_uidvalidity:<imap_name>)，
    # 无需新表/新列 → 本版本是 marker-only bump (记录语义 + 同步前端 EXPECTED_DB_VERSION)。
    # 无结构迁移动作，幂等天然成立。

    # === v23: DROP 旧 folder_sync 三表 (P6 展示链路死代码清理) ===
    # 旧 FolderSyncWorker → folder_email/folder_email_fts/folder_sync_state 展示链路
    # 实测从未工作 (folder_email 0 行)。多文件夹同步走 email_metadata 主链路 (v22)。
    # 幂等: DROP ... IF EXISTS 对有无三表的库均安全。先 DROP 触发器再 DROP 表 (避免
    # AFTER DELETE 触发器在 DROP TABLE 时触碰已不存在的 FTS 影子表)。
    cursor.execute("DROP TRIGGER IF EXISTS folder_email_fts_insert")
    cursor.execute("DROP TRIGGER IF EXISTS folder_email_fts_delete")
    cursor.execute("DROP TRIGGER IF EXISTS folder_email_fts_update")
    cursor.execute("DROP TABLE IF EXISTS folder_email_fts")
    cursor.execute("DROP TABLE IF EXISTS folder_email")
    cursor.execute("DROP TABLE IF EXISTS folder_sync_state")

    # === v24: email_body_fts_trigram (T7 CJK 中文子串搜索, 并行 trigram 表) ===
    # 设计来源: .trellis/tasks/06-17-dsl-parse-warnings/research/codex-t7-tokenizer.md 方案②。
    # 主表 email_body_fts (porter unicode61) 不动 → 英文零回归; 这里新增并行 contentful
    # FTS5 表用 tokenize='trigram' 解决中文非前缀子串搜索 (unicode61 把连续 CJK 串当单一
    # token, '产品' 漏掉 '产品评审')。实测硬约束: trigram MATCH <3 个 Unicode 字符无召回
    # (2 字中文必须走 trigram 表 LIKE 兜底; 见研究报告实跑表)。
    #
    # contentful (非 contentless): 因为 2 字中文要靠 LIKE 兜底, 而 contentless 无法读列值,
    # LIKE 不可用 → 必须存原文副本。索引比 unicode61 大 (~2-3 倍), 7 万行可接受。
    # rowid = internal_id, 与 email_body / email_metadata 互查。
    #
    # 幂等: CREATE VIRTUAL TABLE IF NOT EXISTS (对新库 init 也建表) + 4 trigger IF NOT EXISTS
    # + 回填 WHERE NOT EXISTS (current_version < 24 gate, 重跑不重复插)。
    #
    # 回滚 (彻底回退 v24): 先关 SEARCH_TRIGRAM_ENABLED flag (查询立即回 unicode 路径), 必要时:
    #   DROP TRIGGER IF EXISTS email_body_fts_trigram_insert;
    #   DROP TRIGGER IF EXISTS email_body_fts_trigram_delete;
    #   DROP TRIGGER IF EXISTS email_body_fts_trigram_update;
    #   DROP TRIGGER IF EXISTS email_body_fts_trigram_meta_update;
    #   DROP TABLE IF EXISTS email_body_fts_trigram;
    # 主表 email_body_fts 不动 → 回滚低风险, 英文/已有路径不受影响。
    cursor.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS email_body_fts_trigram USING fts5(
            body_markdown,
            subject,
            sender,
            tokenize='trigram'
        )
    """)
    # insert/update/delete on email_body: 与主表 email_body_fts trigger 1:1 镜像
    # (subject/sender 从 email_metadata join 取, 双写流程 metadata 先 commit)。
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_body_fts_trigram_insert
        AFTER INSERT ON email_body BEGIN
            INSERT INTO email_body_fts_trigram(rowid, body_markdown, subject, sender)
            SELECT NEW.internal_id,
                   COALESCE(NEW.body_markdown, ''),
                   COALESCE((SELECT subject FROM email_metadata WHERE internal_id = NEW.internal_id), ''),
                   COALESCE((SELECT sender  FROM email_metadata WHERE internal_id = NEW.internal_id), '');
        END
    """)
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_body_fts_trigram_delete
        AFTER DELETE ON email_body BEGIN
            DELETE FROM email_body_fts_trigram WHERE rowid = OLD.internal_id;
        END
    """)
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_body_fts_trigram_update
        AFTER UPDATE ON email_body BEGIN
            DELETE FROM email_body_fts_trigram WHERE rowid = OLD.internal_id;
            INSERT INTO email_body_fts_trigram(rowid, body_markdown, subject, sender)
            SELECT NEW.internal_id,
                   COALESCE(NEW.body_markdown, ''),
                   COALESCE((SELECT subject FROM email_metadata WHERE internal_id = NEW.internal_id), ''),
                   COALESCE((SELECT sender  FROM email_metadata WHERE internal_id = NEW.internal_id), '');
        END
    """)
    # meta_update: 主表 email_body_fts 的历史隐患 (subject/sender 后改 → FTS stale) 在
    # trigram 表一并修。仅当该 internal_id 已有 body 行时才 re-sync (无 body → 无 FTS 行)。
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_body_fts_trigram_meta_update
        AFTER UPDATE OF subject, sender ON email_metadata
        WHEN EXISTS (SELECT 1 FROM email_body WHERE internal_id = NEW.internal_id)
        BEGIN
            DELETE FROM email_body_fts_trigram WHERE rowid = NEW.internal_id;
            INSERT INTO email_body_fts_trigram(rowid, body_markdown, subject, sender)
            SELECT NEW.internal_id,
                   COALESCE(b.body_markdown, ''),
                   COALESCE(NEW.subject, ''),
                   COALESCE(NEW.sender, '')
              FROM email_body b WHERE b.internal_id = NEW.internal_id;
        END
    """)
    # 首次回填: 把已有 email_body 行推入 trigram FTS (幂等, WHERE NOT EXISTS 防重)。
    # 大库 7 万行可能耗时, 带计数日志 (参考 v5 reindex 风格)。
    if current_version < 24:
        cursor.execute("""
            INSERT INTO email_body_fts_trigram(rowid, body_markdown, subject, sender)
            SELECT b.internal_id,
                   COALESCE(b.body_markdown, ''),
                   COALESCE(m.subject, ''),
                   COALESCE(m.sender, '')
              FROM email_body b
              JOIN email_metadata m ON m.internal_id = b.internal_id
             WHERE NOT EXISTS (
                   SELECT 1 FROM email_body_fts_trigram WHERE rowid = b.internal_id
             )
        """)
        reindexed = cursor.rowcount or 0
        if reindexed:
            logger.info(
                f"v24 trigram FTS5 reindex: {reindexed} email_body rows indexed "
                f"(email_body_fts_trigram)"
            )

    # === v25: email_recipient_fts (T8 收件人全文化, 并行 contentful FTS5 表) ===
    # 设计来源: .trellis/tasks/06-17-dsl-parse-warnings 方案②保守。
    # 主表 email_body_fts (body/subject/sender) 不动 → 裸词搜索逐字节零回归
    # (裸词天然不碰收件人列, 正是②保守语义)。这里新增并行 contentful FTS5 表索引
    # email_metadata 的 to_addr / cc_addr / sender_name 三列, 仅由新增的显式 FTS 列
    # 语法 to~:/cc~:/from~: 查询。无 flag (纯新增 opt-in 语法, 不改任何现有行为)。
    #
    # 数据源是 email_metadata (to_addr/cc_addr/sender_name 都在 email_metadata 列),
    # 与 body_fts (来自 email_body) 不同 → trigger 直接挂 email_metadata:
    #   - AFTER INSERT: 新邮件行写入 → 同步进 recipient_fts。
    #   - AFTER UPDATE OF to_addr,cc_addr,sender_name: 仅这三列变更才 DELETE+INSERT 重同步。
    #   - AFTER DELETE: 邮件行删除 → 清 recipient_fts。
    # contentful (非 contentless): 与 body_fts/trigram 表一致, 自带数据副本支持 snippet/排名。
    # rowid = internal_id, 与 email_metadata 互查。
    #
    # 幂等: CREATE VIRTUAL TABLE IF NOT EXISTS + 3 trigger IF NOT EXISTS + 回填
    # WHERE NOT EXISTS (current_version < 25 gate, 重跑不重复插)。
    #
    # 回滚 (彻底回退 v25): 三个新语法只在 parser 显式列名出现时生效, 不影响裸词; 必要时:
    #   DROP TRIGGER IF EXISTS email_recipient_fts_insert;
    #   DROP TRIGGER IF EXISTS email_recipient_fts_update;
    #   DROP TRIGGER IF EXISTS email_recipient_fts_delete;
    #   DROP TABLE IF EXISTS email_recipient_fts;
    # 主表 email_body_fts / email_body_fts_trigram 不动 → 回滚低风险。
    cursor.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS email_recipient_fts USING fts5(
            to_addr,
            cc_addr,
            sender_name,
            tokenize='porter unicode61 remove_diacritics 2'
        )
    """)
    # insert/update_of/delete on email_metadata (数据源直接是 email_metadata 三列)。
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_recipient_fts_insert
        AFTER INSERT ON email_metadata BEGIN
            INSERT INTO email_recipient_fts(rowid, to_addr, cc_addr, sender_name)
            VALUES (NEW.internal_id,
                    COALESCE(NEW.to_addr, ''),
                    COALESCE(NEW.cc_addr, ''),
                    COALESCE(NEW.sender_name, ''));
        END
    """)
    # 仅 to_addr/cc_addr/sender_name 三列变更才重同步 (其余列更新不触发, 省开销)。
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_recipient_fts_update
        AFTER UPDATE OF to_addr, cc_addr, sender_name ON email_metadata BEGIN
            DELETE FROM email_recipient_fts WHERE rowid = OLD.internal_id;
            INSERT INTO email_recipient_fts(rowid, to_addr, cc_addr, sender_name)
            VALUES (NEW.internal_id,
                    COALESCE(NEW.to_addr, ''),
                    COALESCE(NEW.cc_addr, ''),
                    COALESCE(NEW.sender_name, ''));
        END
    """)
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS email_recipient_fts_delete
        AFTER DELETE ON email_metadata BEGIN
            DELETE FROM email_recipient_fts WHERE rowid = OLD.internal_id;
        END
    """)
    # 首次回填: 把已有 email_metadata 行推入 recipient FTS (幂等, WHERE NOT EXISTS 防重)。
    # 大库 7 万行可能耗时, 带计数日志 (参考 v24 reindex 风格)。
    if current_version < 25:
        cursor.execute("""
            INSERT INTO email_recipient_fts(rowid, to_addr, cc_addr, sender_name)
            SELECT m.internal_id,
                   COALESCE(m.to_addr, ''),
                   COALESCE(m.cc_addr, ''),
                   COALESCE(m.sender_name, '')
              FROM email_metadata m
             WHERE NOT EXISTS (
                   SELECT 1 FROM email_recipient_fts WHERE rowid = m.internal_id
             )
        """)
        reindexed = cursor.rowcount or 0
        if reindexed:
            logger.info(
                f"v25 recipient FTS5 reindex: {reindexed} email_metadata rows "
                f"indexed (email_recipient_fts)"
            )

    # === v26: agentic 搜索 = 特化 Custom Agent (复用 report_agent 表, 无 DDL) ===
    # 设计来源: .trellis/tasks/06-17-dsl-parse-warnings/agentic-search-impl-plan.md §3.3。
    # 把"搜索"做成一个特化 Custom Agent: 复用 report_agent 表的 type 多态 + model/prompt/
    # tools_json 列 (v18 起全在), 播种一行 type='search' 的搜索 agent。无新表/新列 → 纯 seed。
    #
    # 种子语义: id='email_search_agent', type='search', enabled=1, model=NULL (运行时回退
    # getLlmModel), prompt=NULL (运行时回退内置默认搜索 prompt), tools_json 给 MVP 唯一工具
    # email_search_fulltext (已含 DSL+FTS+中文 trigram+收件人 T5-T8), title='邮件搜索'。
    # report 专属列 (schedule/window/kos_enrich/…) 留 NULL/DEFAULT, search agent 不需要。
    #
    # 幂等: INSERT OR IGNORE (id PK 冲突即跳过), 重跑无副作用; 旧库已有此行 → 跳过, 不覆盖
    # 用户改过的 model/prompt/tools。
    #
    # 回滚 (回退 v26): DELETE FROM report_agent WHERE id='email_search_agent'; 必要时降
    # db_version。无表结构变更, 删行无副作用 (主表/其他 agent 不动)。
    cursor.execute(
        "INSERT OR IGNORE INTO report_agent "
        "(id, type, enabled, title, model, prompt, tools_json, updated_at) "
        "VALUES ('email_search_agent', 'search', 1, '邮件搜索', NULL, NULL, ?, ?)",
        ('["email_search_fulltext"]', time.time()),
    )

    # === v27: AI 邮件预处理 = 特化 Custom Agent (复用 report_agent 表) + context_docs_json 列 ===
    # issue #31/#32 Part2 增量2。把"AI 邮件分类/预处理"做成 Agents 页第三种 Custom Agent
    # (type='preprocess')：persona 复用 prompt 列、文档勾选存新列 context_docs_json (JSON 数组
    # of profile-doc 名, 如 ["soul","user"])。开关/模型仍走全局 env (LLM_AGENT_ENABLED/
    # LLM_MODEL)，运行时对 persona/docs 做 NULL-safe 叠加 (不填=字节级回退现状)。
    # ① ALTER 补 context_docs_json 列 (**必须在下面 seed 前**, seed 引用它)；新库 CREATE 已含 →
    #    PRAGMA 检查跳过。旧库 (v18-v26) 补列, 已存在则 no-op。
    if current_version < 27:
        try:
            _pa_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
            if "context_docs_json" not in _pa_cols:
                cursor.execute("ALTER TABLE report_agent ADD COLUMN context_docs_json TEXT")
                logger.info("v27 migration: report_agent +context_docs_json")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor, "report_agent", {"context_docs_json"}, "v27 migration", e
            )
    # ② 播种 type='preprocess' 行。幂等 (INSERT OR IGNORE), 旧库已有则跳过、不覆盖用户改过的
    #    prompt/docs。enabled=0/model=NULL 是占位 (预处理开关/模型走全局 env, 非本行);
    #    context_docs_json 默认 ["soul","user"] = 对齐 build_task_identity_context 默认 → 卡片
    #    未动时行为字节一致。worker.py 调度器只跑 type=='report', 天然不碰本行。
    #    回滚 (回退 v27): DELETE FROM report_agent WHERE id='email_preprocess_agent'。
    cursor.execute(
        "INSERT OR IGNORE INTO report_agent "
        "(id, type, enabled, title, model, prompt, tools_json, context_docs_json, updated_at) "
        "VALUES ('email_preprocess_agent', 'preprocess', 0, 'AI 邮件预处理', NULL, NULL, NULL, ?, ?)",
        ('["soul", "user"]', time.time()),
    )

    # === v28: 删 monthly_email_digest 默认 seed 行 (dogfood 反馈 #9) ===
    # 仅删未被用户改动过的默认态行（enabled=0 AND prompt IS NULL）, 保客制化。
    # 新库: v19 seed 块已不播种月报, 本迁移是对已存在旧库的清理; 幂等 (无行则 DELETE 零影响)。
    # 回滚 (回退 v28): 月报行已删不自动恢复; 手动 INSERT 或降 db_version。
    if current_version < 28:
        cursor.execute(
            "DELETE FROM report_agent "
            "WHERE id = 'monthly_email_digest' AND enabled = 0 AND prompt IS NULL"
        )
        logger.info("v28 migration: monthly_email_digest default row removed")

    # === v29: report_agent 加 fallback_models_json 列 (dogfood R2 反馈 #2) ===
    # 预处理 fallback 从全局 env (LLM_FALLBACK_MODELS) 拆出行级列: NULL = 跟随全局
    # (老用户升级零感知)、'[]' = 显式不设兜底、JSON 数组 = 预处理专用链。无 seed 变更。
    # 新库 CREATE 已含 → PRAGMA 检查跳过; 旧库 (v18-v28) 补列, 已存在则 no-op。
    # 回滚 (回退 v29): 列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
    if current_version < 29:
        try:
            _pa_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
            if "fallback_models_json" not in _pa_cols:
                cursor.execute("ALTER TABLE report_agent ADD COLUMN fallback_models_json TEXT")
                logger.info("v29 migration: report_agent +fallback_models_json")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor, "report_agent", {"fallback_models_json"}, "v29 migration", e
            )

    # === v30: Custom Agent 内核 S4 W1 —— report_agent 加 trigger/tool_policy/budget 三列 +
    # async_jobs 加 claim_token/spec_claimed_at 两列 (S4 fresh-spawn CAS)。全 additive TEXT NULL,
    # 旧库对既有行/调用零影响 (NULL = 非事件型 / 不收窄 / 全默认 / 未拉取)。新库 CREATE 已含 →
    # PRAGMA 检查跳过; 旧库 (v18-v29) 补列, 已存在则 no-op。无 seed (type='custom' 行由 owner 创建)。
    # 回滚 (回退 v30): 五列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
    if current_version < 30:
        try:
            _ra_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
            for _c in ("trigger_json", "tool_policy_json", "budget_json"):
                if _c not in _ra_cols:
                    cursor.execute(f"ALTER TABLE report_agent ADD COLUMN {_c} TEXT")
            logger.info("v30 migration: report_agent +trigger_json/tool_policy_json/budget_json")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor, "report_agent",
                {"trigger_json", "tool_policy_json", "budget_json"}, "v30 migration", e,
            )
        try:
            _aj_cols = {r[1] for r in cursor.execute("PRAGMA table_info(async_jobs)").fetchall()}
            for _c, _t in (("claim_token", "TEXT"), ("spec_claimed_at", "REAL")):
                if _c not in _aj_cols:
                    cursor.execute(f"ALTER TABLE async_jobs ADD COLUMN {_c} {_t}")
            logger.info("v30 migration: async_jobs +claim_token/spec_claimed_at")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor, "async_jobs",
                {"claim_token", "spec_claimed_at"}, "v30 migration", e,
            )

    # === v31: 项目周报 sync 迁入 custom agent 框架 —— 播种 type='project_progress' 单例行 ===
    # S5 W5a（P2 拍板）。把"项目周报邮件 → 触发确定性 xlsx→Notion sync"做成 Agents 页第四种专型
    # 行（type='project_progress'，id='project_progress_sync'）：**无 DDL**（复用 v30 trigger_json 列）。
    # 触发配置（sender/subject）与 enabled 从 env 播种一次 → 之后 Settings 抽屉可改（行权威）；总闸仍
    # 是 env PROJECT_PROGRESS_SYNC_ENABLED。**执行不进 async_jobs / gateway** —— runner 逐字不变，
    # new_watcher hook 仍直调（P1：框架不容纳非 LLM 执行体，项目周报只把触发配置搬进行）。
    #
    # trigger_json 用 email_filter 词汇（subject_pattern/sender_pattern），但 project_progress 走
    # ProjectProgressDetector（子串-sender + 正则-subject），**非** AgentEmailMatcher（正则-sender）—— 逐字
    # 保持子串语义（行为等价）。sender 是 email 子串，作 email_filter regex 校验也能编译（drawer 保存
    # 时经 validate_agent_config_patch），运行时仍子串匹配。env 全空 → 空 pattern（detector 永不匹配 =
    # 现状"全空永不匹配"）。
    #
    # env 值经 pydantic settings 读（serve-api **不** load_dotenv —— 直读 os.environ 会读空，
    # 迁移可能在 serve-api 进程先跑；settings 在两个进程都从 env_file / os.environ 正确填充）。
    # 幂等: INSERT OR IGNORE（旧库已有则跳过、不覆盖用户改过的 enabled/trigger）。
    # 回滚 (回退 v31): DELETE FROM report_agent WHERE id='project_progress_sync'。
    if current_version < 31:
        try:
            from src.config import config as _settings
            _pp_enabled = 1 if getattr(_settings, "project_progress_auto_sync_enabled", False) else 0
            _pp_subject = getattr(_settings, "project_progress_subject_pattern", "") or ""
            _pp_sender = getattr(_settings, "project_progress_sender", "") or ""
        except Exception as e:  # noqa: BLE001 — config 不可得（裸测试环境）→ 安全默认（禁用 + 空触发）
            logger.debug(f"v31 migration: settings unavailable, seed with safe defaults: {e}")
            _pp_enabled, _pp_subject, _pp_sender = 0, "", ""
        _pp_trigger = json.dumps(
            {
                "v": 1,
                "kind": "email_filter",
                "subject_pattern": _pp_subject,
                "sender_pattern": _pp_sender,
            },
            ensure_ascii=False,
        )
        cursor.execute(
            "INSERT OR IGNORE INTO report_agent "
            "(id, type, enabled, title, model, prompt, tools_json, trigger_json, updated_at) "
            "VALUES ('project_progress_sync', 'project_progress', ?, '项目周报同步', "
            "NULL, NULL, NULL, ?, ?)",
            (_pp_enabled, _pp_trigger, time.time()),
        )
        logger.info(
            f"v31 migration: project_progress_sync seeded "
            f"(enabled={_pp_enabled}, subject={_pp_subject!r}, sender={_pp_sender!r})"
        )

    # === v32: preprocess 行级「处理后自动标已读」开关 ===
    # 新库 CREATE 已含 → PRAGMA 跳过；旧库补 INTEGER 列。NULL 语义仍是默认 true，
    # 但对固定 preprocess 行显式回填 1，便于 Settings 读写与数据审计。UPDATE 幂等。
    if current_version < 32:
        try:
            _pa_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
            if "mark_read_after_processing" not in _pa_cols:
                cursor.execute(
                    "ALTER TABLE report_agent ADD COLUMN mark_read_after_processing INTEGER"
                )
                logger.info("v32 migration: report_agent +mark_read_after_processing")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor,
                "report_agent",
                {"mark_read_after_processing"},
                "v32 migration",
                e,
            )
        cursor.execute(
            "UPDATE report_agent SET mark_read_after_processing = 1 "
            "WHERE id = 'email_preprocess_agent' "
            "AND mark_read_after_processing IS NULL"
        )
        logger.info("v32 migration: preprocess mark_read_after_processing defaulted to 1")

    # === v33: email_metadata.snippet 去规范化正文预览 ===
    if current_version < 33:
        try:
            cursor.execute("PRAGMA table_info(email_metadata)")
            columns = {row[1] for row in cursor.fetchall()}
            if "snippet" not in columns:
                cursor.execute("ALTER TABLE email_metadata ADD COLUMN snippet TEXT")
                logger.info("v33 migration: email_metadata +snippet")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor, "email_metadata", {"snippet"}, "v33 migration", e,
            )
        cursor.execute("""
            UPDATE email_metadata
               SET snippet = (
                   SELECT substr(b.body_markdown, 1, 100)
                     FROM email_body b
                    WHERE b.internal_id = email_metadata.internal_id
               )
             WHERE snippet IS NULL
               AND EXISTS (
                   SELECT 1 FROM email_body b
                    WHERE b.internal_id = email_metadata.internal_id
               )
        """)
        logger.info("v33 migration: email_metadata.snippet backfilled")

    # === v34: email_meeting 回填 (recurring_series → email_meeting best-effort) ===
    # 表本身由上面 CREATE TABLE IF NOT EXISTS 建 (新/旧库均生效)。这里只做存量
    # 回填: 每个 recurring_series 的 last_seen_message_id 对应邮件写一条映射行,
    # method=NULL (series 行的 last_seen 可能是 REQUEST 或 CANCEL, 不可考),
    # is_recurring=1。存量非周期邀请无 uid 可回填 (raw MIME 未存)。
    if current_version < 34:
        # 数据回填是 best-effort (映射缺失 = 查询面 404, 可经 replay 路径补),
        # 不同于 schema 建表 (fail-loud): 异常降级 warning 不中断迁移链。
        try:
            cursor.execute("""
                INSERT OR IGNORE INTO email_meeting (
                    internal_id, ical_uid, method, recurrence_id,
                    sequence, is_recurring, created_at, updated_at
                )
                SELECT em.internal_id, rs.series_uid, NULL, NULL,
                       COALESCE(rs.last_sequence, 0), 1, ?, ?
                FROM recurring_series rs
                JOIN email_metadata em ON em.message_id = rs.last_seen_message_id
                WHERE rs.last_seen_message_id IS NOT NULL
            """, (time.time(), time.time()))
            logger.info(
                f"v34 migration: email_meeting backfilled from recurring_series "
                f"({cursor.rowcount} rows)"
            )
        except sqlite3.Error as e:
            logger.warning(f"v34 migration: email_meeting backfill skipped: {e}")

    # === v35: calendar_event.tzid (#10 tzid 半步) ===
    # 旧库补列 (新库 CREATE 已含 → PRAGMA 跳过)。无数据回填: NULL = 修复前
    # UTC 语义, 下轮全量 CalDAV sync 重新 upsert 自然带上 tzid。
    if current_version < 35:
        try:
            _ce_cols = {r[1] for r in cursor.execute("PRAGMA table_info(calendar_event)").fetchall()}
            if "tzid" not in _ce_cols:
                cursor.execute("ALTER TABLE calendar_event ADD COLUMN tzid TEXT")
                logger.info("v35 migration: calendar_event +tzid")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor, "calendar_event", {"tzid"}, "v35 migration", e,
            )

    # === v36: email_metadata 草稿线程 linkage 3 列 (compose Bug A) ===
    # 旧库补列 (新库 CREATE 已含 → PRAGMA 跳过)。无数据回填: 存量草稿行 NULL =
    # 修复前语义 (发送不带 threading), 新草稿由 mirror/reconcile 写入。
    if current_version < 36:
        _draft_cols = {
            "draft_source_internal_id": "INTEGER",
            "draft_in_reply_to": "TEXT",
            "draft_references": "TEXT",
        }
        try:
            cursor.execute("PRAGMA table_info(email_metadata)")
            _em_cols = {row[1] for row in cursor.fetchall()}
            for _col, _typ in _draft_cols.items():
                if _col not in _em_cols:
                    cursor.execute(
                        f"ALTER TABLE email_metadata ADD COLUMN {_col} {_typ}"
                    )
                    logger.info(f"v36 migration: email_metadata +{_col}")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor, "email_metadata", set(_draft_cols), "v36 migration", e,
            )

    # === v37: llm_processing 纳入版本化建表 (首启缺表修复) ===
    # 表 + 两索引由上面的 v37 段无条件 CREATE ... IF NOT EXISTS 建 (新/旧库均
    # 生效, 幂等), 无数据回填 → 无需 current_version gate (镜像 v22 marker-only
    # + v34 建表模式)。bump 版本号 = 对外承诺「db_version>=37 ⇒ llm_processing
    # 已建」, 供前端 backend_lifecycle.ts 就绪门控 + admin health REQUIRED_TABLES。

    # === v38: preprocess 参考上下文源迁 report_agent 行存储 (task 07-22) ===
    # 新库 CREATE 已含 context_source → PRAGMA 跳过 ALTER；旧库补 TEXT 列。seed 一次性
    # 回填 preprocess 行 (行落地后行权威, env 键降级为首次 seed 默认——镜像 v31
    # project_progress trigger 行内热读先例): env LLM_PREPROCESS_CONTEXT_SOURCE 显式合法值
    # → 写入行; 否则按 LLM_CONTEXT_PAGE_ID 非空 → 'notion_context', 空 → 'standing_docs'
    # (与旧 _resolve_context_source 继承规则逐字一致 → 升级前后注入形态零变化)。
    # env 值经 pydantic settings 读 (serve-api 不 load_dotenv, 但 settings 在两进程都从
    # env_file / os.environ 正确填充, 同 v31 先例)。幂等: ALTER 前 PRAGMA 检查 + 仅回填
    # context_source IS NULL 的固定 preprocess 行 (不覆盖用户改过的值)。
    if current_version < 38:
        try:
            _pa_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
            if "context_source" not in _pa_cols:
                cursor.execute("ALTER TABLE report_agent ADD COLUMN context_source TEXT")
                logger.info("v38 migration: report_agent +context_source")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor, "report_agent", {"context_source"}, "v38 migration", e,
            )
        try:
            from src.config import config as _settings
            _raw_src = (getattr(_settings, "llm_preprocess_context_source", "") or "").strip().lower()
            _page_id = (getattr(_settings, "llm_context_page_id", "") or "").strip()
        except Exception as e:  # noqa: BLE001 — config 不可得 (裸测试环境) → 安全继承 (无 env → standing_docs)
            logger.debug(f"v38 migration: settings unavailable, seed via inheritance defaults: {e}")
            _raw_src, _page_id = "", ""
        if _raw_src in ("standing_docs", "notion_context"):
            _seed_src = _raw_src
        else:
            _seed_src = "notion_context" if _page_id else "standing_docs"
        cursor.execute(
            "UPDATE report_agent SET context_source = ? "
            "WHERE id = 'email_preprocess_agent' AND context_source IS NULL",
            (_seed_src,),
        )
        logger.info(f"v38 migration: preprocess context_source seeded to {_seed_src!r}")

    # === v40: email_metadata.in_reply_to (KOS Thread 链接反查) ===
    # 新库 CREATE 已含 in_reply_to → PRAGMA 跳过 ALTER；旧库补 nullable TEXT 列。
    # 无数据回填: 存量行 NULL = 修复前语义 (In-Reply-To 解析后即丢弃), 新邮件由
    # reader/davmail 两条解析路径 + _persist_email_metadata_after_parse 落库
    # (forward-only, 无 backfill re-push)。
    if current_version < 40:
        try:
            cursor.execute("PRAGMA table_info(email_metadata)")
            _em_cols = {row[1] for row in cursor.fetchall()}
            if "in_reply_to" not in _em_cols:
                cursor.execute("ALTER TABLE email_metadata ADD COLUMN in_reply_to TEXT")
                logger.info("v40 migration: email_metadata +in_reply_to")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor, "email_metadata", {"in_reply_to"}, "v40 migration", e,
            )

    # === v41: kos_ingest_log 升格正式表 (issue #59) ===
    # 无条件幂等 (镜像 v37 llm_processing / v22 marker 模式, 无 current_version gate):
    # CREATE IF NOT EXISTS 对新库直接建全形状; 老库若已被 bulk_ingest 惰性建成 6 列
    # 旧形状, PRAGMA 判断后 ALTER 补 4 列; 最后建调度索引 (依赖 next_retry_at,
    # 顺序在补列之后)。D2: 不受 MAILAGENT_KOS_INGEST_ENABLED 影响。
    try:
        ensure_kos_ingest_log_schema(cursor)
    except sqlite3.OperationalError as e:
        # 双重复查: ensure 内建表→补列→建索引三步任一真失败都必须让迁移中断
        # (只查列会吞掉「列全在位但索引没建成」的失败形态)。
        _migration_guard_columns(
            cursor, "kos_ingest_log", set(KOS_INGEST_LOG_RETRY_COLUMNS),
            "v41 migration", e,
        )
        _migration_guard_index(cursor, "idx_kos_ingest_retry", "v41 migration", e)
    # 一次性: 老 bulk 时代遗留的 failed 行 next_retry_at=NULL → 永远不满足重试
    # 扫描的 due 判据 (next_retry_at <= now), 会以"永久积压"形态挂在 Dashboard 上。
    # 给它们排一次立即到期, 让重试 worker 自动收编 (成功→pushed / 仍失败→按退避
    # 重排或转 dead)。gate 在 <41: 41 之后所有 failed 行都由 record_failure 写,
    # 恒带 next_retry_at。
    if current_version < 41:
        _stale = cursor.execute(
            "UPDATE kos_ingest_log SET next_retry_at = ? "
            "WHERE status = 'failed' AND next_retry_at IS NULL",
            (time.time(),),
        ).rowcount
        if _stale:
            logger.info(
                f"v41 migration: scheduled {_stale} legacy failed "
                f"kos_ingest_log row(s) for retry"
            )
        # 🔴 ALTER ADD COLUMN 后必须显式回填 (本仓 ALTER+seed 教训): 存量行
        # (生产实测 7471 行) 全是 bulk 写的 —— producer 在 v41 之前从不记账,
        # 所以 source IS NULL ⇒ 'bulk' 是精确回填, 不是猜测。
        _src = cursor.execute(
            "UPDATE kos_ingest_log SET source = 'bulk' WHERE source IS NULL"
        ).rowcount
        if _src:
            logger.info(
                f"v41 migration: backfilled source='bulk' for {_src} "
                f"pre-existing kos_ingest_log row(s)"
            )

    # === v42: report_agent avatar identity ===
    # 新库 CREATE 已含列；旧库 additive ALTER。NULL 保持确定性默认，不回填 240 种组合。
    if current_version < 42:
        try:
            cursor.execute("PRAGMA table_info(report_agent)")
            _agent_cols = {row[1] for row in cursor.fetchall()}
            if "avatar_json" not in _agent_cols:
                cursor.execute("ALTER TABLE report_agent ADD COLUMN avatar_json TEXT")
                logger.info("v42 migration: report_agent +avatar_json")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor, "report_agent", {"avatar_json"}, "v42 migration", e,
            )

    # === v43: report_agent description ===
    if current_version < 43:
        try:
            cursor.execute("PRAGMA table_info(report_agent)")
            _agent_cols = {row[1] for row in cursor.fetchall()}
            if "description" not in _agent_cols:
                cursor.execute("ALTER TABLE report_agent ADD COLUMN description TEXT")
                logger.info("v43 migration: report_agent +description")
        except sqlite3.OperationalError as e:
            _migration_guard_columns(
                cursor, "report_agent", {"description"}, "v43 migration", e,
            )

    # === v44: Matter aggregate base tables (P1) ===
    if current_version < 44:
        try:
            for ddl in MATTER_TABLE_DDLS:
                cursor.execute(ddl)
            for ddl in MATTER_INDEX_DDLS:
                cursor.execute(ddl)
        except sqlite3.OperationalError as e:
            required = {"matter_seq", "matter", "matter_item", "matter_event", "matter_update"}
            present = {
                row[0]
                for row in cursor.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            missing = sorted(required - present)
            if missing:
                raise SyncStoreMigrationError(
                    f"v44 migration: tables still missing {missing}: {e}"
                ) from e
            raise

    # === v45: Matter resources, stakeholders, relations, search projection ===
    if current_version < 45:
        try:
            for ddl in MATTER_TABLE_DDLS:
                cursor.execute(ddl)

            item_fks = {
                (row[2], row[3], row[6])
                for row in cursor.execute("PRAGMA foreign_key_list(matter_item)")
            }
            event_fks = {
                (row[2], row[3], row[6])
                for row in cursor.execute("PRAGMA foreign_key_list(matter_event)")
            }
            needs_rebuild = not {
                ("matter_stakeholder", "waiting_on_stakeholder_id", "SET NULL"),
                ("resource", "source_resource_id", "SET NULL"),
            }.issubset(item_fks) or (
                "resource", "resource_id", "SET NULL"
            ) not in event_fks

            if needs_rebuild:
                cursor.execute("PRAGMA defer_foreign_keys = ON")
                item_ddl = MATTER_TABLE_DDLS[2].replace(
                    "CREATE TABLE IF NOT EXISTS matter_item",
                    "CREATE TABLE matter_item_v45",
                    1,
                )
                event_ddl = (
                    MATTER_TABLE_DDLS[3]
                    .replace(
                        "CREATE TABLE IF NOT EXISTS matter_event",
                        "CREATE TABLE matter_event_v45",
                        1,
                    )
                    .replace("REFERENCES matter_item(id)", "REFERENCES matter_item_v45(id)")
                    .replace("REFERENCES matter_event(id)", "REFERENCES matter_event_v45(id)")
                )
                cursor.execute("DROP TABLE IF EXISTS matter_event_v45")
                cursor.execute("DROP TABLE IF EXISTS matter_item_v45")
                cursor.execute(item_ddl)
                cursor.execute(event_ddl)
                # 🔴 matter_item 这一趟必须**显式列名**而不是 `SELECT *`: v71 起
                # canonical DDL 带了 exec_profile, 而恰好停在 v44 的老库那张表没有这一
                # 列 —— `SELECT *` 会以「24 列表收到 23 个值」当场炸掉整条升级梯子。
                # 搬旧表有的那些列, 新列留空 = 它自己的缺省语义 (exec_profile NULL =
                # propose_only)。matter_event 本批没加列, 维持原样。
                old_item_cols = [
                    row[1]
                    for row in cursor.execute(
                        "PRAGMA table_info(matter_item)"
                    ).fetchall()
                ]
                new_item_cols = {
                    row[1]
                    for row in cursor.execute(
                        "PRAGMA table_info(matter_item_v45)"
                    ).fetchall()
                }
                carried = ", ".join(
                    column for column in old_item_cols if column in new_item_cols
                )
                cursor.execute(
                    f"INSERT INTO matter_item_v45 ({carried}) "
                    f"SELECT {carried} FROM matter_item"
                )
                cursor.execute(
                    "INSERT INTO matter_event_v45 SELECT * FROM matter_event"
                )
                cursor.execute("DROP TABLE matter_event")
                cursor.execute("DROP TABLE matter_item")
                cursor.execute("ALTER TABLE matter_item_v45 RENAME TO matter_item")
                cursor.execute("ALTER TABLE matter_event_v45 RENAME TO matter_event")

            for ddl in MATTER_INDEX_DDLS:
                cursor.execute(ddl)

            from src.matters.repository import MatterRepository

            repository = MatterRepository(db_path)
            matter_ids = [
                int(row[0]) for row in cursor.execute("SELECT id FROM matter")
            ]
            for matter_id in matter_ids:
                repository.refresh_search_projection(conn, matter_id)

            # 只查本次 rebuild 的两张表——全库 foreign_key_check 会把无关表的
            # 历史畸形（如老迁移测试用 CTAS 重建、丢了 PK 的 email_metadata 造成
            # "foreign key mismatch"）算到 v45 头上，v45 只对自己动过的表负责。
            violations = [
                *cursor.execute("PRAGMA foreign_key_check(matter_item)").fetchall(),
                *cursor.execute("PRAGMA foreign_key_check(matter_event)").fetchall(),
            ]
            if violations:
                raise SyncStoreMigrationError(
                    f"v45 migration: foreign_key_check failed: {violations}"
                )
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            raise SyncStoreMigrationError(f"v45 migration failed: {e}") from e

    # === v46: Matter agent runs + binding columns (P4) ===
    # matter_run 表 + 4 索引 (DDL 单源 MATTER_TABLE_DDLS/MATTER_INDEX_DDLS,
    # IF NOT EXISTS 幂等) + matter 加绑定四列 (v43 加列范式: 新库 CREATE 已含列,
    # 旧库 PRAGMA 探列后 additive ALTER)。matter_update 的提案列 v44 已全量建好,
    # 本版**零动作** (D1)。
    if current_version < 46:
        try:
            for ddl in MATTER_TABLE_DDLS:
                cursor.execute(ddl)
            cursor.execute("PRAGMA table_info(matter)")
            _matter_cols = {row[1] for row in cursor.fetchall()}
            for _col, _col_ddl in (
                ("agent_profile_id", "agent_profile_id TEXT NULL"),
                (
                    "agent_enabled",
                    "agent_enabled INTEGER NOT NULL DEFAULT 0 "
                    "CHECK (agent_enabled IN (0, 1))",
                ),
                ("matter_instructions", "matter_instructions TEXT NULL"),
                (
                    "schedule_json",
                    "schedule_json TEXT NULL "
                    "CHECK (schedule_json IS NULL OR json_valid(schedule_json))",
                ),
            ):
                if _col not in _matter_cols:
                    cursor.execute(f"ALTER TABLE matter ADD COLUMN {_col_ddl}")
                    logger.info(f"v46 migration: matter +{_col}")
            for ddl in MATTER_INDEX_DDLS:
                cursor.execute(ddl)
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "matter",
                {"agent_profile_id", "agent_enabled", "matter_instructions",
                 "schedule_json"},
                "v46 migration", e,
            )
            _migration_guard_columns(
                cursor, "matter_run",
                {"id", "matter_id", "idempotency_key", "status"},
                "v46 migration", e,
            )
            _migration_guard_index(
                cursor, "uq_matter_run_one_active", "v46 migration", e
            )

    # === v47: Matter Attention episodes (P5) ===
    if current_version < 47:
        try:
            for ddl in MATTER_TABLE_DDLS:
                cursor.execute(ddl)
            for ddl in MATTER_INDEX_DDLS:
                cursor.execute(ddl)
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor,
                "matter_attention",
                {"id", "matter_id", "kind", "subject_key", "state", "severity",
                 "why", "recurrence_no", "first_opened_at", "last_observed_at",
                 "snoozed_until", "resolved_at", "dismissed_at", "cleared_at",
                 "last_notified_at", "payload_json"},
                "v47 migration",
                e,
            )
            _migration_guard_index(
                cursor, "uq_matter_attention_active", "v47 migration", e
            )

    # === v48: normalize MailAgent email/thread resource identities ===
    if current_version < 48:
        try:
            cursor.execute(
                "SELECT * FROM resource WHERE provider='mailagent' "
                "AND kind IN ('email','thread') ORDER BY id"
            )
            for legacy in list(cursor.fetchall()):
                canonical_key = normalize_resource_key(
                    legacy["provider"], legacy["kind"], legacy["external_key"]
                )

                metadata_json = legacy["metadata_json"]
                if legacy["kind"] == "email" and json.loads(metadata_json) == {}:
                    internal_id = int(canonical_key.split(":", 1)[1])
                    email_row = cursor.execute(
                        "SELECT internal_id,message_id,date_received "
                        "FROM email_metadata WHERE internal_id=?",
                        (internal_id,),
                    ).fetchone()
                    if email_row:
                        metadata_json = json.dumps(
                            {
                                "internal_id": internal_id,
                                "message_id": email_row["message_id"],
                                "date_received": email_row["date_received"],
                            },
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )

                if canonical_key == legacy["external_key"]:
                    if metadata_json != legacy["metadata_json"]:
                        cursor.execute(
                            "UPDATE resource SET metadata_json=? WHERE id=?",
                            (metadata_json, legacy["id"]),
                        )
                    continue

                canonical = cursor.execute(
                    "SELECT * FROM resource WHERE provider=? AND external_key=?",
                    (legacy["provider"], canonical_key),
                ).fetchone()
                if canonical is None:
                    cursor.execute(
                        "UPDATE resource SET external_key=?, metadata_json=? WHERE id=?",
                        (canonical_key, metadata_json, legacy["id"]),
                    )
                    continue

                canonical_metadata = canonical["metadata_json"]
                if json.loads(canonical_metadata) == {} and json.loads(metadata_json) != {}:
                    canonical_metadata = metadata_json
                cursor.execute(
                    "UPDATE resource SET metadata_json=? WHERE id=?",
                    (canonical_metadata, canonical["id"]),
                )

                cursor.execute(
                    "SELECT * FROM matter_resource WHERE resource_id=? "
                    "AND deleted_at IS NULL ORDER BY id",
                    (legacy["id"],),
                )
                for legacy_link in cursor.fetchall():
                    canonical_link = cursor.execute(
                        "SELECT * FROM matter_resource WHERE matter_id=? "
                        "AND resource_id=? AND deleted_at IS NULL ORDER BY id LIMIT 1",
                        (legacy_link["matter_id"], canonical["id"]),
                    ).fetchone()
                    if canonical_link is None:
                        continue
                    cursor.execute(
                        "UPDATE matter_resource SET "
                        "relation_type=COALESCE(relation_type, ?), "
                        "pinned=MAX(pinned, ?), "
                        "confidence=COALESCE(confidence, ?), "
                        "provenance_json=CASE WHEN provenance_json='{}' "
                        "THEN ? ELSE provenance_json END, "
                        "confirmed_at=COALESCE(confirmed_at, ?), "
                        "sub_state=CASE WHEN sub_state='none' THEN ? ELSE sub_state END, "
                        "created_at=MIN(created_at, ?), updated_at=MAX(updated_at, ?) "
                        "WHERE id=?",
                        (
                            legacy_link["relation_type"],
                            legacy_link["pinned"],
                            legacy_link["confidence"],
                            legacy_link["provenance_json"],
                            legacy_link["confirmed_at"],
                            legacy_link["sub_state"],
                            legacy_link["created_at"],
                            legacy_link["updated_at"],
                            canonical_link["id"],
                        ),
                    )
                    cursor.execute(
                        "DELETE FROM matter_resource WHERE id=?",
                        (legacy_link["id"],),
                    )

                cursor.execute(
                    "UPDATE matter_resource SET resource_id=? WHERE resource_id=?",
                    (canonical["id"], legacy["id"]),
                )
                for table, column in (
                    ("matter_item", "source_resource_id"),
                    ("matter_event", "resource_id"),
                    ("matter_stakeholder", "source_resource_id"),
                ):
                    cursor.execute(
                        f"UPDATE {table} SET {column}=? WHERE {column}=?",
                        (canonical["id"], legacy["id"]),
                    )
                cursor.execute("DELETE FROM resource WHERE id=?", (legacy["id"],))
        except (
            MatterError,
            sqlite3.OperationalError,
            sqlite3.IntegrityError,
            ValueError,
        ) as e:
            raise SyncStoreMigrationError(f"v48 migration failed: {e}") from e

    if current_version < 49:
        try:
            for ddl in MATTER_TABLE_DDLS:
                cursor.execute(ddl)
            for ddl in MATTER_INDEX_DDLS:
                cursor.execute(ddl)
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            raise SyncStoreMigrationError(f"v49 migration failed: {e}") from e

    # === v50: 标签定义表 + 完成标志清单 (P6-B D4/D5/D14) ===
    # 🔴 只改 schema，绝不 UPDATE 既有 matter 行：`agent_enabled` 的建表默认从 0 翻成
    # 1 只对**新建**事项生效，存量事项不回填（D2）—— 用户没要求过的事项不该在升级
    # 后突然开始自动跑跟进。
    if current_version < 50:
        try:
            for ddl in MATTER_TABLE_DDLS:
                cursor.execute(ddl)
            cursor.execute("PRAGMA table_info(matter)")
            _matter_cols = {row[1] for row in cursor.fetchall()}
            if "goal_checks_json" not in _matter_cols:
                cursor.execute(
                    "ALTER TABLE matter ADD COLUMN goal_checks_json TEXT NOT NULL "
                    "DEFAULT '[]' CHECK (json_valid(goal_checks_json))"
                )
                logger.info("v50 migration: matter +goal_checks_json")
            for ddl in MATTER_INDEX_DDLS:
                cursor.execute(ddl)
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "matter", {"goal_checks_json"}, "v50 migration", e,
            )
            _migration_guard_columns(
                cursor, "matter_tag", {"name", "color", "shape", "created_at"},
                "v50 migration", e,
            )

    # === v51: 空 message_id 修复 + 入库来源 provenance (2026-08-11 丢邮件事故) ===
    #
    # (1) message_id='' → NULL —— 空串撞 TEXT UNIQUE 时 INSERT OR REPLACE 会**静默
    #     删掉**冲突的老行 (连 notion_page_id 一起), 且不报错。NULL 在 SQLite UNIQUE
    #     下可共存, 是唯一安全的"无 Message-ID"表示。写入侧已由 _storage_message_id
    #     收口, 这里清存量。幂等 (WHERE 命中即为空集)。
    #
    # (2) ingest_reason —— 邮件是怎么进库的, 供飞书通知门控判据用。
    #     🔴 值域 realtime | startup_catchup | inbox_reconcile;
    #     **NULL = 存量行/未知, 语义等同 realtime (照常通知)** —— 有意不回填:
    #     回填成任何具体值都是在编造历史, 而 NULL→按 realtime 处理正是安全默认
    #     (宁可多通知, 不可漏通知)。这与"ALTER 加列必回填"的一般纪律相反, 因为
    #     此列的缺省语义本身就是有意义的, 不是待补的空洞。
    if current_version < 51:
        # 🔴 DML 清理与 DDL 加列**分开 try**: 合在一起时, UPDATE 因锁/触发器等
        # OperationalError 失败、而 ingest_reason 列恰好已存在的话,
        # _migration_guard_columns 会判定"已迁移"吞掉错误并推进 db_version ⇒
        # 空串存量永久不再被清理 (迁移只跑一次)。DML 失败必须无条件 raise。
        cursor.execute(
            "UPDATE email_metadata SET message_id = NULL WHERE message_id = ''"
        )
        if cursor.rowcount:
            logger.info(
                f"v51 migration: email_metadata message_id ''→NULL "
                f"({cursor.rowcount} row(s))"
            )
        try:
            cursor.execute("PRAGMA table_info(email_metadata)")
            _em_cols = {row[1] for row in cursor.fetchall()}
            if "ingest_reason" not in _em_cols:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN ingest_reason TEXT"
                )
                logger.info("v51 migration: email_metadata +ingest_reason")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            # 只有"列已存在"这一种并发/重入形态才允许被 guard 吞
            _migration_guard_columns(
                cursor, "email_metadata", {"ingest_reason"}, "v51 migration", e,
            )

    # === v52: 全局干系人库 (Matters dogfood 轮 2 W-C) ===
    # matter_contact 表 + matter_stakeholder.contact_id + seed 回填。
    # 🔴 关联索引只能在这里建 (ALTER 之后), 不进 MATTER_INDEX_DDLS —— 理由见
    # MATTER_STAKEHOLDER_CONTACT_INDEX_DDL 的注释。
    if current_version < 52:
        try:
            for ddl in MATTER_TABLE_DDLS:
                cursor.execute(ddl)
            cursor.execute("PRAGMA table_info(matter_stakeholder)")
            _sh_cols = {row[1] for row in cursor.fetchall()}
            if "contact_id" not in _sh_cols:
                cursor.execute(
                    "ALTER TABLE matter_stakeholder ADD COLUMN contact_id INTEGER "
                    "NULL REFERENCES matter_contact(id) ON DELETE SET NULL"
                )
                logger.info("v52 migration: matter_stakeholder +contact_id")
            cursor.execute(MATTER_STAKEHOLDER_CONTACT_INDEX_DDL)
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "matter_stakeholder", {"contact_id"}, "v52 migration", e,
            )
            # 🔴 列 guard 一个人挡不住这一块: contact_id 已存在 (重入/并发) 而**索引**
            # 建失败时, 列 guard 会判"已迁移"吞掉错误、version 照样落 52 ⇒ 索引永不重
            # 建。索引复查必须跟在后面 (v46/v47 同款成对写法)。
            _migration_guard_index(
                cursor, "idx_matter_stakeholder_contact", "v52 migration", e
            )

        # seed 回填 —— DML 与上面被 guard 的 DDL **分开**（v51 教训: 混在一个 try 里,
        # DML 失败会被"列已存在"guard 吞掉后永久跳过）。DML 失败必须无条件 raise。
        # ① 存量 email 归一 (写入侧早已 lower, 这里兜历史脏数据): 空串→NULL, 其余
        #    trim+lower。归一只动 email_normalized, 不碰 person_key (稳定键不重算)。
        cursor.execute(
            "UPDATE matter_stakeholder SET email_normalized = NULL "
            "WHERE email_normalized IS NOT NULL AND trim(email_normalized) = ''"
        )
        cursor.execute(
            "UPDATE matter_stakeholder "
            "SET email_normalized = lower(trim(email_normalized)) "
            "WHERE email_normalized IS NOT NULL "
            "AND email_normalized <> lower(trim(email_normalized))"
        )
        # ② 按归一 email 聚合入全局库 (含软删行 —— 删的是"某事项的干系人关系",
        #    人本身仍是真实存在过的联系人)。display_name/organization 各取最近
        #    更新的非空行; INSERT OR IGNORE 幂等 (重跑/半程重试不重复)。
        cursor.execute(
            "INSERT OR IGNORE INTO matter_contact "
            "(email_normalized, display_name, organization, created_at, updated_at) "
            "SELECT s.email_normalized, "
            "  (SELECT s2.display_name FROM matter_stakeholder s2 "
            "   WHERE s2.email_normalized = s.email_normalized "
            "   AND s2.display_name IS NOT NULL AND trim(s2.display_name) <> '' "
            "   ORDER BY s2.updated_at DESC, s2.id DESC LIMIT 1), "
            "  (SELECT s3.organization FROM matter_stakeholder s3 "
            "   WHERE s3.email_normalized = s.email_normalized "
            "   AND s3.organization IS NOT NULL AND trim(s3.organization) <> '' "
            "   ORDER BY s3.updated_at DESC, s3.id DESC LIMIT 1), "
            "  MIN(s.created_at), MAX(s.updated_at) "
            "FROM matter_stakeholder s "
            "WHERE s.email_normalized IS NOT NULL "
            "GROUP BY s.email_normalized"
        )
        if cursor.rowcount:
            logger.info(
                f"v52 migration: seeded {cursor.rowcount} matter_contact row(s)"
            )
        # ③ 回写关联 (ALTER 加列 + seed 必配 WHERE col IS NULL 回填)。
        cursor.execute(
            "UPDATE matter_stakeholder SET contact_id = ("
            "  SELECT c.id FROM matter_contact c "
            "  WHERE c.email_normalized = matter_stakeholder.email_normalized"
            ") WHERE contact_id IS NULL AND email_normalized IS NOT NULL"
        )

    # === v53: outlook_com backend EntryID 缓存列 (task 08-12 Win backend) ===
    # entry_id = Outlook COM EntryID (十六进制串), 只当快路径缓存不当锚 —— EntryID
    # 在邮件移动文件夹后会变 (MAPI 语义), 稳定锚仍是 message_id UNIQUE, miss 时
    # 按 PR_INTERNET_MESSAGE_ID 反查 + 回写自愈 (与 davmail imap_uid 双路同构)。
    # NULL 即语义 (非 outlook_com 行), 有意不回填。
    # ⚠️ merge 注意: main 分支可能并发 bump v53, merge 时需重编号本迁移块。
    if current_version < 53:
        try:
            cursor.execute("PRAGMA table_info(email_metadata)")
            _em_cols_v53 = {row[1] for row in cursor.fetchall()}
            if "entry_id" not in _em_cols_v53:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN entry_id TEXT"
                )
                logger.info("v53 migration: email_metadata +entry_id")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            # 只有"列已存在"这一种并发/重入形态才允许被 guard 吞
            _migration_guard_columns(
                cursor, "email_metadata", {"entry_id"}, "v53 migration", e,
            )

    # === v54: 通讯录 Contact Directory (task 08-13 WP1, 方案 A) ===
    # 动作序 (PRD §3.3): ① 建三表 + 索引 ② 迁 matter_contact → contact (id 保持,
    # matter_stakeholder.contact_id 的值因此不用改写) + 每行生成主邮箱锚点
    # ③ rebuild matter_stakeholder (SQLite 改不了 FK 目标, contact_id 改指
    # contact 只能整表重建 —— 完全镜像 v45 先例: PRAGMA 判据探测幂等 /
    # defer_foreign_keys / 建-灌-DROP-RENAME / 重建 4 个索引 / 定向
    # foreign_key_check) ④ DROP matter_contact。
    # 🔴 DDL 与 DML 分 try (v51/v52 教训): seed/迁数据/rebuild 失败必须 raise,
    # 绝不被「表已存在」guard 吞; 半重建状态绝不落 version (整个迁移单事务,
    # 失败随连接回收 ROLLBACK)。
    # 🔴 梯子冻结: MATTER_TABLE_DDLS 里 matter_contact / matter_stakeholder 的
    # 旧形状 CREATE **原样冻结** (append-only) —— v52 块靠它们建表 + seed; 新库
    # 满梯子先建旧形状再在这里换形, 多做一次 rebuild 是幂等成本, 换来梯子对
    # v44..v53 全部中间版本成立。
    # 🔴 账本 backfill 不进 migration (万封级 IO 会卡 app 首启 waitReady 门控):
    # 这里只建空表 + 迁 18 行级 contact; 账本由 src/contacts/scanner.py 从
    # sync_state['contact_extract.watermark']=0 增量消化 (或 CLI 手动催跑)。
    if current_version < 54:
        # ① 新表 + 索引 (纯 DDL, IF NOT EXISTS 幂等; 真失败必须 raise)。
        try:
            for ddl in CONTACT_TABLE_DDLS:
                cursor.execute(ddl)
            for ddl in CONTACT_INDEX_DDLS:
                cursor.execute(ddl)
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            raise SyncStoreMigrationError(
                f"v54 migration (contact tables): {e}"
            ) from e

        # ② 迁数据 (DML, 与 DDL 分 try, 失败无条件 raise)。INSERT OR IGNORE
        #    幂等; matter_contact 已 DROP (重入) 时整段跳过。重入安全性由
        #    「迁移单事务原子提交」+ OR IGNORE 双重兜底。
        try:
            has_legacy = cursor.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name='matter_contact'"
            ).fetchone() is not None
            if has_legacy:
                cursor.execute(
                    "INSERT OR IGNORE INTO contact "
                    "(id, display_name, organization, created_at, updated_at) "
                    "SELECT id, display_name, organization, created_at, updated_at "
                    "FROM matter_contact"
                )
                migrated = cursor.rowcount
                cursor.execute(
                    "INSERT OR IGNORE INTO contact_email "
                    "(contact_id, email_normalized, is_primary, created_at) "
                    "SELECT mc.id, mc.email_normalized, 1, mc.created_at "
                    "FROM matter_contact mc "
                    "WHERE EXISTS (SELECT 1 FROM contact c WHERE c.id = mc.id)"
                )
                if migrated:
                    logger.info(
                        f"v54 migration: migrated {migrated} matter_contact "
                        f"row(s) → contact (ids preserved)"
                    )
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            raise SyncStoreMigrationError(
                f"v54 migration (contact seed): {e}"
            ) from e

        # ③ rebuild matter_stakeholder + ④ DROP matter_contact。
        try:
            sh_fk_targets = {
                (row[2], row[3])
                for row in cursor.execute(
                    "PRAGMA foreign_key_list(matter_stakeholder)"
                )
            }
            needs_rebuild = ("matter_contact", "contact_id") in sh_fk_targets
            if needs_rebuild:
                cursor.execute("PRAGMA defer_foreign_keys = ON")
                sh_ddl = next(
                    ddl for ddl in MATTER_TABLE_DDLS
                    if ddl.startswith(
                        "CREATE TABLE IF NOT EXISTS matter_stakeholder"
                    )
                )
                new_ddl = sh_ddl.replace(
                    "CREATE TABLE IF NOT EXISTS matter_stakeholder",
                    "CREATE TABLE matter_stakeholder_v54", 1,
                ).replace(
                    "REFERENCES matter_contact(id)", "REFERENCES contact(id)", 1,
                )
                cursor.execute("DROP TABLE IF EXISTS matter_stakeholder_v54")
                cursor.execute(new_ddl)
                # 🔴 显式列名 INSERT —— 老库 (v52 升级路径) 的 contact_id 是
                # ALTER 追加在**末尾**, 新库满梯子的建表列序里它在中间;
                # `SELECT *` 在两条路径下列序不同必错位。
                _sh_cols = (
                    "id, matter_id, person_key, display_name, email_normalized, "
                    "organization, role, relationship, is_waiting_on, "
                    "last_contact_at, source_resource_id, contact_id, "
                    "deleted_at, created_at, updated_at"
                )
                cursor.execute(
                    f"INSERT INTO matter_stakeholder_v54 ({_sh_cols}) "
                    f"SELECT {_sh_cols} FROM matter_stakeholder"
                )
                # 🔴 入向 FK 的实际影响面 (PRD §3.3 预期「按名字解析不用动
                # matter_item」在这里**不成立**): DROP TABLE 在 foreign_keys=ON
                # 下执行隐式 DELETE FROM, matter_item.waiting_on_stakeholder_id
                # 的 ON DELETE SET NULL **动作**会被触发 (defer_foreign_keys 只
                # 延迟约束校验, 不拦动作), waiting 指针整列被清 —— 先快照、
                # RENAME 之后回填 (行量 = 事项行动项级, 个位数到十位数)。
                _waiting_rows = cursor.execute(
                    "SELECT id, waiting_on_stakeholder_id FROM matter_item "
                    "WHERE waiting_on_stakeholder_id IS NOT NULL"
                ).fetchall()
                cursor.execute("DROP TABLE matter_stakeholder")
                cursor.execute(
                    "ALTER TABLE matter_stakeholder_v54 RENAME TO matter_stakeholder"
                )
                for _item_row in _waiting_rows:
                    cursor.execute(
                        "UPDATE matter_item SET waiting_on_stakeholder_id=? "
                        "WHERE id=?",
                        (_item_row[1], _item_row[0]),
                    )
                # 重建它的 4 个索引: 3 个在 MATTER_INDEX_DDLS (重放即得) +
                # 关联索引 (独立常量, 不进组的理由见其注释)。漏一个 = 静默
                # 性能/约束回退, 迁移测试逐个断言。
                for ddl in MATTER_INDEX_DDLS:
                    cursor.execute(ddl)
                cursor.execute(MATTER_STAKEHOLDER_CONTACT_INDEX_DDL)
                # 定向 foreign_key_check (v45 纪律: 只查本次动过的表 + 按名字
                # 解析入向 FK 的 matter_item; 全库 check 会把无关表的历史畸形
                # 算到 v54 头上)。
                violations = [
                    *cursor.execute(
                        "PRAGMA foreign_key_check(matter_stakeholder)"
                    ).fetchall(),
                    *cursor.execute(
                        "PRAGMA foreign_key_check(matter_item)"
                    ).fetchall(),
                ]
                if violations:
                    raise SyncStoreMigrationError(
                        f"v54 migration: foreign_key_check failed: {violations}"
                    )
            # ④ 退役旧表 (rebuild 后无任何 FK 指向它; 重入时可能已不存在)。
            cursor.execute("DROP TABLE IF EXISTS matter_contact")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            raise SyncStoreMigrationError(
                f"v54 migration (stakeholder rebuild): {e}"
            ) from e

    # === v55: contact 字段级锁定列 (task 08-13 WP2) ===
    # additive ALTER (探列幂等, 镜像 v53 形状) + seed: 老锁 (identity_locked_at
    # 非 NULL) 全部来自 matters 写穿改名 ⇒ 折成 display_name 字段锁, seed 后
    # scanner 的 display_name 锁判据与老库行为等价。fresh 库满梯子在 v54 块
    # 建表时已带该列 (CONTACT_TABLE_DDLS 最新形), 探列后跳过 ALTER。
    if current_version < 55:
        try:
            cursor.execute("PRAGMA table_info(contact)")
            _contact_cols_v55 = {row[1] for row in cursor.fetchall()}
            if "identity_locks_json" not in _contact_cols_v55:
                cursor.execute(
                    "ALTER TABLE contact ADD COLUMN identity_locks_json TEXT "
                    "CHECK (identity_locks_json IS NULL "
                    "OR json_valid(identity_locks_json))"
                )
                logger.info("v55 migration: contact +identity_locks_json")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "contact", {"identity_locks_json"}, "v55 migration", e,
            )
        # seed 是 DML, 与 DDL 分 try, 真失败必须 raise (v51/v52 教训)。幂等:
        # WHERE identity_locks_json IS NULL 只补空位, 重入不覆盖。
        try:
            cursor.execute(
                "UPDATE contact SET identity_locks_json = "
                "json_object('display_name', identity_locked_at) "
                "WHERE identity_locked_at IS NOT NULL "
                "AND identity_locks_json IS NULL"
            )
            if cursor.rowcount:
                logger.info(
                    f"v55 migration: seeded display_name lock on "
                    f"{cursor.rowcount} contact row(s)"
                )
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            raise SyncStoreMigrationError(
                f"v55 migration (identity_locks seed): {e}"
            ) from e

    # === v56: Matters 资料摘要三列 (task 08-12 design-alignment 批 M4) ===
    # additive ALTER ×3 (探列幂等, 镜像 v53/v55 形状)。fresh 库满梯子在 v44/v45 块
    # 建 resource 时已带三列 (MATTER_TABLE_DDLS 最新形), 探列后跳过 ALTER; 老库
    # (v44..v55) 三列追加在表尾 —— 与 fresh 库列序不同, 但资料读面全部按列名取数
    # (`dict(row)` / `_joined_resource_row` 显式键), 无 `SELECT *` 位置消费。
    # 🔴 无 DML seed: 存量行三列 NULL = 「还没有摘要」空态 (有意不回填, 理由见
    # DB_VERSION 注记); 无新索引 (同注记 —— 真要加必须放本块内, 不进
    # MATTER_INDEX_DDLS, v52 教训)。sum_src 的 CHECK 与 CREATE 同一单源
    # (`sql_check_clause(MatterResourceSummarySource)`), 不手抄第二份值域。
    if current_version < 56:
        _resource_sum_cols = {
            "sum": "ALTER TABLE resource ADD COLUMN sum TEXT",
            "sum_src": (
                "ALTER TABLE resource ADD COLUMN sum_src TEXT "
                "CHECK (sum_src IS NULL OR sum_src "
                f"{sql_check_clause(MatterResourceSummarySource)})"
            ),
            "sum_at": "ALTER TABLE resource ADD COLUMN sum_at INTEGER",
        }
        try:
            cursor.execute("PRAGMA table_info(resource)")
            _resource_cols_v56 = {row[1] for row in cursor.fetchall()}
            for _col, _ddl in _resource_sum_cols.items():
                if _col not in _resource_cols_v56:
                    cursor.execute(_ddl)
                    logger.info(f"v56 migration: resource +{_col}")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            # 只有「列已存在」这一种并发/重入形态才允许被 guard 吞 —— 三列必须
            # 全部在场才算已迁移 (半程重入时缺的列会在下轮重试补齐)。
            _migration_guard_columns(
                cursor, "resource", set(_resource_sum_cols), "v56 migration", e,
            )

    # === v57: 资料版本轨迹表 (task 08-12 design-alignment 批 M7) ===
    # 纯 DDL, 无 DML —— 存量库升上来轨迹为空是**正确**的 (历史版本从来没记过, 见
    # DB_VERSION 注记)。表 DDL 与索引都必须在本块显式执行: v56 老库不会经过
    # v44/v45/v49/v50 那几个重放 MATTER_TABLE_DDLS 的块。
    # 两条 IF NOT EXISTS 幂等; 真失败无条件 raise (半程重入下轮重试)。
    if current_version < 57:
        try:
            cursor.execute(RESOURCE_VERSION_TABLE_DDL)
            cursor.execute(RESOURCE_VERSION_INDEX_DDL)
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            raise SyncStoreMigrationError(
                f"v57 migration (resource_version): {e}"
            ) from e

    # === v58: email_metadata.sender_email 派生列 + 回填 (task 08-14 WP-5) ===
    # 🔴 **必须回填**, 与 ingest_reason / entry_id / v56 三列那几条「有意不回填」
    # 相反: 那些列的 NULL 本身有语义 (「未知 ≙ 默认」), 而本列是纯派生值 —— 不填
    # 就等于让三个消费者对全部存量行继续瞎 (contacts 账本缺 68% 的发件人、出向
    # 判据漏 87%), 而回填不编造任何历史 (值 100% 由同一行的 sender 算出)。
    # 顺序: ALTER (探列幂等) → 回填 DML → 建索引。
    # 🔴 DDL 与 DML 分 try (v51/v52 教训): 回填失败必须无条件 raise, 绝不被
    # 「列已存在」guard 吞掉后永久跳过 —— 迁移只跑一次。
    # 索引复查跟在列 guard 后面 (v52 同款成对写法): 列已存在而索引建失败时,
    # 只有列 guard 会判「已迁移」→ version 照落 → 索引永不重建。
    if current_version < 58:
        try:
            cursor.execute("PRAGMA table_info(email_metadata)")
            _em_cols_v58 = {row[1] for row in cursor.fetchall()}
            if "sender_email" not in _em_cols_v58:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN sender_email TEXT"
                )
                logger.info("v58 migration: email_metadata +sender_email")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "email_metadata", {"sender_email"}, "v58 migration", e,
            )
        try:
            _filled = _backfill_sender_email(cursor)
            if _filled:
                logger.info(
                    f"v58 migration: backfilled sender_email on {_filled} row(s)"
                )
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            raise SyncStoreMigrationError(
                f"v58 migration (sender_email backfill): {e}"
            ) from e
        try:
            # _sent_predicate 的 `m.sender_email IN (...)` 吃这条索引。
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_email_sender_email "
                "ON email_metadata(sender_email)"
            )
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_index(
                cursor, "idx_email_sender_email", "v58 migration", e
            )

    # === v59: contact.name_en → formal_name (task 08-14 WP-6 A) ===
    # 语义与回滚代价见 DB_VERSION 注记。两段分 try (v51/v52 教训: DDL 的
    # 「已存在」guard 绝不许把 DML 失败一起吞掉 —— 迁移只跑一次)。
    if current_version < 59:
        try:
            cursor.execute("PRAGMA table_info(contact)")
            _contact_cols_v59 = {row[1] for row in cursor.fetchall()}
            # 只有「老形状」才改名; fresh 库 (v54 块按最新 DDL 建表) 与重入
            # 都落在这个 if 之外 = 幂等。
            if (
                "formal_name" not in _contact_cols_v59
                and "name_en" in _contact_cols_v59
            ):
                cursor.execute(
                    "ALTER TABLE contact RENAME COLUMN name_en TO formal_name"
                )
                logger.info("v59 migration: contact.name_en → formal_name")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "contact", {"formal_name"}, "v59 migration", e,
            )
        # 🔴 锁映射的键跟着列一起改 —— 不迁 = 静默解锁 (见 DB_VERSION 注记 ②)。
        # json_set/json_remove 组合是原子的单条 UPDATE; WHERE 挑出真的带老键的
        # 行 ⇒ 重入时匹配 0 行 = 幂等。
        try:
            _relocked = cursor.execute(
                "UPDATE contact SET identity_locks_json = json_remove("
                "  json_set(identity_locks_json, '$.formal_name',"
                "    json_extract(identity_locks_json, '$.name_en')),"
                "  '$.name_en') "
                "WHERE identity_locks_json IS NOT NULL "
                "  AND json_valid(identity_locks_json) "
                "  AND json_extract(identity_locks_json, '$.name_en') IS NOT NULL"
            ).rowcount
            if _relocked:
                logger.info(
                    f"v59 migration: moved name_en lock → formal_name on "
                    f"{_relocked} row(s)"
                )
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            raise SyncStoreMigrationError(
                f"v59 migration (identity_locks rekey): {e}"
            ) from e

    # === v60: 干系人分层 + 自定义顺序 (S2, 08-18) ===
    # tier ('core'|'normal') 决定分到哪一组 (非核心默认折叠), sort_order 决定组内先后。
    # 🔴 两列是**两个独立维度**, 不许合成一个「优先级数字」——「把人拖进核心组」与
    #    「在核心组里往上挪一位」是两个操作。
    # sort_order 回填按现有 id 序 (0,1,2…)。
    # ⚠️ 回填**不是**「保住升级前顺序」所必需 —— 新读侧
    #    `ORDER BY (tier='core') DESC, sort_order, id` 在 sort_order 全 0 时由 id 兜底
    #    接管, 顺序与老读侧 `ORDER BY id` 恰好一致 (实测确认)。回填的真正价值是给
    #    **第一次拖拽**一个有意义的基线: 全 0 时前端算不出「插到 p0 和 p1 之间」该给
    #    什么值, 只能整组重写一遍。
    #    tier 无需回填 (新列 DEFAULT 'normal')。
    if current_version < 60:
        try:
            cursor.execute("PRAGMA table_info(matter_stakeholder)")
            _sh_cols_v60 = {row[1] for row in cursor.fetchall()}
            _added: list[str] = []
            if "tier" not in _sh_cols_v60:
                cursor.execute(
                    "ALTER TABLE matter_stakeholder ADD COLUMN tier TEXT NOT NULL "
                    f"DEFAULT 'normal' CHECK (tier {sql_check_clause(MatterStakeholderTier)})"
                )
                _added.append("tier")
            if "sort_order" not in _sh_cols_v60:
                cursor.execute(
                    "ALTER TABLE matter_stakeholder ADD COLUMN sort_order "
                    "INTEGER NOT NULL DEFAULT 0"
                )
                _added.append("sort_order")
                # 回填: per-matter 按 id 升序编号 (0,1,2…), 保住升级前的显示顺序。
                cursor.execute(
                    "UPDATE matter_stakeholder SET sort_order = ("
                    "  SELECT COUNT(*) FROM matter_stakeholder AS earlier "
                    "  WHERE earlier.matter_id = matter_stakeholder.matter_id "
                    "    AND earlier.id < matter_stakeholder.id"
                    ")"
                )
                logger.info(
                    f"v60 migration: matter_stakeholder sort_order backfilled "
                    f"({cursor.rowcount} row(s))"
                )
            if _added:
                logger.info(f"v60 migration: matter_stakeholder +{'+'.join(_added)}")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "matter_stakeholder", {"tier", "sort_order"}, "v60 migration", e,
            )

    # === v61: matter.description → background + goal (08-19) ===
    # 语义、数据规则与回滚代价见 DB_VERSION 注记。两段分 try (v51/v52/v59 教训:
    # DDL 的「已存在」guard 绝不许把 DML 失败一起吞掉 —— 迁移只跑一次)。
    if current_version < 61:
        try:
            cursor.execute("PRAGMA table_info(matter)")
            _matter_cols_v61 = {row[1] for row in cursor.fetchall()}
            # 只有「老形状」才改名; fresh 库 (v44 块按最新 DDL 建表) 与重入都落在
            # 这个 if 之外 = 幂等。
            if (
                "background" not in _matter_cols_v61
                and "description" in _matter_cols_v61
            ):
                cursor.execute(
                    "ALTER TABLE matter RENAME COLUMN description TO background"
                )
                logger.info("v61 migration: matter.description → background")
            if "goal" not in _matter_cols_v61:
                cursor.execute(
                    "ALTER TABLE matter ADD COLUMN goal TEXT NOT NULL DEFAULT ''"
                )
                logger.info("v61 migration: matter +goal")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "matter", {"background", "goal"}, "v61 migration", e,
            )
        # 拆段: 只碰那一版短命 UI 写出的「行首整行小标题」行。绝大多数库这里匹配
        # 0 行 —— 那正是 owner 定的默认 (整串算背景, 已由上面的 RENAME 完成)。
        # 🔴 `goal = ''` 是幂等的第二道闸: 已拆过的行 goal 非空就不再进候选,
        # 于是 owner 升级后自己在背景里敲的 `## 背景` 不会被二次拆走。
        try:
            _v61_rows = cursor.execute(
                "SELECT id, background FROM matter "
                "WHERE goal = '' AND (background LIKE '%## 背景%' OR background LIKE '%## 目标%')"
            ).fetchall()
            _v61_updates = []
            for _row in _v61_rows:
                _bg, _goal = split_legacy_matter_description(_row[1] or "")
                if (_bg, _goal) != ((_row[1] or ""), ""):
                    _v61_updates.append((_bg, _goal, _row[0]))
            if _v61_updates:
                cursor.executemany(
                    "UPDATE matter SET background = ?, goal = ? WHERE id = ?",
                    _v61_updates,
                )
                logger.info(
                    f"v61 migration: split 背景/目标 headings on "
                    f"{len(_v61_updates)} matter row(s)"
                )
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            raise SyncStoreMigrationError(
                f"v61 migration (background/goal split): {e}"
            ) from e

    # === v62: folder_pref 建表 + 从两个 env 键播种一次 (08-19) ===
    # 语义 / 名字空间跨越 / 极性 / 回滚代价见 DB_VERSION 注记与 FOLDER_PREF_TABLE_DDLS
    # 头注。DDL 与播种分两个 try (v51/v52/v59 教训: DDL 的「已存在」guard 绝不许把
    # 播种的 DML 失败一起吞掉 —— 迁移只跑一次)。
    if current_version < 62:
        # ① 建表 + 索引 (纯 DDL, IF NOT EXISTS 幂等; 真失败必须 raise —— 同 v54)。
        try:
            for ddl in FOLDER_PREF_TABLE_DDLS:
                cursor.execute(ddl)
            for ddl in FOLDER_PREF_INDEX_DDLS:
                cursor.execute(ddl)
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            raise SyncStoreMigrationError(f"v62 migration (folder_pref table): {e}") from e
        # 播种: 显示名 (env) → imap_name (SYNC_FOLDERS) 的映射只能靠 decode。
        # settings 不可得 (裸测试环境) / 三个键全空 → 什么都不播 = 表空 = 全默认,
        # 与升级前逐字等价 (gate 行缺失时回退 env frozenset)。
        try:
            _fp_seed = _folder_pref_seed_rows()
        except Exception as e:  # noqa: BLE001 — config 不可得 → 不播种 (安全默认)
            logger.debug(f"v62 migration: settings unavailable, skip seed: {e}")
            _fp_seed = []
        if _fp_seed:
            try:
                cursor.executemany(
                    "INSERT OR IGNORE INTO folder_pref "
                    "(imap_name, mailbox_label, icon, notify_enabled, llm_disabled, updated_at) "
                    "VALUES (?, ?, NULL, ?, ?, ?)",
                    [(r[0], r[1], r[2], r[3], time.time()) for r in _fp_seed],
                )
                logger.info(
                    f"v62 migration: folder_pref seeded {len(_fp_seed)} row(s) from "
                    f"FOLDER_NOTIFY_ENABLED / FOLDER_LLM_DISABLED "
                    f"({[(r[1], r[2], r[3]) for r in _fp_seed]})"
                )
            except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
                raise SyncStoreMigrationError(f"v62 migration (folder_pref seed): {e}") from e

    # === v63: Contact Profile WP6 状态列 + report_agent seed ===
    # 不依赖 v62 块的具体内容 (PRAGMA 探列 + INSERT OR IGNORE 全幂等), 允许 <=62 老库直接升级。
    if current_version < 63:
        try:
            _contact_cols_v63 = {
                row[1] for row in cursor.execute("PRAGMA table_info(contact)").fetchall()
            }
            _profile_cols_v63 = (
                (
                    "profile_status",
                    "TEXT NULL CHECK (profile_status IS NULL OR "
                    "profile_status IN ('ok','skipped','failed','running'))",
                ),
                ("profile_attempted_at", "INTEGER NULL"),
                ("profile_error", "TEXT NULL"),
            )
            _added_v63: list[str] = []
            for _col, _ddl in _profile_cols_v63:
                if _col not in _contact_cols_v63:
                    cursor.execute(f"ALTER TABLE contact ADD COLUMN {_col} {_ddl}")
                    _added_v63.append(_col)
            if _added_v63:
                logger.info(f"v63 migration: contact +{'+'.join(_added_v63)}")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor,
                "contact",
                {"profile_status", "profile_attempted_at", "profile_error"},
                "v63 migration",
                e,
            )
        try:
            _profile_trigger = json.dumps(
                {"fire_hour": 4, "daily_limit": 50}, ensure_ascii=False
            )
            cursor.execute(
                "INSERT OR IGNORE INTO report_agent "
                "(id, type, enabled, title, model, prompt, trigger_json, updated_at) "
                "VALUES ('contact_profile_agent', 'contact_profile', 0, "
                "'联系人画像', '', '', ?, ?)",
                (_profile_trigger, time.time()),
            )
            logger.info("v63 migration: contact_profile_agent seeded (enabled=0)")
        except sqlite3.Error as e:
            raise SyncStoreMigrationError(
                f"v63 migration (contact_profile_agent seed): {e}"
            ) from e

    # === v64: contact_suggestion 待审治理队列 ===
    if current_version < 64:
        try:
            for ddl in CONTACT_SUGGESTION_TABLE_DDLS:
                cursor.execute(ddl)
            for ddl in CONTACT_SUGGESTION_INDEX_DDLS:
                cursor.execute(ddl)
        except sqlite3.Error as e:
            raise SyncStoreMigrationError(
                f"v64 migration (contact_suggestion table): {e}"
            ) from e
    # === v65: Contact Governance 标准内建 agent 行 ===
    if current_version < 65:
        try:
            _report_agent_cols_v65 = {
                row[1] for row in cursor.execute("PRAGMA table_info(report_agent)").fetchall()
            }
            _required_v65 = {
                "id", "type", "enabled", "title", "model", "prompt", "trigger_json", "updated_at"
            }
            if not _required_v65 <= _report_agent_cols_v65:
                missing = sorted(_required_v65 - _report_agent_cols_v65)
                raise SyncStoreMigrationError(
                    f"v65 migration (contact_governance_agent seed): report_agent missing {missing}"
                )
        except sqlite3.Error as e:
            raise SyncStoreMigrationError(
                f"v65 migration (report_agent probe): {e}"
            ) from e
        try:
            _governance_trigger = json.dumps({"fire_hour": 5}, ensure_ascii=False)
            cursor.execute(
                "INSERT OR IGNORE INTO report_agent "
                "(id, type, enabled, title, model, prompt, trigger_json, updated_at) "
                "VALUES ('contact_governance_agent', 'contact_governance', 0, "
                "'通讯录治理', '', '', ?, ?)",
                (_governance_trigger, time.time()),
            )
            logger.info("v65 migration: contact_governance_agent seeded (enabled=0)")
        except sqlite3.Error as e:
            raise SyncStoreMigrationError(
                f"v65 migration (contact_governance_agent seed): {e}"
            ) from e
    # === v66: contact gender ===
    if current_version < 66:
        try:
            _contact_cols_v66 = {
                row[1] for row in cursor.execute("PRAGMA table_info(contact)").fetchall()
            }
            if "gender" not in _contact_cols_v66:
                cursor.execute("ALTER TABLE contact ADD COLUMN gender TEXT NULL")
                logger.info("v66 migration: contact +gender")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "contact", {"gender"}, "v66 migration", e
            )
    # === v67: contact 表本体的三条读路径索引 ===
    if current_version < 67:
        for _index_name_v67, _ddl_v67 in CONTACT_V67_INDEXES:
            try:
                cursor.execute(_ddl_v67)
            except sqlite3.OperationalError as e:
                _migration_guard_index(cursor, _index_name_v67, "v67 migration", e)
        logger.info("v67 migration: contact indexes ensured")
    # === v68: notification 通知中心 ===
    # 语义 / 数据规则 / 回滚代价见 DB_VERSION 注记与 NOTIFICATION_TABLE_DDLS 头注。
    # 表与索引同块同 try: 纯新表首建, 不存在 v52 式「索引先于列」的错位面。
    if current_version < 68:
        try:
            for ddl in NOTIFICATION_TABLE_DDLS:
                cursor.execute(ddl)
            for ddl in NOTIFICATION_INDEX_DDLS:
                cursor.execute(ddl)
        except sqlite3.Error as e:
            raise SyncStoreMigrationError(
                f"v68 migration (notification table): {e}"
            ) from e
    # === v69: contact 日历三字段 (meeting_count / last_met_at / next_meeting_at) ===
    # 语义 / 单位 / 回滚代价见 DB_VERSION 注记。三列各判各的: 半程失败重跑时
    # 已加的那一列不会再 ALTER 一次。
    if current_version < 69:
        _contact_calendar_cols = (
            ("meeting_count", "INTEGER NOT NULL DEFAULT 0"),
            ("last_met_at", "INTEGER NULL"),
            ("next_meeting_at", "INTEGER NULL"),
        )
        try:
            _contact_cols_v69 = {
                row[1] for row in cursor.execute("PRAGMA table_info(contact)").fetchall()
            }
            _added_v69 = []
            for _col_v69, _type_v69 in _contact_calendar_cols:
                if _col_v69 not in _contact_cols_v69:
                    cursor.execute(
                        f"ALTER TABLE contact ADD COLUMN {_col_v69} {_type_v69}"
                    )
                    _added_v69.append(_col_v69)
            if _added_v69:
                logger.info(f"v69 migration: contact +{','.join(_added_v69)}")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "contact",
                {name for name, _ in _contact_calendar_cols}, "v69 migration", e,
            )
    # === v70: matter_progress curated 进展条目 ===
    # 语义 / 数据规则 / 回滚代价见 DB_VERSION 注记与 MATTER_PROGRESS_TABLE_DDLS 头注。
    # 表与索引同块同 try: 纯新表首建, 不存在 v52 式「索引先于列」的错位面。
    if current_version < 70:
        try:
            for ddl in MATTER_PROGRESS_TABLE_DDLS:
                cursor.execute(ddl)
            for ddl in MATTER_PROGRESS_INDEX_DDLS:
                cursor.execute(ddl)
        except sqlite3.Error as e:
            raise SyncStoreMigrationError(
                f"v70 migration (matter_progress table): {e}"
            ) from e
    # === v71: 行动项执行契约 matter_item_dispatch + 两列 additive ALTER ===
    # 语义 / 数据规则 / 回滚代价见 DB_VERSION 注记与 MATTER_ITEM_DISPATCH_TABLE_DDLS 头注。
    # 表与索引同块同 try: 纯新表首建, 不存在 v52 式「索引先于列」的错位面。
    if current_version < 71:
        try:
            for ddl in MATTER_ITEM_DISPATCH_TABLE_DDLS:
                cursor.execute(ddl)
            for ddl in MATTER_ITEM_DISPATCH_INDEX_DDLS:
                cursor.execute(ddl)
        except sqlite3.Error as e:
            raise SyncStoreMigrationError(
                f"v71 migration (matter_item_dispatch table): {e}"
            ) from e
        # per-行动项执行档。fresh 库满梯子在 v44/v45 块建 matter_item 时已带这一列
        # (MATTER_TABLE_DDLS 最新形), 探列后跳过 ALTER; 老库追加在表尾 —— 列序与
        # fresh 库不同, 但 item 读面全部按列名取数 (`dict(row)` / 显式列 INSERT)。
        # 🔴 **不碰**既有那条跨列 CHECK (「非 action 无状态机」): 改 CHECK 要重建整张表。
        # 「只有 kind='action' 能设执行档」下沉 service 校验。
        _item_exec_profile_ddl = (
            "ALTER TABLE matter_item ADD COLUMN exec_profile TEXT NULL "
            "CHECK (exec_profile IS NULL OR exec_profile "
            f"{sql_check_clause(MatterItemExecProfile)})"
        )
        try:
            _item_cols_v71 = {
                row[1]
                for row in cursor.execute("PRAGMA table_info(matter_item)").fetchall()
            }
            if "exec_profile" not in _item_cols_v71:
                cursor.execute(_item_exec_profile_ddl)
                logger.info("v71 migration: matter_item +exec_profile")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "matter_item", {"exec_profile"}, "v71 migration", e,
            )
        # 提案 → 派发的回钩列 + 它的部分索引。🔴 索引只能在这里建 (ALTER 之后),
        # 不进 MATTER_INDEX_DDLS —— v45..v70 老库重放那组时这一列还不存在 (v52 教训)。
        try:
            _update_cols_v71 = {
                row[1]
                for row in cursor.execute(
                    "PRAGMA table_info(matter_update)"
                ).fetchall()
            }
            if "item_dispatch_id" not in _update_cols_v71:
                cursor.execute(
                    "ALTER TABLE matter_update ADD COLUMN item_dispatch_id INTEGER"
                )
                logger.info("v71 migration: matter_update +item_dispatch_id")
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_columns(
                cursor, "matter_update", {"item_dispatch_id"}, "v71 migration", e,
            )
        try:
            cursor.execute(MATTER_UPDATE_ITEM_DISPATCH_INDEX_DDL)
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as e:
            _migration_guard_index(
                cursor, "idx_matter_update_item_dispatch", "v71 migration", e,
            )
    # === v73: agent_run_log / agent_run_step 统一执行台账 + contact_profile_run 迁入 ===
    # 语义 / 数据规则 / 回滚代价见 DB_VERSION 注记与 AGENT_RUN_LOG_TABLE_DDLS 头注。
    # (v72 的 contact_profile_run 建表块已随本版本退役: <v72 老库从没有那张表,
    #  下面的 sqlite_master 探测会跳过搬迁; 恰在 v72 的库走「搬 + DROP」。)
    if current_version < 73:
        try:
            for ddl in AGENT_RUN_LOG_TABLE_DDLS:
                cursor.execute(ddl)
            for ddl in AGENT_RUN_LOG_INDEX_DDLS:
                cursor.execute(ddl)
            has_profile_run = cursor.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name='contact_profile_run'"
            ).fetchone() is not None
            if has_profile_run:
                # 字段映射 (v72 → v73):
                #   status: ok→completed / noop→skipped / fail→failed (9 值域子集,
                #           与旧读侧 _PROFILE_RUN_STATE_BY_STATUS 逐字一致);
                #   summary: 旧读侧 _profile_run_summary 的三句话预生成进列
                #            (新表存 summary 不存计数列, 逐人明细此后走步骤表);
                #   时间列: v72 已是毫秒, 直搬不换算; error 原样。
                #   trigger_kind/detail/model/tokens: 旧台账没有 → NULL。
                cursor.execute(
                    """INSERT INTO agent_run_log
                         (agent_id, started_at, completed_at, status,
                          trigger_kind, trigger_detail, summary, model,
                          input_tokens, output_tokens, error)
                       SELECT 'contact_profile_agent', started_at, completed_at,
                              CASE status WHEN 'ok' THEN 'completed'
                                          WHEN 'noop' THEN 'skipped'
                                          ELSE 'failed' END,
                              NULL, NULL,
                              CASE WHEN status = 'noop'
                                     THEN '没有待更新画像的联系人'
                                   WHEN status = 'fail' AND error IS NOT NULL
                                     THEN '没跑完 · 候选 ' || candidates
                                          || ' 人，已完成 ' || ok_count || ' 人'
                                   ELSE '画像 ' || ok_count || ' 人 · 跳过 '
                                        || skipped || ' · 失败 ' || failed
                              END,
                              NULL, NULL, NULL, error
                         FROM contact_profile_run
                        ORDER BY started_at ASC, id ASC"""
                )
                cursor.execute("DROP TABLE contact_profile_run")
                logger.info(
                    "v73 migration: contact_profile_run rows migrated into "
                    "agent_run_log, table dropped"
                )
        except sqlite3.Error as e:
            raise SyncStoreMigrationError(
                f"v73 migration (agent_run_log tables): {e}"
            ) from e
    # v74: per-message manual reply dismissal (seconds, local-only), and
    # explicit Notion skip provenance. NULL provenance stays unknown for old rows.
    # Additive rollback: old binaries simply ignore both structures.
    # 🔴 today_reply_dismissal 有意不挂 email_metadata 外键：_save_email_v3 对已存在的
    # internal_id 走 INSERT OR REPLACE（先删后插），外键 CASCADE 会把人工决定一起删掉。
    # 读侧只做 NOT EXISTS，孤儿行无害。
    if current_version < 74:
        try:
            cursor.execute("""CREATE TABLE IF NOT EXISTS today_reply_dismissal (
                internal_id INTEGER PRIMARY KEY,
                operation_id TEXT NOT NULL,
                dismissed_at REAL NOT NULL
            )""")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_today_reply_operation ON today_reply_dismissal(operation_id)")
            cols = {row[1] for row in cursor.execute("PRAGMA table_info(email_metadata)")}
            if "sync_skip_reason" not in cols:
                cursor.execute("ALTER TABLE email_metadata ADD COLUMN sync_skip_reason TEXT")
        except sqlite3.Error as exc:
            raise SyncStoreMigrationError(f"v74 migration (reply decisions): {exc}") from exc
    # === v75: 2 字 CJK bigram 并行 FTS5 索引（仅建空表 + 清理触发器，<50ms 不阻塞开窗）===
    if current_version < 75:
        try:
            cursor.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS email_body_fts_cjk2 USING fts5(
                    body_bg,
                    subject_bg,
                    sender_bg,
                    tokenize='unicode61'
                )
            """)
            cursor.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS email_attachment_fts_cjk2 USING fts5(
                    filename_bg,
                    text_bg,
                    tokenize='unicode61'
                )
            """)
            cursor.execute("""
                CREATE TRIGGER IF NOT EXISTS email_body_fts_cjk2_delete
                AFTER DELETE ON email_body BEGIN
                    DELETE FROM email_body_fts_cjk2 WHERE rowid = OLD.internal_id;
                END
            """)
            cursor.execute("""
                CREATE TRIGGER IF NOT EXISTS email_attachment_fts_cjk2_delete
                AFTER DELETE ON email_attachment_text BEGIN
                    DELETE FROM email_attachment_fts_cjk2 WHERE rowid = OLD.attachment_id;
                END
            """)
            cursor.execute("""
                CREATE TRIGGER IF NOT EXISTS email_attachment_fts_cjk2_non_extracted
                AFTER UPDATE ON email_attachment_text
                WHEN NEW.status != 'extracted' OR NEW.text_content IS NULL OR NEW.text_content = ''
                BEGIN
                    DELETE FROM email_attachment_fts_cjk2 WHERE rowid = NEW.attachment_id;
                END
            """)
            has_existing_body = (
                cursor.execute("SELECT 1 FROM email_body LIMIT 1").fetchone() is not None
            )
            has_existing_att = (
                cursor.execute(
                    "SELECT 1 FROM email_attachment_text "
                    "WHERE status = 'extracted' AND text_content IS NOT NULL AND text_content != '' "
                    "LIMIT 1"
                ).fetchone()
                is not None
            )
            done_val = "0" if (has_existing_body or has_existing_att) else "1"
            cursor.execute(
                """INSERT OR IGNORE INTO sync_state (key, value, updated_at)
                   VALUES ('cjk2_backfill_done', ?, ?)""",
                (done_val, time.time()),
            )
        except sqlite3.Error as exc:
            raise SyncStoreMigrationError(f"v75 migration (cjk2 FTS5): {exc}") from exc
    return True
