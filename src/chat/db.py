"""ai_chat.db 读 + 写访问 —— serve-api 远程 chat 端点（V2.1 阶段 2 读 + 阶段 3 3b-3 写）。

ai_chat.db = 前端 owned schema（``frontend/src/electron/main/chat_db.ts``，CHAT_DB_VERSION 31）。
v31（L4 群聊 g1 编排底座，task 09-01）= 群编排的三载体 + 一列，全部 additive：
``ai_chat_sessions.group_config_json``（群设置 JSON：法官位 / 链上限 / 小时预算 / 预设；
NULL = 全取出厂默认，默认值单源在 ``ai-gateway/groupFloors.ts``，DB 不存默认值副本）、
``ai_chat_group_member``（每成员 ``response_mode`` + gateway 的 ``seen_through_id`` 游标，
缺行 = mention + 游标空）、``ai_chat_group_turn``（每次唤醒一行的台账，**两个成本指标与全部
地板计数的权威源**）、``ai_chat_messages.chain_id``（链归属：成员回复写触发消息的 chain_id，
链根行落库为 **NULL**——一次 INSERT 拿不到自身 id，g1 不回填；读侧判据是「NULL 或等于自身 id
即链根」。地板与指标都按 ``ai_chat_group_turn.chain_id`` 计数，不读本列）。
🔴 **两写者列级纪律**：``ai_chat_group_member`` 一张表两个写者 —— ``response_mode`` 只由
serve-api 写（本文件 ``upsert_group_member_modes``，**列级 UPSERT，语句里绝不出现
seen_through_id**），``seen_through_id`` 只由 gateway 写（chat_db/groups.ts 的列级 UPDATE）。
任何一侧整行覆写都会静默冲掉对方的列（owner 刚改的响应模式被一次游标推进冲回 mention）。
``group_config_json`` 归 serve-api 写（``update_group_config``）；``ai_chat_group_turn`` /
``chain_id`` 归 gateway 写，本文件**只读**。``members_json`` 也归 serve-api 写，有两个写点：
建群（``create_new_session(group_members=…)``）与加人/踢人（``update_group_members``，
PATCH /chat/sessions/{id}/group-members）。后者连带 **DELETE** 被动名单的
``ai_chat_group_member`` 整行（行级删除，不是列级覆写：不再是成员 ⇒ 模式与游标一起消失）。
词表（response_mode / outcome / trigger_kind）
单源 ``src/chat/group_limits.py``，闸 ``tests/config/test_group_constants_parity.py``。
本文件的群读写一律经 ``_has_table`` / ``_has_column`` 兼容尚未迁移的旧库（返空不报错）。
v30（L4 群聊）= ``ai_chat_sessions.members_json``（群聊成员 agent id 数组 JSON，非群聊行 NULL）
+ ``ai_chat_messages.speaker_agent_id``（群聊里 assistant 消息的发言成员；NULL = 既有语义不变）
两个 additive 列 + ``origin`` 值域登记 ``'group'``（照 v22/v29 先例；值域现为
'agent' | 'im' | 'team' | 'group' | NULL=交互）。'group' = custom agents 群聊会话（本文件
``create_new_session(group_members=…)`` 与 TS ``createNewSession({groupMembers})`` 双载体写入，
恒 general anchor）。🔴 默认交互过滤两侧同步改为 ``NOT IN ('agent','team','group')``（'group'
行属对话域「群聊」tab，不进主对话历史/⌘O 通用列表）；筛选词表 + 排除集手抄闸同 v29
（tests/config/test_chat_type_mirror_parity.py）。speaker_agent_id 只由前端 gateway 写；
读走 ``SELECT *`` 自动带回。
v29（L4 P4b 团队对话，task 08-27）= ``ai_chat_sessions.origin`` 值域登记 ``'team'``
（**无 schema 变更**的 no-op ladder 步，照 v22 'im' 先例：值域现为
'agent' | 'im' | 'team' | NULL=交互）。'team' = 人在团队页以指定 agent 身份开的**交互式**
会话（≠ 'agent' 的 headless run）：本文件 ``create_new_session(agent_id=…)`` 与 TS
``createNewSession({agentId})`` 双载体写入（origin='team' + agent_id，恒 general anchor）。
🔴 默认交互过滤两侧同步改为 ``NOT IN ('agent','team')``（'team' 行属团队页，不进主对话
历史/⌘O 通用列表）；筛选词表四处手抄 + 排除集两处手抄均有闸
（tests/config/test_chat_type_mirror_parity.py）。
v28（L4 批次3 行动项执行契约，task 08-25）= ``ai_chat_sessions.item_id`` + ``paused_marker_json``
两个 additive 列 + 索引 ``idx_chat_sessions_item``。``item_id`` = 这条会话执行的行动项
（matter_item，跨库无 FK，同 agent_job_id），供「行动项执行历史」反查（本文件
``list_all_sessions`` 的 ``item_id=`` 过滤参数，带 ``_has_column`` 兼容旧库）；
``paused_marker_json`` = manual 会话「曾在审批处暂停」的持久 marker（R7），只证明暂停发生过，
**不含任何 resume 凭据**（审批 stash 仍是 gateway 进程内存，重启后恒不可批 —— marker 只让
UI 诚实说「已失效」）。两列都只由前端 gateway 写，本文件不写；读走 ``SELECT *`` 自动带回。
v27（Matters MVP P3，task 08-09）= ``ai_chat_sessions.anchor_type`` 新增 ``'matter'``：
``email_id`` 必须 NULL，``anchor_id`` 存 Matter 内部正整数 id；前端 rebuild/swap 扩宽 CHECK。
v26（harness optimization P5，task 08-07）= ``chat_queued_input`` 队列表与调度索引。
v25（harness optimization P2，task 08-07）= ``ai_chat_sessions.parent_session_id`` /
``parent_tool_call_id`` / ``invoked_by``。三列均 nullable，父会话删除不级联。
🔴 09-02（g2）起 Python 不再只读这三列中的两列：``create_new_session`` 的 **group 分支**写
``parent_session_id``（子群回指父群）+ ``invoked_by``（值域 group_limits.SESSION_INVOKED_BY）；
``parent_tool_call_id`` 仍只由 gateway 写。
v24（harness optimization P1，task 08-07）= ``ai_chat_sessions.trigger_id`` / ``trigger_kind`` /
``trigger_fired_at`` 与 agent/trigger 两个查询索引。三列均 nullable；Python 只读且通过
``_has_column`` 兼容尚未迁移的 v23 库。
v23（WP-15 context 环，task 08-05）= ``ai_chat_messages.context_tokens``：本回合最后一次
provider 调用的 prompt token 数（= composer 右下 context 环显示的「上下文占用」）。
🔴 与 ``tokens_input`` **语义不同** —— 那一列是 ai@7 的多 step **求和**（工具循环回合里同一段
prompt 被计好几遍），这一列是**末 step** 的 inputTokens。只有前端 gateway 的 persistTurn 写，
本文件**不写**这一列；读侧 ``SELECT *`` 自动带回（远程 web 因此与桌面同源）。
v22（飞书 messenger 阶段 2 PR-1，task 08-01）= ``ai_chat_sessions.origin`` 值域登记 ``'im'``
（**无 schema 变更**的 no-op ladder 步：origin 是 v19 加的无 CHECK 自由文本列，值域现为
'agent' | 'im' | NULL=交互）。'im' 行由 gateway 主进程 ``createImSession`` 写（origin='im'，
general anchor，飞书会话），默认交互列表过滤 ``COALESCE(origin,'interactive') <> 'agent'``
**有意**不动 —— 'im' 行自动进桌面会话列表（Q18=A「来自飞书」）。本文件读侧 ``SELECT *`` /
``s.*`` 自动带回，``list_all_sessions`` 的 origin 过滤参数值域暂不加 'im'（TS 侧
ChatSessionOriginFilter 已补词表、无调用方传它；两侧过滤 SQL 逐字镜像不变）。
v21（custom-agent epic W3，task 07-28）= ``ai_chat_sessions.pinned_at`` + ``starred``：
置顶分组顺序与独立星标状态；两类组织动作均不 bump updated_at。
v20（harness-chat lane A B4，task 07-15）= ``ai_chat_sessions.last_read_at``：未读徽标的
per-session 已读水位（NULL = 旧行/从未打开 → 不打点；未读判定 = updated_at > last_read_at）。
写经本文件 ``update_session_last_read``（serve-api PATCH /chat/sessions/{id}/read，远程 parity），
刻意不 bump updated_at（已读绝不重排历史）；读走 ``SELECT *`` 自动带回 + list_all_sessions 显式列
已加 s.last_read_at。additive ALTER（schema 归 chat_db connection.ts ``migrate``，本文件不建表）。
NOT EXPECTED_DB_VERSION。
v19（S4 W3，task 07-02-s4-custom-agent-core）= ``ai_chat_sessions.origin`` + ``agent_id`` +
``agent_job_id``：headless custom-agent run（cron/email 触发，ADR-003 D3）落一个一等会话行，
origin='agent' 标记（交互会话 NULL），agent_id/agent_job_id 回链 report_agent + async_jobs
（agent_job_id = async_jobs.job_id 的 TEXT，跨库无 FK）。backend_kind CHECK 不变（仍 'ai-sdk'，
引擎没变、只是发起方变）。三个 additive ALTER，读走 ``SELECT *`` 自动带回；本文件不建表/不写这三列
（schema 归 chat_db.ts ``migrate``，会话创建走 gateway 主进程 ``createAgentSession``）。NOT EXPECTED_DB_VERSION。
v18（S2 W1，task 07-02-s2-exec-skill-install）= ``chat_tool_call.whitelist_rule_id``：S2 exec 工具
（run_command / file_read / file_write）经结构化白名单 PolicyRule 命中而**免卡执行**的审计行记
``approval_status='auto_whitelist'``（approval_status 是自由 TEXT，v10 加时无 CHECK，新值无需枚举迁移）
（07-16 approval-mode switcher 无 bump 再加三个自由值：``auto_accept_edits`` / ``auto_bypass``
（owner 全局模式跳卡，含 send）/ ``auto_reversible``（既有可逆免卡路径，原先不可区分地记 'approved'）；
'approved'/'edited' 自此专指真实人工卡决定）
（09-02 群工具 g2 无 bump 再加两个自由值：``auto_judge_scope``（群内法官的 judgeScopeHash
匹配免卡）/ ``auto_user_requested_verified``（主 agent 群工具的服务端核验型 user_requested）；
本文件的免卡执行口径 ``count_auto_whitelist_writes`` 已改 IN 三值，人工审批口径不动）
+ ``whitelist_rule_id`` = 命中的规则 id。gateway 在 Electron main 经 chat_db.ts 直写（本 serve-api 路径
不写此列，同 v10-v12：``append_tool_call`` 既有写面不变、新列默认 NULL；读走 ``SELECT *`` 自动带回）。
v17（S1 R1，task 07-02 openness wave1）= ``ai_chat_messages_fts``：ai_chat_messages.content 的
FTS5 external-content 索引（tokenize='trigram'，中文子串可搜）+ INSERT/UPDATE/DELETE 同步触发器
+ 存量 'rebuild' backfill。本文件新增 ``search_sessions``（**只 SELECT**，0 CREATE TABLE 不变式
保持）：≥3 字符 query 走 FTS MATCH（phrase 转义，用户输入永不解析为 FTS 语法）；<3 字符（trigram
索引够不着）或 FTS 表不存在（旧库未经前端迁移）→ LIKE 降级。
v16（M5b，2026-06-30）= agent_memory_kv 物理退役（DROP TABLE）。记忆终态 = user.md(M3 恒注入) +
mem0(M1/M2 capture/召回)；KV 表无 FK 依赖，简单事务 DROP。NOT EXPECTED_DB_VERSION。
v15：ai_chat_sessions.archived INTEGER NOT NULL DEFAULT 0 — 软删标志（0=正常，1=已归档）。归档会话
从 list_all_sessions 过滤（WHERE s.archived = 0）；写经 update_session_archived 镜像（ai_chat.db
own ladder，非 EXPECTED_DB_VERSION；chat_db.ts 是 schema 真源，本文件不建表）。
v14（demo-fidelity Phase 10）：ai_chat_sessions.title — 可选会话标题（gateway haiku 自动标题 /
手动改名）。读走 ``SELECT *`` 自动带回（list_all_sessions 显式列已加 s.title）；写经
update_session_title 镜像（chat_db.ts 是 schema 真源，本文件不建表）。
v7（P2c）= chat session anchor：``email_id`` 改 nullable + 加 ``anchor_type``/``anchor_id`` 列
（table CHECK 强制 email→两者非空 / general→两者 NULL，禁 emailId=0 sentinel）。
v8（P2a，task 06-23）= agent_memory_kv provenance + priority：加 ``source_session_id`` /
``source_message_id`` / ``source_tool_use_id``（写入来源的会话/消息/工具，取代
``source_wiki_path='session:<id>'`` 旧 overload）+ ``priority``（用户显式重要性，驱动
``memory_summary`` 注入相关性排序）。
v9（P4 Phase 02，task 06-23 chat-panel AI SDK Gateway）= ``ai_chat_messages.ui_message_json``：
AI SDK v6 UIMessage canonical JSON（gateway runtime 双写，与 ``content`` 提取文本并列）。读走
``SELECT *`` 自动带回；写经 ``append_message`` / ``update_message`` 镜像（legacy 行 NULL）。本
文件只 mirror 读写既有列、**绝不建表/改 schema**（schema 归 chat_db.ts ``migrate``）。
v10（P4 Phase 03b，task 06-23 chat-panel HITL write tools）= ``chat_tool_call.approval_status``
+ ``approval_hash``：AI SDK Gateway 写工具的审批审计（gateway 在 Electron main 经 chat_db.ts
直写，非本 serve-api 路径）。读走 ``SELECT *`` 自动带回（read/legacy 行 NULL），本文件的
``append_tool_call`` 不写这两列（既有写面不变，新列默认 NULL）。
v11（P4 Phase 04a，task 06-23 chat-panel A2UI tool cards）= ``chat_tool_call.ui_payload_json``：
富工具卡的 A2UI 渲染 payload（component + props + audit，protocol §3），gateway 在 Electron main
经 chat_db.ts 直写（仅 MAILAGENT_A2UI_TOOL_CARDS 开 + 工具有卡时）。读走 ``SELECT *`` 自动带回
（read/legacy/flag-off 行 NULL），``append_tool_call`` 不写此列（既有写面不变，新列默认 NULL）。
v12（P4 Phase 04b，task 06-23 chat-panel high-risk send）= ``chat_tool_call.content_hash`` +
``idempotency_key``：高风险外发（email_prepare_send）的双 guard 审计（content hash 绑定审批内容与
实发内容，idempotency_key 是 Python send ledger 的一次性键），gateway 在 Electron main 经 chat_db.ts
直写（仅 email_prepare_send 行）。读走 ``SELECT *`` 自动带回（其余/legacy 行 NULL），
``append_tool_call`` 不写此两列（既有写面不变，新列默认 NULL）。
v13（P4 Phase 06a，task 06-23 chat-panel cutover）= ``ai_chat_sessions.backend_kind`` CHECK 放宽，
加 ``'ai-sdk'``（经 AI SDK Gateway 创作的会话成为一等 backend_kind，面板按 session 路由 runtime）。
chat_db.ts ``migrate`` 表重建放宽 CHECK；本文件纯镜像不建表，``get_or_create_session`` /
``create_new_session`` 的 ``backend_kind: str`` 形参无独立 CHECK，故只需同步本头注释版本号。
读函数（阶段 2）+ 写函数（3b-3）SQL **逐字镜像** chat_db.ts 对应函数，行形状对齐前端
``ChatSession`` / ``ChatSessionSummary`` / ``ChatMessage`` / ``ChatToolCall``（``model.ts``）：
  - 读：``listSessionsForEmail`` / ``listAllSessions`` / ``listMessages`` / ``listToolCallsForMessage``。
  - 写（3b-3 = ``ChatPersistPort`` 写面）：``getOrCreateSession`` / ``createNewSession`` /
    ``appendMessage`` / ``updateMessage`` / ``deleteMessagesFromId`` / ``abortStreamingMessages`` /
    ``appendToolCall`` / ``updateToolCall`` + 单行读 ``getSession`` / ``getMessage`` /
    ``getToolCallByUseId``（dispatcher 需要）。

路径 = ``DATA_ROOT/frontend/ai_chat.db``（对齐 chat_db.ts ``resolveChatDbPath``），env
``AI_CHAT_DB_PATH`` override。serve-api 由 ``backend_lifecycle`` 注入 ``MAILAGENT_DATA_ROOT``，
故 ``src.config.DATA_ROOT`` 与前端 ``resolveDataRoot()`` 同源。

graceful（读）：库不存在（全新用户无 chat 历史）/ 表未初始化 / 锁 → 返回 ``[]``（不建空库），
对齐前端 IPC handler「失败返 []」契约。

**写约束**：schema 归前端 owns（chat_db.ts ``migrate`` 是唯一真源，按 CHAT_DB_VERSION 升级）—
serve-api **只写既有表、绝不建表/改 schema**（防版本漂移）。故写路径**不**做「库不存在返
graceful」处理：生产里前端 ``getChatDb()`` 在任何 renderer harness 写之前已建好库 + 迁移
（3c cutover 序），写到缺 schema 的库是真实配置错（OperationalError 经全局 handler → 500）。
3b 不接 renderer（http persist 仅 3b-5 mock-fetch 测）→ 生产单 writer；3c（D5 本地走 serve-api）
后亦单 writer，短暂双写 WAL 安全。
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

# g1 群聊（v31）— 值域 / 指标口径词表单源（闸 tests/config/test_group_constants_parity.py）。
from src.chat.group_limits import CHAIN_ROOT_TRIGGER_KINDS, SILENT_OUTCOMES


def _now_ms() -> int:
    """epoch 毫秒（对齐 chat_db.ts ``Date.now()``，所有写的 created_at/updated_at 用它）。"""
    return int(time.time() * 1000)


def parse_group_member_ids(raw: Any) -> List[str]:
    """``members_json`` 原文 → 成员 id 列表（宽容解析，与 TS ``parseGroupMemberIds`` 同口径：
    坏 JSON / 非数组 / 非字符串项一律丢弃 → 空名单）。路由层的 ``_group_member_ids`` 引本函数。"""
    if not isinstance(raw, str) or not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [m for m in parsed if isinstance(m, str) and m.strip()]


_ANCHOR_TYPES = ("email", "general", "matter")


def _resolve_anchor(
    anchor_type: str, email_id: Optional[int], matter_id: Optional[int] = None
) -> tuple[str, Optional[int], Optional[int]]:
    """P2c — 把 (anchor_type, email_id) 解析成 (anchor_type, email_id, anchor_id)。镜像
    chat_db.ts ``resolveAnchor``：email（默认）→ email_id 必须非负 int、anchor_id=email_id；
    general → 两者 NULL（**绝不**接受 emailId sentinel）。非法 email anchor 抛 ValueError
    （router 已前置校验，这里是 defense-in-depth，免得插入违反 v7 CHECK 的行）。"""
    if anchor_type == "general":
        # codex review HIGH — reject a general anchor carrying ANY non-None emailId
        # (incl. 0); never silently drop it (that's the banned sentinel).
        if email_id is not None:
            raise ValueError(f"general anchor must not carry an emailId (got {email_id!r})")
        return "general", None, None
    if anchor_type == "matter":
        if email_id is not None:
            raise ValueError(f"matter anchor must not carry an emailId (got {email_id!r})")
        if not isinstance(matter_id, int) or isinstance(matter_id, bool) or matter_id <= 0:
            raise ValueError(
                f"anchor_type='matter' requires a positive integer matterId, got {matter_id!r}"
            )
        return "matter", None, matter_id
    if anchor_type not in _ANCHOR_TYPES:
        raise ValueError(f"anchor_type must be one of {_ANCHOR_TYPES!r}, got {anchor_type!r}")
    if not isinstance(email_id, int) or isinstance(email_id, bool) or email_id < 0:
        raise ValueError(
            f"anchor_type='email' requires a non-negative integer emailId, got {email_id!r}"
        )
    return "email", email_id, email_id


def _clip_snippet(content: str, query: str, snippet_chars: int) -> str:
    """把命中消息裁成以命中词为中心的 snippet（≤ snippet_chars 字符）。

    大小写不敏感找 query 首次出现位置，窗口前置 ~30% 上下文；找不到（FTS 多词/大小写折叠
    差异等）退化为开头截断。截断侧加省略号标记，模型能看出这是节选。
    """
    if len(content) <= snippet_chars:
        return content
    idx = content.lower().find(query.lower())
    if idx < 0:
        return content[:snippet_chars] + "…"
    lead = max(0, idx - max(20, snippet_chars * 3 // 10))
    clipped = content[lead : lead + snippet_chars]
    prefix = "…" if lead > 0 else ""
    suffix = "…" if lead + snippet_chars < len(content) else ""
    return f"{prefix}{clipped}{suffix}"


# UpdateMessagePatch / UpdateToolCallPatch（camelCase wire key → 列名）映射，**字段顺序逐字
# 镜像 chat_db.ts updateMessage / updateToolCall**。``key in patch`` 精确复刻 TS ``!== undefined``
# 语义（key 缺 → 不更；key 在即便值 None → 更为 NULL），故 patch 来自 wire 时「省略 ≠ 置空」。
_MESSAGE_PATCH_FIELDS = (
    ("content", "content"),
    ("status", "status"),
    ("tokensInput", "tokens_input"),
    ("tokensOutput", "tokens_output"),
    ("costUsd", "cost_usd"),
    ("errorMessage", "error_message"),
    ("model", "model"),
    ("metadata", "metadata"),
    # task 06-08-chat 需求 5 — extended-thinking summary（finalizeMessage 终态写）。
    ("thinking", "thinking"),
    # v9（P4 Phase 02）— AI SDK UIMessage canonical JSON（gateway onFinish 终态写）。
    ("uiMessageJson", "ui_message_json"),
)
_TOOL_CALL_PATCH_FIELDS = (
    ("status", "status"),
    ("outputJson", "output_json"),
    ("durationMs", "duration_ms"),
    ("userEditedInputJson", "user_edited_input_json"),
    ("confirmedAt", "confirmed_at"),
)


def resolve_ai_chat_db_path() -> str:
    """ai_chat.db 路径：env ``AI_CHAT_DB_PATH`` override，否则 ``DATA_ROOT/frontend/ai_chat.db``。"""
    override = os.environ.get("AI_CHAT_DB_PATH")
    if override:
        return override
    # lazy import：避免裸 worktree（无 .env）import 即触发 Config 校验（与 deps.py 同纪律）。
    from src.config import DATA_ROOT

    return os.path.join(DATA_ROOT, "frontend", "ai_chat.db")


class ChatDb:
    """ai_chat.db 读 + 写访问。连接 per-call 短命（WAL 并发安全，与 mail-sync/前端 writer 不冲突）。

    读 graceful（库不存在 → []）；写假设 schema 已存在（前端 owns，见模块 docstring「写约束」）。
    """

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or resolve_ai_chat_db_path()

    @contextmanager
    def _connection(self):
        # 默认 connect（非 mode=ro）：能读 WAL -wal 里前端 writer 尚未 checkpoint 的新数据
        # （mode=ro 读不到未 checkpoint 的 WAL）。只读查询不写，WAL 下 reader 不阻塞 writer。
        conn = sqlite3.connect(self.db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def _write_connection(self):
        """写连接：clean exit 自动 commit，异常 rollback，总 close（per-call 短命，WAL 安全）。

        ``foreign_keys = ON`` 对齐 chat_db.ts ``getChatDb``（真实 schema 的 ON DELETE CASCADE +
        message→session FK 在生产里据此生效；测试 DDL 无 FK → no-op）。journal_mode 不在此设：
        库的 WAL 模式是持久化属性，已由前端首次 ``getChatDb`` 建立，任何后开连接自动沿用。
        """
        conn = sqlite3.connect(self.db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _read_all(self, sql: str, params: tuple = ()) -> List[Dict[str, Any]]:
        # 库不存在 → 空（不让 connect 建空文件，避免在 ai_chat.db 位置留废库）。
        if not os.path.exists(self.db_path):
            return []
        try:
            with self._connection() as conn:
                return [dict(r) for r in conn.execute(sql, params).fetchall()]
        except sqlite3.Error:
            # 表未初始化（库刚建无 schema）/ 锁超时 → graceful 空（对齐前端 handler 失败返 []）。
            return []

    def _read_one(self, sql: str, params: tuple = ()) -> Optional[Dict[str, Any]]:
        """单行读（graceful 同 _read_all：库不存在/表未初始化/锁 → None）。镜像 chat_db.ts
        ``getSession`` / ``getMessage`` / ``getToolCallByUseId`` 的 ``row ?? null``。"""
        if not os.path.exists(self.db_path):
            return None
        try:
            with self._connection() as conn:
                row = conn.execute(sql, params).fetchone()
                return dict(row) if row is not None else None
        except sqlite3.Error:
            return None

    def _has_column(self, table: str, column: str) -> bool:
        """Best-effort schema probe for compatibility reads against a pre-migration frontend DB."""
        if not os.path.exists(self.db_path):
            return False
        try:
            with self._connection() as conn:
                rows = conn.execute(f"PRAGMA table_info({table})")
                return any(row["name"] == column for row in rows)
        except sqlite3.Error:
            return False

    def _has_table(self, table: str) -> bool:
        """Best-effort 表存在探针（v31 群三载体在尚未被前端迁移的库上整表缺席 → 读面返空、
        写面 no-op，而不是 500）。"""
        if not os.path.exists(self.db_path):
            return False
        try:
            with self._connection() as conn:
                row = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                    (table,),
                ).fetchone()
                return row is not None
        except sqlite3.Error:
            return False

    # ── sessions ──────────────────────────────────────────────────────────

    def list_sessions_for_email(self, email_id: int) -> List[Dict[str, Any]]:
        """某邮件的 chat sessions（按 updated_at 倒序）。镜像 listSessionsForEmail → ChatSession[]。"""
        return self._read_all(
            "SELECT * FROM ai_chat_sessions WHERE email_id = ? ORDER BY updated_at DESC",
            (email_id,),
        )

    def list_general_sessions(self) -> List[Dict[str, Any]]:
        """P2c — general（无邮件 context）sessions（按 updated_at 倒序）。镜像
        listGeneralSessions → ChatSession[]。与 list_sessions_for_email 分开，general session
        绝不漏进某封邮件的 sidebar。"""
        # P4b：'team' 行（general anchor + agent 身份）与 'agent' 行一样不进通用列表 ——
        # 它们的宿主是团队页。v30：'group' 行同理（宿主是对话域「群聊」tab）。
        # 排除集与 TS 镜像 listGeneralSessions 逐字对齐（轻量闸见
        # test_chat_type_mirror_parity.py::test_chat_interactive_origin_exclusion_mirror_parity）。
        origin_clause = (
            " AND COALESCE(origin, 'interactive') NOT IN ('agent', 'team', 'group')"
            if self._has_column("ai_chat_sessions", "origin")
            else ""
        )
        return self._read_all(
            "SELECT * FROM ai_chat_sessions WHERE anchor_type = 'general'"
            f"{origin_clause} ORDER BY updated_at DESC",
        )

    def list_all_sessions(
        self,
        limit: int = 300,
        include_archived: bool = False,
        origin: str = "interactive",
        *,
        agent_id: Optional[str] = None,
        agent_job_id: Optional[str] = None,
        trigger_id: Optional[str] = None,
        trigger_kind: Optional[str] = None,
        created_after: Optional[int] = None,
        created_before: Optional[int] = None,
        archived: Optional[bool] = None,
        starred: Optional[bool] = None,
        matter_id: Optional[int] = None,
        item_id: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """跨邮件 session 历史（含 first_user_message 预览 + message_count + last_message_*
        五列投影；除 origin='group' 外排除无消息 session）。镜像 listAllSessions →
        ChatSessionSummary[]（``last_message_*`` 由路由层折成 ``last_message`` 对象）。
        include_archived=False（默认）只返回活跃会话（archived=0）；
        include_archived=True 返回全部含归档会话（用于归档分组视图）。

        v20 起用 ``s.*``（TS 侧仍显式列）：serve-api 可能先于前端 migrate 跑到（启动竞态 /
        旧库），显式引用 last_read_at 会在 pre-v20 库上 OperationalError → _read_all 吞成 []
        = 整个历史列表被清空。``s.*`` 两个世界都成立：列在 → 带回（未读徽标），列不在 →
        缺键（前端按 undefined = 无徽标处理）。"""
        if origin not in ("interactive", "agent", "im", "team", "group", "all"):
            raise ValueError(f"invalid session origin filter: {origin!r}")
        clauses = []
        params: list[Any] = []
        if archived is not None:
            clauses.append("s.archived = ?")
            params.append(1 if archived else 0)
        elif not include_archived:
            clauses.append("s.archived = 0")
        has_origin = self._has_column("ai_chat_sessions", "origin")
        if origin == "interactive" and has_origin:
            # P4b：'team'（人以 agent 身份开的会话）不进主对话历史 —— 它们属于团队页
            # （按 agent_id 读）。v30：'group'（群聊会话）同理，属对话域「群聊」tab。
            # 排除集与 TS 镜像逐字对齐（chat_db/sessions.ts
            # listAllSessions 的 originClause 默认支；轻量闸
            # tests/config/test_chat_type_mirror_parity.py::test_chat_interactive_origin_exclusion_mirror_parity）。
            clauses.append("COALESCE(s.origin, 'interactive') NOT IN ('agent', 'team', 'group')")
        elif origin == "agent":
            if not has_origin:
                return []
            clauses.append("s.origin = 'agent'")
        elif origin == "im":
            if not has_origin:
                return []
            clauses.append("s.origin = 'im'")
        elif origin == "team":
            if not has_origin:
                return []
            clauses.append("s.origin = 'team'")
        elif origin == "group":
            if not has_origin:
                return []
            clauses.append("s.origin = 'group'")
        for column, value in (
            ("agent_id", agent_id), ("agent_job_id", agent_job_id),
            ("trigger_id", trigger_id), ("trigger_kind", trigger_kind),
        ):
            if value is None:
                continue
            if not self._has_column("ai_chat_sessions", column):
                return []
            clauses.append(f"s.{column} = ?")
            params.append(value)
        if created_after is not None:
            clauses.append("s.created_at >= ?")
            params.append(created_after)
        if created_before is not None:
            clauses.append("s.created_at <= ?")
            params.append(created_before)
        if starred is not None:
            if not self._has_column("ai_chat_sessions", "starred"):
                return []
            clauses.append("s.starred = ?")
            params.append(1 if starred else 0)
        if matter_id is not None:
            # 事项对话锚在 matter 上。以前这条是 chat 路由里的一段手写 SQL 旁路，于是
            # 上面所有过滤参数对 matterId 查询全部静默失效，连 first_user_message 预览和
            # message_count 都拿不到 —— 现在它只是众多条件里的一条。
            if not self._has_column("ai_chat_sessions", "anchor_type"):
                return []
            clauses.append("s.anchor_type = 'matter' AND s.anchor_id = ?")
            params.append(matter_id)
        if item_id is not None:
            # v28 —「行动项执行历史」：一条行动项名下的全部会话。与 matter_id 分开（一件事的
            # 会话 ⊋ 某条行动项的会话），且**不**按 origin 过滤 —— 行动项要看的正是 headless
            # 执行 run。旧库（未跑 v28 迁移）没有这一列 → 返回 []，绝不让 SQL 报错吞成整表。
            if not self._has_column("ai_chat_sessions", "item_id"):
                return []
            clauses.append("s.item_id = ?")
            params.append(item_id)
        if origin != "group":
            # 🔴 'group' 行豁免这一条：群是**先建后说话**的（建群对话框一次填齐，第一条消息可能
            # 几分钟后才发）。要求「有消息才可见」会让刚建的群在列表里不存在，renderer 只能靠
            # 一个本地过渡态假装它在 —— 重启即消失。其余 origin 字节不变（无消息的会话是
            # getOrCreateSession 留下的空壳，本就不该进历史）。
            clauses.append("EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.session_id = s.id)")
        where_clause = " AND ".join(clauses)
        # 群列表行的「最后一条发言」预览（U5）。🔴 每个可能缺席的列都要探一次：pre-v30 库没有
        # speaker_agent_id、更旧的 mirror schema 没有 status / metadata —— 引用一个不存在的列
        # 会 OperationalError → _read_all 吞成 [] = **整个历史列表被清空**（同 v20 的 s.* 教训）。
        def _col(name: str, expr: str) -> str:
            return expr if self._has_column("ai_chat_messages", name) else "NULL"

        speaker_col = _col("speaker_agent_id", "m.speaker_agent_id")
        via_col = _col("metadata", "json_extract(m.metadata, '$.via')")
        # status 缺席的库退化成「不过滤 streaming 行」而不是整表读不出来。
        status_filter = " AND m.status = 'complete'" if self._has_column(
            "ai_chat_messages", "status"
        ) else ""
        # 每列一个相关子查询而不是一次 join：SQLite 对 `WHERE session_id=? ORDER BY created_at
        # DESC LIMIT 1` 走同一条索引，写法与上面两列一致。role 只取 user/assistant ——
        # system 行是 group_stop 之类的编排痕迹，不是「谁说了什么」。
        last_message_cols = ",\n                 ".join(
            f"(SELECT {expr} FROM ai_chat_messages m"
            " WHERE m.session_id = s.id AND m.role IN ('user', 'assistant')"
            f"{status_filter}"
            f" ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS {alias}"
            for expr, alias in (
                ("substr(m.content, 1, 200)", "last_message_content"),
                ("m.role", "last_message_role"),
                (speaker_col, "last_message_speaker_agent_id"),
                (via_col, "last_message_via"),
                ("m.created_at", "last_message_created_at"),
            )
        )
        return self._read_all(
            f"""SELECT
                 s.*,
                 (SELECT substr(m.content, 1, 500) FROM ai_chat_messages m
                    WHERE m.session_id = s.id AND m.role = 'user'
                    ORDER BY m.created_at ASC LIMIT 1) AS first_user_message,
                 (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.session_id = s.id) AS message_count,
                 {last_message_cols}
               FROM ai_chat_sessions s
               WHERE {where_clause}
               ORDER BY s.updated_at DESC
               LIMIT ?""",
            (*params, max(1, min(int(limit), 300))),
        )

    # ── messages ──────────────────────────────────────────────────────────

    def list_messages(self, session_id: int) -> List[Dict[str, Any]]:
        """某 session 的全部消息（按 created_at/id 升序）。镜像 listMessages → ChatMessage[]。"""
        return self._read_all(
            "SELECT * FROM ai_chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
            (session_id,),
        )

    def get_latest_assistant_message(self, session_id: int) -> Optional[Dict[str, Any]]:
        """某 session 最新一条 assistant 消息 or None（**只读**，graceful 同 _read_one）。

        飞书 IM 桥（``src/im/bridge.py``，08-01 阶段 2 PR-3）在审批 decide 终态后
        取「本回合的完整最终回复」用 —— ``/decide`` 响应里的 ``summary`` 是 gateway
        180 字符截断的一行摘要，完整文本只在这儿。调用侧自带 created_at 时间闸 +
        有界重试，本函数不做等待。
        """
        return self._read_one(
            "SELECT * FROM ai_chat_messages WHERE session_id = ? AND role = 'assistant' "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (session_id,),
        )

    # ── session search（S1 R1，只 SELECT — 0 CREATE TABLE 不变式）───────────

    def search_sessions(
        self,
        query: str,
        *,
        session_limit: int = 20,
        snippets_per_session: int = 3,
        snippet_chars: int = 200,
        origin: str = "all",
        agent_id: Optional[str] = None,
        agent_job_id: Optional[str] = None,
        trigger_id: Optional[str] = None,
        trigger_kind: Optional[str] = None,
        created_after: Optional[int] = None,
        created_before: Optional[int] = None,
        archived: Optional[bool] = None,
        starred: Optional[bool] = None,
    ) -> List[Dict[str, Any]]:
        """按消息内容检索历史会话，按 session 聚合返回 {session 元数据 + 命中 snippet}。

        检索路径两级：≥3 字符 query → ``ai_chat_messages_fts`` MATCH（trigram，中文子串可搜；
        query 恒转义成 FTS phrase ``"…"``，用户输入永不解析为 FTS 语法 → AND/OR/* 注入不进
        MATCH 表达式）；<3 字符（trigram 索引最小 token=3，注定 0 命中）或 FTS 表不存在
        （旧库未经前端 v17 迁移，OperationalError）→ LIKE 降级（``%``/``_``/``\\`` 转义）。

        cap：session ≤ ``session_limit``（clamp 到 [1,20]）、每 session snippet ≤
        ``snippets_per_session``、每 snippet ≤ ``snippet_chars`` 字符（命中词居中切窗）。
        排序：FTS 按 rank（bm25），LIKE 按 created_at 倒序；session 序 = 其首个命中的出现序。
        graceful（读契约）：库不存在 / 锁 / 损坏 → []。
        """
        query = (query or "").strip()
        if not query or not os.path.exists(self.db_path):
            return []
        session_limit = max(1, min(int(session_limit), 20))
        snippets_per_session = max(1, min(int(snippets_per_session), 5))
        # 命中行按 hit-cap 预取：足够填满 session_limit×snippets 的聚合，又不无界扫全库。
        hit_cap = 200
        try:
            with self._connection() as conn:
                hits: Optional[List[sqlite3.Row]] = None
                if len(query) >= 3:
                    # FTS5 phrase：内部双引号翻倍转义 → 整个 query 是单一 phrase 字面量。
                    match_expr = '"' + query.replace('"', '""') + '"'
                    try:
                        hits = conn.execute(
                            """SELECT m.session_id, m.id AS message_id, m.role,
                                      substr(m.content, 1, 4000) AS content, m.created_at
                                 FROM ai_chat_messages_fts f
                                 JOIN ai_chat_messages m ON m.id = f.rowid
                                WHERE ai_chat_messages_fts MATCH ?
                                ORDER BY rank
                                LIMIT ?""",
                            (match_expr, hit_cap),
                        ).fetchall()
                    except sqlite3.OperationalError:
                        hits = None  # FTS 表不存在（未迁移库）→ LIKE 降级
                if hits is None:
                    like_expr = (
                        "%"
                        + query.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
                        + "%"
                    )
                    hits = conn.execute(
                        r"""SELECT m.session_id, m.id AS message_id, m.role,
                                  substr(m.content, 1, 4000) AS content, m.created_at
                             FROM ai_chat_messages m
                            WHERE m.content LIKE ? ESCAPE '\'
                            ORDER BY m.created_at DESC, m.id DESC
                            LIMIT ?""",
                        (like_expr, hit_cap),
                    ).fetchall()

                # 按 session 聚合：session 序 = 首个命中的出现序（FTS=rank / LIKE=新→旧）。
                by_session: Dict[int, List[sqlite3.Row]] = {}
                order: List[int] = []
                for h in hits:
                    sid = h["session_id"]
                    if sid not in by_session:
                        if len(order) >= session_limit:
                            continue
                        by_session[sid] = []
                        order.append(sid)
                    if len(by_session[sid]) < snippets_per_session:
                        by_session[sid].append(h)
                if not order:
                    return []

                placeholders = ",".join("?" * len(order))
                session_rows = {
                    r["id"]: dict(r)
                    for r in conn.execute(
                        f"SELECT id, email_id, anchor_type, backend_kind, title, archived, "
                        f"created_at, updated_at FROM ai_chat_sessions "
                        f"WHERE id IN ({placeholders})",
                        order,
                    ).fetchall()
                }
                allowed = {
                    row["id"]: row
                    for row in self.list_all_sessions(
                        limit=300, include_archived=True, origin=origin,
                        agent_id=agent_id, agent_job_id=agent_job_id,
                        trigger_id=trigger_id, trigger_kind=trigger_kind,
                        created_after=created_after, created_before=created_before,
                        archived=archived, starred=starred,
                    )
                }
                out: List[Dict[str, Any]] = []
                for sid in order:
                    sess = session_rows.get(sid)
                    if sess is None or sid not in allowed:
                        continue  # 孤儿消息（session 行已删）— 防御，正常被 FK CASCADE 挡住
                    sess = allowed[sid]
                    out.append(
                        {
                            "session": sess,
                            "snippets": [
                                {
                                    "message_id": h["message_id"],
                                    "role": h["role"],
                                    "snippet": _clip_snippet(
                                        h["content"], query, snippet_chars
                                    ),
                                    "created_at": h["created_at"],
                                }
                                for h in by_session[sid]
                            ],
                        }
                    )
                return out
        except sqlite3.Error:
            return []

    # ── tool calls ────────────────────────────────────────────────────────

    def list_tool_calls_for_message(self, message_id: int) -> List[Dict[str, Any]]:
        """某 assistant 消息的工具调用审计行（按 created_at/id 升序）。
        镜像 listToolCallsForMessage → ChatToolCall[]。无 tool_use 的消息返 []。"""
        return self._read_all(
            "SELECT * FROM chat_tool_call WHERE message_id = ? ORDER BY created_at ASC, id ASC",
            (message_id,),
        )

    def list_im_approvals(self, limit: int = 20) -> Optional[List[Dict[str, Any]]]:
        """飞书（``ai_chat_sessions.origin='im'``）会话里的**人工审批决定**，最近 N 条倒序。

        08-01 阶段 2 PR-4「信任可见」：设置-AI「飞书对话」区的「批过哪些操作」用。

        🔴 **只取真人决定的三个值** ``approved`` / ``edited`` / ``rejected``。另外四个
        ``auto_*``（auto_whitelist / auto_accept_edits / auto_bypass / auto_reversible）
        是**免卡执行**的审计位（值域纪律见 ``frontend/src/ai-gateway/tools/types.ts``
        的分值域注释），把它们混进「批过哪些操作」= 谎报有人批过。read 类工具该列为
        NULL，自然不入选。

        🔴 **判据是「会话 origin='im'」，不是「点击发生在飞书」** —— gateway 对桌面
        审批卡与飞书审批卡写的是同一个 ``approval_status``，DB 层分不出点击来自哪一
        侧。故本投影的诚实语义是「飞书会话里的审批决定」，调用侧文案必须照此写。

        时间取 ``COALESCE(confirmed_at, updated_at)``：``chat_tool_call`` 没有
        ``decided_at`` 列，``confirmed_at`` 是审批落定戳、``updated_at`` 兜住它为空的行
        （实测生产行 ``confirmed_at`` 恒 NULL —— 写侧 ``updateToolCall`` 至今没有调用方传它）。

        🔴 ``decided_at`` 的单位是 **epoch 毫秒**（两列都由 ``chat_db/tool_calls.ts`` 的
        ``Date.now()`` 写入），**不是秒** —— 与 sync_state 里 Python ``time.time()`` 写的那些
        时间戳单位相反，且都是整数、在 JSON 里肉眼分不出来。本方法原样透出不做换算，
        **渲染侧必须按毫秒解释**（按秒解释不会报错，只会把 2026 年画成五万七千年）。

        库不存在 / 表未初始化 / 锁 → **None**（调用方降级成「读不到」）——有意不走
        ``_read_all`` 的 graceful ``[]``：把不可达渲染成「零条审批」就是谎报，镜像
        ``count_auto_whitelist_writes`` 的 None-vs-空 纪律。
        """
        n = max(1, int(limit))
        if not os.path.exists(self.db_path):
            return None
        try:
            with self._connection() as conn:
                rows = conn.execute(
                    "SELECT tc.tool_name AS tool_name, "
                    "tc.approval_status AS approval_status, "
                    "COALESCE(tc.confirmed_at, tc.updated_at) AS decided_at, "
                    "m.session_id AS session_id, s.title AS session_title "
                    "FROM chat_tool_call tc "
                    "JOIN ai_chat_messages m ON m.id = tc.message_id "
                    "JOIN ai_chat_sessions s ON s.id = m.session_id "
                    "WHERE s.origin = 'im' "
                    "AND tc.approval_status IN ('approved', 'edited', 'rejected') "
                    "ORDER BY decided_at DESC, tc.id DESC LIMIT ?",
                    (n,),
                ).fetchall()
                return [dict(r) for r in rows]
        except sqlite3.Error:
            return None

    def count_auto_whitelist_writes(
        self, session_ids: List[int]
    ) -> Optional[Dict[int, Dict[str, Any]]]:
        """按 session 统计免卡执行审计行（S5 ADR-004 D6 badge；S6 W3-2 rev3.1 §4.4/F#3 分源）。

        ``chat_tool_call.approval_status='auto_whitelist'``（CHAT_DB v18 语义，gateway 直写）
        经 message→session join 归到会话，并按 ``whitelist_rule_id`` 是否为空分两源：
        **rule-source**（rule_id 非空 = owner 逐条建的白名单规则命中）与 **grant-source**
        （rule_id=null = grant 级免卡，如 open 档 web_fetch / web_search 授权），grant 桶按
        ``tool_name`` 细分（UI 据此区分「全开放联网」vs「搜索授权」）。🔴 投影**不得假设
        rule_id 非空**——grant 级免卡行 rule_id 天然为 null。

        口径是「免卡执行过」而不是某一个字面值：g2 群工具的 ``auto_judge_scope``（法官
        scope hash 匹配）与 ``auto_user_requested_verified``（服务端核验型用户显式要求）
        同样是没弹卡就跑了的写，一并计入。人工审批口径（上面
        ``list_recent_im_approvals`` 的 approved/edited/rejected）**不动**。

        返回 ``{session_id: {"total": n, "rule": n, "grant": {tool_name: n}}}``（无命中的 id
        不在 dict，调用方 default 0）。库不存在 / 表未初始化 / 锁 → **None**（调用方把字段
        降级为 null）—— 有意不走 ``_read_all`` 的 graceful ``[]``：badge 必须区分「账本可达
        且 0 次免卡」与「账本不可达」，后者渲染 0 就是谎报。
        """
        ids = [int(s) for s in session_ids]
        if not ids:
            return {}
        if not os.path.exists(self.db_path):
            return None
        placeholders = ",".join("?" * len(ids))
        try:
            with self._connection() as conn:
                rows = conn.execute(
                    "SELECT m.session_id AS sid, tc.tool_name AS tool, "
                    "(tc.whitelist_rule_id IS NULL) AS grant_source, COUNT(*) AS n "
                    "FROM chat_tool_call tc "
                    "JOIN ai_chat_messages m ON m.id = tc.message_id "
                    "WHERE tc.approval_status IN "
                    "('auto_whitelist', 'auto_judge_scope', 'auto_user_requested_verified') "
                    f"AND m.session_id IN ({placeholders}) "
                    "GROUP BY m.session_id, tc.tool_name, grant_source",
                    tuple(ids),
                ).fetchall()
                out: Dict[int, Dict[str, Any]] = {}
                for r in rows:
                    sid = int(r["sid"])
                    bucket = out.setdefault(sid, {"total": 0, "rule": 0, "grant": {}})
                    n = int(r["n"])
                    bucket["total"] += n
                    if r["grant_source"]:
                        tool = str(r["tool"])
                        bucket["grant"][tool] = bucket["grant"].get(tool, 0) + n
                    else:
                        bucket["rule"] += n
                return out
        except sqlite3.Error:
            return None

    # ── sessions（写 + 单读，3b-3）─────────────────────────────────────────

    def get_or_create_session(
        self,
        email_id: Optional[int] = None,
        backend_kind: str = "custom-api",
        backend_model: Optional[str] = None,
        backend_agent_page_id: Optional[str] = None,
        *,
        anchor_type: str = "email",
        matter_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """复用既有 session 或新建。镜像 chat_db.ts getOrCreateSession（P2c anchor-aware）。

        email（默认）→ 按 email_id 查复用（pre-v7 逐字节不变，邮件 sidebar 零回归）；general →
        按 anchor_type='general' AND email_id IS NULL 查、复用最近一条（无 anchor_id 去重，"latest"
        即契约；显式新建走 create_new_session）。pageId 为 None 时走 ``IS NULL`` 分支（SQLite 把
        UNIQUE NULL 当永远互异）。命中且 backendModel 变了 → 刷新 model + updated_at。
        """
        anchor_type, email_id, anchor_id = _resolve_anchor(anchor_type, email_id, matter_id)
        now = _now_ms()
        page_clause = (
            "backend_agent_page_id IS NULL"
            if backend_agent_page_id is None
            else "backend_agent_page_id = ?"
        )
        page_params: tuple = () if backend_agent_page_id is None else (backend_agent_page_id,)
        with self._write_connection() as conn:
            if anchor_type == "email":
                existing = conn.execute(
                    f"SELECT * FROM ai_chat_sessions "
                    f"WHERE email_id = ? AND backend_kind = ? AND {page_clause}",
                    (email_id, backend_kind, *page_params),
                ).fetchone()
            elif anchor_type == "general":
                existing = conn.execute(
                    f"SELECT * FROM ai_chat_sessions "
                    f"WHERE anchor_type = 'general' AND email_id IS NULL "
                    f"AND backend_kind = ? AND {page_clause} "
                    f"ORDER BY updated_at DESC LIMIT 1",
                    (backend_kind, *page_params),
                ).fetchone()
            else:
                existing = conn.execute(
                    f"SELECT * FROM ai_chat_sessions "
                    f"WHERE anchor_type = 'matter' AND anchor_id = ? "
                    f"AND backend_kind = ? AND {page_clause} "
                    f"AND COALESCE(origin, 'interactive') = 'interactive' "
                    f"ORDER BY updated_at DESC LIMIT 1",
                    (anchor_id, backend_kind, *page_params),
                ).fetchone()

            if existing is not None:
                if backend_model and backend_model != existing["backend_model"]:
                    conn.execute(
                        "UPDATE ai_chat_sessions SET backend_model = ?, updated_at = ? WHERE id = ?",
                        (backend_model, now, existing["id"]),
                    )
                    return {**dict(existing), "backend_model": backend_model, "updated_at": now}
                return dict(existing)

            cur = conn.execute(
                "INSERT INTO ai_chat_sessions "
                "(email_id, anchor_type, anchor_id, backend_kind, backend_model, "
                "backend_agent_page_id, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (email_id, anchor_type, anchor_id, backend_kind, backend_model,
                 backend_agent_page_id, now, now),
            )
            return {
                "id": int(cur.lastrowid),
                "email_id": email_id,
                "anchor_type": anchor_type,
                "anchor_id": anchor_id,
                "backend_kind": backend_kind,
                "backend_model": backend_model,
                "backend_agent_page_id": backend_agent_page_id,
                "title": None,
                "created_at": now,
                "updated_at": now,
            }

    def create_new_session(
        self,
        email_id: Optional[int] = None,
        backend_kind: str = "custom-api",
        backend_model: Optional[str] = None,
        backend_agent_page_id: Optional[str] = None,
        *,
        anchor_type: str = "email",
        matter_id: Optional[int] = None,
        agent_id: Optional[str] = None,
        group_members: Optional[List[str]] = None,
        title: Optional[str] = None,
        parent_session_id: Optional[int] = None,
        invoked_by: Optional[str] = None,
    ) -> Dict[str, Any]:
        """无条件 INSERT 新 session（绕过复用查找）。镜像 chat_db.ts createNewSession
        （「+ 新建会话」显式意图，v4 drop UNIQUE 后多 session/邮件合法；P2c anchor-aware）。

        P4b（team 会话）：``agent_id`` 非空 = 「人以指定 agent 身份开的交互式会话」→
        行落 ``origin='team'`` + ``agent_id``（v29 值域登记；agent 会话恒 general anchor，
        路由层已校验）。gateway ``handleChat`` 按 sessionId 反查这两列装配身份（S2 W0：
        身份绝不从 body 读）。缺省（None）保持 INSERT 字节级不变。

        v30（群聊）：``group_members`` 非空 = custom agents 群聊会话 → 行落
        ``origin='group'`` + ``members_json``（恒 general anchor；成员存在性/chat-capable/上限
        由路由层校验，与 ``agent_id`` 互斥）。``title`` = 建群时的初始标题，🔴 **只在 group
        分支写**：group 行必然生在 v30+ 库（title 列恒在），而 team/默认分支保持 INSERT
        字节级不变（老 fixture / pre-v14 形状库无 title 列，动它就是回归）。

        g2（agent 群工具面）：``parent_session_id``（子群回指父群）与 ``invoked_by``
        （发起方，值域 group_limits.SESSION_INVOKED_BY）同样**只在 group 分支写**，理由同
        title。子集 / 单层嵌套 / 值域校验全在路由层（红线 5），本方法只落列。"""
        anchor_type, email_id, anchor_id = _resolve_anchor(anchor_type, email_id, matter_id)
        now = _now_ms()
        members_json = (
            json.dumps(list(group_members)) if group_members is not None else None
        )
        with self._write_connection() as conn:
            if agent_id is not None:
                cur = conn.execute(
                    "INSERT INTO ai_chat_sessions "
                    "(email_id, anchor_type, anchor_id, backend_kind, backend_model, "
                    "backend_agent_page_id, created_at, updated_at, origin, agent_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'team', ?)",
                    (email_id, anchor_type, anchor_id, backend_kind, backend_model,
                     backend_agent_page_id, now, now, agent_id),
                )
            elif members_json is not None:
                cur = conn.execute(
                    "INSERT INTO ai_chat_sessions "
                    "(email_id, anchor_type, anchor_id, backend_kind, backend_model, "
                    "backend_agent_page_id, title, created_at, updated_at, origin, members_json, "
                    "parent_session_id, invoked_by) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'group', ?, ?, ?)",
                    (email_id, anchor_type, anchor_id, backend_kind, backend_model,
                     backend_agent_page_id, title, now, now, members_json,
                     parent_session_id, invoked_by),
                )
            else:
                cur = conn.execute(
                    "INSERT INTO ai_chat_sessions "
                    "(email_id, anchor_type, anchor_id, backend_kind, backend_model, "
                    "backend_agent_page_id, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (email_id, anchor_type, anchor_id, backend_kind, backend_model,
                     backend_agent_page_id, now, now),
                )
            return {
                "id": int(cur.lastrowid),
                "email_id": email_id,
                "anchor_type": anchor_type,
                "anchor_id": anchor_id,
                "backend_kind": backend_kind,
                "backend_model": backend_model,
                "backend_agent_page_id": backend_agent_page_id,
                "title": title if members_json is not None else None,
                "created_at": now,
                "updated_at": now,
                **({"origin": "team", "agent_id": agent_id} if agent_id is not None else {}),
                **(
                    {
                        "origin": "group",
                        "members_json": members_json,
                        "parent_session_id": parent_session_id,
                        "invoked_by": invoked_by,
                    }
                    if members_json is not None
                    else {}
                ),
            }

    def get_session(self, session_id: int) -> Optional[Dict[str, Any]]:
        """单 session 行 or None。镜像 chat_db.ts getSession → ChatSession | null。"""
        return self._read_one(
            "SELECT * FROM ai_chat_sessions WHERE id = ?", (session_id,)
        )

    def delete_session(self, session_id: int) -> None:
        """删整个 session（其消息 + 工具调用经 FK ON DELETE CASCADE 连带删）。镜像 chat_db.ts
        deleteSession（3c-2 补：cutover 后 renderer ChatRuntime.deleteSession 经此删，取代
        electron chat:deleteSession IPC）。CASCADE 由 _write_connection 的 ``PRAGMA foreign_keys
        = ON`` + 真实 schema 的 message→session / tool_call→message FK 生效（删不存在的 id 是
        no-op，对齐 fire-and-forget 语义）。

        群（origin='group'）多一步 **断子群的链**：``parent_session_id`` 没有 FK，删了父群后
        子群那一列会指向一个不存在的会话（读侧无从区分「父群被删」与「父群 id 写错了」）。
        置 NULL = 子群保留、只是不再能跳回父群。非群会话的父子关系（custom_agent_call 的
        子会话）保持原样：那条链另有语义，不在本批的改动半径里。"""
        with self._write_connection() as conn:
            if self._has_column("ai_chat_sessions", "parent_session_id"):
                conn.execute(
                    "UPDATE ai_chat_sessions SET parent_session_id = NULL "
                    "WHERE parent_session_id = "
                    "(SELECT id FROM ai_chat_sessions WHERE id = ? AND origin = 'group')",
                    (session_id,),
                )
            conn.execute("DELETE FROM ai_chat_sessions WHERE id = ?", (session_id,))

    def update_session_title(self, session_id: int, title: str) -> None:
        """设置 session 标题（手动改名 / gateway haiku 自动标题）。镜像 chat_db.ts updateSessionTitle：
        刻意不 bump updated_at → 改名不重排历史列表。改不存在的 id 是 no-op（UPDATE 匹配 0 行）。"""
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET title = ? WHERE id = ?", (title, session_id)
            )

    def update_session_model(self, session_id: int, model: Optional[str]) -> None:
        """W8 per-session 模型偏好（task 08-04 WP2）：把 composer 里刚选的模型写回该会话行。

        ``ai_chat_sessions.backend_model`` 列与 chat_db.ts ``getOrCreateSession`` 的
        refresh-on-touch 分支早就写好了，但**调用链触达不到**——renderer 只在建会话时传一次
        backendModel，之后换模型只落 localStorage（全局一份，切会话不区分）。本方法是缺的那
        一环：切模型 → 落该会话行 → 重开时回填（零 ALTER、零 CHAT_DB_VERSION bump）。

        刻意**不** bump updated_at（同 title/archived/pinned/starred 纪律：换模型不该把会话
        顶到历史列表最前）。改不存在的 id 是 no-op。``model=None`` = 清空（回落全局默认）。
        """
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET backend_model = ? WHERE id = ?",
                (model, session_id),
            )

    def update_session_archived(self, session_id: int, archived: bool) -> None:
        """设置 session 归档状态（软删）。镜像 chat_db.ts updateSessionArchived：刻意不 bump
        updated_at → 归档不重排历史列表。改不存在的 id 是 no-op（UPDATE 匹配 0 行）。"""
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET archived = ? WHERE id = ?",
                (1 if archived else 0, session_id),
            )

    def update_session_pinned(
        self, session_id: int, pinned: bool, at_ms: Optional[int] = None
    ) -> None:
        """置顶/取消置顶；置顶时间决定 pinned 分组顺序，不 bump updated_at。"""
        pinned_at = (at_ms if at_ms is not None else _now_ms()) if pinned else None
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET pinned_at = ? WHERE id = ?",
                (pinned_at, session_id),
            )

    def update_session_starred(self, session_id: int, starred: bool) -> None:
        """设置独立星标状态；不重排、不分组，也不 bump updated_at。"""
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET starred = ? WHERE id = ?",
                (1 if starred else 0, session_id),
            )

    def update_session_last_read(self, session_id: int, at_ms: Optional[int] = None) -> None:
        """harness-chat lane A B4（task 07-15）— 置 session 已读水位 last_read_at=now（v20 列）。

        刻意不 bump updated_at（已读绝不重排历史）；未读判定 = updated_at > last_read_at。
        改不存在的 id 是 no-op。pre-v20 库（前端尚未迁移 / 启动竞态）缺列 → 静默 no-op：
        已读是 best-effort UX 面，绝不该 500（写约束的「缺 schema = 真配置错」对本列例外，
        因为 serve-api 可能先于前端 migrate 服务请求）。"""
        now = at_ms if at_ms is not None else _now_ms()
        try:
            with self._write_connection() as conn:
                conn.execute(
                    "UPDATE ai_chat_sessions SET last_read_at = ? WHERE id = ?",
                    (now, session_id),
                )
        except sqlite3.OperationalError:
            # pre-v20 ai_chat.db（no such column: last_read_at）→ best-effort no-op。
            pass

    # ── messages（写 + 单读，3b-3）─────────────────────────────────────────

    def append_message(
        self,
        session_id: int,
        role: str,
        content: str,
        status: str,
        model: Optional[str] = None,
        tokens_input: Optional[int] = None,
        tokens_output: Optional[int] = None,
        cost_usd: Optional[float] = None,
        error_message: Optional[str] = None,
        metadata: Optional[str] = None,
        ui_message_json: Optional[str] = None,
    ) -> Dict[str, Any]:
        """INSERT 一条消息 + bump session updated_at（列表排序反映新活动）。镜像 chat_db.ts
        appendMessage → ChatMessage。两条语句同一 now、同一事务。

        v9（P4 Phase 02）— ``ui_message_json`` = AI SDK UIMessage canonical JSON（gateway
        runtime 双写）；legacy 写省略 → NULL（重载时由 content 合成 UIMessage）。"""
        now = _now_ms()
        with self._write_connection() as conn:
            cur = conn.execute(
                "INSERT INTO ai_chat_messages "
                "(session_id, role, content, tokens_input, tokens_output, cost_usd, "
                "model, status, error_message, metadata, ui_message_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    role,
                    content,
                    tokens_input,
                    tokens_output,
                    cost_usd,
                    model,
                    status,
                    error_message,
                    metadata,
                    ui_message_json,
                    now,
                    now,
                ),
            )
            conn.execute(
                "UPDATE ai_chat_sessions SET updated_at = ? WHERE id = ?", (now, session_id)
            )
            return {
                "id": int(cur.lastrowid),
                "session_id": session_id,
                "role": role,
                "content": content,
                "tokens_input": tokens_input,
                "tokens_output": tokens_output,
                "cost_usd": cost_usd,
                "model": model,
                "status": status,
                "error_message": error_message,
                "metadata": metadata,
                # task 06-08-chat 需求 5 — appendMessage 不 seed thinking（finalizeMessage
                # 终态经 update_message 写）；INSERT 未写该列 → 行 thinking=NULL。镜像 chat_db.ts。
                "thinking": None,
                "ui_message_json": ui_message_json,
                "created_at": now,
                "updated_at": now,
            }

    def update_message(self, message_id: int, patch: Dict[str, Any]) -> None:
        """部分更新一条消息（streamContent 仅 content / finalizeMessage 终态全字段）。镜像
        chat_db.ts updateMessage：动态拼字段（``key in patch`` = TS ``!== undefined``），无字段
        即 no-op，**不** bump session updated_at。patch 用 camelCase wire key（见 _MESSAGE_PATCH_FIELDS）。"""
        fields: List[str] = []
        params: List[Any] = []
        for key, col in _MESSAGE_PATCH_FIELDS:
            if key in patch:
                fields.append(f"{col} = ?")
                params.append(patch[key])
        if not fields:
            return
        fields.append("updated_at = ?")
        params.append(_now_ms())
        params.append(message_id)
        with self._write_connection() as conn:
            conn.execute(
                f"UPDATE ai_chat_messages SET {', '.join(fields)} WHERE id = ?", params
            )

    def get_message(self, message_id: int) -> Optional[Dict[str, Any]]:
        """单消息行 or None。镜像 chat_db.ts getMessage → ChatMessage | null。"""
        return self._read_one(
            "SELECT * FROM ai_chat_messages WHERE id = ?", (message_id,)
        )

    def delete_messages_from_id(self, session_id: int, from_message_id: int) -> int:
        """删 from_message_id 及之后所有消息（含自身，行内编辑重跑）。镜像 chat_db.ts
        deleteMessagesFromId → 删除行数（``>= ?`` 不是 ``> ?``：调用方随后 appendMessage 重建编辑行）。"""
        with self._write_connection() as conn:
            cur = conn.execute(
                "DELETE FROM ai_chat_messages WHERE session_id = ? AND id >= ?",
                (session_id, from_message_id),
            )
            return cur.rowcount

    def abort_streaming_messages(self, session_id: int) -> int:
        """把该 session 的 pending/streaming 消息标 aborted（切邮件/关面板时）。镜像 chat_db.ts
        abortStreamingMessages → 翻转行数。"""
        now = _now_ms()
        with self._write_connection() as conn:
            cur = conn.execute(
                "UPDATE ai_chat_messages SET status = 'aborted', updated_at = ? "
                "WHERE session_id = ? AND status IN ('pending', 'streaming')",
                (now, session_id),
            )
            return cur.rowcount

    # ── chat_tool_call（写 + 单读，3b-3）───────────────────────────────────

    def append_tool_call(
        self,
        message_id: int,
        tool_use_id: str,
        tool_name: str,
        input_json: str,
        confirmation_tier: str,
        status: str,
        content_offset: Optional[int] = None,
    ) -> Dict[str, Any]:
        """INSERT 一条工具调用审计行（user_edited/output/duration/confirmed_at 初始 NULL）。
        镜像 chat_db.ts appendToolCall → ChatToolCall。

        ``content_offset``（task 06-08-chat Bug 2）= 该工具卡在父 assistant 消息 ``content``
        里的插入字符偏移（harness 见 tool_use 时的累积正文长度）；前端据此把 content split
        交错渲染工具卡。chat_tool_call.content_offset 列由前端 chat_db.ts v5 迁移建（schema
        归前端 owns）—— serve-api 只写既有列（生产里 renderer getChatDb() 已迁好库）。
        """
        now = _now_ms()
        with self._write_connection() as conn:
            cur = conn.execute(
                "INSERT INTO chat_tool_call "
                "(message_id, tool_use_id, tool_name, input_json, "
                "user_edited_input_json, output_json, "
                "status, duration_ms, confirmation_tier, confirmed_at, "
                "content_offset, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, ?, ?, ?)",
                (
                    message_id,
                    tool_use_id,
                    tool_name,
                    input_json,
                    status,
                    confirmation_tier,
                    content_offset,
                    now,
                    now,
                ),
            )
            return {
                "id": int(cur.lastrowid),
                "message_id": message_id,
                "tool_use_id": tool_use_id,
                "tool_name": tool_name,
                "input_json": input_json,
                "user_edited_input_json": None,
                "output_json": None,
                "status": status,
                "duration_ms": None,
                "confirmation_tier": confirmation_tier,
                "confirmed_at": None,
                "content_offset": content_offset,
                "created_at": now,
                "updated_at": now,
            }

    def update_tool_call(self, tool_call_id: int, patch: Dict[str, Any]) -> None:
        """部分更新一条工具调用（status/output/duration/userEditedInput/confirmedAt）。镜像
        chat_db.ts updateToolCall：动态拼字段（``key in patch``），无字段即 no-op。patch 用
        camelCase wire key（见 _TOOL_CALL_PATCH_FIELDS）。"""
        fields: List[str] = []
        params: List[Any] = []
        for key, col in _TOOL_CALL_PATCH_FIELDS:
            if key in patch:
                fields.append(f"{col} = ?")
                params.append(patch[key])
        if not fields:
            return
        fields.append("updated_at = ?")
        params.append(_now_ms())
        params.append(tool_call_id)
        with self._write_connection() as conn:
            conn.execute(
                f"UPDATE chat_tool_call SET {', '.join(fields)} WHERE id = ?", params
            )

    def get_tool_call_by_use_id(
        self, message_id: int, tool_use_id: str
    ) -> Optional[Dict[str, Any]]:
        """单工具调用（by message + tool_use_id）or None。镜像 chat_db.ts getToolCallByUseId
        → ChatToolCall | null（dispatcher 据此判「这个 tool_use_id 见过没」）。"""
        return self._read_one(
            "SELECT * FROM chat_tool_call WHERE message_id = ? AND tool_use_id = ?",
            (message_id, tool_use_id),
        )

    # ── 群聊 g1（CHAT_DB v31）─────────────────────────────────────────────

    def get_group_config(self, session_id: int) -> Dict[str, Any]:
        """群设置读面：``{"modes", "config", "members", "judgeScopeStale"}``。

        缺行的成员**不出现**在 modes 里（读侧一律 ``?? 'mention'``，PRD Q1）；
        ``group_config_json`` 为 NULL / 脏 JSON → ``{"v": 1}``（全取出厂默认）。
        ``members`` = ``members_json`` 的成员序（群详情面一次拿全，不用再打一次 /sessions/{id}）。
        ``judgeScopeStale`` = 有法官位且 ``judgeScopeHash`` 与当前名单原文的 sha256 失配
        （= 名单在 owner 确认法官位之后变过；g2 的免卡判据同源，UI 据此提示「重新确认」）。
        未迁移的旧库（表/列缺席）→ 空 modes + 默认 config，不报错（``SELECT *`` 让缺列变缺键）。
        """
        config: Dict[str, Any] = {"v": 1}
        row = self._read_one("SELECT * FROM ai_chat_sessions WHERE id = ?", (session_id,)) or {}
        raw = row.get("group_config_json")
        if isinstance(raw, str) and raw:
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    config = {**parsed, "v": 1}
            except (ValueError, TypeError):
                config = {"v": 1}
        raw_members = row.get("members_json")
        members = parse_group_member_ids(raw_members)
        # hash 钉的是**原文**（owner 确认那一刻看到的那份名单），与写侧 put_group_config 同口径 ——
        # 等价重排也算变。
        judge_scope_stale = config.get("judgeAgentId") is not None and config.get(
            "judgeScopeHash"
        ) != hashlib.sha256((raw_members or "").encode("utf-8")).hexdigest()
        modes: Dict[str, str] = {}
        if self._has_table("ai_chat_group_member"):
            for member in self._read_all(
                "SELECT agent_id, response_mode FROM ai_chat_group_member "
                "WHERE session_id = ? ORDER BY agent_id ASC",
                (session_id,),
            ):
                modes[str(member["agent_id"])] = str(member["response_mode"])
        return {
            "modes": modes,
            "config": config,
            "members": members,
            "judgeScopeStale": judge_scope_stale,
        }

    def update_group_config(self, session_id: int, config: Dict[str, Any]) -> None:
        """写 ``ai_chat_sessions.group_config_json``（整块覆写，调用方已把旧值 merge 好）。

        刻意不 bump ``updated_at``（改设置不该把群顶到列表最前，同 title / archived 纪律）。
        列缺席（旧库）→ no-op。
        """
        if not self._has_column("ai_chat_sessions", "group_config_json"):
            return
        payload = json.dumps({**config, "v": 1}, ensure_ascii=False)
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET group_config_json = ? WHERE id = ?",
                (payload, session_id),
            )

    def upsert_group_member_modes(self, session_id: int, modes: Dict[str, str]) -> None:
        """写每成员响应模式（**列级 UPSERT**）。

        🔴 语句里**只有** ``response_mode`` 一列 —— ``seen_through_id`` 归 gateway 写，
        整行 UPSERT 会把成员的 seen 游标冲成 NULL（模型下一轮把整段历史当新消息重看一遍）。
        这条纪律由 ``tests/api/test_chat_group_config.py`` 的语句文本断言钉住。
        表缺席（旧库）→ no-op。
        """
        if not modes or not self._has_table("ai_chat_group_member"):
            return
        now = _now_ms()
        with self._write_connection() as conn:
            for agent_id, mode in modes.items():
                conn.execute(
                    "INSERT INTO ai_chat_group_member (session_id, agent_id, response_mode, updated_at) "
                    "VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(session_id, agent_id) DO UPDATE SET "
                    "response_mode = excluded.response_mode, updated_at = excluded.updated_at",
                    (session_id, agent_id, mode, now),
                )

    def update_group_members(
        self, session_id: int, members: List[str], cleared: List[str]
    ) -> None:
        """写新成员名单（加人 / 踢人），并删掉 ``cleared`` 名下的 ``ai_chat_group_member`` 整行。

        🔴 ``cleared = remove ∪ add``，**add 的 id 也要删**：gateway 推游标走的是
        ``INSERT OR IGNORE`` + 单列 UPDATE（chat_db/groups.ts ``advanceSeenCursor``），在
        「取出队列项 → 复核成员资格 → speak → 推游标」这段秒级窗口里被踢的成员，会在
        serve-api 删完行之后把行**重建回来**并带上推进后的游标。add 时再删一次，才能保证
        「踢掉 → 加回」之间不可能残留游标 —— 重新加回的成员从首轮窗口（最后 40 行）开始读，
        这是有意的：残留游标会让它错过中间历史的「新鲜」判定。

        🔴 这里是**行级删除**，不是列级覆写：删的是「不再是成员」的整行，``response_mode`` 与
        ``seen_through_id`` 一起消失，不违反两写者纪律（本语句里没有任何一列的名字）。

        刻意不 bump ``updated_at``（改名单不该把群顶到列表最前，同 title / 设置纪律）。
        """
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET members_json = ? WHERE id = ?",
                (json.dumps(members), session_id),
            )
            if cleared:
                marks = ",".join("?" * len(cleared))
                conn.execute(
                    f"DELETE FROM ai_chat_group_member WHERE session_id = ? AND agent_id IN ({marks})",
                    (session_id, *cleared),
                )

    def list_group_turns(
        self,
        session_id: int,
        limit: int = 200,
        before_id: Optional[int] = None,
        since_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """turn 台账只读分页（新→旧）：``{"turns": [...], "hasMore": bool}``。

        renderer 用它在刷新后还原沉默 / 重复 / 跳过 / 失败 / 停止的 meta 行 —— 那些 turn
        **没有**落库消息，只有这张表证明它们发生过。``since_ms`` 恒由 renderer 传「最早一条
        落库消息的时间」：清空历史后旧 meta 行就不再回到对话里（台账本身保留，用量不变）。
        投影是 camelCase（同 group_metrics），且**不含** window_from_id / window_to_id ——
        那两列是调度器的内部窗口边界，UI 没有消费点。
        未迁移的旧库（表缺席）→ 空结果，不报错。
        """
        if not self._has_table("ai_chat_group_turn"):
            return {"turns": [], "hasMore": False}
        limit = max(1, min(int(limit), 500))
        clauses = ["session_id = ?"]
        params: list[Any] = [session_id]
        if before_id is not None:
            clauses.append("id < ?")
            params.append(int(before_id))
        if since_ms is not None:
            clauses.append("started_at >= ?")
            params.append(int(since_ms))
        rows = self._read_all(
            "SELECT * FROM ai_chat_group_turn WHERE "
            + " AND ".join(clauses)
            + " ORDER BY started_at DESC, id DESC LIMIT ?",
            (*params, limit + 1),  # 多取一行 = hasMore 的判据，不用再打一次 COUNT
        )
        has_more = len(rows) > limit
        return {
            "turns": [
                {
                    "id": r["id"],
                    "runId": r["run_id"],
                    "chainId": r["chain_id"],
                    "seq": r["seq"],
                    "agentId": r["agent_id"],
                    "triggerKind": r["trigger_kind"],
                    "outcome": r["outcome"],
                    "messageId": r["message_id"],
                    "model": r["model"],
                    "tokensInput": r["tokens_input"],
                    "tokensOutput": r["tokens_output"],
                    "costUsd": r["cost_usd"],
                    "error": r["error"],
                    "startedAt": r["started_at"],
                    "finishedAt": r["finished_at"],
                }
                for r in rows[:limit]
            ],
            "hasMore": has_more,
        }

    def group_metrics(self, session_id: int) -> Dict[str, Any]:
        """群成本两指标 + 两个滚动窗口（只读 ``ai_chat_group_turn``，design §6）。

        * ``silentRunRate`` = COUNT(outcome ∈ silent/held_dup/skipped) / COUNT(*)；
          无 turn 行 → None（未知，不是 0）。
        * ``turnsPerHumanMessage`` = 「链根 trigger ∈ human/main_agent」的那些链上的全部 turn 数
          / 这样的链数。链根判据落在**链**上（同一 chain_id 出现过 human/main_agent 触发），
          不是逐行判 trigger_kind —— 成员级联行的 trigger_kind 是 'agent'，逐行判会把分子清零。
        * ``last1h`` / ``last24h``：turns / tokens / costUsd（整窗 cost 全 NULL → None：金额未知
          ≠ 0）+ ``caps``。🔴 caps 只回 owner **配置过**的值，未配置回 None —— 出厂默认在
          ``groupFloors.ts``（单源），Python 不抄一份数值。
        * ``lastStopReason``：最近一条 outcome='stopped' 行的 error（地板原因词）。
        * ``sessionTurns`` / ``sessionTokens`` / ``sessionCostUsd``：**无窗口**的会话累计
          （狼人杀一局的总量是 family 三群相加，不是小时量；cost 全 NULL → None，未知 ≠ 0）。

        未迁移的旧库（表缺席）→ 全 None / 零窗口，不报错。
        """
        empty_window = {"turns": 0, "tokens": 0, "costUsd": None}
        config = self.get_group_config(session_id)["config"]
        caps = {
            "turns": config.get("hourlyTurns"),
            "tokens": config.get("hourlyTokens"),
            "costUsd": config.get("hourlyUsd"),
        }
        if not self._has_table("ai_chat_group_turn"):
            return {
                "silentRunRate": None,
                "turnsPerHumanMessage": None,
                "last1h": {**empty_window, "caps": caps},
                "last24h": {**empty_window, "caps": caps},
                "lastStopReason": None,
                "sessionTurns": 0,
                "sessionTokens": 0,
                "sessionCostUsd": None,
            }
        silent_marks = ",".join("?" * len(SILENT_OUTCOMES))
        totals = self._read_one(
            "SELECT COUNT(*) AS total, "
            f"SUM(CASE WHEN outcome IN ({silent_marks}) THEN 1 ELSE 0 END) AS silent "
            "FROM ai_chat_group_turn WHERE session_id = ?",
            (*SILENT_OUTCOMES, session_id),
        ) or {}
        total = int(totals.get("total") or 0)
        silent_rate = (int(totals.get("silent") or 0) / total) if total else None

        root_marks = ",".join("?" * len(CHAIN_ROOT_TRIGGER_KINDS))
        human = self._read_one(
            "WITH human_chains AS ("
            "  SELECT DISTINCT chain_id FROM ai_chat_group_turn "
            f"   WHERE session_id = ? AND trigger_kind IN ({root_marks})"
            ") "
            "SELECT (SELECT COUNT(*) FROM ai_chat_group_turn t "
            "         WHERE t.session_id = ? AND t.chain_id IN (SELECT chain_id FROM human_chains)"
            "       ) AS turns, "
            "       (SELECT COUNT(*) FROM human_chains) AS chains",
            (session_id, *CHAIN_ROOT_TRIGGER_KINDS, session_id),
        ) or {}
        chains = int(human.get("chains") or 0)
        per_human = (int(human.get("turns") or 0) / chains) if chains else None

        now = _now_ms()

        def window(since_ms: int) -> Dict[str, Any]:
            row = self._read_one(
                "SELECT COUNT(*) AS turns, "
                "COALESCE(SUM(COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0)), 0) AS tokens, "
                "SUM(cost_usd) AS cost_usd "
                "FROM ai_chat_group_turn WHERE session_id = ? AND started_at >= ?",
                (session_id, since_ms),
            ) or {}
            cost = row.get("cost_usd")
            return {
                "turns": int(row.get("turns") or 0),
                "tokens": int(row.get("tokens") or 0),
                "costUsd": None if cost is None else float(cost),
                "caps": caps,
            }

        stopped = self._read_one(
            "SELECT error FROM ai_chat_group_turn WHERE session_id = ? AND outcome = 'stopped' "
            "ORDER BY started_at DESC, id DESC LIMIT 1",
            (session_id,),
        )
        session_totals = self._read_one(
            "SELECT COUNT(*) AS turns, "
            "COALESCE(SUM(COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0)), 0) AS tokens, "
            "SUM(cost_usd) AS cost_usd "
            "FROM ai_chat_group_turn WHERE session_id = ?",
            (session_id,),
        ) or {}
        session_cost = session_totals.get("cost_usd")
        return {
            "silentRunRate": silent_rate,
            "turnsPerHumanMessage": per_human,
            "last1h": window(now - 3_600_000),
            "last24h": window(now - 86_400_000),
            "lastStopReason": (stopped or {}).get("error"),
            "sessionTurns": int(session_totals.get("turns") or 0),
            "sessionTokens": int(session_totals.get("tokens") or 0),
            "sessionCostUsd": None if session_cost is None else float(session_cost),
        }
