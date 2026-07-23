"""search skill —— 全文搜邮件正文 + 附件抽取文本（FTS5）。

镜像 ``GET /api/email/search`` + ``GET /api/attachment/search`` 的检索原语
（``EmailRepository.search_email_bodies_with_meta`` / ``search_attachment_texts``）。
agent-facing 输出强调 ``total_matches`` + ``has_more``（自我收敛信号，Phase A G-A2）。
"""

from __future__ import annotations

from typing import Any

from src.skills.errors import SkillError
from src.skills.models import ToolDef, ToolHandler
from src.skills.registry import BoundSkill, BoundTool

_SEARCH_LIMIT_MAX = 200
_ATTACHMENT_SEARCH_LIMIT_MAX = 100


def _email_search(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    q = str(params.get("q") or "").strip()
    if not q:
        raise SkillError("E_INVALID_ARG", "q is required and must be non-empty")
    limit = int(params.get("limit") or 50)
    if limit < 1 or limit > _SEARCH_LIMIT_MAX:
        raise SkillError("E_INVALID_ARG", f"limit must be 1..{_SEARCH_LIMIT_MAX}")
    raw = bool(params.get("raw", False))
    mode = "raw" if raw else "smart"
    repo = ctx.repo()
    result = repo.search_email_bodies_with_meta(
        q,
        mode=mode,
        limit=limit,
        mailbox=params.get("mailbox"),
        since_date=params.get("since"),
        until_date=params.get("until"),
    )
    items = [
        {
            "internal_id": h.internal_id,
            "subject": h.subject,
            "sender": h.sender,
            "date_received": h.date_received,
            "mailbox": h.mailbox,
            "rank": h.rank,
            "snippet": h.snippet,
            "notion_url": h.notion_url,
            "source": h.source,
            "filename": h.filename,
        }
        for h in result.hits
    ]
    data: dict[str, Any] = {
        "items": items,
        "total_matches": len(items),
        "has_more": result.has_more,
        "mode": mode,
    }
    if not raw and result.transformed_query != q:
        data["transformed_query"] = result.transformed_query
    if result.parse_warnings:
        data["parse_warnings"] = result.parse_warnings
    return data


def _attachment_search(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    q = str(params.get("q") or "").strip()
    if not q:
        raise SkillError("E_INVALID_ARG", "q is required and must be non-empty")
    limit = int(params.get("limit") or 20)
    if limit < 1 or limit > _ATTACHMENT_SEARCH_LIMIT_MAX:
        raise SkillError("E_INVALID_ARG", f"limit must be 1..{_ATTACHMENT_SEARCH_LIMIT_MAX}")
    raw = bool(params.get("raw", False))
    repo = ctx.repo()
    # 路由内化（批次3 PR-E）：传原始 q + raw 标志，内核做 trigram 路由 / smart 变换。
    hits = repo.search_attachment_texts(
        q,
        raw=raw,
        limit=limit,
        mailbox=params.get("mailbox"),
        since_date=params.get("since"),
        until_date=params.get("until"),
    )
    items = [
        {
            "attachment_id": h.attachment_id,
            "internal_id": h.internal_id,
            "filename": h.filename,
            "content_type": h.content_type,
            "email_subject": h.email_subject,
            "email_sender": h.email_sender,
            "email_date": h.email_date,
            "email_mailbox": h.email_mailbox,
            "snippet": h.snippet,
            "rank": h.rank,
            "notion_url": h.notion_url,
        }
        for h in hits
    ]
    mode = "raw" if raw else "smart"
    data: dict[str, Any] = {
        "items": items,
        "total_matches": len(items),
        "mode": mode,
    }
    # 路由内化后 transform 全在内核 —— skill 不再回报 transformed_query（trigram 开时无单一
    # 变换串；只有端点按 D1 修订保留 flag-off 回报）。检索用原始 q（上面已直传）。
    return data


def build_skill() -> BoundSkill:
    common_q = {
        "q": {"type": "string", "description": "query (DSL v1 + CJK-aware smart rewrite)"},
        "mailbox": {"type": "string"},
        "since": {"type": "string", "description": "YYYY-MM-DD"},
        "until": {"type": "string", "description": "YYYY-MM-DD"},
        "limit": {"type": "integer"},
        "raw": {"type": "boolean", "description": "true = raw FTS5 syntax"},
    }
    tools = [
        BoundTool(
            ToolDef(
                name="email_search",
                description="Full-text search email bodies + subject + sender (FTS5 bm25).",
                input_schema={"type": "object", "properties": common_q, "required": ["q"]},
                output_schema={
                    "type": "object",
                    "description": "{items, total_indexed, total_matches, has_more, mode}",
                },
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=["email:read"],
                mcp_exposed=True,
                handler=ToolHandler(
                    kind="repository", target="EmailRepository.search_email_bodies_with_meta"
                ),
            ),
            _email_search,
        ),
        BoundTool(
            ToolDef(
                name="attachment_search",
                description="Full-text search extracted attachment text and filenames (PDF/docx/pptx/xlsx; CJK-aware substrings).",
                input_schema={"type": "object", "properties": common_q, "required": ["q"]},
                output_schema={"type": "object", "description": "{items, total_indexed, mode}"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=["attachment:read"],
                mcp_exposed=True,
                handler=ToolHandler(
                    kind="repository", target="EmailRepository.search_attachment_texts"
                ),
            ),
            _attachment_search,
        ),
    ]
    return BoundSkill(
        name="search",
        version="1.0.0",
        title="Search",
        description="Full-text search across email bodies and attachment text.",
        default_enabled=True,
        prompt_fragment=(
            "Use email_search to find emails by keyword or DSL query (from:/subject:/after:/"
            "has:attachment). Use attachment_search to find content inside attachments. Each "
            "result carries internal_id — pass it to email_get / email_body for full content. "
            "If has_more is true, narrow the query rather than paging blindly."
        ),
        docs_path="skills/search/SKILL.md",
        tools=tools,
    )
