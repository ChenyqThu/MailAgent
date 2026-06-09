"""MailWriteService —— transport-neutral 邮件写操作 (A2-A4: flag/resync/archive/pin/compose)。

把「编排 + 守卫」从 CLI 命令体下沉到这里, 让 CLI (typer) 与 serve-api (FastAPI)
各自退化成「解析 → 调 service → 格式化」的薄壳, 不再 fork CLI 跨传输复用
(见 plan cli-streamed-brook.md §A2-A4 / docs/backend-service-migration-matrix.md)。

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
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

from loguru import logger

from src.services.errors import (
    ServiceError,
    ServiceInvalidArgError,
    ServiceNotFoundError,
)
from src.services.guards import Actor, check_pm2_conflict, require_write_auth
from src.sync.outbox import OutboxRepository

if TYPE_CHECKING:
    from src.services.context import ServiceDeps


# outbox source 标签: 历史上 CLI 直写 + serve-api fork CLI 都落 'cli'; 这里保留以维持
# parity (echo prevention 只特判 source='notion_webhook', 其余 source 仅审计用)。
# 前端写收编 (D1) 时再按传输区分 source。
_OUTBOX_SOURCE = "cli"

# 归档目标 mailbox (IMAP MOVE INBOX→Archive 后 SQLite/Notion 的 Mailbox 标签)。
_ARCHIVE_MAILBOX = "存档"

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


# forward 附件总大小上限 (编码前). base64 膨胀 ~33%, Exchange 常见上限 25-35MB.
_MAX_FORWARD_ATTACH_BYTES = 20 * 1024 * 1024


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


def _reply_md_to_html(reply_md: str) -> str:
    """markdown reply_suggestion → HTML。md_to_html 已抽到 src/converter (随
    site-packages 必然打进 .app)。"""
    from src.converter.markdown_to_html import md_to_html

    return md_to_html(reply_md)


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
    forward_intro_text: Optional[str] = None,
    forward_intro_html: Optional[str] = None,
    attachments: Optional[list] = None,
    self_email: Optional[str] = None,
):
    """从原邮件 metadata + reply 内容构造 DraftRequest.

    收件人语义:
    - ``to_override`` / ``cc_override`` 非 None → 权威完整列表 (前端 compose 用户编辑后的),
      不做推导也不叠加 extra.
    - 否则 reply/reply-all 推导原收件人 + ``extra_to``/``extra_cc`` 追加; forward 用
      ``extra_to`` 作收件人本体.
    ``bcc`` 总是直接 split. forward: Fwd: 前缀 + 独立邮件 (无 threading) + intro + 附件.

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
    intro_html = header_html + (body_html or f"<pre>{_html.escape(body_text or '')}</pre>")
    return intro_text, intro_html


