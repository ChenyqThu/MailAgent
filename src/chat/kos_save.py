"""chat 一键保存对话到 KOS —— serve-api `POST /api/chat/save-to-kos`（V2.1 3b-4）。

Python 复刻 frontend ``chat/kos_save.ts`` 全语义（B-pure-unified：远程 browser 跑 chat
harness 时经 serve-api 保存对话到 KOS，不依赖 main-only 的 better-sqlite3 / keytar / fetch）。
**纯函数 frontmatter / slug / title 与 TS 逐字节对齐**（KOS dream-cycle backlinks 据
``source_refs: sources/email/<id>`` 解析 chat→email 图边，Lucien 硬约束）。

算法（镜像 saveConversationToKos.ts）：
  1. ChatDb.get_message(message_id) → assistant；校验 role=assistant + content 非空。
  2. ChatDb.get_session(session_id) → session（email_id + backend_model）。
  3. ChatDb.list_messages(session_id) 向前找最近 user message 配对。
  4. slug = input.slug 或 build_conversation_slug；title = input.title 或 build_auto_title。
  5. summarize（LLM 一次性非流式）→ 结构化中文总结 body；失败非致命 → fallback raw transcript。
  6. build_conversation_page_content（frontmatter + body）→ KOSClient.put_page。
  7. 返回 {slug, status, contentBytes}。

summarizer 可注入（测试 mock LLM 走 success / fallback 两路径，不烧 token / 不打网）。
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from typing import Any, Callable, Dict, Optional

import httpx
from loguru import logger

from src.chat.db import ChatDb
from src.kos.client import KOSClient, KOSError

SLUG_PREFIX = "chat-history/mailagent"

# 一次性 summarize 调用 deadline（generous，用户在 toast 上等；失败 fallback raw transcript）。
_SUMMARIZE_TIMEOUT = httpx.Timeout(connect=10.0, read=45.0, write=10.0, pool=10.0)
_SUMMARIZE_MAX_TOKENS = 64000
_CRS_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "Chrome/146.0.0.0 Safari/537.36"
)

# 与 kos_save.ts SUMMARIZE_SYSTEM_PROMPT 逐字一致（中文归档助手 prompt）。
_SUMMARIZE_SYSTEM_PROMPT = "\n".join(
    [
        "你是 MailAgent 的对话归档助手。用户刚和 AI 助手就一封邮件进行了一轮问答,",
        "现在要把这轮对话提炼成结构化的中文总结, 存入知识库 (KOS) 供日后跨会话检索。",
        "",
        "硬性要求:",
        "- 输出简体中文。",
        "- 禁止复述邮件正文 —— 邮件原文已单独存在知识库里, 只需引用, 不要重复内容。",
        "- 聚焦【这轮对话本身】的提炼: 用户真正想解决什么、得到了什么结论、牵涉哪些实体与待办。",
        "- 跳过寒暄与 \"好的/明白了\" 这类无信息量的内容。",
        "- 只输出 markdown 正文, 不要输出 YAML frontmatter, 不要用代码块包裹整段输出。",
        "",
        "严格按以下结构输出 (三段, 标题用中文原文):",
        "# {一句话主题作为标题}",
        "## 关键结论 / 决策",
        "- (逐条列出对话得出的结论或决策; 没有就写 \"- (本轮无明确结论)\")",
        "## 涉及实体 / 待办",
        "- (逐条显式列出涉及的人名 / 项目 / 产品 / 公司 / 具体动作, 供知识库实体识别使用;",
        "  没有就写 \"- (无)\")",
    ]
)


# ── 输入 / 输出 ──────────────────────────────────────────────────────


class SaveConversationError(Exception):
    """save-to-kos 校验 / KOS 错误（携带 stable code 供端点转 envelope）。"""

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


# summarizer signature：测试注入 mock；None → 真 summarize_conversation。
Summarizer = Callable[..., str]


# ── 纯函数 helpers（frontmatter / slug / title 与 TS 字节对齐）─────────


def build_conversation_slug(
    *, email_id: int, session_id: int, message_id: int, prefix: str = SLUG_PREFIX
) -> str:
    """default slug = ``chat-history/mailagent/<email>/<session>/<message>``（Lucien namespace）。

    全段非负整数，无需 escape/lowercase 归一化。镜像 chat_db.ts buildConversationSlug。
    """
    return f"{prefix}/{email_id}/{session_id}/{message_id}"


def build_auto_title(user_content: str) -> str:
    """首个 user message 的首句 / 首行，cap 50 字符。镜像 buildAutoTitle。"""
    first_line = (user_content.split("\n", 1)[0] or "").strip()
    # TS: split(/[.。!?!?]/)[0] —— char class = `.` 全角`。` ASCII`!?`（ASCII 重复）；
    # **无全角 `！？`**（hexdump 确认，codex review MEDIUM）。逐字对齐：只切 `.。!?`。
    first_sentence = (re.split(r"[.。!?]", first_line, 1)[0] or "").strip()
    sliced = first_sentence[:50]
    return sliced if sliced else "Conversation excerpt"


def build_conversation_page_content(
    *,
    user_content: str,
    assistant_content: str,
    email_id: int,
    session_id: int,
    message_id: int,
    title: str,
    saved_at_iso: str,
    backend_model: Optional[str],
    summary_body: Optional[str] = None,
    email_subject: Optional[str] = None,
) -> str:
    """frontmatter + body markdown（送 KOS put_page）。**与 kos_save.ts 逐字节对齐**。

    YAML frontmatter top-level key 字母序（diff 稳定）；mailagent.* 嵌套（Lucien 2026-05-23
    spec）；source_refs 指向 bulk-ingest 的 ``sources/email/<internal_id>``（email_id==internal_id，
    KOS backlinks 解析 chat→email 图边）。summary_body 非空 → 结构化总结 body；否则 raw transcript。
    """
    # title JSON.stringify 等价：json.dumps(ensure_ascii=False) —— 非 ASCII 不转义，与 TS 一致。
    fm = "\n".join(
        [
            "---",
            "mailagent:",
            f"  email_id: {email_id}",
            f"  message_id: {message_id}",
            f"  session_id: {session_id}",
            f"model: {backend_model if backend_model is not None else 'unknown'}",
            f"saved_at: {saved_at_iso}",
            "source: mailagent-chat",
            "source_refs:",
            f"  - 'sources/email/{email_id}'",
            "tags: [chat-history, mailagent, conversation]",
            f"title: {json.dumps(title, ensure_ascii=False)}",
            "type: conversation",
            "---",
        ]
    )

    summary = (summary_body or "").strip()
    if summary:
        # 结构化总结 body：LLM 已产出 H1 + 分段 markdown；在 H1 后插 reference line（指向邮件
        # 页，不复述正文）。无 raw transcript（原始 turn 留 chat_db SQLite，brain 只需 distilled）。
        ref_subject = (email_subject or "").strip()
        if ref_subject:
            ref_line = (
                f"> 关于邮件《{ref_subject}》的讨论 · 关联 sources/email/{email_id}"
            )
        else:
            ref_line = f"> 关于邮件的讨论 · 关联 sources/email/{email_id}"
        lines = summary.split("\n")
        if lines and lines[0].startswith("# "):
            rest = re.sub(r"^\n+", "", "\n".join(lines[1:]))
            return f"{fm}\n\n{lines[0]}\n{ref_line}\n\n{rest}"
        return f"{fm}\n\n{ref_line}\n\n{summary}"

    # Fallback body — raw User/Assistant transcript（LLM unavailable）。2026-05-25 polish
    # 起去掉 # {title} H1（frontmatter title 已携带）。
    sections = [""]
    if user_content.strip():
        sections.extend(["## User", "", user_content.strip(), ""])
    sections.extend(["## Assistant", "", assistant_content.strip(), ""])
    return fm + "\n".join(sections)


def _build_summarize_user_prompt(
    *, user_content: str, assistant_content: str, email_subject: Optional[str]
) -> str:
    """镜像 buildSummarizeUserPrompt。"""
    parts = []
    if email_subject:
        parts.append(f"这轮对话讨论的邮件主题是:《{email_subject}》")
    else:
        parts.append("这轮对话讨论的是用户当前打开的一封邮件 (主题未知)。")
    parts.append("")
    parts.append("用户提问:")
    parts.append(user_content.strip() if user_content.strip() else "(无)")
    parts.append("")
    parts.append("AI 助手回答:")
    parts.append(assistant_content.strip())
    return "\n".join(parts)


def _extract_summary_text(parsed: Any) -> str:
    """从非流式响应抽 assistant 文本（anthropic content[] / openai choices[].message.content）。

    镜像 extractSummaryText：两 shape 都取不到 → ""（caller 视空为失败 → fallback）。
    """
    if not isinstance(parsed, dict):
        return ""
    # Anthropic shape.
    content = parsed.get("content")
    if isinstance(content, list):
        text = "".join(
            b.get("text", "")
            for b in content
            if isinstance(b, dict)
            and b.get("type") == "text"
            and isinstance(b.get("text"), str)
        )
        if text.strip():
            return text.strip()
    # OpenAI shape.
    choices = parsed.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        msg = first.get("message") if isinstance(first, dict) else None
        if isinstance(msg, dict):
            c = msg.get("content")
            if isinstance(c, str) and c.strip():
                return c.strip()
    return ""


def summarize_conversation(
    *,
    user_content: str,
    assistant_content: str,
    email_subject: Optional[str],
    email_id: int,
    llm_api_key: str,
    llm_api_base: str,
    llm_model: str,
) -> str:
    """一次性 summarize LLM 调用（非流式）。镜像 summarizeConversation：claude-* 走
    ``/v1/messages``，其余（openai protocol）走 ``/v1/chat/completions``。任何失败 throw（caller
    fallback raw transcript）。 """
    if not llm_api_key:
        raise SaveConversationError("LLM API key not configured", "E_NO_LLM_KEY")
    base_url = llm_api_base.rstrip("/")
    user_prompt = _build_summarize_user_prompt(
        user_content=user_content,
        assistant_content=assistant_content,
        email_subject=email_subject,
    )
    is_anthropic = llm_model.startswith("claude-") or llm_model.startswith("claude:")
    if is_anthropic:
        url = f"{base_url}/v1/messages"
        headers = {
            "content-type": "application/json",
            "x-api-key": llm_api_key,
            "anthropic-version": "2023-06-01",
            "user-agent": _CRS_USER_AGENT,
        }
        body: Dict[str, Any] = {
            "model": llm_model,
            "max_tokens": _SUMMARIZE_MAX_TOKENS,
            "system": _SUMMARIZE_SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_prompt}],
            "stream": False,
        }
    else:
        url = f"{base_url}/v1/chat/completions"
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {llm_api_key}",
        }
        body = {
            "model": llm_model,
            "max_tokens": _SUMMARIZE_MAX_TOKENS,
            "messages": [
                {"role": "system", "content": _SUMMARIZE_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "stream": False,
        }

    with httpx.Client(timeout=_SUMMARIZE_TIMEOUT) as client:
        resp = client.post(url, json=body, headers=headers)
    if resp.status_code != 200:
        code = "E_QUOTA" if resp.status_code == 429 else "E_UPSTREAM"
        raise SaveConversationError(
            f"summarize LLM HTTP {resp.status_code}", code
        )
    text = _extract_summary_text(resp.json())
    if not text:
        raise SaveConversationError("summarize LLM returned empty content", "E_UPSTREAM")
    return text


def get_email_subject(email_id: int, sync_db_path: str) -> Optional[str]:
    """读 sync_store.db email_metadata.subject（summarize prompt 锚点）。镜像 getEmailSubject：
    miss / 不可达 → None（summary 仍可跑，只少 subject 锚点）。 """
    if not os.path.exists(sync_db_path):
        return None
    try:
        conn = sqlite3.connect(sync_db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT subject FROM email_metadata WHERE internal_id = ?", (email_id,)
            ).fetchone()
            return row["subject"] if row is not None else None
        finally:
            conn.close()
    except sqlite3.Error:
        return None


# ── 主入口 ───────────────────────────────────────────────────────────


def save_conversation_to_kos(
    *,
    chat_db: ChatDb,
    kos_client: KOSClient,
    message_id: int,
    slug: Optional[str],
    title: Optional[str],
    sync_db_path: str,
    saved_at_iso: str,
    llm_api_key: str,
    llm_api_base: str,
    llm_model: str,
    summarizer: Optional[Summarizer] = None,
) -> Dict[str, Any]:
    """保存 (user → assistant) 一对 message 到 KOS 单页。镜像 saveConversationToKos.ts。

    raise SaveConversationError（携带 code）于校验 / KOS 错误（端点 wrap envelope）。
    summarizer 注入用于测试（mock LLM）；None → 真 summarize_conversation（失败 fallback transcript）。
    """
    if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id < 0:
        raise SaveConversationError(
            f"save-to-kos: invalid messageId {message_id}", "E_INVALID_ARG"
        )

    assistant_msg = chat_db.get_message(message_id)
    if assistant_msg is None:
        raise SaveConversationError(f"message {message_id} not found", "E_NOT_FOUND")
    if assistant_msg.get("role") != "assistant":
        raise SaveConversationError(
            f"save-to-kos: messageId {message_id} is role={assistant_msg.get('role')}, "
            "not 'assistant'",
            "E_INVALID_ARG",
        )
    assistant_content = assistant_msg.get("content") or ""
    if not assistant_content.strip():
        raise SaveConversationError(
            f"save-to-kos: assistant message {message_id} content is empty", "E_INVALID_ARG"
        )

    session = chat_db.get_session(assistant_msg["session_id"])
    if session is None:
        raise SaveConversationError(
            f"save-to-kos: session {assistant_msg['session_id']} not found", "E_NOT_FOUND"
        )

    # 向前找最近 user message（id < assistant.id, role=user, content 非空）。镜像 TS 倒序 walk。
    all_messages = chat_db.list_messages(session["id"])
    user_content = ""
    for m in reversed(all_messages):
        if m["id"] >= assistant_msg["id"]:
            continue
        if m.get("role") == "user" and (m.get("content") or "").strip():
            user_content = m["content"]
            break

    final_slug = slug or build_conversation_slug(
        email_id=session["email_id"],
        session_id=session["id"],
        message_id=assistant_msg["id"],
    )
    final_title = title or build_auto_title(user_content)

    email_subject = get_email_subject(session["email_id"], sync_db_path)

    # summarize（失败非致命 → fallback raw transcript，Lucien ④）。
    summary_body: Optional[str] = None
    try:
        if summarizer is not None:
            summary_body = summarizer(
                user_content=user_content,
                assistant_content=assistant_content,
                email_subject=email_subject,
                email_id=session["email_id"],
            )
        else:
            summary_body = summarize_conversation(
                user_content=user_content,
                assistant_content=assistant_content,
                email_subject=email_subject,
                email_id=session["email_id"],
                llm_api_key=llm_api_key,
                llm_api_base=llm_api_base,
                llm_model=llm_model,
            )
    except Exception as e:  # noqa: BLE001 — summarize 失败一律降级，不阻断保存
        logger.warning(
            f"[kos_save] summarize failed for message {assistant_msg['id']} ({e}); "
            "falling back to raw transcript body"
        )
        summary_body = None

    content = build_conversation_page_content(
        user_content=user_content,
        assistant_content=assistant_content,
        email_id=session["email_id"],
        session_id=session["id"],
        message_id=assistant_msg["id"],
        title=final_title,
        saved_at_iso=saved_at_iso,
        backend_model=(
            assistant_msg.get("model")
            if assistant_msg.get("model") is not None
            else session.get("backend_model")
        ),
        summary_body=summary_body,
        email_subject=email_subject,
    )
    content_bytes = len(content.encode("utf-8"))

    try:
        result = kos_client.put_page(final_slug, content)
    except KOSError as e:
        raise SaveConversationError(str(e), e.code) from e

    # contentBytes（camelCase）对齐 shared SaveConversationResult 契约（platform.ts），
    # HttpChatPlatform.saveToKos 3b-5 fetch 本端点即满足同契约（codex review MEDIUM）。
    return {
        "slug": result.get("slug") or final_slug,
        "status": result.get("status") if isinstance(result.get("status"), str) else "unknown",
        "contentBytes": content_bytes,
    }
