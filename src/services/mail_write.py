"""MailWriteService —— transport-neutral 邮件写操作 (A2-A4: flag/resync/archive/pin/compose)。

把「编排 + 守卫」从 CLI 命令体下沉到这里, 让 CLI (typer) 与 serve-api (FastAPI)
各自退化成「解析 → 调 service → 格式化」的薄壳, 不再 fork CLI 跨传输复用
(见 plan cli-streamed-brook.md §A2-A4 / docs/reference/architecture/backend-service-migration-matrix.md)。

两类方法:
  - ``plan_*`` (plan_flags/plan_resync/plan_archive/plan_pin/compose_plan): dry-run 纯预览,
    **不过** auth/pm2、**不写**任何东西, CLI 与 serve-api 共用 (RFC: dry-run 跳过写鉴权)。
  - 执行路径 (set_flags/resync/archive/set_pin/compose_draft/send): 入口过
    ``require_write_auth(actor)`` (+ flag/resync 还过 ``check_pm2_conflict``), 再调领域类
    (NotionSync / SyncStore / OutboxRepository / backend, 一行不改)。

A4 compose 净简化: service 接**字符串** body_html/body_text (非文件路径) —— CLI 适配器读
``--body-file``/``--body-html-file`` 成字符串, serve-api 直接传 TipTap HTML, 旧 fork 路径的
``--body-html-file`` 临时文件那段整段删 (见 routers/email.py)。

返回的 ``@dataclass`` 字段与现 CLI ``emit`` 的 ``data`` 形状**逐字段对齐** (parity
golden 锚定: tests/cli/test_service_parity.py)。方法同步; serve-api 经
``asyncio.to_thread`` 调用 —— ``resync`` 内部用 ``asyncio.run`` 起独立 loop, 在 worker
线程里不与 uvicorn 的 event loop 相撞 (``create_email_page_from_sqlite`` 是 async)。
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

from loguru import logger

from src.mail.mailbox_semantics import (
    ARCHIVE_LABEL,
    DRAFT_MAILBOX_LABELS,
    is_drafts_mailbox,
    is_inbox_mailbox,
    is_sent_mailbox,
)
from src.services.errors import (
    ServiceError,
    ServiceInvalidArgError,
    ServiceNotFoundError,
)
from src.services.guards import Actor, check_pm2_conflict, require_write_auth
from src.sync.outbox import OutboxRepository
from src.sync.outbox_intents import mirror_and_enqueue_flag_sync

if TYPE_CHECKING:
    from src.services.context import ServiceDeps


# outbox source 标签: 历史上 CLI 直写 + serve-api fork CLI 都落 'cli'; 这里保留以维持
# parity (echo prevention 只特判 source='notion_webhook', 其余 source 仅审计用)。
# 前端写收编 (D1) 时再按传输区分 source。
_OUTBOX_SOURCE = "cli"

# 归档目标 mailbox (IMAP MOVE INBOX→Archive 后 SQLite/Notion 的 Mailbox 标签)。
_ARCHIVE_MAILBOX = ARCHIVE_LABEL

# move_to_folder 拒绝的目标 (移到回收站/垃圾邮件 = 变相删除, 不该走 move)。
_TRASH_LIKE_IMAP = {"TRASH", "JUNK", "DELETED ITEMS", "DELETED MESSAGES"}
_TRASH_LIKE_LABEL = {"回收站", "已删除", "已删除邮件", "垃圾邮件", "Trash", "Junk", "Deleted Items"}


@dataclass
class FlagResult:
    """``set_flags`` 执行结果 —— 对齐 ``email_flag`` emit 的 data (dry_run=False 分支)。

    ``not_found`` 恒为 list; CLI 适配器仅在非空时把它放进 emit 的 data
    (保持「空时不出现 not_found 键」的历史形状)。
    """

    updated_ids: list[int]
    payload: dict[str, Any]
    outbox_entries: list[dict[str, Any]]
    not_found: list[int]


@dataclass
class ResyncResult:
    """``resync`` 执行结果 —— 对齐 ``_resync_single`` emit 的 data (dry_run=False 分支)。"""

    internal_id: int
    old_page_id: Optional[str]
    new_page_id: Optional[str]
    archived_page_id: Optional[str]
    action: str


@dataclass
class ArchiveResult:
    """``archive`` 执行结果 —— 对齐 ``email_archive`` emit 的 data (dry_run=False 分支)。

    ``action`` (恒 "archive") / ``success`` (恒 True) / ``dry_run`` (恒 False) 由适配器
    回填 (历史 data 形状), 这里只放动态字段。
    """

    internal_id: int
    from_mailbox: str
    to_mailbox: str
    notion_updated: bool
    notion_error: Optional[str]


@dataclass
class MoveResult:
    """``move_to_folder`` 执行结果 (多文件夹同步: 任意文件夹→任意文件夹移动)。"""

    internal_id: int
    from_mailbox: str
    to_mailbox: str
    notion_updated: bool
    notion_error: Optional[str]


@dataclass
class FolderMutationResult:
    """文件夹管理 (create/rename/delete) 执行结果。"""

    action: str            # create | rename | delete
    imap_name: str
    new_imap_name: Optional[str] = None
    affected_local_rows: int = 0   # rename/delete 影响的本地 email_metadata 行数
    restart_required: bool = False  # 改了 .env SYNC_FOLDERS 白名单 → 需 restart mail-sync 生效


@dataclass
class PinResult:
    """``set_pin`` 执行结果 —— 对齐 ``email_pin`` / ``email_unpin`` emit 的 data。

    ``dry_run`` (恒 False) 由适配器回填。
    """

    internal_id: int
    is_pinned: bool
    changed: bool


@dataclass
class ReplySuggestionResult:
    """``set_reply_suggestion`` 执行结果 — 写 llm_processing.labels_json.reply_suggestion_md。"""

    internal_id: int
    reply_suggestion_md: str
    chars: int


@dataclass
class AiFieldsResult:
    """``set_ai_fields`` 执行结果 — 覆盖 AI Action / Priority / Review Status。

    字段为**实际落库**值: ``action`` / ``priority`` = labels_json 写入的中文枚举
    (未传则 None); ``review_status`` = 前端 enum ('reviewed'/'pending', 未传则 None),
    映自 ``llm_processing.status`` (success↔reviewed)。调用方据此回报「上报值 == SSoT 值」。
    """

    internal_id: int
    action: Optional[str]
    priority: Optional[str]
    review_status: Optional[str]


# compose 附件总大小上限 (编码前; forward 自动收集与显式 attachments 引用共用,
# serve-api 上传端点单文件 cap 也沿用同一常量). base64 膨胀 ~33%, Exchange 常见
# 上限 25-35MB.
MAX_COMPOSE_ATTACH_BYTES = 20 * 1024 * 1024

# 引用分离 marker (D2 Bug B): _build_reply_quote / _build_forward_intro 产出的引用块
# 整体包 <div data-ma-quote="1">…</div> (含「在…写道：」/ Forwarded message 头行 +
# blockquote/正文全部)。前端 draft-edit 回填按该属性切分: marker 前段进 editor,
# marker 段 (含) 进折叠 quote 区; 无 marker 回退全量分流。wrapper div 对收件方渲染
# 无害 (落盘草稿与发送 MIME 都带)。TS 侧同名常量在 frontend/src/shared/lib/quoteSplit.ts。
QUOTE_MARKER_ATTR = "data-ma-quote"


@dataclass
class ComposeRequest:
    """compose (draft / send / draft-plan) 的 transport-neutral 入参。

    收件人 ``to`` / ``cc`` / ``bcc`` 是**逗号分隔字符串** (CLI ``--to`` 原样; serve-api 把
    list ``join`` 成逗号串), service 内 ``_split_addrs`` 再提纯。``body_text`` / ``body_html``
    是**字符串内容** (非文件路径) —— CLI 适配器读 ``--body-file`` / ``--body-html-file`` 成
    字符串, serve-api 直接传 TipTap HTML (A4 净简化: 旧 fork 路径的临时文件那段整段删)。
    """

    internal_id: int
    mode: str = "reply-all"
    extra_to: Optional[str] = None
    extra_cc: Optional[str] = None
    body_text: Optional[str] = None  # markdown (--body-file)
    body_html: Optional[str] = None  # HTML (--body-html-file / 前端 TipTap)
    to: Optional[str] = None  # 完整收件人覆盖 (--to)
    cc: Optional[str] = None  # 完整抄送覆盖 (--cc)
    bcc: Optional[str] = None  # 密送 (--bcc)
    subject: Optional[str] = None  # 完整主题覆盖 (--subject)
    # reply/reply-all 改主题断线程守卫的逃生口 (--force-subject / 前端 forceSubject):
    # 默认 False → subject 与原主题规范化后不同时 service 拒绝 (E_INVALID_ARG)。
    force_subject: bool = False
    importance: Optional[str] = None  # 重要性 high/normal/low (写 MIME Importance 头)
    # quote_original: 显式正文 (body_text/body_html) 也强制在下方附原邮件引用
    # (reply/reply-all) 或转发引用 (forward)。默认 False 保持既有语义: 前端 TipTap
    # 已把引用预填进 editor 后随 body_html 传回, 服务端不能再拼 (否则重复)。
    # True 用于"只给回复正文、由服务端拼引用"的调用方 (chat email_draft_reply 工具:
    # body_markdown 是纯回复内容, 语义=插在 quoted source 之上)。
    quote_original: bool = False
    # attachments: 附件引用列表 (prd 07-04 D1/D2), 每项 dict 三选一:
    #   {"stage_id": str}      compose-attachment 上传暂存 (serve-api 两段式)
    #   {"attachment_id": int} 库内已有附件 (email_attachment.id, 转发沿用)
    #   {"local_path": str}    本地文件 — 仅 CLI in-process 信任面 (--attach),
    #                          serve-api adapter 拒绝该形态
    # None = 未提供 (forward 保持自动收集原附件); 显式提供 (含 []) 时为权威列表,
    # forward 不再自动收集 (语义同 to_override 覆盖推导)。
    attachments: Optional[list[dict]] = None
    # source_draft_id (D1 Bug A): mode='new' (草稿编辑发送/保存) 时给出草稿行自己的
    # internal_id → service 读该行 draft_in_reply_to/draft_references/thread_id
    # linkage, 恢复 threading 头 (In-Reply-To/References) 不再丢线程。绑定校验
    # (codex 批次2 finding 5): 必须 == internal_id (草稿行自己) 且该行是草稿箱行,
    # 否则忽略 linkage。行不存在或 linkage 空 → 回退现状零派生。HTTP body key
    # "sourceDraftId"; 其余模式忽略。
    source_draft_id: Optional[int] = None


@dataclass
class ComposeDraftResult:
    """``compose_draft`` 执行结果 —— 对齐 ``email_draft`` execute emit 的 data。

    ``success`` (恒 True) / ``dry_run`` (恒 False) 由适配器回填 (历史 data 形状)。
    """

    internal_id: int
    drafts_folder: str
    appended_uid: Optional[int]
    method: Optional[str]
    mode: str
    to_count: int
    cc_count: int
    attachments: int
    warnings: list[str]


@dataclass
class DeleteDraftResult:
    """``delete_draft`` 执行结果 — IMAP 删 Exchange 草稿 + 本地行清理。"""

    internal_id: int
    imap_uid: int
    local_deleted: bool


@dataclass
class ComposeSendResult:
    """``send`` 执行结果 —— 对齐 ``email_send`` execute emit 的 data。

    ``sent`` (恒 True) 由适配器回填。
    """

    internal_id: int
    mode: str
    message_id: Optional[str]
    archived_to_sent: bool
    method: Optional[str]
    to_count: int
    cc_count: int
    attachments: int
    warnings: list[str]


def _split_addrs(addrs: str) -> list[str]:
    """split RFC 822 to/cc 字段提纯 email. 对齐 handlers._split_addrs (getaddresses
    正确处理 quoted display name + Outlook semicolon)."""
    if not addrs:
        return []
    from email.utils import getaddresses

    normalized = addrs.replace(";", ",")
    out: list[str] = []
    try:
        for _name, email in getaddresses([normalized]):
            email = (email or "").strip()
            if email:
                out.append(email)
    except Exception:
        # getaddresses 理论上不抛, 兜底逗号切
        out = [a.strip() for a in normalized.split(",") if a.strip()]
    return out


# reply 前缀 (Re:/回复:/答复:, 半/全角冒号, 大小写不敏感) —— 规范化比较时反复剥除。
# 故意不剥 Fwd:/Fw: (转发前缀属主题本体: 回复一封转发邮件, 两侧都保留 Fwd 才相等)。
_REPLY_PREFIX_RE = re.compile(r"^(re|回复|答复)\s*[:：]\s*", re.IGNORECASE)  # ： = 全角冒号


def _normalize_reply_subject(subject: str) -> str:
    """主题规范化: 剥 Re:/回复:/答复: 前缀 (可叠加) + 压空白 + lower。

    用于 reply/reply-all 改主题守卫的「是否同主题」判定 —— Exchange/Outlook 按
    ConversationTopic (即规范化主题) 分组, Gmail 同理, 改主题即断线程。
    """
    s = (subject or "").strip()
    while True:
        stripped = _REPLY_PREFIX_RE.sub("", s, count=1)
        if stripped == s:
            break
        s = stripped.strip()
    return " ".join(s.split()).lower()


def _reply_md_to_html(reply_md: str) -> str:
    """markdown reply_suggestion → HTML。md_to_html 已抽到 src/converter (随
    site-packages 必然打进 .app)。"""
    from src.converter.markdown_to_html import md_to_html

    return md_to_html(reply_md)


def _is_wellformed_msgid(mid: str) -> bool:
    """msg-id 形状校验 (已剥尖括号): 非空、含 ``@``、无空白/尖括号。

    linkage 消费前的最低限度形状闸 (codex finding 4) —— 不追求 RFC 5322 全文法,
    只挡明显畸形 (空串 / 折行残片 / 未剥净的 ``<``/``>``), 防止拼进发送 MIME 的
    In-Reply-To/References 头产生非法值。
    """
    return bool(mid) and "@" in mid and re.search(r"[\s<>]", mid) is None


def _sanitize_draft_linkage(
    in_reply_to: Optional[str],
    references: Optional[str],
    *,
    own_message_id: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """校验草稿行 draft_* linkage, 返回 ``(in_reply_to, references)`` 规范形。

    codex finding 4: 恢复分支不能只看 draft_in_reply_to 非空就信 —— 列值可能来自
    畸形头 / 错误回填。规则:
    - ``in_reply_to`` 形状不合法 → 整体拒 (``(None, None)``, 调用方回退零派生);
    - **自引用拒**: in_reply_to == 草稿行自己的 message_id → 数据不一致, 整体拒
      (回复自己会让收件端把草稿链到它自身, 线程语义错乱);
    - ``references`` 逐 token 校验, 畸形 token 丢弃, 合法 token 重组为规范
      ``<a> <b>`` 链; 全部畸形 → None (调用方按既有口径从 thread_id 派生)。
    返回的 in_reply_to 已剥尖括号 (与 draft_in_reply_to 列口径一致)。
    """
    irt = str(in_reply_to or "").strip().strip("<>")
    if not _is_wellformed_msgid(irt):
        return None, None
    own = str(own_message_id or "").strip().strip("<>")
    if own and irt == own:
        return None, None
    tokens: list[str] = []
    for tok in str(references or "").split():
        t = tok.strip().strip("<>")
        if _is_wellformed_msgid(t):
            tokens.append(f"<{t}>")
    return irt, (" ".join(tokens) or None)


def _is_draft_mailbox_row(row: dict) -> bool:
    """行是否草稿箱行 — mailbox 口径单源 ``DRAFT_MAILBOX_LABELS``
    (mailbox_semantics; issue #42 起含 '草稿'/'Drafts' 历史变体)。

    覆盖两处落库值: mirror (``_mirror_draft_locally`` 直写 '草稿箱') + reconcile
    (davmail_backend ``DRAFTS_MAILBOX_LABEL`` = '草稿箱')。source_draft_id 绑定校验
    (codex 批次2 finding 5) 与懒自愈 gate 共用本判定。
    """
    return (row.get("mailbox") or "") in DRAFT_MAILBOX_LABELS


def _compose_reply_draft(
    record: dict,
    *,
    internal_id: int,
    mode: str,
    reply_text: str,
    reply_html: Optional[str],
    extra_to: Optional[str],
    extra_cc: Optional[str],
    to_override: Optional[str] = None,
    cc_override: Optional[str] = None,
    bcc: Optional[str] = None,
    subject_override: Optional[str] = None,
    force_subject: bool = False,
    forward_intro_text: Optional[str] = None,
    forward_intro_html: Optional[str] = None,
    attachments: Optional[list] = None,
    self_email: Optional[str] = None,
    importance: Optional[str] = None,
    source_linkage: Optional[dict] = None,
):
    """从原邮件 metadata + reply 内容构造 DraftRequest.

    收件人语义:
    - ``to_override`` / ``cc_override`` 非 None → 权威完整列表 (前端 compose 用户编辑后的),
      不做推导也不叠加 extra.
    - 否则 reply/reply-all 推导原收件人 + ``extra_to``/``extra_cc`` 追加; forward 用
      ``extra_to`` 作收件人本体.
    ``bcc`` 总是直接 split. forward: Fwd: 前缀 + 独立邮件 (无 threading) + intro + 附件.

    主题语义: reply/reply-all 下 ``subject_override`` 与原主题规范化后不同 (剥
    Re:/回复:/答复: 前缀) → 默认 raise ``ServiceInvalidArgError`` (改主题断线程守卫),
    ``force_subject=True`` 放行; forward/new 不受限.

    ``self_email`` (reply-all 排除自己用): service 调用方传 ``ctx.config.user_email``
    (尊重各传输持有的 cfg, 不读全局); 缺省 None → 读全局 config (纯函数测试便利)。
    """
    from src.mail.backend import DraftRequest

    if self_email is None:
        from src.config import config as _cfg

        self_email = _cfg.user_email or ""
    self_email = self_email.lower().strip()
    bcc_list = list(dict.fromkeys(_split_addrs(bcc or "")))
    orig_subj = record.get("subject", "") or ""

    if mode == "new":
        # 独立新邮件 (草稿编辑): 显式收件人/主题/正文, 不依赖 record (internal_id 是
        # 草稿自己)。默认零线程派生 (无 Re:/Fwd: 前缀, 不设 in_reply_to/references);
        # source_linkage (D1 Bug A, 来自草稿行 draft_* 列) 非空时恢复 threading 头 —
        # 从回复草稿发送不再丢线程。references 缺失时按既有 reply 分支同构派生
        # (thread_id + in_reply_to 拼链); internal_id_for_threading = 原邮件行
        # internal_id (语义对齐 reply 分支, 反查不到时 None)。
        in_reply_to: Optional[str] = None
        references: Optional[str] = None
        iid_for_threading: Optional[int] = None
        linkage_mid = str((source_linkage or {}).get("in_reply_to") or "").strip().strip("<>")
        if linkage_mid:
            in_reply_to = f"<{linkage_mid}>"
            refs = " ".join(str((source_linkage or {}).get("references") or "").split())
            if refs:
                references = refs
            else:
                tid = str((source_linkage or {}).get("thread_id") or "").strip().strip("<>")
                chunks: list[str] = []
                if tid and tid != linkage_mid:
                    chunks.append(f"<{tid}>")
                chunks.append(in_reply_to)
                references = " ".join(chunks)
            src_iid = (source_linkage or {}).get("source_internal_id")
            if isinstance(src_iid, int) and not isinstance(src_iid, bool):
                iid_for_threading = src_iid
        to_list = list(dict.fromkeys(_split_addrs(to_override or "")))
        cc_list = list(dict.fromkeys(_split_addrs(cc_override or "")))
        subject = subject_override if subject_override is not None else "(no subject)"
        return DraftRequest(
            mode="new",
            internal_id_for_threading=iid_for_threading,
            to=to_list, cc=cc_list, bcc=bcc_list,
            subject=subject or "(no subject)",
            # 写新邮件正文来自用户显式输入 — 空就是空, 不塞 "(rich text body)" 占位
            # (那是"有富文本但 plain 提取失败"的提示, 真空正文用它会误导 plain-text
            #  客户端)。sender.py 对真空 plain part 另有 "(empty body)" 兜底。
            reply_text=reply_text or "",
            reply_html=reply_html,
            in_reply_to=in_reply_to,
            references=references,
            attachments=attachments or [],
            importance=importance,
        )

    if mode == "forward":
        if to_override is not None:
            to_list = list(dict.fromkeys(_split_addrs(to_override)))
            cc_list = list(dict.fromkeys(_split_addrs(cc_override or "")))
        else:
            to_list = list(dict.fromkeys(_split_addrs(extra_to or "")))
            cc_list = list(dict.fromkeys(_split_addrs(extra_cc or "")))
        subject = subject_override if subject_override is not None else (
            orig_subj if orig_subj.lower().startswith(("fwd:", "fw:")) else f"Fwd: {orig_subj}"
        )
        return DraftRequest(
            mode=mode,
            internal_id_for_threading=internal_id,
            to=to_list, cc=cc_list, bcc=bcc_list,
            subject=subject or "(no subject)",
            reply_text=reply_text or "",
            reply_html=reply_html,
            forward_intro_text=forward_intro_text,
            forward_intro_html=forward_intro_html,
            attachments=attachments or [],
            importance=importance,
        )

    if to_override is not None:
        # 前端 compose 传权威完整列表 — 不推导, 不叠加 extra.
        to_list = list(dict.fromkeys(_split_addrs(to_override)))
        cc_list = list(dict.fromkeys(_split_addrs(cc_override or "")))
    else:
        extra_to_list = _split_addrs(extra_to or "")
        extra_cc_list = _split_addrs(extra_cc or "")
        orig_from = (record.get("sender") or "").strip()
        orig_to = _split_addrs(record.get("to_addr") or "")
        orig_cc = _split_addrs(record.get("cc_addr") or "")
        if mode == "reply":
            to_list = [orig_from] if orig_from else []
            cc_list = []
        else:  # reply-all
            candidates = ([orig_from] if orig_from else []) + orig_to
            to_list = [a for a in candidates if a.lower() != self_email]
            cc_list = [a for a in orig_cc if a.lower() != self_email]
        to_list = list(dict.fromkeys(to_list + extra_to_list))  # dedup 保序
        cc_list = list(dict.fromkeys(cc_list + extra_cc_list))

    # 改主题断线程守卫 (fork aad6a203 回港): reply/reply-all 下 subject_override 与原主题
    # 规范化后不同 → Exchange/Outlook (ConversationTopic) / Gmail 都判为新会话, 收件人
    # 看到的是一封脱离线程的新邮件。默认拒绝; 前端 composer (用户显式改题) 恒传
    # force_subject=True 放行, agent/CLI 须显式 --force-subject / forceSubject。
    if (
        subject_override is not None
        and not force_subject
        and _normalize_reply_subject(subject_override) != _normalize_reply_subject(orig_subj)
    ):
        raise ServiceInvalidArgError(
            f"reply/reply-all 修改主题会断开会话线程 (Outlook/Gmail 按主题分组): "
            f"subject {subject_override!r} != 原主题 {orig_subj!r}",
            hint="确需改主题: 用 --mode forward 发独立邮件, 或加 --force-subject 强制",
        )

    subject = subject_override if subject_override is not None else (
        orig_subj if orig_subj.lower().startswith("re:") else f"Re: {orig_subj}"
    )

    # In-Reply-To + References (Outlook 线程 fold)
    message_id = (record.get("message_id") or "").strip().strip("<>")
    in_reply_to: Optional[str] = None
    references: Optional[str] = None
    if message_id:
        in_reply_to = f"<{message_id}>"
        tid = (record.get("thread_id") or "").strip().strip("<>")
        chunks: list[str] = []
        if tid and tid != message_id:
            chunks.append(f"<{tid}>")
        chunks.append(in_reply_to)
        references = " ".join(chunks)

    return DraftRequest(
        mode=mode,
        internal_id_for_threading=internal_id,
        to=to_list, cc=cc_list, bcc=bcc_list,
        subject=subject or "(no subject)",
        reply_text=reply_text or "(rich text body)",
        reply_html=reply_html,
        in_reply_to=in_reply_to,
        references=references,
        attachments=attachments or [],
        importance=importance,
    )


def _build_forward_intro(
    record: dict, body_text: str, body_html: Optional[str]
) -> tuple[str, str]:
    """构造转发引用块 (plain + html): 原文 From/Date/Subject/To 摘要 + 正文."""
    import html as _html

    sender = (record.get("sender") or "").strip()
    date = (record.get("date_received") or "").strip()
    subj = (record.get("subject") or "").strip()
    to = (record.get("to_addr") or "").strip()

    intro_text = (
        "---------- Forwarded message ----------\n"
        f"From: {sender}\n"
        f"Date: {date}\n"
        f"Subject: {subj}\n"
        f"To: {to}\n\n"
        f"{body_text or ''}"
    )
    header_html = (
        '<div style="border-top:1px solid #ccc;margin-top:16px;padding-top:8px;'
        'color:#555;font-size:13px">'
        "---------- Forwarded message ----------<br>"
        f"From: {_html.escape(sender)}<br>"
        f"Date: {_html.escape(date)}<br>"
        f"Subject: {_html.escape(subj)}<br>"
        f"To: {_html.escape(to)}</div>"
    )
    intro_html = (
        f'<div {QUOTE_MARKER_ATTR}="1">'
        + header_html
        + (body_html or f"<pre>{_html.escape(body_text or '')}</pre>")
        + "</div>"
    )
    return intro_text, intro_html


def _build_reply_quote(
    record: dict, body_text: str, body_html: Optional[str]
) -> tuple[str, str]:
    """构造回复引用块 (plain + html): 像 Mail.app / Outlook 一样在回复正文下方附原邮件.

    与 forward 的 "Forwarded message" 头不同, reply 用 "在 <date>, <sender> 写道:" 头.
    原文 HTML **原样拼接不包 blockquote** — blockquote 的 border-left + color:#555 会
    覆盖原文自身样式 (未显式设色的文字全被染灰), owner 反馈"引用丢文字格式"即此;
    改为 分割线 (hr) + 引用头 + 原文, 原文字节不动 (Outlook 桌面端同款形态)。
    原邮件正文本身已含整条线程 (Exchange 每次回复嵌套前文), 故引这一层即带上全部历史.
    """
    import html as _html

    sender = (record.get("sender") or "").strip()
    date = (record.get("date_received") or "").strip()

    intro_text = f"在 {date}，{sender} 写道：\n\n{body_text or ''}"
    quoted = body_html or f"<pre>{_html.escape(body_text or '')}</pre>"
    intro_html = (
        f'<div {QUOTE_MARKER_ATTR}="1">'
        '<hr style="border:none;border-top:1px solid #ccc;margin:16px 0 8px">'
        '<div style="color:#555;font-size:13px;margin:0 0 12px">'
        f"在 {_html.escape(date)}，{_html.escape(sender)} 写道：</div>"
        f"{quoted}</div>"
    )
    return intro_text, intro_html


class MailWriteService:
    """邮件写操作的应用服务 (A2 范围: flag / resync)。

    ``ctx`` 是 ``ServiceDeps`` (CliContext 或 ServiceContext 均满足) —— service 只读
    ``email_repo`` / ``sync_store`` / ``notion_sync``, outbox 从 ``sync_store.db_path``
    现取 (与历史 CLI ``OutboxRepository(cli_config.sync_store_db_path)`` 同库)。
    """

    def __init__(self, ctx: "ServiceDeps") -> None:
        self._ctx = ctx

    # ------------------------------------------------------------
    # flags (Sprint 15 SSoT inversion: 写 SQLite intent + outbox 双 target)
    # ------------------------------------------------------------

    @staticmethod
    def _flag_payloads(
        is_read: Optional[bool],
        is_flagged: Optional[bool],
        processing_status: Optional[str],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """构造 (notion payload, mailapp payload)。

        notion payload 含全部给定字段; mailapp 只读 ``is_read`` / ``is_flagged``
        (MailAppFanout 不认 processing_status)。``None`` 字段不进 payload。
        """
        payload: dict[str, Any] = {}
        if is_read is not None:
            payload["is_read"] = is_read
        if is_flagged is not None:
            payload["is_flagged"] = is_flagged
        if processing_status is not None:
            payload["processing_status"] = processing_status
        mailapp_payload = {
            k: v for k, v in payload.items() if k in ("is_read", "is_flagged")
        }
        return payload, mailapp_payload

    def plan_flags(
        self,
        internal_ids: list[int],
        *,
        is_read: Optional[bool] = None,
        is_flagged: Optional[bool] = None,
        processing_status: Optional[str] = None,
    ) -> dict[str, Any]:
        """dry-run 预览 (无 auth/pm2/写)。形状 = ``email_flag`` 的 dry-run 分支。"""
        payload, mailapp_payload = self._flag_payloads(
            is_read, is_flagged, processing_status
        )
        ids = list(internal_ids)
        return {
            "dry_run": True,
            "internal_ids": ids,
            "payload": payload,
            "would_enqueue": [
                {
                    "internal_id": iid,
                    "mailapp_payload": mailapp_payload,
                    "notion_payload": payload,
                }
                for iid in ids
            ],
        }

    def set_flags(
        self,
        internal_ids: list[int],
        *,
        is_read: Optional[bool] = None,
        is_flagged: Optional[bool] = None,
        processing_status: Optional[str] = None,
        actor: Actor,
        allow_concurrent: bool = False,
    ) -> FlagResult:
        """写 flag/processing_status intent 到 SQLite (echo prevention) + outbox 双 target。

        搬自 ``src/cli/commands/email.py::email_flag`` 行 1331-1393 (行为保持)。逐封:
        get_metadata → 缺失记 not_found; 否则 ``update_local_flags`` (立即镜像) +
        outbox enqueue (mailapp 仅当有 mailapp_payload + notion)。
        """
        require_write_auth(actor)
        check_pm2_conflict(allow_concurrent=allow_concurrent)

        payload, mailapp_payload = self._flag_payloads(
            is_read, is_flagged, processing_status
        )
        repo = self._ctx.email_repo
        sync_store = self._ctx.sync_store
        outbox = OutboxRepository(str(sync_store.db_path))

        # 不变量:「已完成 ⇒ 无旗标」(architecture-internals: 标完成联动摘旗的对称面)。
        # 对已完成邮件重新置旗 = 复活为待办 → processing_status 联动回 '已同步',
        # 否则留下 is_flagged=1 ∧ '已完成' 的设计外组合 (badge / 旗标列表按
        # is_flagged 裸查会多计, 行渲染又被 isDone 压制 → 数字对不上)。调用方
        # 显式传 processing_status 时尊重其值, 不做联动。
        revive_ids: set[int] = set()
        if is_flagged and processing_status is None:
            statuses = sync_store.get_processing_statuses(list(internal_ids))
            revive_ids = {i for i, s in statuses.items() if s == "已完成"}

        updated: list[int] = []
        outbox_entries: list[dict[str, Any]] = []
        not_found: list[int] = []
        for iid in internal_ids:
            meta = repo.get_metadata(iid)
            if meta is None:
                not_found.append(iid)
                continue

            # mirror_and_enqueue_flag_sync = update_local_flags (echo prevention;
            # None 字段沿用当前 meta 值) + dual-target 入队 (E2-D 共享层, 与
            # handlers / reverse_sync 同一入队函数)。
            new_read = bool(is_read) if is_read is not None else bool(meta.is_read)
            new_flagged = (
                bool(is_flagged) if is_flagged is not None else bool(meta.is_flagged)
            )
            local_status = processing_status
            notion_payload = payload
            if iid in revive_ids:
                local_status = "已同步"
                notion_payload = {**payload, "processing_status": "已同步"}
            enq = mirror_and_enqueue_flag_sync(
                sync_store,
                outbox,
                iid,
                local_read=new_read,
                local_flagged=new_flagged,
                local_processing_status=local_status,
                mailapp_payload=mailapp_payload,
                notion_payload=notion_payload,
                source=_OUTBOX_SOURCE,
            )
            oid_mailapp = enq.mailapp_outbox_id
            oid_notion = enq.notion_outbox_id
            updated.append(iid)
            # #4 乐观回显: 立即发 SSE → useEventBridge invalidate ['emails']/['mailboxes']/
            # ['email',id] → 所有视图(含智能信箱 [已旗标])从已同步写入的 SQLite 秒刷新,
            # 不必等 outbox.done(fanout 派发 davmail/Notion 完成, 可能几秒~几十秒)。
            # 在 service 层发(非 storage update_local_flags): 只覆盖用户发起的写, 不对
            # reverse_sync / fanout echo-prevention / 批量回填等内部写喷事件。
            try:
                from src.events.publisher import safe_publish

                safe_publish(
                    "email.flag_changed",
                    internal_id=iid,
                    data={"is_read": new_read, "is_flagged": new_flagged},
                    source="mail_write.set_flags",
                )
            except Exception:
                pass
            outbox_entries.append(
                {
                    "internal_id": iid,
                    "mailapp_outbox_id": oid_mailapp,
                    "notion_outbox_id": oid_notion,
                }
            )

        return FlagResult(
            updated_ids=updated,
            payload=payload,
            outbox_entries=outbox_entries,
            not_found=not_found,
        )

    # ------------------------------------------------------------
    # resync (SQLite SSoT → Notion 重传)
    # ------------------------------------------------------------

    def plan_resync(
        self,
        internal_id: int,
        *,
        replace_existing: bool = False,
        skip_parent_lookup: bool = False,
    ) -> dict[str, Any]:
        """dry-run 预览。meta 不存在 → ``ServiceNotFoundError``。形状 = ``_resync_single`` dry-run。"""
        meta = self._ctx.email_repo.get_metadata(internal_id)
        if meta is None:
            raise ServiceNotFoundError(
                f"Email metadata not found for internal_id={internal_id}"
            )
        return {
            "internal_id": internal_id,
            "subject": meta.subject,
            "current_page_id": meta.notion_page_id,
            "action": "replace" if replace_existing else "create_or_skip",
            "would_replace": replace_existing,
            "skip_parent_lookup": skip_parent_lookup,
            "dry_run": True,
        }

    def resync(
        self,
        internal_id: int,
        *,
        replace_existing: bool = False,
        skip_parent_lookup: bool = False,
        actor: Actor,
        allow_concurrent: bool = False,
    ) -> ResyncResult:
        """重传单封到 Notion。搬自 ``_resync_single`` 行 758-807 (行为保持)。

        ``create_email_page_from_sqlite`` 是 async —— 同步方法内用 ``asyncio.run`` 起独立
        loop (serve-api 经 ``asyncio.to_thread`` 调本方法, loop 落在 worker 线程, 不撞
        uvicorn loop)。正文未双写抛 ``ValueError`` → 转 ``ServiceNotFoundError`` + 回填 hint。
        """
        require_write_auth(actor)
        check_pm2_conflict(allow_concurrent=allow_concurrent)

        repo = self._ctx.email_repo
        meta = repo.get_metadata(internal_id)
        if meta is None:
            raise ServiceNotFoundError(
                f"Email metadata not found for internal_id={internal_id}"
            )

        try:
            result = asyncio.run(
                self._ctx.notion_sync.create_email_page_from_sqlite(
                    internal_id,
                    repo=repo,
                    sync_store=self._ctx.sync_store,
                    replace_existing=replace_existing,
                    skip_parent_lookup=skip_parent_lookup,
                )
            )
        except ValueError as e:
            raise ServiceNotFoundError(
                str(e),
                hint="Phase 1 之前的邮件正文未双写; 跑 `mailagent backfill body "
                "--internal-ids <id>` 回填后再 resync",
            ) from e

        # 回写 notion_page_id: created/replaced 建了新页 → DB 若不更新会指向老/死页,
        # 后续 flag fanout 打死页。窄回写只动 notion_page_id (不碰 thread_id/sync_status)。
        # 失败不阻断 resync 结果返回。
        if result.action in ("created", "replaced") and result.page_id:
            try:
                self._ctx.sync_store.update_notion_page_id(internal_id, result.page_id)
            except Exception as e:  # pragma: no cover - 防御性, 回写失败不影响 resync 结果
                logger.warning(
                    f"resync: failed to write back notion_page_id for "
                    f"internal_id={internal_id}: {e}"
                )

        return ResyncResult(
            internal_id=internal_id,
            old_page_id=result.existing_page_id or meta.notion_page_id,
            new_page_id=result.page_id,
            archived_page_id=result.archived_page_id,
            action=result.action,
        )

    # ------------------------------------------------------------
    # archive (收件箱归档: IMAP MOVE INBOX→Archive + Mailbox→存档, davmail-only)
    # ------------------------------------------------------------

    def _folder_imap_reader(self):
        """构造 FolderImapReader (归档走 IMAP); 要求 davmail backend, 否则
        ``ServiceInvalidArgError``。搬自 CLI ``_folder_imap_reader`` (与 folder.py 同 gate:
        folder 级 IMAP 操作 applescript 模式不支持)。"""
        from src.mail.backend.imap_folder_reader import FolderImapReader
        from src.mail.backend.davmail_backend import DavMailBackend

        backend = self._ctx.backend
        if not isinstance(backend, DavMailBackend):
            raise ServiceInvalidArgError(
                "归档需要 MAILAGENT_BACKEND=davmail (IMAP MOVE); "
                f"当前 backend={getattr(backend, 'backend_origin', '?')!r} 不支持.",
                hint="在 .env 设 MAILAGENT_BACKEND=davmail 并确认 DavMail JVM 在跑.",
            )
        return FolderImapReader(backend)

    async def _update_notion_mailbox(self, page_id: str, mailbox: str) -> None:
        """把 Notion 邮件页的 Mailbox (Select) 属性改成目标值 (归档 = 存档)。"""
        client = self._ctx.notion_sync.client.client  # AsyncClient
        await client.pages.update(
            page_id=page_id,
            properties={"Mailbox": {"select": {"name": mailbox}}},
        )

    def plan_archive(self, internal_id: int) -> dict[str, Any]:
        """dry-run 预览 (无 auth/写)。meta 不存在 → ``ServiceNotFoundError``。
        形状 = ``email_archive`` 的 dry-run 分支。"""
        meta = self._ctx.sync_store.get(internal_id)
        if not meta:
            raise ServiceNotFoundError(
                f"Email metadata not found for internal_id={internal_id}"
            )
        return {
            "internal_id": internal_id,
            "action": "archive",
            "from_mailbox": meta.get("mailbox") or "",
            "to_mailbox": _ARCHIVE_MAILBOX,
            "message_id": meta.get("message_id"),
            "has_imap_uid": meta.get("imap_uid") is not None,
            "notion_page_id": meta.get("notion_page_id"),
            "dry_run": True,
        }

    def archive(self, internal_id: int, *, actor: Actor) -> ArchiveResult:
        """归档收件箱邮件 (IMAP MOVE INBOX→Archive + SQLite/Notion Mailbox→存档)。

        搬自 ``src/cli/commands/email.py::email_archive`` 行 1152-1196 (行为保持)。
        archive **不做** pm2 检测 (原 CLI 无 → 无 ``allow_concurrent`` 参数); Notion 镜像
        失败仅 warn 不阻断 (IMAP 已成功, 下次 resync 可纠正)。``require_write_auth`` 在
        already-archived 业务校验之后 (贴近原 CLI 顺序; CLI 适配器的 token 校验更早)。
        """
        meta = self._ctx.sync_store.get(internal_id)
        if not meta:
            raise ServiceNotFoundError(
                f"Email metadata not found for internal_id={internal_id}"
            )
        current_mailbox = meta.get("mailbox") or ""
        message_id = meta.get("message_id")
        imap_uid = meta.get("imap_uid")
        notion_page_id = meta.get("notion_page_id")

        if current_mailbox == _ARCHIVE_MAILBOX:
            raise ServiceInvalidArgError(
                f"Email {internal_id} 已在存档 (mailbox={current_mailbox!r})"
            )

        require_write_auth(actor)

        # 1. IMAP MOVE <当前文件夹> → Archive (davmail-only)。
        #    src 从邮件**当前** mailbox 解析 (自定义文件夹邮件归档时 src 不是 INBOX 而是
        #    Jira/Notion 等 → 写死 INBOX 会找不到 UID。archive_inbox_message 的 src_imap 泛化)。
        reader = self._folder_imap_reader()
        src_imap = self._resolve_folder_imap(current_mailbox)
        moved = reader.archive_inbox_message(
            message_id, fallback_uid=imap_uid, src_imap=src_imap
        )
        if not moved:
            raise ServiceError(
                f"IMAP 归档失败 ({src_imap!r}→Archive) internal_id={internal_id}; "
                "邮件可能已不在源文件夹或 Archive 文件夹未发现"
            )

        # 2. SQLite: mailbox → 存档 (移出收件箱视图; body/附件保留)
        self._ctx.sync_store.update_mailbox(internal_id, _ARCHIVE_MAILBOX)

        # 3. Notion 镜像: Mailbox 属性 → 存档 (可逆, 不删页)。失败仅 warn — IMAP 已成功,
        #    不该因 Notion 抖动让整体算失败 (下次 resync 可纠正)。
        notion_updated = False
        notion_error = None
        if notion_page_id:
            try:
                asyncio.run(
                    self._update_notion_mailbox(notion_page_id, _ARCHIVE_MAILBOX)
                )
                notion_updated = True
            except Exception as e:  # noqa: BLE001 — Notion SDK 抛各种, 不阻断归档
                notion_error = str(e)

        return ArchiveResult(
            internal_id=internal_id,
            from_mailbox=current_mailbox,
            to_mailbox=_ARCHIVE_MAILBOX,
            notion_updated=notion_updated,
            notion_error=notion_error,
        )

    # ------------------------------------------------------------
    # 多文件夹同步: move_to_folder + 文件夹管理 CRUD (davmail-only)
    # ------------------------------------------------------------

    def _resolve_folder_imap(self, mailbox: str) -> str:
        """email_metadata.mailbox (显示名) → IMAP folder 原始名 (SELECT 用)。

        标准邮箱用映射 (探测到的 sent/drafts 优先); 自定义文件夹 = encode_imap_utf7(显示名)。
        """
        from src.mail.backend.imap_utf7 import encode_imap_utf7

        # ⚠️ 不在这里提前取 self._ctx.backend —— 它 lazy 创建真 davmail backend (连 IMAP)。
        # 收件箱/自定义文件夹的解析不需要 backend; 仅 发件箱/草稿 需探测到的 folder 名。
        if not mailbox or is_inbox_mailbox(mailbox):
            return "INBOX"
        if is_sent_mailbox(mailbox):
            return getattr(self._ctx.backend, "sent_folder", None) or "Sent"
        if is_drafts_mailbox(mailbox):
            return getattr(self._ctx.backend, "drafts_folder", None) or "Drafts"
        if mailbox == _ARCHIVE_MAILBOX:
            return self._folder_imap_reader().resolve_imap_folder("archive") or "Archive"
        return encode_imap_utf7(mailbox)

    def _assert_not_system_folder(self, imap_name: str) -> None:
        """管理 gate: imap_name 是系统文件夹则拒绝 (收件箱/发件箱/Drafts/Junk/Trash)。

        best-effort discover; IMAP 不可用时不阻塞 (EWS 自身也会拒删 distinguished folder)。
        """
        if imap_name.upper() == "INBOX":
            raise ServiceInvalidArgError("INBOX 是系统文件夹, 不可管理")
        try:
            from src.mail.backend.imap_client import list_folders

            for fi in list_folders(self._ctx.config, with_counts=False):
                if fi.imap_name == imap_name and fi.is_system:
                    raise ServiceInvalidArgError(
                        f"{imap_name!r} 是系统文件夹 (收件箱/发件箱/Drafts/Junk/Trash), 不可重命名/删除"
                    )
        except ServiceInvalidArgError:
            raise
        except Exception:  # noqa: BLE001 — discover 失败不阻塞 (EWS 兜底拒删)
            pass

    def move_to_folder(
        self, internal_id: int, dst_imap_name: str, *, actor: Actor
    ) -> MoveResult:
        """把邮件从当前文件夹移到任意目标文件夹 (IMAP MOVE + SQLite/Notion mailbox 更新)。"""
        from src.mail.backend.imap_utf7 import decode_imap_utf7

        meta = self._ctx.sync_store.get(internal_id)
        if not meta:
            raise ServiceNotFoundError(
                f"Email metadata not found for internal_id={internal_id}"
            )
        current_mailbox = meta.get("mailbox") or ""
        dst_label = decode_imap_utf7(dst_imap_name)
        if current_mailbox == dst_label:
            raise ServiceInvalidArgError(
                f"Email {internal_id} 已在 {dst_label!r}"
            )
        # 防误「移动=删除」: 拒绝移到回收站/垃圾邮件 (移到那等于删除, 应走 delete)。
        if dst_imap_name.upper() in _TRASH_LIKE_IMAP or dst_label in _TRASH_LIKE_LABEL:
            raise ServiceInvalidArgError(
                f"不能移动到回收站/垃圾邮件 ({dst_label!r}); 删除请用归档或专门的删除操作"
            )
        require_write_auth(actor)

        reader = self._folder_imap_reader()
        src_imap = self._resolve_folder_imap(current_mailbox)
        moved = reader.move_by_message_id(
            src_imap, meta.get("message_id"), dst_imap_name,
            fallback_uid=meta.get("imap_uid"),
        )
        if not moved:
            raise ServiceError(
                f"IMAP 移动失败 ({src_imap!r}→{dst_imap_name!r}) internal_id={internal_id}"
            )
        self._ctx.sync_store.update_mailbox(internal_id, dst_label)
        notion_updated = False
        notion_error = None
        page_id = meta.get("notion_page_id")
        if page_id:
            try:
                asyncio.run(self._update_notion_mailbox(page_id, dst_label))
                notion_updated = True
            except Exception as e:  # noqa: BLE001
                notion_error = str(e)
        return MoveResult(
            internal_id=internal_id,
            from_mailbox=current_mailbox,
            to_mailbox=dst_label,
            notion_updated=notion_updated,
            notion_error=notion_error,
        )

    def create_folder(
        self, parent_imap: str, name: str, *, actor: Actor
    ) -> FolderMutationResult:
        """在父文件夹下新建子文件夹 (IMAP CREATE)。parent_imap 空=顶层。"""
        require_write_auth(actor)
        reader = self._folder_imap_reader()
        child_imap = reader.build_child_imap_name(parent_imap, name)
        if not reader.create_folder(child_imap):
            raise ServiceError(f"创建文件夹失败 (IMAP CREATE {child_imap!r})")
        return FolderMutationResult(action="create", imap_name=child_imap)

    def cleanup_local_folder(self, imap_name: str, *, actor: Actor) -> FolderMutationResult:
        """取消同步某文件夹时**清理本地副本** (P5: 取消勾选 + 同时清理选项)。

        **不碰 Exchange 文件夹** (与 delete_folder 区别) —— 只删本地 email_metadata
        (级联 body/attachment/FTS + 附件目录) + 从白名单移除。davmail-only 不要求 (纯本地)。
        """
        from src.mail.backend.imap_utf7 import decode_imap_utf7

        # 守卫: 空名 / INBOX / 标准邮箱不可清 (防 raw API/CLI 误删收件箱本地行)。
        # 纯静态检查 (cleanup 非 davmail 也可, 不能用 _assert_not_system_folder 的 IMAP LIST)。
        if not imap_name or not imap_name.strip():
            raise ServiceInvalidArgError("imap_name 不能为空")
        label = decode_imap_utf7(imap_name.strip())
        if imap_name.strip().upper() == "INBOX" or label in (
            "收件箱", "发件箱", "已发送", "已发送邮件", "草稿", "草稿箱",
        ):
            raise ServiceInvalidArgError(
                f"{label!r} 是系统邮箱, 不可清理本地副本 (仅自定义文件夹可清)"
            )
        require_write_auth(actor)
        affected = self._delete_local_mailbox_rows(label)
        wl_changed = self._remove_whitelist_entry(imap_name)
        return FolderMutationResult(
            action="cleanup", imap_name=imap_name,
            affected_local_rows=affected, restart_required=wl_changed,
        )

    def rename_folder(
        self, imap_name: str, new_name: str, *, actor: Actor
    ) -> FolderMutationResult:
        """重命名文件夹 (IMAP RENAME + 本地 email_metadata.mailbox 一致性回填)。

        new_name 是叶子显示名; 保留原父路径。系统文件夹拒绝。
        """
        from src.mail.backend.imap_utf7 import decode_imap_utf7, encode_imap_utf7

        require_write_auth(actor)
        self._assert_not_system_folder(imap_name)
        # 保留父路径, 仅换叶子段。
        if "/" in imap_name:
            parent = imap_name.rsplit("/", 1)[0]
            new_imap = f"{parent}/{encode_imap_utf7(new_name)}"
        else:
            new_imap = encode_imap_utf7(new_name)
        reader = self._folder_imap_reader()
        if not reader.rename_folder(imap_name, new_imap):
            raise ServiceError(f"重命名失败 (IMAP RENAME {imap_name!r}→{new_imap!r})")
        # 一致性: 本地 email_metadata.mailbox (旧显示名→新显示名) + 白名单。
        old_label = decode_imap_utf7(imap_name)
        new_label = decode_imap_utf7(new_imap)
        affected = self._rename_local_mailbox(old_label, new_label)
        wl_changed = self._rename_whitelist_entry(imap_name, new_imap)
        return FolderMutationResult(
            action="rename", imap_name=imap_name, new_imap_name=new_imap,
            affected_local_rows=affected, restart_required=wl_changed,
        )

    def delete_folder(self, imap_name: str, *, actor: Actor) -> FolderMutationResult:
        """删除文件夹 (IMAP DELETE + 本地 email_metadata 清理 + 白名单移除)。系统文件夹拒绝。"""
        from src.mail.backend.imap_utf7 import decode_imap_utf7

        require_write_auth(actor)
        self._assert_not_system_folder(imap_name)
        reader = self._folder_imap_reader()
        if not reader.delete_folder(imap_name):
            raise ServiceError(
                f"删除失败 (IMAP DELETE {imap_name!r}); 可能是系统文件夹或非空受保护"
            )
        label = decode_imap_utf7(imap_name)
        affected = self._delete_local_mailbox_rows(label)
        wl_changed = self._remove_whitelist_entry(imap_name)
        return FolderMutationResult(
            action="delete", imap_name=imap_name, affected_local_rows=affected,
            restart_required=wl_changed,
        )

    # --- 文件夹管理一致性 helper (本地 SQLite + 白名单) ---

    def _rename_local_mailbox(self, old_label: str, new_label: str) -> int:
        """重命名本地 mailbox 标签 —— 精确匹配 + **子文件夹前缀替换** (label 存完整路径,
        重命名父文件夹时 `old/子` 邮件的 label 仍是旧前缀, 精确匹配漏掉 → 误导)。
        """
        import sqlite3

        try:
            conn = sqlite3.connect(str(self._ctx.sync_store.db_path), timeout=10.0)
            try:
                cur1 = conn.execute(
                    "UPDATE email_metadata SET mailbox = ? WHERE mailbox = ?",
                    (new_label, old_label),
                )
                # 子文件夹: `old_label/...` → `new_label/...` (SUBSTR 1-indexed, 截 old_label 后的 /...)
                cur2 = conn.execute(
                    "UPDATE email_metadata SET mailbox = ? || SUBSTR(mailbox, ?) "
                    "WHERE mailbox LIKE ?",
                    (new_label, len(old_label) + 1, old_label + "/%"),
                )
                conn.commit()
                return (cur1.rowcount or 0) + (cur2.rowcount or 0)
            finally:
                conn.close()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[mail-write] rename local mailbox {old_label!r}→{new_label!r} failed: {e}")
            return 0

    def _delete_local_mailbox_rows(self, label: str) -> int:
        """删该 mailbox 的本地 email_metadata 行 —— 走 EmailRepository.delete_email_full
        逐行删 (FK CASCADE 清 body/attachment/FTS + 删本地附件目录)。

        🔴 不能 raw `sqlite3.connect` 直接 DELETE: 那条连接 FK 默认 OFF → body/attachment/FTS
        孤儿 + 附件目录残留 (与 delete_email_full 的 DB 完整性契约不一致)。
        """
        import sqlite3

        try:
            conn = sqlite3.connect(str(self._ctx.sync_store.db_path), timeout=10.0)
            try:
                # 精确 label + 子文件夹 (label/...) —— 删/清父文件夹时子文件夹本地行也清
                # (label 存完整路径; 与 _rename_local_mailbox 的子前缀处理对称, 防孤儿)。
                ids = [
                    r[0] for r in conn.execute(
                        "SELECT internal_id FROM email_metadata "
                        "WHERE mailbox = ? OR mailbox LIKE ?",
                        (label, label + "/%"),
                    ).fetchall()
                ]
            finally:
                conn.close()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[mail-write] collect rows mailbox={label!r} failed: {e}")
            return 0
        repo = self._ctx.email_repo
        n = 0
        for iid in ids:
            try:
                repo.delete_email_full(iid)   # FK CASCADE (body/attachment/FTS) + 附件目录
                n += 1
            except Exception as e:  # noqa: BLE001
                logger.warning(f"[mail-write] delete_email_full({iid}) failed: {e}")
        return n

    def _rewrite_whitelist(self, mutate) -> bool:
        """读 SYNC_FOLDERS → mutate(list) → 写回 .env (JSON)。返回是否**真改动**白名单
        (用于 restart_required 信号)。失败仅 warn 返 False。"""
        import json as _json

        try:
            from dotenv import set_key as _set_key

            from src.config import _resolve_env_file
            from src.mail.backend.davmail_backend import DavMailBackend

            cfg = self._ctx.config
            current = DavMailBackend._parse_custom_folders(cfg) if cfg else []
            new = mutate(list(current))
            if new == current:
                return False   # 文件夹不在白名单 → 不写 → 无需 restart
            env_file = _resolve_env_file()
            _set_key(str(env_file), "SYNC_FOLDERS", _json.dumps(new, ensure_ascii=False), quote_mode="auto")
            return True
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[mail-write] rewrite whitelist failed: {e}")
            return False

    def _rename_whitelist_entry(self, old_imap: str, new_imap: str) -> bool:
        return self._rewrite_whitelist(lambda lst: [new_imap if x == old_imap else x for x in lst])

    def _remove_whitelist_entry(self, imap_name: str) -> bool:
        return self._rewrite_whitelist(lambda lst: [x for x in lst if x != imap_name])

    # ------------------------------------------------------------
    # pin / unpin (v8 前端置顶持久化; Mail.app 无 pin 概念, mail-sync 不读写)
    # ------------------------------------------------------------

    @staticmethod
    def _pin_changed(already: bool, pinned: bool) -> bool:
        """是否真正改变了置顶态: pin(True) → not already; unpin(False) → already。

        统一表达 = ``already != pinned`` (逐字段对齐 ``email_pin`` 的 ``changed=not already``
        与 ``email_unpin`` 的 ``changed=was``)。
        """
        return already != pinned

    def plan_pin(self, internal_id: int, *, pinned: bool) -> dict[str, Any]:
        """dry-run 预览 (无 auth/写)。meta 不存在 → ``ServiceNotFoundError``。
        形状 = ``email_pin`` / ``email_unpin`` 的 dry-run 分支。"""
        _ = self._ctx.sync_store  # ensure v8 schema (is_pinned + pinned_at ALTER)
        meta = self._ctx.email_repo.get_metadata(internal_id)
        if meta is None:
            raise ServiceNotFoundError(
                f"Email with internal_id={internal_id} not found",
                hint="Use 'mailagent email list' to find available IDs",
            )
        already = bool(meta.is_pinned)
        return {
            "internal_id": internal_id,
            "is_pinned": pinned,
            "changed": self._pin_changed(already, pinned),
            "dry_run": True,
        }

    def set_pin(self, internal_id: int, *, pinned: bool, actor: Actor) -> PinResult:
        """写 email_metadata.is_pinned (pin=True / unpin=False)。

        搬自 ``email_pin`` 行 964-1002 + ``email_unpin`` 行 1015-1046 (行为保持)。pin
        **不做** pm2 检测 (Mail.app 无 pin 概念, mail-sync 不读写该字段 → 无并发损坏风险
        → 无 ``allow_concurrent`` 参数)。set_pin 返回 None = race (写命令间被删) → NotFound。
        """
        _ = self._ctx.sync_store  # ensure v8 schema (is_pinned + pinned_at ALTER)
        repo = self._ctx.email_repo
        meta = repo.get_metadata(internal_id)
        if meta is None:
            raise ServiceNotFoundError(
                f"Email with internal_id={internal_id} not found",
                hint="Use 'mailagent email list' to find available IDs",
            )
        already = bool(meta.is_pinned)

        require_write_auth(actor)

        result = repo.set_pin(internal_id, pinned)
        if result is None:
            raise ServiceNotFoundError(
                f"Email with internal_id={internal_id} disappeared mid-write"
            )
        changed = self._pin_changed(already, pinned)
        # 乐观回显 (镜像 set_flags 的 email.flag_changed): 立即发 SSE → useEventBridge
        # invalidate ['pinnedIds']/['emails'] → 所有视图(含 agent / CLI / 远程发起的写)
        # 秒刷新置顶态。pin 不进 outbox (Mail.app 无 pin 概念, 无 fanout), 故这是唯一的
        # 实时通知点 —— 缺它则 SSE 连着时既无事件又不轮询, UI 永不刷新 (dogfood 根因)。
        # 仅在真正改变时发 (changed): 重复写不喷无意义事件。在 service 层发, 只覆盖经
        # 服务层的写 (用户/agent/CLI), 不对内部回填喷事件。
        if changed:
            try:
                from src.events.publisher import safe_publish

                safe_publish(
                    "email.pin_changed",
                    internal_id=internal_id,
                    data={"is_pinned": pinned},
                    source="mail_write.set_pin",
                )
            except Exception:
                pass
        return PinResult(
            internal_id=internal_id,
            is_pinned=pinned,
            changed=changed,
        )

    # ------------------------------------------------------------
    # reply_suggestion (写 llm_processing.labels_json.reply_suggestion_md, SSoT)
    # ------------------------------------------------------------

    def set_reply_suggestion(
        self, internal_id: int, reply_md: str, *, actor: Actor
    ) -> ReplySuggestionResult:
        """写邮件的回复建议 markdown 到 SQLite ``llm_processing.labels_json``。

        SQLite 是 reply_suggestion 的 SSoT (LLM 生成 + 用户/前端 chat 改动回灌)。前端
        chat 工具 ``email_set_reply_suggestion`` 经此让用户(经 AI)改建议。范式同
        ``set_pin``: meta 不存在 → ``ServiceNotFoundError``; require_write_auth 在业务
        校验之后。**不做** pm2 检测 (mail-sync 不读写 reply_suggestion_md → 无并发损坏)。
        ``compose`` 取建议时读同一字段 (``_fetch_reply_suggestion_md``)。
        """
        from src.llm_agent.store import LLMProcessingStore

        meta = self._ctx.email_repo.get_metadata(internal_id)
        if meta is None:
            raise ServiceNotFoundError(
                f"Email with internal_id={internal_id} not found",
                hint="Use 'mailagent email list' to find available IDs",
            )

        require_write_auth(actor)

        store = LLMProcessingStore(self._ctx.config.sync_store_db_path)
        # set_reply_suggestion 返回**实际落库**的字符串 (可能被裁短) — 用它构造结果,
        # 保证「上报值 == SSoT 值」(否则 Craft 预填 / LLM next-turn 上下文与上报内容不一致)。
        stored_md = store.set_reply_suggestion(internal_id, reply_md)
        return ReplySuggestionResult(
            internal_id=internal_id,
            reply_suggestion_md=stored_md,
            chars=len(stored_md),
        )

    # ------------------------------------------------------------
    # ai_fields (覆盖 AI Action / Priority / Review Status, SSoT)
    # ------------------------------------------------------------

    # 合法 review_status (前端 enum)。'reviewed'→llm_processing.status='success';
    # 'pending'→'pending' (与 email_views.py::_map_review_status 反向对齐)。
    _REVIEW_STATUS_ENUM = ("reviewed", "pending")

    def set_ai_fields(
        self,
        internal_id: int,
        *,
        action: Optional[str] = None,
        priority: Optional[str] = None,
        review_status: Optional[str] = None,
        actor: Actor,
    ) -> AiFieldsResult:
        """覆盖单封邮件的 AI 分类字段 (AI Action / Priority / Review Status) 到 SQLite SSoT。

        前端 chat 工具 ``email_set_ai_fields`` 经此让用户(经 AI)覆盖 LLM 原分类。范式同
        ``set_pin`` / ``set_reply_suggestion``: meta 不存在 → ``ServiceNotFoundError``;
        require_write_auth 在业务校验之后。**不做** pm2 检测 (mail-sync 不在用户改分类时
        并发写这些字段 — labels_json/status 由 LLM worker 写, 但那是同一封不同时机, 与
        reply_suggestion 同类风险面，沿用其无 pm2 决策)。

        合法枚举**严格取自 ``src/llm_agent/schema.py``** (写字段值, 不改 schema 定义):
          - ``priority`` ∈ PRIORITY_ENUM (🔴 紧急 / 🟡 重要 / 🟢 一般 / ⚪ 低)
          - ``action`` ∈ mailbox-specific ACTION_TYPE (收件箱用 ACTION_TYPE_INBOX,
            发件箱用 ACTION_TYPE_SENT — 经 ``is_valid_action_type`` 按邮件 mailbox 判)
          - ``review_status`` ∈ {'reviewed', 'pending'} (映射到 llm_processing.status)
        任一非法 → ``ServiceInvalidArgError``; 三者全 None → ``ServiceInvalidArgError``
        ('至少一项非空')。

        写位置 (经 LLMProcessingStore.set_ai_fields, 与既有读链一一对应):
        labels_json.action_type/priority (+ 镜像主表列 ai_action/ai_priority) + status 列。
        返回**实际落库**值, 保证「上报值 == SSoT 值」。
        """
        from src.llm_agent.schema import PRIORITY_ENUM, is_valid_action_type

        meta = self._ctx.email_repo.get_metadata(internal_id)
        if meta is None:
            raise ServiceNotFoundError(
                f"Email with internal_id={internal_id} not found",
                hint="Use 'mailagent email list' to find available IDs",
            )

        # 至少一项非空 (空写没有意义 — 与 email_flag「至少一个 flag 字段」对齐)。
        if action is None and priority is None and review_status is None:
            raise ServiceInvalidArgError(
                "at least one of action / priority / review_status must be set"
            )

        # 枚举校验 — 严格匹配 schema.py 合法值 (写字段值, 不改 schema 定义)。
        if priority is not None and priority not in PRIORITY_ENUM:
            raise ServiceInvalidArgError(
                f"invalid priority {priority!r}; allowed: {list(PRIORITY_ENUM)}"
            )
        if action is not None and not is_valid_action_type(action, meta.mailbox or ""):
            # mailbox-specific: 收件箱 ↔ 发件箱 枚举不同 (is_valid_action_type 按 mailbox 判)。
            from src.llm_agent.schema import ACTION_TYPE_INBOX, ACTION_TYPE_SENT

            allowed = (
                ACTION_TYPE_SENT if is_sent_mailbox(meta.mailbox) else ACTION_TYPE_INBOX
            )
            raise ServiceInvalidArgError(
                f"invalid action {action!r} for mailbox {meta.mailbox!r}; "
                f"allowed: {list(allowed)}"
            )
        if review_status is not None and review_status not in self._REVIEW_STATUS_ENUM:
            raise ServiceInvalidArgError(
                f"invalid review_status {review_status!r}; "
                f"allowed: {list(self._REVIEW_STATUS_ENUM)}"
            )

        require_write_auth(actor)

        from src.llm_agent.store import LLMProcessingStore

        store = LLMProcessingStore(self._ctx.config.sync_store_db_path)
        stored = store.set_ai_fields(
            internal_id,
            action=action,
            priority=priority,
            review_status=review_status,
        )
        # store 把 status 列回映成前端 enum: success→reviewed / 其它→pending (与读链一致)。
        stored_review = stored.get("review_status")
        review_out = (
            None
            if stored_review is None
            else ("reviewed" if stored_review == "success" else "pending")
        )
        return AiFieldsResult(
            internal_id=internal_id,
            action=stored.get("action_type"),
            priority=stored.get("priority"),
            review_status=review_out,
        )

    # ------------------------------------------------------------
    # compose (draft / send / draft-plan) — backend.append_draft / send_email
    # ------------------------------------------------------------

    def _fetch_reply_suggestion_md(self, internal_id: int) -> str:
        """从 SQLite ``llm_processing.labels_json`` 读 ``reply_suggestion_md`` (SSoT)。

        SQLite 是 reply_suggestion 的 SSoT (LLM 生成 + 用户/Notion 改动回灌), 不读 Notion。
        搬自 CLI ``_fetch_reply_suggestion_md`` (读 ``ctx.config`` 而非全局 cfg)。
        """
        import json as _json

        from src.llm_agent.store import LLMProcessingStore

        store = LLMProcessingStore(self._ctx.config.sync_store_db_path)
        row = store.get(internal_id)
        if not row:
            return ""
        raw = row.get("labels_json") or ""
        if not raw:
            return ""
        try:
            labels = _json.loads(raw)
        except (ValueError, TypeError):
            return ""
        if not isinstance(labels, dict):
            return ""
        return (labels.get("reply_suggestion_md") or "").strip()

    def _collect_forward_attachments(
        self, internal_id: int
    ) -> tuple[list, list[str]]:
        """读原邮件常规附件 (过滤 inline), 累计不超 cap。返回 (attachments, warnings)。

        inline 图片 (cid:) 默认不带 — forward_intro_html 重拼, cid 引用会失效 (已知限制)。
        搬自 CLI ``_collect_forward_attachments`` (用 ``ctx.email_repo``)。
        """
        out: list = []
        warnings: list[str] = []
        total = 0
        for a in self._ctx.email_repo.get_attachments(internal_id):
            if a.is_inline:
                continue
            data = self._ctx.email_repo.get_attachment_bytes(a.id)
            if not data:
                warnings.append(f"附件 {a.filename!r} 读取失败, 跳过")
                continue
            if total + len(data) > MAX_COMPOSE_ATTACH_BYTES:
                warnings.append(
                    f"附件总大小超 {MAX_COMPOSE_ATTACH_BYTES // (1024 * 1024)}MB, "
                    f"跳过 {a.filename!r} 及之后附件"
                )
                break
            total += len(data)
            out.append((a.filename, data, a.content_type or "application/octet-stream"))
        return out, warnings

    def _resolve_attachment_refs(
        self, refs: list, *, total_so_far: int = 0
    ) -> list:
        """把 ``ComposeRequest.attachments`` 引用解析成 (filename, bytes, mime) 三元组。

        三种 ref 形态见 ComposeRequest.attachments 注释 (stage_id / attachment_id /
        local_path)。显式引用 = 用户明确要带的附件 — 任何解析失败 / 超 cap 直接
        ``ServiceInvalidArgError`` **不静默跳过** (区别于 forward 自动收集的
        warn+skip: 静默丢用户点名的附件等于数据丢失)。cap 与自动收集共用
        ``MAX_COMPOSE_ATTACH_BYTES``, ``total_so_far`` 传入已收集部分的字节数。
        """
        from pathlib import Path

        from src.services.compose_staging import guess_mime, read_staged

        out: list = []
        total = total_so_far
        for ref in refs:
            if not isinstance(ref, dict):
                raise ServiceInvalidArgError(
                    f"attachment ref 必须是 dict, got {type(ref).__name__}"
                )
            if "stage_id" in ref:
                staged = read_staged(self._ctx.config, str(ref["stage_id"] or ""))
                if staged is None:
                    raise ServiceInvalidArgError(
                        f"附件暂存不存在或已过期 (stage_id={ref['stage_id']!r}), 请重新上传"
                    )
                filename, data, mime = staged
            elif "attachment_id" in ref:
                att_id = ref["attachment_id"]
                if not isinstance(att_id, int) or isinstance(att_id, bool):
                    raise ServiceInvalidArgError(
                        f"attachment_id 必须是 int, got {att_id!r}"
                    )
                rec = self._ctx.email_repo.get_attachment_record(att_id)
                if rec is None:
                    raise ServiceInvalidArgError(f"附件不存在 (attachment_id={att_id})")
                data = self._ctx.email_repo.get_attachment_bytes(att_id)
                if not data:
                    raise ServiceInvalidArgError(
                        f"附件文件读取失败 (attachment_id={att_id}, {rec.filename!r})"
                    )
                filename = rec.filename
                mime = rec.content_type or "application/octet-stream"
            elif "local_path" in ref:
                # 仅 CLI in-process 信任面 (--attach); serve-api adapter 拒绝该形态。
                p = Path(str(ref["local_path"] or ""))
                try:
                    data = p.read_bytes()
                except OSError as e:
                    raise ServiceInvalidArgError(f"--attach 文件读取失败: {e}")
                filename = p.name
                mime = guess_mime(p.name)
            else:
                raise ServiceInvalidArgError(
                    "attachment ref 需含 stage_id / attachment_id / local_path 之一, "
                    f"got {sorted(ref.keys())}"
                )
            if total + len(data) > MAX_COMPOSE_ATTACH_BYTES:
                raise ServiceInvalidArgError(
                    f"附件总大小超 {MAX_COMPOSE_ATTACH_BYTES // (1024 * 1024)}MB 上限"
                    f" (加入 {filename!r} 时溢出)"
                )
            total += len(data)
            out.append((filename, data, mime))
        return out

    def _prepare_draft(
        self,
        request: "ComposeRequest",
        *,
        allow_missing_reply: bool,
        split_quote: bool,
        persist_heal: bool = True,
    ) -> tuple[Any, list[str], Optional[dict]]:
        """构造 DraftRequest (compose_draft + send 共用)。搬自 CLI ``_prepare_draft`` 行 1508-1623。

        正文优先级: ``body_html`` (字符串) > ``body_text`` (markdown 字符串) > SQLite
        reply_suggestion_md。``split_quote=True`` (dry-run 预填): 引用块单独作第 3 个返回值
        ``quote`` 不并进正文; False (执行路径): 引用块并进 reply_html/forward_intro。
        ``persist_heal=False`` (compose_plan dry-run): linkage 懒自愈只取件解析本次
        使用, **不回写库** — 保 compose_plan 文档化的「无 auth/写」契约 (codex 批次2
        finding 4)。meta 不存在 → ``ServiceNotFoundError``。
        """
        internal_id = request.internal_id
        mode = request.mode
        record = self._ctx.sync_store.get(internal_id) or {}
        # mode='new' (写全新邮件 / 草稿编辑发送) 不依赖源邮件 record — 显式收件人 /
        # 正文、零线程派生 (走下方 explicit_body 分支)。写全新邮件传哨兵 internal_id
        # (=-1, 无对应行), record={} 即可。其余模式 (reply/reply-all/forward) 必须有
        # 源邮件 record 才能推导收件人 / 引用块 / 附件。
        if not record and mode != "new":
            raise ServiceNotFoundError(
                f"Email metadata not found for internal_id={internal_id}"
            )

        # source_draft_id (D1 Bug A): mode='new' 且给了草稿行 id → 读该行 draft_*
        # linkage 列, 交 _compose_reply_draft 恢复 threading 头。行不存在 / 列空
        # (非回复草稿) → None, 回退现状零派生。
        # - 绑定校验 (codex 批次2 finding 5): source_draft_id 必须 == request.
        #   internal_id (draft-edit 语义 = 草稿行自己, 前端恒双份传同一 id) 且该行
        #   mailbox 是草稿箱 (_is_draft_mailbox_row, 口径同懒自愈 gate)。不满足 →
        #   忽略 linkage 回退零派生 + warning (不报错) — 防错误客户端拿任意 id 把
        #   无关邮件线程接到别的草稿的源下。已存 linkage 与懒自愈两条路都过此闸。
        # - 懒自愈 (codex finding 1): 存量草稿行 (v36 迁移前入库, draft_* 全 NULL,
        #   reconcile 稳态短路永不回填) → 消费时按 imap_uid 从 davmail 取草稿 MIME
        #   头解析 In-Reply-To/References, 当场使用并回写 draft_* 列 (persist_heal=
        #   False 的 dry-run 只用不写)。
        # - 消费校验 (codex finding 4): 列值须过 _sanitize_draft_linkage (msg-id
        #   形状 + 拒自引用), 不合法 → 回退零派生。
        source_linkage: Optional[dict] = None
        if mode == "new" and request.source_draft_id is not None:
            draft_row = self._ctx.sync_store.get(request.source_draft_id) or {}
            if request.source_draft_id != internal_id or not _is_draft_mailbox_row(
                draft_row
            ):
                logger.warning(
                    f"[compose] source_draft_id={request.source_draft_id} 绑定校验"
                    f"不过 (internal_id={internal_id}, mailbox="
                    f"{draft_row.get('mailbox')!r}) — 忽略 linkage 回退零线程派生"
                )
            else:
                if not (draft_row.get("draft_in_reply_to") or "").strip():
                    healed = self._heal_draft_linkage(
                        request.source_draft_id, draft_row, persist=persist_heal
                    )
                    if healed:
                        draft_row = {**draft_row, **healed}
                raw_irt = (draft_row.get("draft_in_reply_to") or "").strip()
                if raw_irt:
                    irt, refs = _sanitize_draft_linkage(
                        raw_irt,
                        draft_row.get("draft_references"),
                        own_message_id=draft_row.get("message_id"),
                    )
                    if irt:
                        source_linkage = {
                            "in_reply_to": irt,
                            "references": refs,
                            "thread_id": draft_row.get("thread_id"),
                            "source_internal_id": draft_row.get(
                                "draft_source_internal_id"
                            ),
                        }
                    else:
                        logger.warning(
                            f"[compose] source_draft_id={request.source_draft_id} "
                            f"linkage invalid (malformed / self-referencing "
                            f"In-Reply-To={raw_irt[:60]!r}) — 回退零线程派生"
                        )

        # explicit_body: 调用方传了完整正文 (前端 compose 发送 / 用户 body_text)。forward 时
        # 已含引用块 (dry-run 预填阶段拼进 editor 后随 body_html 传回), 不能再单独构造
        # forward_intro — 否则 build_outgoing_mime 二次 append 致引用块重复。
        explicit_body = bool(request.body_html or request.body_text)
        if request.body_html:
            from src.converter.html_to_markdown import html_to_markdown

            reply_html = request.body_html
            reply_text = html_to_markdown(reply_html) if reply_html.strip() else ""
        elif request.body_text:
            reply_text = request.body_text
            reply_html = _reply_md_to_html(reply_text) if reply_text.strip() else None
        else:
            reply_md = self._fetch_reply_suggestion_md(internal_id)
            # allow_missing_reply: dry-run 预填放宽 — 没建议也要能预填收件人 (正文留空)。
            # 真实 draft/send 仍要求有正文来源, 避免误发空回复。mode='new' (写新邮件)
            # 例外: 无源邮件谈不上 reply_suggestion, 允许空正文 (用户可只写主题/收件人;
            # 下方 _compose_reply_draft new 分支给 reply_text 兜底)。
            if not reply_md and mode not in ("forward", "new") and not allow_missing_reply:
                raise ServiceNotFoundError(
                    f"Email {internal_id} 无 reply_suggestion (SQLite labels_json 空)",
                    hint="先 mailagent llm run <id> 生成回复建议, 或用 --body-file 传正文",
                )
            reply_text = reply_md or ""
            reply_html = _reply_md_to_html(reply_md) if reply_md else None

        # 引用原邮件 (Mail.app / Outlook: reply/reply-all/forward 都在正文下方附原文)。仅
        # "无显式正文" 时构造 — 显式正文已含预填引用, 跳过避免二次拼接重复。
        forward_intro_text = forward_intro_html = None
        attachments: list = []
        warnings: list[str] = []
        quote: Optional[dict] = None  # split_quote=True 时单独返回引用块, 不并进正文
        # 是否构造原文引用块: 无显式正文 (前端 compose 走 draft-plan 预填引用进 editor)
        # 默认构造; 有显式正文默认跳过 (body 已含预填引用, 再拼会重复)。例外:
        # quote_original=True 的调用方 (chat email_draft_reply / 正文 Craft 按钮: body 是
        # 纯回复内容、未含引用) 即便有显式正文也强制构造并下拼到正文之下。
        build_quote = (not explicit_body) or request.quote_original
        if mode == "forward":
            # 附件 server-side 收集 — 前端无法传字节, 按 internal_id 重读。
            # request.attachments 显式提供 (含 []) 时为权威列表 (前端转发可取消勾选
            # 原附件, 语义同 to_override 覆盖推导), 跳过自动收集; None (CLI 旧调用 /
            # 灵动岛) 保持自动收集全部原邮件常规附件。
            if request.attachments is None:
                attachments, warnings = self._collect_forward_attachments(internal_id)
            if build_quote:
                body_md = self._ctx.email_repo.get_body_markdown(internal_id) or ""
                body_html = self._ctx.email_repo.get_body_html(internal_id)
                fi_text, fi_html = _build_forward_intro(record, body_md, body_html)
                if split_quote:
                    quote = {"text": fi_text, "html": fi_html}
                else:
                    forward_intro_text, forward_intro_html = fi_text, fi_html
        elif mode in ("reply", "reply-all") and build_quote:  # reply / reply-all
            orig_md = self._ctx.email_repo.get_body_markdown(internal_id) or ""
            orig_html = self._ctx.email_repo.get_body_html(internal_id)
            if orig_md or orig_html:
                q_text, q_html = _build_reply_quote(record, orig_md, orig_html)
                if split_quote:
                    quote = {"text": q_text, "html": q_html}
                else:
                    reply_text = f"{reply_text}\n\n{q_text}" if reply_text.strip() else q_text
                    reply_html = f"{reply_html}{q_html}" if reply_html else q_html

        # 显式附件引用 → bytes 三元组, 追加在 forward 自动收集之后 (forward 显式时
        # 自动收集已跳过, attachments 为空)。cap 跨两来源共享。
        if request.attachments:
            attachments = attachments + self._resolve_attachment_refs(
                request.attachments,
                total_so_far=sum(len(a[1]) for a in attachments),
            )

        draft = _compose_reply_draft(
            record, internal_id=internal_id, mode=mode,
            reply_text=reply_text, reply_html=reply_html,
            extra_to=request.extra_to, extra_cc=request.extra_cc,
            to_override=request.to, cc_override=request.cc, bcc=request.bcc,
            subject_override=request.subject,
            force_subject=request.force_subject,
            forward_intro_text=forward_intro_text,
            forward_intro_html=forward_intro_html,
            attachments=attachments,
            self_email=self._ctx.config.user_email,
            importance=request.importance,
            source_linkage=source_linkage,
        )
        return draft, warnings, quote

    def _heal_draft_linkage(
        self, internal_id: int, draft_row: dict, *, persist: bool = True
    ) -> Optional[dict]:
        """存量草稿 linkage 懒自愈 (codex finding 1)。

        v36 迁移前入库的草稿行 draft_* 三列全 NULL, 且 reconcile_drafts 只处理新
        UID (稳态 STATUS 短路直接返回) 永不回填 → 这类草稿"编辑后发送"永久丢线程。
        修法: 消费时 (source_draft_id 恢复分支) 发现列空 → 按该行从 davmail 取草稿
        MIME (复用 backend.fetch_email_content_by_id 的 imap_uid 快路径), 解析
        In-Reply-To/References (RFC 2047 decode 口径与 reconcile 一致), 过
        _sanitize_draft_linkage 校验后**当场使用并回写** draft_* 三列 + thread_id。
        下次消费直接命中列, 不再取件。

        - ``persist=False`` (compose_plan dry-run, codex 批次2 finding 4): 取件 +
          解析 + 本次使用照旧, **跳过回写** — dry-run 不落库。
        - thread_id 以 healed 头为权威 (codex 批次2 finding 6): 从解码后的
          References/In-Reply-To 派生 root (_thread_id_from_headers 口径); 既有
          thread_id 与派生 root 一致才等价保留, 否则覆盖 — 存量行的 RFC2047 碎片等
          坏 root 不再被 COALESCE 保下来拼出 ``<坏id> <合法父>`` 链。

        仅 davmail backend 可用时走 (applescript fallback 无草稿同步 → 直接回退);
        取件失败 / 无 threading 头 / 校验不过 → None (回退现状零派生, 不报错)。
        """
        try:
            if not _is_draft_mailbox_row(draft_row):
                return None
            cfg = self._ctx.config
            if getattr(cfg, "mailagent_backend", "applescript") != "davmail":
                return None
            fetch = getattr(self._ctx.backend, "fetch_email_content_by_id", None)
            if not callable(fetch):
                return None
            # persist=False (compose_plan dry-run) → update_uid=False: 取件即便走
            # message_id fallback 命中也不回写 imap_uid 元数据 (codex 批次3 finding —
            # persist_heal=False 已不写 linkage, 但取件侧 _update_sync_store_uid 仍会
            # 侧写 SQLite, 违反 compose_plan「无写」契约字面)。persist=True 保持现状回填。
            content = fetch(internal_id, update_uid=persist) or {}
            source = content.get("source") or ""
            if not source:
                return None
            from email.parser import Parser

            from src.mail.backend.davmail_backend import (
                _decode_mime_header,
                _thread_id_from_headers,
            )

            msg = Parser().parsestr(source, headersonly=True)
            irt, refs = _sanitize_draft_linkage(
                _decode_mime_header(msg.get("In-Reply-To")).strip().strip("<>"),
                " ".join(_decode_mime_header(msg.get("References")).split()),
                own_message_id=draft_row.get("message_id"),
            )
            if not irt:
                return None
            src_iid: Optional[int] = None
            try:
                rec = self._ctx.sync_store.get_by_message_id(irt)
                if isinstance(rec, dict):
                    iid = rec.get("internal_id")
                    if isinstance(iid, int) and not isinstance(iid, bool):
                        src_iid = iid
            except Exception:  # noqa: BLE001 — 反查失败列留空, 不影响 threading 头
                pass
            healed = {
                "draft_in_reply_to": irt,
                "draft_references": refs,
                "draft_source_internal_id": src_iid,
                # healed 头为权威 (批次2 finding 6): root 从解码后的链派生, 与既有
                # thread_id 不一致 (坏 root / RFC2047 碎片) 就覆盖, 一致则值等价。
                "thread_id": _thread_id_from_headers(refs, irt),
            }
            if persist:
                try:
                    self._ctx.sync_store.update_draft_linkage(
                        internal_id,
                        draft_in_reply_to=irt,
                        draft_references=refs,
                        draft_source_internal_id=src_iid,
                        thread_id=healed["thread_id"],
                        overwrite_thread_id=True,
                    )
                except Exception as e:  # noqa: BLE001 — 回写失败不影响当场使用
                    logger.warning(
                        f"[compose] draft linkage self-heal write-back failed "
                        f"internal_id={internal_id}: {e}"
                    )
            logger.info(
                f"[compose] draft linkage self-healed internal_id={internal_id} "
                f"in_reply_to={irt[:60]!r}"
            )
            return healed
        except Exception as e:  # noqa: BLE001 — 自愈是 best-effort, 失败回退零派生
            logger.warning(
                f"[compose] draft linkage self-heal failed internal_id={internal_id}: {e}"
            )
            return None

    def compose_plan(self, request: "ComposeRequest") -> dict[str, Any]:
        """dry-run 预览 (无 auth/写)。形状 = ``email_draft`` 的 dry-run plan 分支。

        ``allow_missing_reply=True`` (前端预填无 reply_suggestion 也返回收件人) +
        ``split_quote=True`` (引用块单独给前端折叠展示, TipTap 只载建议) +
        ``persist_heal=False`` (codex 批次2 finding 4: linkage 懒自愈只取件解析
        本次使用不回写库 — CLI --dry-run / 灵动岛消费者不得意外写库)。
        """
        internal_id = request.internal_id
        mode = request.mode
        draft, warnings, quote = self._prepare_draft(
            request, allow_missing_reply=True, split_quote=True, persist_heal=False
        )
        quote_html = (quote or {}).get("html", "") or ""
        quote_text = (quote or {}).get("text", "") or ""
        return {
            "internal_id": internal_id,
            "mode": mode,
            "to": draft.to,
            "cc": draft.cc,
            "bcc": draft.bcc,
            "subject": draft.subject,
            "reply_source": "body-file" if request.body_text else "sqlite:llm_processing.labels_json",
            "reply_text": draft.reply_text,
            "reply_html": draft.reply_html,
            "quote_html": quote_html,
            "quote_text": quote_text,
            "forward_intro_text": draft.forward_intro_text or (quote_text if mode == "forward" else None),
            "forward_intro_html": draft.forward_intro_html or (quote_html if mode == "forward" else None),
            "reply_text_preview": (draft.reply_text or "")[:120],
            "reply_html_len": len(draft.reply_html or ""),
            "quote_html_len": len(quote_html),
            "in_reply_to": draft.in_reply_to,
            "attachments": len(draft.attachments),
            "forward_intro_preview": (draft.forward_intro_text or quote_text or "")[:120],
            "warnings": warnings,
            "dry_run": True,
        }

    def compose_draft(
        self, request: "ComposeRequest", *, actor: Actor
    ) -> ComposeDraftResult:
        """创建草稿 (backend.append_draft)。搬自 ``email_draft`` execute 行 1700-1779。

        compose **不做** pm2 检测 (原 CLI 无 → 无 ``allow_concurrent``)。顺序: 构造 draft →
        forward 收件人校验 → ``require_write_auth`` → append_draft (token 校验留 CLI 适配器,
        更早; 顺序差异同 A3 archive 决策, 测试不可见)。
        """
        draft, warnings, _quote = self._prepare_draft(
            request, allow_missing_reply=False, split_quote=False
        )
        if request.mode == "forward" and not draft.to:
            raise ServiceInvalidArgError(
                "forward 模式必须指定收件人 (--extra-to 或 --to)"
            )

        require_write_auth(actor)

        result = self._ctx.backend.append_draft(draft)
        if not result.success:
            raise ServiceError(f"草稿创建失败: {result.error}")

        self._mirror_draft_locally(draft, result)

        return ComposeDraftResult(
            internal_id=request.internal_id,
            drafts_folder=result.drafts_folder,
            appended_uid=result.appended_uid,
            method=result.method,
            mode=request.mode,
            to_count=len(draft.to),
            cc_count=len(draft.cc),
            attachments=len(draft.attachments),
            warnings=warnings,
        )

    def _mirror_draft_locally(self, draft, result) -> None:
        """草稿即时落库 — 保存成功立刻进 email_metadata (mailbox='草稿箱', pending)。

        不等 reconcile 的 STATUS 探测: davmail 对 Drafts folder 有缓存, 新 APPEND
        要 2-3 分钟才反映在 STATUS → 用户保存后草稿箱迟迟不出现。这里本地直写
        (与 SSoT inversion 哲学一致: 本地写入 intent 即本地可见), watcher 下个
        poll cycle (~5s) 按 imap_uid 快路径 fetch body → synced — 收件箱级速度。
        reconcile 兜底 Outlook/OWA 端的增删; message_id merge protection 防止
        davmail 缓存追上后 reconcile 把同一封再 to_add 成重复行。

        仅 davmail 路径 (appended_uid 非空) + DRAFTS_SYNC_ENABLED。任何失败仅
        warning — 草稿已成功 APPEND 到 Exchange, 本地镜像晚到由 reconcile 补。
        """
        try:
            if not result.appended_uid:
                return  # AppleScript 路径 / APPENDUID 缺失 → 交给 reconcile
            cfg = self._ctx.config
            if not bool(getattr(cfg, "drafts_sync_enabled", True)):
                return
            from datetime import datetime

            store = self._ctx.sync_store
            internal_id = store.allocate_davmail_internal_id()
            # 草稿线程 linkage (D1 Bug A): 有 threading 头 (reply/reply-all, 或
            # source_draft_id 恢复过 linkage 的 mode='new') 就持久化 — 发送时
            # _prepare_draft 按 source_draft_id 读回, 恢复 In-Reply-To/References。
            # thread_id 从 References 首元素派生 (= 原邮件 record.thread_id, 原邮件
            # 是线程根时 = 其 message_id) — 与 reconcile 的 _thread_id_from_headers
            # 口径一致, 对账自愈不漂移; forward/new 无 threading 头 → 维持 None。
            in_reply_to_mid = (draft.in_reply_to or "").strip().strip("<>") or None
            references_chain = " ".join((draft.references or "").split()) or None
            thread_id = None
            if references_chain:
                thread_id = references_chain.split()[0].strip("<>") or None
            elif in_reply_to_mid:
                thread_id = in_reply_to_mid
            payload = {
                "internal_id": internal_id,
                "message_id": result.message_id,
                "subject": draft.subject or "",
                "sender": getattr(cfg, "user_email", "") or "",
                "sender_name": "",
                "to_addr": ", ".join(draft.to),
                "cc_addr": ", ".join(draft.cc),
                "date_received": datetime.now().astimezone().isoformat(),
                "mailbox": "草稿箱",
                "is_read": True,
                "is_flagged": False,
                "thread_id": thread_id,
                "sync_status": "pending",
                "backend_origin": "davmail",
                "imap_uid": result.appended_uid,
            }
            if in_reply_to_mid:
                payload["draft_in_reply_to"] = in_reply_to_mid
                payload["draft_references"] = references_chain
                payload["draft_source_internal_id"] = draft.internal_id_for_threading
            if result.appended_uidvalidity is not None:
                payload["imap_uidvalidity"] = result.appended_uidvalidity
            store.save_email(payload)
            logger.info(
                f"[compose] draft mirrored locally internal_id={internal_id} "
                f"uid={result.appended_uid}"
            )
            # 正文立即落 email_body SSoT —— 正文是本地撰写的 (draft.reply_html, 前端
            # getSanitizedHtml 已含引用), 直接写本地, 草稿保存后秒开即可读。否则要等
            # watcher 下个 poll 按 imap_uid 从 davmail Drafts 回捞 body (davmail 对
            # Drafts folder 有 STATUS 缓存, 实测迟到 1-2 分钟 → 用户秒开看到空正文)。
            # 独立 try: 正文写失败不影响 metadata 镜像; watcher refetch 覆盖为规范版。
            try:
                html = draft.reply_html or ""
                if html:
                    from src.converter.html_to_markdown import html_to_markdown
                    from src.repository.email_repository import BodyPayload

                    try:
                        md = html_to_markdown(html) or (draft.reply_text or "")
                    except Exception:  # noqa: BLE001 — markdown 仅供 FTS, 失败退化纯文本
                        md = draft.reply_text or ""
                    self._ctx.email_repo.commit_email_with_body(
                        internal_id,
                        BodyPayload(
                            html=html,
                            markdown=md,
                            body_format="html",
                            fetched_source="compose",
                        ),
                        [],
                        message_id=result.message_id,
                    )
            except Exception as e:  # noqa: BLE001 — 正文镜像失败由 watcher refetch 兜底
                logger.warning(f"[compose] draft body mirror failed (watcher 兜底): {e}")
        except Exception as e:  # noqa: BLE001 — 镜像失败不影响草稿创建成功语义
            logger.warning(f"[compose] draft local mirror failed (reconcile 兜底): {e}")

    def delete_draft(self, internal_id: int, *, actor: Actor) -> DeleteDraftResult:
        """删除草稿 (本地行先删 + SSE 即时刷, IMAP \\Deleted+EXPUNGE 后置)。

        草稿箱列表行的删除按钮走这里 — 区别于收件箱"删除"按钮的归档语义
        (flag→done): 草稿是未发出的本地物, 真删除才符合预期 (用户验收)。
        davmail-only (FolderImapReader gate); 仅 mailbox=草稿箱 的行可删。

        dogfood round 3 顺序反转: IMAP 链每次重建连接+probe 实测 6-13s
        (davmail 慢窗口更久), 放在本地删之前会让 UI 等整条链才移除行。
        现在本地 delete_email_full + SSE 在前 (行 <1s 消失), IMAP 在后;
        IMAP 失败仅 warning — Exchange 残留由 reconcile 把行拉回 (自愈),
        用户重删即可。行不存在 → 幂等成功 (连点第二次不再重复 IMAP 链)。
        """
        meta = self._ctx.sync_store.get(internal_id)
        if not meta:
            # DELETE 幂等: 行已不在 (连点 / 已删) → 目标状态达成, 不走 IMAP。
            return DeleteDraftResult(
                internal_id=internal_id, imap_uid=0, local_deleted=False
            )
        if not is_drafts_mailbox(meta.get("mailbox")):
            raise ServiceInvalidArgError(
                f"邮件 {internal_id} 不是草稿 (mailbox={meta.get('mailbox')!r}); "
                "删除草稿仅适用于草稿箱"
            )
        imap_uid = meta.get("imap_uid")
        if not imap_uid:
            raise ServiceInvalidArgError(
                f"草稿 {internal_id} 缺 imap_uid (AppleScript 存量行?), 无法定位 Exchange 草稿"
            )

        require_write_auth(actor)

        # ── 本地先删 + SSE: UI 即时移除行 + badge 减一 (events_bridge 对
        # email.synced 宽 invalidate ['emails']+['mailboxes'])。 ──
        local_deleted = True
        try:
            self._ctx.email_repo.delete_email_full(internal_id)
        except Exception as e:  # noqa: BLE001 — 本地残留交 reconcile 清
            logger.warning(f"[delete-draft] local delete failed (reconcile 兜底): {e}")
            local_deleted = False
        try:
            from src.events.publisher import safe_publish

            safe_publish(
                "email.synced",
                internal_id=internal_id,
                data={"deleted": True, "mailbox": "草稿箱"},
                source="delete_draft",
            )
        except Exception:
            pass

        # ── IMAP 后置 (慢链): 失败不抛 — 本地已删, 抛错会让前端报失败但行已
        # 消失 (语义混乱); Exchange 残留由下次 reconcile to_add 拉回行重现。 ──
        reader = self._folder_imap_reader()
        if not reader.delete_message("drafts", int(imap_uid)):
            logger.warning(
                f"[delete-draft] IMAP delete failed uid={imap_uid} "
                "(本地已删; Exchange 残留由 reconcile 拉回, 重删即可)"
            )
        logger.info(f"[delete-draft] internal_id={internal_id} uid={imap_uid} done")
        return DeleteDraftResult(
            internal_id=internal_id, imap_uid=int(imap_uid), local_deleted=local_deleted
        )

    def send(
        self, request: "ComposeRequest", *, actor: Actor, confirmed: bool
    ) -> ComposeSendResult:
        """真实发送 (backend.send_email, 不可逆)。搬自 ``email_send`` 行 1840-1901。

        与 compose_draft 同源构造 (split_quote=False, 保 '草稿预览 = 实际发送内容')。顺序:
        构造 draft → forward 校验 → ``require_write_auth`` → 二次确认 (``confirmed=False`` →
        ``ServiceInvalidArgError``, 对齐 json 模式无 ``--yes``) → send_email。text 模式交互
        confirm 留 CLI 适配器 (service 不做交互)。
        """
        draft, warnings, _quote = self._prepare_draft(
            request, allow_missing_reply=False, split_quote=False
        )
        if request.mode == "forward" and not draft.to:
            raise ServiceInvalidArgError(
                "forward 模式必须指定收件人 (--extra-to 或 --to)"
            )

        require_write_auth(actor)

        if not confirmed:
            raise ServiceInvalidArgError(
                "发送需二次确认: 加 --yes 显式发送",
                hint="前端应在确认对话框后传 --yes",
            )

        result = self._ctx.backend.send_email(draft)
        if not result.success:
            raise ServiceError(f"邮件发送失败: {result.error}")

        # send 成功 → 清理消费掉的暂存附件目录 (发送失败时保留, 用户可原样重试)。
        # attachment_id / local_path 引用无暂存物, 不涉及。
        from src.services.compose_staging import discard_staged

        for ref in request.attachments or []:
            if isinstance(ref, dict) and ref.get("stage_id"):
                discard_staged(self._ctx.config, str(ref["stage_id"]))

        return ComposeSendResult(
            internal_id=request.internal_id,
            mode=request.mode,
            message_id=result.message_id,
            archived_to_sent=result.archived_to_sent,
            method=result.method,
            to_count=len(draft.to),
            cc_count=len(draft.cc),
            attachments=len(draft.attachments),
            warnings=warnings,
        )
