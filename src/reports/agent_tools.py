"""报告 agent 工具桥 —— 日报 agentic loop 的 Python 工具（schema + handler）。

LLM 在 `LLMClient.run_tool_loop` 里按需调这些工具下钻查正文/附件/Gbrain 背景；
handler 直接调后端 `EmailRepository` / `KOSClient`，返回**字符串**结果回灌。所有 handler
自处理错误（返 ``error: ...`` 不抛），loop 把错误回灌让模型自适应。

`build_report`（终止工具）**不在这里** —— 由 summarizer 把 `REPORT_TOOL_SCHEMA` 追加为
loop 的 final_tool（命中即收尾、不执行 handler）。这样 agent_tools 不依赖 summarizer，
避免循环 import。
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Tuple

from src.repository.email_repository import EmailRepository

ToolHandler = Callable[[Dict[str, Any]], str]

# 单封正文截断（与前端 email_body 工具的 12K 对齐）。
_BODY_MAX_CHARS = 12000

# ── 工具 schema（Anthropic input_schema 格式）──────────────────────────────────

SCHEMA_GET_EMAIL_BODY: Dict[str, Any] = {
    "name": "get_email_body",
    "description": "按 internal_id 取单封邮件正文（markdown，截断 ~12K 字）。摘要不够、要看细节时调。",
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["internal_id"],
        "properties": {
            "internal_id": {"type": "integer", "description": "邮件 internal_id（来自给定清单）"}
        },
    },
}

SCHEMA_SEARCH_EMAILS: Dict[str, Any] = {
    "name": "search_emails",
    "description": "全文搜索邮件正文/主题/发件人（CJK 友好）。要找清单外或跨线程的相关邮件时调。",
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["query"],
        "properties": {
            "query": {"type": "string", "description": "自然语言或关键词"},
            "limit": {"type": "integer", "description": "最多返回条数（默认 15，上限 30）"},
            "mailbox": {"type": "string", "description": "限定邮箱，如 收件箱 / 发件箱（可省）"},
        },
    },
}

SCHEMA_SEARCH_ATTACHMENTS: Dict[str, Any] = {
    "name": "search_attachments",
    "description": "全文搜索附件文本（PDF/docx/pptx/xlsx 已抽取）。要查附件里的事实/数字时调。",
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["query"],
        "properties": {
            "query": {"type": "string"},
            "limit": {"type": "integer", "description": "默认 10，上限 20"},
        },
    },
}

SCHEMA_KOS_QUERY: Dict[str, Any] = {
    "name": "kos_query",
    "description": "查 Gbrain 知识库（跨人/公司/项目/历史邮件的背景）。需要某实体/项目背景时调。",
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["query"],
        "properties": {
            "query": {"type": "string"},
            "limit": {"type": "integer", "description": "默认 8"},
        },
    },
}


# ── 结果格式化（→ 紧凑字符串回灌）──────────────────────────────────────────────

def _fmt_email_hits(hits: List[Any]) -> str:
    if not hits:
        return "(无匹配邮件)"
    lines: List[str] = []
    for h in hits:
        snip = (getattr(h, "snippet", "") or "").replace("\n", " ")
        lines.append(
            f"id={h.internal_id} | {h.subject or '(无主题)'} | {h.sender or '?'}"
            f" | {h.date_received or ''} | {snip}"
        )
    return "\n".join(lines)


def _fmt_attach_hits(hits: List[Any]) -> str:
    if not hits:
        return "(无匹配附件)"
    lines: List[str] = []
    for h in hits:
        snip = (getattr(h, "snippet", "") or "").replace("\n", " ")
        lines.append(
            f"邮件 id={h.internal_id} | 附件 {h.filename} | {h.email_subject or ''} | {snip}"
        )
    return "\n".join(lines)


def _fmt_kos_hits(hits: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for h in hits[:12]:
        if not isinstance(h, dict):
            continue
        title = h.get("title") or h.get("slug") or "?"
        text = (h.get("chunk_text") or h.get("snippet") or "").replace("\n", " ")[:300]
        lines.append(f"[{h.get('type', '?')}] {title} (slug={h.get('slug', '')}) — {text}")
    return "\n".join(lines) or "(知识库无匹配)"


# ── 构造工具集 ─────────────────────────────────────────────────────────────────

def build_report_tools(
    db_path: str, *, kos_enabled: bool
) -> Tuple[List[Dict[str, Any]], Dict[str, ToolHandler]]:
    """日报 agentic loop 的**辅助**工具集（不含 build_report 终止工具，由 summarizer 追加）。

    返回 ``(tools_schema_list, handlers)``。handlers 闭包复用一个 EmailRepository（每次
    工具调用自开/关 sqlite 连接，轻量）。``kos_enabled=False`` 时不挂 kos_query。
    """
    repo = EmailRepository(db_path)

    def _coerce_int(v: Any) -> Any:
        if isinstance(v, int):
            return v
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    def _get_email_body(inp: Dict[str, Any]) -> str:
        iid = _coerce_int(inp.get("internal_id"))
        if iid is None:
            return "error: internal_id 必须是整数"
        md = repo.get_body_markdown(iid, max_chars=_BODY_MAX_CHARS)
        return md if md else f"(邮件 {iid} 无正文记录)"

    def _search_emails(inp: Dict[str, Any]) -> str:
        q = (inp.get("query") or "").strip()
        if not q:
            return "error: query 不能为空"
        limit = _coerce_int(inp.get("limit")) or 15
        hits = repo.search_email_bodies_smart(
            q, limit=min(limit, 30), mailbox=(inp.get("mailbox") or None)
        )
        return _fmt_email_hits(hits)

    def _search_attachments(inp: Dict[str, Any]) -> str:
        q = (inp.get("query") or "").strip()
        if not q:
            return "error: query 不能为空"
        limit = _coerce_int(inp.get("limit")) or 10
        hits = repo.search_attachment_texts_smart(q, limit=min(limit, 20))
        return _fmt_attach_hits(hits)

    def _kos_query(inp: Dict[str, Any]) -> str:
        q = (inp.get("query") or "").strip()
        if not q:
            return "error: query 不能为空"
        try:
            from src.kos.client import KOSClient

            client = KOSClient()
            if not client.configured:
                return "error: KOS（Gbrain）未配置"
            hits = client.query(q, limit=(_coerce_int(inp.get("limit")) or 8))
            return _fmt_kos_hits(hits if isinstance(hits, list) else [])
        except Exception as e:  # noqa: BLE001 — KOS 不可达不阻断 loop
            return f"error: KOS 查询失败: {e!r}"

    tools: List[Dict[str, Any]] = [
        SCHEMA_GET_EMAIL_BODY,
        SCHEMA_SEARCH_EMAILS,
        SCHEMA_SEARCH_ATTACHMENTS,
    ]
    handlers: Dict[str, ToolHandler] = {
        "get_email_body": _get_email_body,
        "search_emails": _search_emails,
        "search_attachments": _search_attachments,
    }
    if kos_enabled:
        tools.append(SCHEMA_KOS_QUERY)
        handlers["kos_query"] = _kos_query
    return tools, handlers


def kos_is_available() -> bool:
    """后端判 Gbrain（KOS）是否可用：3 个 OAuth env 凭据齐全（不打 health，避免每次报告走网络）。"""
    try:
        from src.kos.client import KOSClient

        return KOSClient().configured
    except Exception:  # noqa: BLE001
        return False
