"""Read-only research for pre-filling the Matter create dialog."""

from __future__ import annotations

import asyncio
import re
from email.utils import getaddresses
from html import unescape
from typing import Any, Awaitable, Callable, Mapping, Sequence

from src.config import notion_enabled
from src.notion.client import NotionClient
from src.repository.email_repository import EmailFull, EmailRepository

from .models import BUILTIN_MATTER_TYPES
from .run_spec import fence_matter_excerpt
from .service import MatterError, MatterService

CREATE_RESEARCH_RESOURCE_REASONS = {
    "source_email": "源邮件",
    "same_thread": "同一邮件线程",
    "full_text_match": "邮件全文检索命中",
    "notion_search_match": "Notion 搜索命中",
}
CREATE_RESEARCH_STAKEHOLDER_REASONS = {
    "sender": "邮件发件人",
    "recipient": "邮件收件人",
}
CREATE_RESEARCH_WARNINGS = {
    "notion_search_failed": "Notion 检索失败，已跳过",
}
CREATE_RESEARCH_LINK_SCOPES = ("thread", "single")

_SUBJECT_PREFIX_RE = re.compile(r"^\s*((re|fw|fwd|回复|转发)\s*[:：]\s*)+", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_TYPE_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("客户交付", ("交付", "上线", "实施", "delivery", "launch", "rollout")),
    ("商务", ("合同", "续约", "报价", "采购", "contract", "renewal", "quote")),
    ("售前", ("售前", "方案", "演示", "投标", "poc", "demo", "proposal")),
    ("问题", ("问题", "故障", "异常", "投诉", "incident", "issue", "bug")),
    ("产品", ("产品", "需求", "版本", "功能", "roadmap", "feature", "release")),
    ("内部", ("内部", "招聘", "绩效", "行政", "internal", "hiring", "review")),
)

NotionSearcher = Callable[[str, int], Awaitable[Sequence[Mapping[str, Any]]]]


