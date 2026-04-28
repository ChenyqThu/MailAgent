"""Notion 项目进度库 Upsert.

依赖 ntn_ token 下的 Notion Markdown API（参见 docs/notion_markdown_api.md）:
  - GET  /v1/pages/{id}/markdown                    读取页面正文
  - PATCH /v1/pages/{id}/markdown                   type=replace_content 写入

整体流程（每个 ENBU 项目）:
  1. query_by_external_id(slug) → 现有页面 id 或 None
  2a. 无 → create_page(properties with full-history markdown in children)
  2b. 有 → update_page(properties) + prepend_this_week_markdown(page_id, week_tag, blocks)
         prepend = GET markdown → client 侧把本周块拼到最前 → PATCH replace_content

只更新 CSV 直接驱动的字段，不覆盖:
    产品线 multi_select / 出现在会议 relation（这两个留给 Lucien 手动挂）

Notion 版本常量:
    API_VERSION = "2025-09-03"  —— ntn_ token 要求
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

import aiohttp
from loguru import logger

from src.config import config

from .progress_parser import (
    ProgressBlock,
    format_block_markdown,
    iso_week_of,
)
from .xlsx_parser import ProjectRow, SheetKind, render_project_full_markdown


API_BASE = "https://api.notion.com/v1"
API_VERSION = "2025-09-03"


# Notion property 名称（中文；与 Guide 第 3.1 节一致）
PROP_TITLE = "项目名称"
PROP_EXTERNAL_ID = "external_id"
PROP_WEEK_TAG = "本周数据期"
PROP_PRIORITY = "优先级"
PROP_PRODUCT_LINE = "产品线"
PROP_PRODUCT_MODELS = "Product Models"
PROP_BU = "BU"
PROP_RND_DIV = "研发分部"
PROP_PM = "PM"
PROP_ASSIST_PM = "协助 PM"
PROP_CONTACT = "接口人"
PROP_REF_DDL = "参考 DDL"
PROP_SHIPPED_US = "美国发货"
PROP_RISK = "风险项"
PROP_SOURCE_EMAIL_URL = "Evelyn 原邮件"  # Notion 历史 property 名, 不能改 (改名会丢历史项目页该字段值)
PROP_STATUS = "Status"
PROP_PARENT_TASK = "母任务"  # Notion self-relation, dual_property → 子任务
PROP_PROJECT_START = "项目开始时间"  # date，取 progress_blocks 最老块日期

# zwf 邮件迁移新增字段（Step 3 schema bootstrap 自动建; 缺失时 _safe_set 静默跳过）
PROP_ESTABLISHMENT_DATE = "立项时间"           # date  ← Product Establishment Date
PROP_DESIRED_SHIP_DATE = "期望交期"             # date  ← Desired shipping Date
PROP_ESTIMATED_SHIP_DATE = "预计出货"           # date  ← Estimated Shipping Date
PROP_ACTUAL_SHIP_DATE = "实际出货"              # date  ← Actual Shipped Date (Sheet 2 only)
PROP_SUSPENSION_DATE = "暂停时间"               # date  ← Suspension Date (Sheet 3 only)
PROP_REASONS_FOR_DELAY = "进度异常"             # rich_text ← Reasons for the Delay
PROP_CURRENT_STATUS = "当前状态"                # select ← Current Status (Sheet 2/3 only)

# Notion DB schema 中存在的 property 名集合的缓存 (由 ProjectProgressNotionClient
# 启动时通过 schema bootstrap 填充). 缺失字段会被 _safe_set 静默跳过, 防止
# validation_error.
KNOWN_DB_PROPS: set = set()

# Status 选项（Notion status 类型，三个分组 To-do/In progress/Complete）
STATUS_IN_PROGRESS = "In progress"
STATUS_DONE = "Done"
STATUS_NOT_STARTED = "Not started"
STATUS_SUSPENDED = "Suspended"  # zwf Sheet 3 → 用户在 Notion 后台手动加该 status option


class NotionMarkdownError(RuntimeError):
    pass


@dataclass
class UpsertOutcome:
    external_id: str
    page_id: Optional[str]
    action: str  # "created" / "updated" / "skipped_idempotent" / "failed"
    error: Optional[str] = None


class ProjectProgressNotionClient:
    """项目进度库专用 Notion 客户端。"""

    MAX_RETRIES = 5
    BASE_RETRY_DELAY = 1.0

    def __init__(self, database_id: str, token: Optional[str] = None):
        self.database_id = database_id
        self.token = token or config.notion_token
        self._ds_id: Optional[str] = None
        self._session: Optional[aiohttp.ClientSession] = None
        # per-external_id 互斥锁：保证"query + create"在同一 ext_id 上严格串行，
        # 避免两个 worker 同时 query 都返回空 → 都 create → 同 ext_id 出现两页的 race
        self._ext_id_locks: Dict[str, asyncio.Lock] = {}
        self._ext_id_locks_guard = asyncio.Lock()

    async def external_id_lock(self, external_id: str) -> asyncio.Lock:
        async with self._ext_id_locks_guard:
            lk = self._ext_id_locks.get(external_id)
            if lk is None:
                lk = asyncio.Lock()
                self._ext_id_locks[external_id] = lk
            return lk

    # ---------- session ----------

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    async def __aenter__(self):
        await self._get_session()
        return self

    async def __aexit__(self, *exc):
        await self.close()

    # ---------- data_source_id ----------

    def _headers(self, *, json_content: bool = True) -> Dict[str, str]:
        h = {
            "Authorization": f"Bearer {self.token}",
            "Notion-Version": API_VERSION,
        }
        if json_content:
            h["Content-Type"] = "application/json"
        return h

    async def _request(
        self,
        method: str,
        url: str,
        *,
        json_body: Optional[Dict[str, Any]] = None,
        expect_json: bool = True,
    ) -> Any:
        session = await self._get_session()
        last_exc: Optional[Exception] = None
        for attempt in range(self.MAX_RETRIES):
            try:
                async with session.request(
                    method,
                    url,
                    headers=self._headers(),
                    json=json_body,
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as resp:
                    if resp.status == 429:
                        ra = resp.headers.get("Retry-After")
                        delay = float(ra) if ra else self.BASE_RETRY_DELAY * (2**attempt)
                        logger.warning(
                            f"[notion-md] 429 rate-limit, retry in {delay:.1f}s "
                            f"(attempt {attempt+1}/{self.MAX_RETRIES})"
                        )
                        await asyncio.sleep(delay)
                        continue
                    if resp.status >= 500:
                        delay = self.BASE_RETRY_DELAY * (2**attempt)
                        logger.warning(
                            f"[notion-md] {resp.status} server error, retry in {delay:.1f}s"
                        )
                        await asyncio.sleep(delay)
                        continue
                    if resp.status not in (200, 201, 204):
                        body = await resp.text()
                        raise NotionMarkdownError(
                            f"HTTP {resp.status} on {method} {url}: {body[:500]}"
                        )
                    if expect_json:
                        return await resp.json()
                    return None
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                last_exc = e
                delay = self.BASE_RETRY_DELAY * (2**attempt)
                logger.warning(f"[notion-md] network error {e!r}, retry in {delay:.1f}s")
                await asyncio.sleep(delay)
        raise NotionMarkdownError(f"Max retries exceeded. Last: {last_exc}")

    async def get_data_source_id(self) -> str:
        if self._ds_id is not None:
            return self._ds_id
        data = await self._request("GET", f"{API_BASE}/databases/{self.database_id}")
        sources = data.get("data_sources", [])
        if not sources:
            raise NotionMarkdownError(
                f"No data_sources on database {self.database_id}"
            )
        self._ds_id = sources[0]["id"]
        logger.debug(f"[notion-md] resolved data_source_id={self._ds_id}")
        return self._ds_id

    # ---------- query ----------

    async def query_by_external_id(self, external_id: str) -> Optional[Dict[str, Any]]:
        ds_id = await self.get_data_source_id()
        body = {
            "filter": {
                "property": PROP_EXTERNAL_ID,
                "rich_text": {"equals": external_id},
            },
            "page_size": 2,
        }
        data = await self._request(
            "POST",
            f"{API_BASE}/data_sources/{ds_id}/query",
            json_body=body,
        )
        results = data.get("results", [])
        if not results:
            return None
        if len(results) > 1:
            logger.warning(
                f"[notion-md] multiple pages with external_id={external_id!r}; "
                "using first"
            )
        return results[0]

    async def list_active_pages(
        self, *, bu: str
    ) -> List[Dict[str, Any]]:
        """列出所有 BU=bu 且 Status != Done 的项目页（archived 排除）。

        返回每页 dict 含 id / external_id / status / project_name。
        用于增量同步结束后扫描"xlsx 消失的"项目 → 标记 Done。
        """
        ds_id = await self.get_data_source_id()
        out: List[Dict[str, Any]] = []
        cursor: Optional[str] = None
        while True:
            body: Dict[str, Any] = {
                "filter": {
                    "and": [
                        {"property": PROP_BU, "select": {"equals": bu}},
                        {"property": PROP_STATUS, "status": {"does_not_equal": STATUS_DONE}},
                    ]
                },
                "page_size": 100,
            }
            if cursor:
                body["start_cursor"] = cursor
            data = await self._request(
                "POST",
                f"{API_BASE}/data_sources/{ds_id}/query",
                json_body=body,
            )
            for r in data.get("results", []):
                props = r.get("properties", {})
                ext_id_arr = props.get(PROP_EXTERNAL_ID, {}).get("rich_text") or []
                ext_id = ext_id_arr[0].get("plain_text", "") if ext_id_arr else ""
                title_arr = props.get(PROP_TITLE, {}).get("title") or []
                title = "".join(t.get("plain_text", "") for t in title_arr)
                status_obj = props.get(PROP_STATUS, {}).get("status") or {}
                status_name = status_obj.get("name")
                out.append({
                    "id": r["id"],
                    "external_id": ext_id,
                    "title": title,
                    "status": status_name,
                })
            if data.get("has_more"):
                cursor = data.get("next_cursor")
            else:
                break
        return out

    async def mark_status(self, page_id: str, status_name: str) -> None:
        await self.update_page_properties(
            page_id, {PROP_STATUS: {"status": {"name": status_name}}}
        )

    async def list_all_by_external_id(self, *, bu: str) -> Dict[str, str]:
        """扫全部 BU=bu 的活跃页，返回 external_id → page_id 字典。

        用于批量回填场景（如 backfill 项目开始时间）。不过滤 Status。
        """
        ds_id = await self.get_data_source_id()
        out: Dict[str, str] = {}
        cursor: Optional[str] = None
        while True:
            body: Dict[str, Any] = {
                "filter": {"property": PROP_BU, "select": {"equals": bu}},
                "page_size": 100,
            }
            if cursor:
                body["start_cursor"] = cursor
            data = await self._request(
                "POST",
                f"{API_BASE}/data_sources/{ds_id}/query",
                json_body=body,
            )
            for r in data.get("results", []):
                props = r.get("properties", {})
                ext_id_arr = props.get(PROP_EXTERNAL_ID, {}).get("rich_text") or []
                ext_id = ext_id_arr[0].get("plain_text", "") if ext_id_arr else ""
                if ext_id:
                    out[ext_id] = r["id"]
            if data.get("has_more"):
                cursor = data.get("next_cursor")
            else:
                break
        return out

    async def set_project_start(self, page_id: str, start_date: "date") -> None:
        """只更新"项目开始时间"一个字段，不 touch 其他 property。"""
        await self.update_page_properties(
            page_id,
            {PROP_PROJECT_START: {"date": {"start": start_date.isoformat()}}},
        )

    # ---------- page CRUD ----------

    async def create_project_page(
        self, properties: Dict[str, Any], markdown_body: str
    ) -> str:
        """用 POST /v1/pages 创建空页面，然后用 Markdown API 填内容。"""
        ds_id = await self.get_data_source_id()
        body = {
            "parent": {"data_source_id": ds_id},
            "properties": properties,
        }
        data = await self._request("POST", f"{API_BASE}/pages", json_body=body)
        page_id = data["id"]
        if markdown_body.strip():
            await self.replace_markdown(page_id, markdown_body)
        return page_id

    async def update_page_properties(
        self, page_id: str, properties: Dict[str, Any]
    ) -> None:
        body = {"properties": properties}
        await self._request("PATCH", f"{API_BASE}/pages/{page_id}", json_body=body)

    # ---------- markdown API ----------

    async def get_markdown(self, page_id: str) -> str:
        data = await self._request(
            "GET", f"{API_BASE}/pages/{page_id}/markdown"
        )
        return data.get("markdown", "") or ""

    async def replace_markdown(self, page_id: str, new_markdown: str) -> None:
        body = {
            "type": "replace_content",
            "replace_content": {"new_str": new_markdown},
        }
        await self._request(
            "PATCH",
            f"{API_BASE}/pages/{page_id}/markdown",
            json_body=body,
            expect_json=True,
        )

    async def update_content(
        self, page_id: str, *, old_str: str, new_str: str
    ) -> None:
        """`update_content` 精准 find-and-replace（Notion 官方推荐的增量方式）。

        Notion 内部只重建被替换的 block，不整页 rebuild。old_str 必须在整页唯一。
        """
        body = {
            "type": "update_content",
            "update_content": {
                "content_updates": [{"old_str": old_str, "new_str": new_str}]
            },
        }
        await self._request(
            "PATCH",
            f"{API_BASE}/pages/{page_id}/markdown",
            json_body=body,
            expect_json=True,
        )

    async def prepend_markdown(
        self, page_id: str, prefix_md: str, *, idempotent_guard: Optional[str] = None
    ) -> bool:
        """把 prefix_md 拼到页面 markdown 最前。

        实现策略（按官方 Markdown API guide 推荐）：
          - 空页面 → `replace_content` 全量写入
          - 非空页面且能找到"首个 heading"且 anchor 在页内唯一 →
            `update_content` find-and-replace（Notion 内部只重建首个 block）
          - 找不到安全 anchor → 降级为 `replace_content` 整页重写

        Returns:
            True 表示实际写入；False 表示幂等跳过。
        """
        if not prefix_md.strip():
            return False
        current = await self.get_markdown(page_id)
        if idempotent_guard:
            # Notion markdown 把 [ ] 转义为 \[ \]；比较前 un-escape
            normalized = _unescape_md_brackets(current)
            head = normalized.lstrip()[: len(idempotent_guard) + 40]
            if idempotent_guard in head:
                logger.info(
                    f"[notion-md] page {page_id} already has guard "
                    f"{idempotent_guard!r}, skip prepend"
                )
                return False

        if not current.strip():
            await self.replace_markdown(page_id, prefix_md.rstrip() + "\n")
            return True

        anchor = _find_prepend_anchor(current)
        if anchor is not None:
            new_str = prefix_md.rstrip() + "\n\n" + anchor
            try:
                await self.update_content(page_id, old_str=anchor, new_str=new_str)
                return True
            except NotionMarkdownError as e:
                logger.warning(
                    f"[notion-md] update_content failed on page {page_id}, "
                    f"falling back to replace_content: {e}"
                )

        # 降级整页 replace
        new_md = prefix_md.rstrip() + "\n\n" + current.lstrip()
        await self.replace_markdown(page_id, new_md)
        return True


# ---------- helpers ----------


def _unescape_md_brackets(md: str) -> str:
    """Notion Markdown API GET 返回的 markdown 把 [ 和 ] 转义为 \\[ 和 \\]。
    幂等 guard 比较前先 un-escape，保证 guard 文本可命中。
    """
    if not md:
        return md
    return md.replace("\\[", "[").replace("\\]", "]")


_HEADING_LINE = re.compile(r"^#{1,6}\s+\S.*$", re.MULTILINE)


def _find_prepend_anchor(markdown_body: str) -> Optional[str]:
    """在整页 markdown 中找一个适合做 update_content anchor 的首段。

    优先规则：
      1. 第一个 heading 行（`#` ~ `######`），且该行在整页中**唯一出现**（避免 find 误匹配多处）
      2. 找不到或非唯一 → 返回 None，调用方降级为 replace_content

    返回的字符串即 read 出来的原样 line（含 `\\[` 转义），直接当 `old_str` 传给 update_content。
    """
    if not markdown_body:
        return None
    for m in _HEADING_LINE.finditer(markdown_body):
        line = m.group()
        if markdown_body.count(line) == 1:
            return line
    return None


# ---------- property builder ----------

def _safe_set(props: Dict[str, Any], prop_name: str, value: Any) -> None:
    """仅当 prop_name 在 KNOWN_DB_PROPS 中存在或 KNOWN_DB_PROPS 为空 (尚未 bootstrap) 时写入.

    schema bootstrap 启动后会填充 KNOWN_DB_PROPS, 缺失字段会被静默跳过, 防止
    validation_error. 在 bootstrap 完成前 (KNOWN_DB_PROPS 为空) 一律写入,
    走旧的 fail-on-validation-error 路径.
    """
    if KNOWN_DB_PROPS and prop_name not in KNOWN_DB_PROPS:
        return
    props[prop_name] = value


def build_properties(
    row: ProjectRow,
    *,
    week_tag: str,
    source_email_url: Optional[str] = None,
    is_create: bool = False,
    force_status: Optional[str] = None,
    parent_page_id: Optional[str] = None,
) -> Dict[str, Any]:
    """xlsx 每行 ProjectRow → Notion properties dict.

    Args:
        is_create: 首次创建? 影响 PROJECT_START 是否写入 (避免 update 覆盖手改值).
        force_status: 强制写入的 Status 名 (None 表示不写, 保留手改).
            - ONGOING + create → STATUS_IN_PROGRESS
            - ONGOING + update → None
            - SHIPPED → STATUS_DONE (强制覆盖, xlsx 权威)
            - SUSPENDED → STATUS_SUSPENDED (强制覆盖, 用户需先在 Notion 加该 option)
        parent_page_id: 子任务专用. 非空时写 "母任务" relation.
    """
    title_text = row.product_model or row.project_name
    props: Dict[str, Any] = {
        PROP_TITLE: {
            "title": [{"type": "text", "text": {"content": title_text[:2000]}}]
        },
        PROP_EXTERNAL_ID: _rich_text(row.external_id),
        PROP_WEEK_TAG: _rich_text(week_tag),
        PROP_BU: {"select": {"name": row.bu[:100]}},
        PROP_SHIPPED_US: {"checkbox": bool(row.shipped_us)},
    }

    if row.priority_raw:
        props[PROP_PRIORITY] = {"select": {"name": row.priority_raw[:100]}}

    if row.product_model:
        name = row.product_model[:100].strip()
        if name:
            props[PROP_PRODUCT_MODELS] = {"multi_select": [{"name": name}]}

    # 产品线: 多 select. Notion 自动创建新 option. option name 不允许含逗号 → 替换为 /.
    if row.product_lines:
        pl_seen = set()
        pl_options = []
        for pl in row.product_lines:
            name = str(pl).replace(",", "/").strip()[:100]
            if not name or name in pl_seen:
                continue
            pl_seen.add(name)
            pl_options.append({"name": name})
        if pl_options:
            props[PROP_PRODUCT_LINE] = {"multi_select": pl_options}

    if row.rnd_division:
        props[PROP_RND_DIV] = {"select": {"name": row.rnd_division[:100]}}
    if row.pm:
        props[PROP_PM] = _rich_text(row.pm)
    if row.assist_pm:
        props[PROP_ASSIST_PM] = _rich_text(row.assist_pm)
    if row.contact_window:
        props[PROP_CONTACT] = _rich_text(row.contact_window)

    if row.ref_date is not None:
        props[PROP_REF_DDL] = {"date": {"start": row.ref_date.isoformat()}}

    risk_lines = list(row.risks)
    if row.ref_date_note:
        risk_lines.insert(0, f"[Ref Date] {row.ref_date_note}")
    if risk_lines:
        joined = "\n".join(risk_lines)[:2000]
        props[PROP_RISK] = _rich_text(joined)

    if source_email_url:
        props[PROP_SOURCE_EMAIL_URL] = {"url": source_email_url[:2000]}

    # ---- zwf 新增字段 (schema 不存在时由 _safe_set 静默跳过) ----
    if row.establishment_date is not None:
        _safe_set(props, PROP_ESTABLISHMENT_DATE,
                  {"date": {"start": row.establishment_date.isoformat()}})
    if row.desired_ship_date is not None:
        _safe_set(props, PROP_DESIRED_SHIP_DATE,
                  {"date": {"start": row.desired_ship_date.isoformat()}})
    if row.estimated_ship_date is not None:
        _safe_set(props, PROP_ESTIMATED_SHIP_DATE,
                  {"date": {"start": row.estimated_ship_date.isoformat()}})
    if row.actual_ship_date is not None:
        _safe_set(props, PROP_ACTUAL_SHIP_DATE,
                  {"date": {"start": row.actual_ship_date.isoformat()}})
    if row.suspension_date is not None:
        _safe_set(props, PROP_SUSPENSION_DATE,
                  {"date": {"start": row.suspension_date.isoformat()}})
    if row.reasons_for_delay:
        _safe_set(props, PROP_REASONS_FOR_DELAY, _rich_text(row.reasons_for_delay))
    if row.current_status:
        _safe_set(props, PROP_CURRENT_STATUS,
                  {"select": {"name": row.current_status[:100]}})

    # ---- Status 写入 ----
    if force_status is not None:
        props[PROP_STATUS] = {"status": {"name": force_status}}

    # 项目开始时间: 首次创建时写; update 路径不覆盖 (走 backfill 单独回填)
    if is_create:
        start_date = row.earliest_progress_date
        # 优先用 xlsx 立项时间 (更准, zwf 才有); 否则用 progress 推断
        if row.establishment_date is not None:
            start_date = row.establishment_date
        if start_date is not None:
            props[PROP_PROJECT_START] = {"date": {"start": start_date.isoformat()}}

    # 母任务 relation: 子任务必填指向 parent; 母/独立任务留空 (不写此 key 保留既有值)
    if parent_page_id:
        props[PROP_PARENT_TASK] = {"relation": [{"id": parent_page_id}]}

    return props


def status_for_row(row: ProjectRow, is_create: bool) -> Optional[str]:
    """根据 row.current_sheet + 是否首次 create 决定 Status 写入策略.

    - ONGOING + create → STATUS_IN_PROGRESS (首次默认)
    - ONGOING + update → None (保留用户手改)
    - SHIPPED → STATUS_DONE (强制覆盖, xlsx 是权威信号)
    - SUSPENDED → STATUS_SUSPENDED (强制覆盖)
    """
    if row.current_sheet == SheetKind.ONGOING:
        return STATUS_IN_PROGRESS if is_create else None
    if row.current_sheet == SheetKind.SHIPPED:
        return STATUS_DONE
    if row.current_sheet == SheetKind.SUSPENDED:
        return STATUS_SUSPENDED
    return None


def _rich_text(content: str) -> Dict[str, Any]:
    """短文本 rich_text 包装。单条 rich_text 最长 2000；超出截断。"""
    if content is None:
        content = ""
    return {
        "rich_text": [
            {"type": "text", "text": {"content": str(content)[:2000]}}
        ]
    }


# ---------- high-level upsert ----------

def build_week_prefix_markdown(
    row: ProjectRow, week_tag: str
) -> Tuple[str, Optional[str]]:
    """返回 (本周块的 markdown, 幂等 guard 字符串)。

    - 若 this_week_blocks 非空：每块渲染为 `### {week_tag} [MM/DD]` + 正文
    - 若为空：返回 ("", None) 表示没有新增内容，跳过正文更新

    幂等 guard 使用 `### {week_tag} ` 前缀（仅 week_tag 维度）：
      同一 week_tag 只要已在页面首段出现过就跳过 prepend，避免一周内多次跑重复写入。
      同时兼容"首次创建 vs 后续 prepend"的 heading 日期可能不完全一致的情况。
    """
    if not row.this_week_blocks:
        return "", None
    parts = [format_block_markdown(b, week_tag) for b in row.this_week_blocks]
    md = "\n".join(parts).strip() + "\n"
    guard = f"### {week_tag} "
    return md, guard


async def upsert_project(
    client: ProjectProgressNotionClient,
    row: ProjectRow,
    *,
    week_tag: str,
    source_email_url: Optional[str] = None,
    dry_run: bool = False,
    rebuild_body: bool = False,
    parent_page_id: Optional[str] = None,
) -> UpsertOutcome:
    """端到端 upsert 单个项目。

    Args:
        rebuild_body: update 路径下强制用全量历史 markdown 重写整页正文。
        parent_page_id: 子任务专用。非空时写 `母任务` relation 指向该 page。
    """
    lk = await client.external_id_lock(row.external_id)
    try:
        async with lk:
            existing = await client.query_by_external_id(row.external_id)
            is_create = existing is None

            force_status = status_for_row(row, is_create=is_create)

            properties = build_properties(
                row,
                week_tag=week_tag,
                source_email_url=source_email_url,
                is_create=is_create,
                force_status=force_status,
                parent_page_id=parent_page_id,
            )
            return await _do_upsert(
                client, row, properties, existing,
                week_tag=week_tag, dry_run=dry_run, rebuild_body=rebuild_body,
            )
    except Exception as e:
        logger.error(f"[upsert] {row.external_id} failed: {e}")
        return UpsertOutcome(
            external_id=row.external_id, page_id=None, action="failed", error=str(e)
        )


async def _do_upsert(
    client: "ProjectProgressNotionClient",
    row: ProjectRow,
    properties: Dict[str, Any],
    existing: Optional[Dict[str, Any]],
    *,
    week_tag: str,
    dry_run: bool,
    rebuild_body: bool,
) -> UpsertOutcome:
    """实际 upsert 动作（已在 external_id_lock 保护下调用）。"""
    is_create = existing is None
    try:

        if is_create:
            full_md = render_project_full_markdown(row, week_tag_override=week_tag)
            if dry_run:
                return UpsertOutcome(
                    external_id=row.external_id, page_id=None, action="created"
                )
            page_id = await client.create_project_page(properties, full_md)
            return UpsertOutcome(
                external_id=row.external_id, page_id=page_id, action="created"
            )

        page_id = existing["id"]
        if dry_run:
            return UpsertOutcome(
                external_id=row.external_id, page_id=page_id, action="updated"
            )
        try:
            await client.update_page_properties(page_id, properties)
        except NotionMarkdownError as e:
            # Notion dual_property 限制: 若该 page 已是另一 page 的母 (子任务非空),
            # 不能再 PATCH 它的 "母任务" relation. 跨周角色翻转 (上周母, 本周子) 会触发.
            # 降级策略: 去掉 PROP_PARENT_TASK 重试, 保留旧角色, log warning.
            if PROP_PARENT_TASK in properties and "subitem" in str(e).lower():
                logger.warning(
                    f"[upsert] {row.external_id} dual_property conflict "
                    f"(page already child elsewhere); dropping 母任务 update and retry: {e}"
                )
                fallback_props = {k: v for k, v in properties.items() if k != PROP_PARENT_TASK}
                await client.update_page_properties(page_id, fallback_props)
            else:
                raise

        if rebuild_body:
            full_md = render_project_full_markdown(row, week_tag_override=week_tag)
            if full_md.strip():
                await client.replace_markdown(page_id, full_md.rstrip() + "\n")
            return UpsertOutcome(
                external_id=row.external_id, page_id=page_id, action="updated"
            )

        prefix_md, guard = build_week_prefix_markdown(row, week_tag)
        if prefix_md:
            wrote = await client.prepend_markdown(
                page_id, prefix_md, idempotent_guard=guard
            )
            if not wrote:
                return UpsertOutcome(
                    external_id=row.external_id,
                    page_id=page_id,
                    action="skipped_idempotent",
                )
        return UpsertOutcome(
            external_id=row.external_id, page_id=page_id, action="updated"
        )
    except Exception as e:
        logger.error(f"[upsert] {row.external_id} failed: {e}")
        return UpsertOutcome(
            external_id=row.external_id, page_id=None, action="failed", error=str(e)
        )