def _build_reply_quote(
    record: dict, body_text: str, body_html: Optional[str]
) -> tuple[str, str]:
    """构造回复引用块 (plain + html): 像 Mail.app / Outlook 一样在回复正文下方附原邮件.

    与 forward 的 "Forwarded message" 头不同, reply 用 "在 <date>, <sender> 写道:" 头 +
    blockquote 包原文 (Outlook / Apple Mail 通用回复引用形态). 原邮件正文本身已含整条线程
    (Exchange 每次回复嵌套前文), 故引这一层即带上全部历史.
    """
    import html as _html

    sender = (record.get("sender") or "").strip()
    date = (record.get("date_received") or "").strip()

    intro_text = f"在 {date}，{sender} 写道：\n\n{body_text or ''}"
    header_html = (
        '<div style="color:#555;font-size:13px;margin-top:16px">'
        f"在 {_html.escape(date)}，{_html.escape(sender)} 写道：</div>"
    )
    quoted = body_html or f"<pre>{_html.escape(body_text or '')}</pre>"
    intro_html = (
        f"{header_html}"
        '<blockquote style="margin:8px 0 0;padding-left:12px;'
        'border-left:2px solid #ccc;color:#555">'
        f"{quoted}</blockquote>"
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

        updated: list[int] = []
        outbox_entries: list[dict[str, Any]] = []
        not_found: list[int] = []
        for iid in internal_ids:
            meta = repo.get_metadata(iid)
            if meta is None:
                not_found.append(iid)
                continue

            # 立即 update_local_flags 做 echo prevention; None 字段沿用当前 meta 值。
            new_read = bool(is_read) if is_read is not None else bool(meta.is_read)
            new_flagged = (
                bool(is_flagged) if is_flagged is not None else bool(meta.is_flagged)
            )
            sync_store.update_local_flags(
                iid, new_read, new_flagged, processing_status=processing_status
            )

            oid_mailapp = (
                outbox.enqueue(
                    internal_id=iid,
                    op_type="flag_sync",
                    target="mailapp",
                    payload=mailapp_payload,
                    source=_OUTBOX_SOURCE,
                )
                if mailapp_payload
                else None
            )
            oid_notion = outbox.enqueue(
                internal_id=iid,
                op_type="flag_sync",
                target="notion",
                payload=payload,
                source=_OUTBOX_SOURCE,
            )
            updated.append(iid)
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
        if not mailbox or mailbox in ("收件箱", "INBOX"):
            return "INBOX"
        if mailbox in ("发件箱", "已发送", "已发送邮件"):
            return getattr(self._ctx.backend, "sent_folder", None) or "Sent"
        if mailbox in ("草稿", "草稿箱", "Drafts"):
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
        return PinResult(
            internal_id=internal_id,
            is_pinned=pinned,
            changed=self._pin_changed(already, pinned),
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
            if total + len(data) > _MAX_FORWARD_ATTACH_BYTES:
                warnings.append(
                    f"附件总大小超 {_MAX_FORWARD_ATTACH_BYTES // (1024 * 1024)}MB, "
                    f"跳过 {a.filename!r} 及之后附件"
                )
                break
            total += len(data)
            out.append((a.filename, data, a.content_type or "application/octet-stream"))
        return out, warnings

    def _prepare_draft(
        self,
        request: "ComposeRequest",
        *,
        allow_missing_reply: bool,
        split_quote: bool,
    ) -> tuple[Any, list[str], Optional[dict]]:
        """构造 DraftRequest (compose_draft + send 共用)。搬自 CLI ``_prepare_draft`` 行 1508-1623。

        正文优先级: ``body_html`` (字符串) > ``body_text`` (markdown 字符串) > SQLite
        reply_suggestion_md。``split_quote=True`` (dry-run 预填): 引用块单独作第 3 个返回值
        ``quote`` 不并进正文; False (执行路径): 引用块并进 reply_html/forward_intro。
        meta 不存在 → ``ServiceNotFoundError``。
        """
        internal_id = request.internal_id
        mode = request.mode
        record = self._ctx.sync_store.get(internal_id)
        if not record:
            raise ServiceNotFoundError(
                f"Email metadata not found for internal_id={internal_id}"
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
            # 真实 draft/send 仍要求有正文来源, 避免误发空回复。
            if not reply_md and mode != "forward" and not allow_missing_reply:
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
        if mode == "forward":
            # 附件总是 server-side 重新收集 — 前端无法传字节, 必须按 internal_id 重读。
            attachments, warnings = self._collect_forward_attachments(internal_id)
            if not explicit_body:
                body_md = self._ctx.email_repo.get_body_markdown(internal_id) or ""
                body_html = self._ctx.email_repo.get_body_html(internal_id)
                fi_text, fi_html = _build_forward_intro(record, body_md, body_html)
                if split_quote:
                    quote = {"text": fi_text, "html": fi_html}
                else:
                    forward_intro_text, forward_intro_html = fi_text, fi_html
        elif not explicit_body:  # reply / reply-all
            orig_md = self._ctx.email_repo.get_body_markdown(internal_id) or ""
            orig_html = self._ctx.email_repo.get_body_html(internal_id)
            if orig_md or orig_html:
                q_text, q_html = _build_reply_quote(record, orig_md, orig_html)
                if split_quote:
                    quote = {"text": q_text, "html": q_html}
                else:
                    reply_text = f"{reply_text}\n\n{q_text}" if reply_text.strip() else q_text
                    reply_html = f"{reply_html}{q_html}" if reply_html else q_html

        draft = _compose_reply_draft(
            record, internal_id=internal_id, mode=mode,
            reply_text=reply_text, reply_html=reply_html,
            extra_to=request.extra_to, extra_cc=request.extra_cc,
            to_override=request.to, cc_override=request.cc, bcc=request.bcc,
            subject_override=request.subject,
            forward_intro_text=forward_intro_text,
            forward_intro_html=forward_intro_html,
            attachments=attachments,
            self_email=self._ctx.config.user_email,
        )
        return draft, warnings, quote

    def compose_plan(self, request: "ComposeRequest") -> dict[str, Any]:
        """dry-run 预览 (无 auth/写)。形状 = ``email_draft`` 的 dry-run plan 分支。

        ``allow_missing_reply=True`` (前端预填无 reply_suggestion 也返回收件人) +
        ``split_quote=True`` (引用块单独给前端折叠展示, TipTap 只载建议)。
        """
        internal_id = request.internal_id
        mode = request.mode
        draft, warnings, quote = self._prepare_draft(
            request, allow_missing_reply=True, split_quote=True
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