class MatterCreateResearchService:
    """Build a deterministic draft without writing Matter aggregate tables."""

    def __init__(
        self,
        email_repository: EmailRepository,
        matter_service: MatterService,
        *,
        notion_searcher: NotionSearcher | None = None,
        notion_is_enabled: Callable[[], bool] | None = None,
    ) -> None:
        self.email_repository = email_repository
        self.matter_service = matter_service
        self.notion_searcher = notion_searcher or _search_notion_pages
        self.notion_is_enabled = notion_is_enabled or notion_enabled

    async def create_draft(self, data: Mapping[str, Any]) -> dict[str, Any]:
        internal_id = _positive_int(data.get("internal_id"), "internal_id")
        source = await asyncio.to_thread(
            self.email_repository.get_email_full, internal_id
        )
        if source is None:
            raise MatterError("E_UPSTREAM", f"email {internal_id} not found")

        requested_thread_id = _optional_text(data.get("thread_id"))
        source_thread_id = _optional_text(source.metadata.thread_id)
        if requested_thread_id and source_thread_id and requested_thread_id != source_thread_id:
            raise MatterError(
                "E_INVALID_ARG",
                "thread_id does not match the source email",
            )
        thread_id = requested_thread_id or source_thread_id
        link_scope = _optional_text(data.get("link_scope")) or (
            "thread" if thread_id else "single"
        )
        if link_scope not in CREATE_RESEARCH_LINK_SCOPES:
            raise MatterError(
                "E_INVALID_ARG",
                f"link_scope must be one of {CREATE_RESEARCH_LINK_SCOPES}",
            )

        emails = await asyncio.to_thread(
            self._collect_thread_emails, source, thread_id, link_scope
        )
        query = _research_query(source.metadata.subject)
        search_hits = await asyncio.to_thread(
            self._search_related_emails,
            query,
        )
        resources = self._email_resources(emails, search_hits)

        warnings: list[dict[str, str]] = []
        notion_status = "disabled"
        if self.notion_is_enabled():
            notion_status = "searched"
            try:
                notion_pages = await self.notion_searcher(query, 8)
            except Exception:
                notion_status = "failed"
                warnings.append(
                    {
                        "code": "notion_search_failed",
                        "message": CREATE_RESEARCH_WARNINGS["notion_search_failed"],
                    }
                )
            else:
                resources.extend(_notion_resources(notion_pages))

        stakeholders = _stakeholders(emails)
        suggested_title = _optional_text(data.get("title")) or _suggested_title(
            source.metadata.subject
        )
        requested_type = _optional_text(data.get("matter_type"))
        if requested_type is not None and requested_type not in BUILTIN_MATTER_TYPES:
            raise MatterError(
                "E_INVALID_ARG",
                f"matter_type must be one of {BUILTIN_MATTER_TYPES}",
            )
        suggested_type = requested_type or _suggested_type(
            " ".join(email.metadata.subject for email in emails)
        )
        suggested_description = _optional_text(data.get("description")) or _description(
            source, emails
        )

        duplicates = await asyncio.to_thread(
            self.matter_service.duplicate_candidates,
            {
                "title": suggested_title,
                "description": suggested_description,
                "stakeholders": [item["email"] for item in stakeholders],
                "resources": [
                    {
                        "provider": item["provider"],
                        "kind": item["kind"],
                        "external_key": item["external_key"],
                    }
                    for item in resources
                ],
            },
        )
        return {
            "source": {
                "internal_id": internal_id,
                "thread_id": thread_id,
                "link_scope": link_scope,
            },
            "draft": {
                "title": suggested_title,
                "matter_type": suggested_type,
                "description": suggested_description,
                "resources": resources,
                "stakeholders": stakeholders,
                "duplicate_candidates": duplicates,
            },
            "research": {
                "thread_email_count": len(emails),
                "related_email_count": sum(
                    item["reason"]["kind"] == "full_text_match" for item in resources
                ),
                "notion_status": notion_status,
                "warnings": warnings,
            },
        }

    def _collect_thread_emails(
        self,
        source: EmailFull,
        thread_id: str | None,
        link_scope: str,
    ) -> list[EmailFull]:
        emails = [source]
        if link_scope != "thread" or not thread_id:
            return emails
        for member in self.email_repository.get_thread_members(
            thread_id,
            exclude_internal_id=source.internal_id,
            synced_only=False,
        ):
            full = self.email_repository.get_email_full(member.internal_id)
            if full is not None:
                emails.append(full)
        return emails

    def _search_related_emails(self, query: str) -> list[Any]:
        hits: list[Any] = []
        seen_ids: set[int] = set()
        for candidate_query in (query, *_research_terms(query)):
            for hit in self.email_repository.search_email_bodies_smart(
                candidate_query, limit=12
            ):
                if hit.internal_id in seen_ids:
                    continue
                hits.append(hit)
                seen_ids.add(hit.internal_id)
                if len(hits) >= 12:
                    return hits
        return hits

    @staticmethod
    def _email_resources(emails: Sequence[EmailFull], search_hits: Sequence[Any]) -> list[dict[str, Any]]:
        resources: list[dict[str, Any]] = []
        seen_ids: set[int] = set()
        for index, email in enumerate(emails):
            reason_kind = "source_email" if index == 0 else "same_thread"
            resources.append(_email_resource(email, reason_kind))
            seen_ids.add(email.internal_id)
        for hit in search_hits:
            if hit.internal_id in seen_ids:
                continue
            resources.append(
                {
                    "provider": "mailagent",
                    "kind": "email",
                    "external_key": f"email:{hit.internal_id}",
                    "title": hit.subject,
                    "url": hit.notion_url,
                    "excerpt": fence_matter_excerpt(
                        resource_id=f"email:{hit.internal_id}",
                        provider="mailagent",
                        excerpt=_clean_excerpt(hit.snippet),
                    ),
                    "reason": _reason("full_text_match", [hit.sender, hit.date_received]),
                }
            )
            seen_ids.add(hit.internal_id)
        return resources


async def _search_notion_pages(query: str, limit: int) -> Sequence[Mapping[str, Any]]:
    client = NotionClient()
    try:
        response = await client.client.search(
            query=query,
            page_size=limit,
            filter={"property": "object", "value": "page"},
        )
        return response.get("results", [])
    finally:
        await client.close()


def _email_resource(email: EmailFull, reason_kind: str) -> dict[str, Any]:
    excerpt = _body_excerpt(email)
    return {
        "provider": "mailagent",
        "kind": "email",
        "external_key": f"email:{email.internal_id}",
        "title": email.metadata.subject,
        "url": email.metadata.notion_url,
        "excerpt": (
            fence_matter_excerpt(
                resource_id=f"email:{email.internal_id}",
                provider="mailagent",
                excerpt=excerpt,
            )
            if excerpt
            else None
        ),
        "reason": _reason(
            reason_kind,
            [email.metadata.sender, email.metadata.date_received],
        ),
    }


