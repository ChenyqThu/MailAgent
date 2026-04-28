"""Notion 项目进度库 schema bootstrap.

启动时一次性 (5min 缓存) 检查 Notion DB 是否含本模块写入需要的 7 个 property.
缺失则用 PATCH /v1/databases/:id 增量加. status 类型的 'Suspended' option
不能通过 API 添加 (Notion API 限制), 仅 log warning, 由用户手动建.

调用入口:
    bootstrapper = ProjectProgressSchemaBootstrapper(client)
    await bootstrapper.ensure_schema()  # idempotent, 5min 缓存

ensure_schema() 副作用:
    - 调用后 KNOWN_DB_PROPS (notion_sync 模块全局) 被填充, _safe_set 才会工作
    - 缺失 status option 仅 log, 不阻塞主流程
"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional, Set

import aiohttp
from loguru import logger

from . import notion_sync as _ns


# 7 个新 property 的期望 schema (类型 → 空 spec, Notion 接受 {"date":{}} / {"rich_text":{}} 等)
EXPECTED_PROPERTIES: Dict[str, Dict[str, Any]] = {
    _ns.PROP_ESTABLISHMENT_DATE: {"date": {}},
    _ns.PROP_DESIRED_SHIP_DATE: {"date": {}},
    _ns.PROP_ESTIMATED_SHIP_DATE: {"date": {}},
    _ns.PROP_ACTUAL_SHIP_DATE: {"date": {}},
    _ns.PROP_SUSPENSION_DATE: {"date": {}},
    _ns.PROP_REASONS_FOR_DELAY: {"rich_text": {}},
    _ns.PROP_CURRENT_STATUS: {"select": {}},
}

# Status 类型期望存在的 option name (API 不能加, 用户必须手动建)
EXPECTED_STATUS_OPTIONS = {_ns.STATUS_IN_PROGRESS, _ns.STATUS_DONE, _ns.STATUS_SUSPENDED}

# 缓存窗口
CACHE_TTL_SEC = 300


class ProjectProgressSchemaBootstrapper:
    """Schema bootstrap. 5min 缓存避免重复调用."""

    def __init__(self, client: "_ns.ProjectProgressNotionClient"):
        self.client = client
        self._last_check_at: float = 0.0
        self._last_known_props: Set[str] = set()

    async def ensure_schema(self, *, force: bool = False) -> Set[str]:
        """检查 + 补全 schema, 填充 notion_sync.KNOWN_DB_PROPS.

        Notion API >= 2025-09-03: properties 存于 data_source 而非 database.
        所以 GET / PATCH 都走 /v1/data_sources/:ds_id.

        Returns:
            DB 当前所有 property name 的集合 (含本次新建的).
        """
        now = time.time()
        if not force and (now - self._last_check_at < CACHE_TTL_SEC) and self._last_known_props:
            _ns.KNOWN_DB_PROPS.clear()
            _ns.KNOWN_DB_PROPS.update(self._last_known_props)
            return self._last_known_props

        # 1) 拿 data_source_id (用 client 已有的方法, 它会缓存)
        try:
            ds_id = await self.client.get_data_source_id()
        except Exception as e:
            logger.warning(f"[notion-schema] resolve data_source_id failed: {e}; skip bootstrap")
            return set()

        # 2) GET data_source 拿 properties
        try:
            ds = await self.client._request(
                "GET", f"{_ns.API_BASE}/data_sources/{ds_id}"
            )
        except Exception as e:
            logger.warning(f"[notion-schema] retrieve data_source failed: {e}; skip bootstrap")
            return set()

        existing_props: Dict[str, Dict[str, Any]] = ds.get("properties", {}) or {}
        existing_names: Set[str] = set(existing_props.keys())

        # 3) 加缺失的非 status 字段 (PATCH /v1/data_sources/:id)
        to_add: Dict[str, Dict[str, Any]] = {}
        for name, spec in EXPECTED_PROPERTIES.items():
            if name not in existing_names:
                to_add[name] = spec
        if to_add:
            try:
                await self.client._request(
                    "PATCH",
                    f"{_ns.API_BASE}/data_sources/{ds_id}",
                    json_body={"properties": to_add},
                )
                logger.info(
                    f"[notion-schema] created {len(to_add)} properties: "
                    f"{', '.join(to_add.keys())}"
                )
                existing_names.update(to_add.keys())
            except Exception as e:
                logger.warning(
                    f"[notion-schema] failed to add properties {list(to_add.keys())}: {e}"
                )
        else:
            logger.info(f"[notion-schema] all {len(EXPECTED_PROPERTIES)} expected properties present")

        # 4) 检查 Status 'Suspended' option 是否存在 (API 不能加, 仅 log)
        status_prop = existing_props.get(_ns.PROP_STATUS)
        if status_prop and status_prop.get("type") == "status":
            options = (status_prop.get("status") or {}).get("options") or []
            opt_names = {o.get("name") for o in options if o.get("name")}
            missing = EXPECTED_STATUS_OPTIONS - opt_names
            if missing:
                logger.warning(
                    f"[notion-schema] Status options missing: {missing}; "
                    f"Notion API does NOT allow adding status options. "
                    f"Please add them manually in Notion DB settings: "
                    f"Status property → 已入库 group → Add option."
                )

        self._last_check_at = now
        self._last_known_props = existing_names
        _ns.KNOWN_DB_PROPS.clear()
        _ns.KNOWN_DB_PROPS.update(existing_names)
        return existing_names