def _notion_resources(pages: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    resources: list[dict[str, Any]] = []
    for page in pages:
        page_id = _optional_text(page.get("id"))
        if not page_id:
            continue
        title = _notion_title(page) or "Untitled Notion page"
        resources.append(
            {
                "provider": "notion",
                "kind": "doc",
                "external_key": f"page:{page_id}",
                "title": title,
                "url": _optional_text(page.get("url")),
                "excerpt": None,
                "reason": _reason("notion_search_match", [title]),
            }
        )
    return resources


def _notion_title(page: Mapping[str, Any]) -> str | None:
    properties = page.get("properties")
    if not isinstance(properties, Mapping):
        return None
    for prop in properties.values():
        if not isinstance(prop, Mapping) or prop.get("type") != "title":
            continue
        parts = prop.get("title") or []
        title = "".join(
            str(part.get("plain_text") or "")
            for part in parts
            if isinstance(part, Mapping)
        ).strip()
        if title:
            return title
    return None


def _stakeholders(emails: Sequence[EmailFull]) -> list[dict[str, Any]]:
    stakeholders: dict[str, dict[str, Any]] = {}
    for email in emails:
        meta = email.metadata
        for name, address in getaddresses([meta.sender]):
            _add_stakeholder(stakeholders, address, name or meta.sender_name, "sender")
        for name, address in getaddresses([meta.to_addr, meta.cc_addr]):
            _add_stakeholder(stakeholders, address, name, "recipient")
    return list(stakeholders.values())


def _add_stakeholder(
    stakeholders: dict[str, dict[str, Any]],
    address: str,
    name: str | None,
    reason_kind: str,
) -> None:
    normalized = address.strip().lower()
    if not normalized or "@" not in normalized:
        return
    current = stakeholders.get(normalized)
    if current is None:
        stakeholders[normalized] = {
            "email": normalized,
            "display_name": _optional_text(name),
            "reason": _reason(reason_kind, [normalized]),
        }
    elif not current["display_name"] and _optional_text(name):
        current["display_name"] = _optional_text(name)


#: 「目的与背景」草稿里来信要点的长度上限。这是用户可见编辑框的预填，不是 prompt 注入面：
#: 400 字够交代来龙去脉，再长就是把邮件正文整段搬进目标字段。
_DESCRIPTION_EXCERPT_LIMIT = 400


def _description(source: EmailFull, emails: Sequence[EmailFull]) -> str:
    """「目的与背景」（详情页「核心目标」）的草稿：干净的业务文本。

    🔴 这段字符串会原样落进创建对话框的编辑框、再存进 ``matter.description`` —— 它是
    **用户可见的业务字段**，不是 prompt 注入面（0813 轮 3 O6）：
    ① 不放 ``UNTRUSTED_*`` 围栏字面量 —— 旧版把 ``fence_matter_excerpt`` 的产出直接拼进来，
       owner 在「核心目标」框里看见的是 ``UNTRUSTED_MATTER_EXCERPT_START id=…`` 这样的
       机器标记；围栏只属于 prompt 注入面（资源摘录仍照旧套围栏，见 ``_email_resource``）。
    ② 不堆机械元数据行（收件时间 / 同线程 N 封的模板行）—— 那是资料列表的职责，不是目标。
    这条链路没有 LLM，写不出真正的「目标」，所以草稿只给一段干净的背景 + 有界的来信要点，
    目标本身留给用户写（UI hint 也明说「你写的这段，Agent 不会改写」）。
    """
    title = _suggested_title(source.metadata.subject)
    context = f"背景：围绕邮件「{title}」"
    if len(emails) > 1:
        context += f"（同线程 {len(emails)} 封往来）"
    context += "推进此事。"
    lines = [context]
    excerpt = _body_excerpt(source)[:_DESCRIPTION_EXCERPT_LIMIT]
    if excerpt:
        lines.append(f"来信要点：{excerpt}")
    return "\n".join(lines)


def _body_excerpt(email: EmailFull) -> str:
    if email.body is None:
        return ""
    body = email.body.markdown or email.body.html or ""
    return _clean_excerpt(body)


def _clean_excerpt(value: Any, limit: int = 1200) -> str:
    text = _TAG_RE.sub(" ", unescape(str(value or "")))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def _research_query(subject: str) -> str:
    title = _suggested_title(subject)
    return title[:160]


def _research_terms(query: str) -> tuple[str, ...]:
    terms = re.findall(r"[\w\u3400-\u9fff]{3,}", query, flags=re.UNICODE)
    return tuple(dict.fromkeys(terms[:5]))


def _suggested_title(subject: str) -> str:
    title = _SUBJECT_PREFIX_RE.sub("", str(subject or "")).strip()
    return title or str(subject or "").strip() or "未命名事项"


def _suggested_type(text: str) -> str | None:
    lowered = text.lower()
    for matter_type, keywords in _TYPE_KEYWORDS:
        if any(keyword in lowered for keyword in keywords):
            return matter_type
    return None


def _reason(kind: str, evidence: Sequence[Any]) -> dict[str, Any]:
    return {
        "kind": kind,
        "label": CREATE_RESEARCH_RESOURCE_REASONS.get(
            kind, CREATE_RESEARCH_STAKEHOLDER_REASONS.get(kind, kind)
        ),
        "evidence": [str(value) for value in evidence if value],
    }


def _positive_int(value: Any, field: str) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise MatterError("E_INVALID_ARG", f"{field} must be a positive integer") from exc
    if result <= 0:
        raise MatterError("E_INVALID_ARG", f"{field} must be a positive integer")
    return result


def _optional_text(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None
