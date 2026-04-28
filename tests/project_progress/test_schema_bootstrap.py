"""Schema bootstrap 测试 (mock Notion API).

不依赖 pytest-asyncio: 测试函数内部 asyncio.run() 包装.
"""

import asyncio
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock

from src.project_progress.notion_schema import (
    EXPECTED_PROPERTIES, EXPECTED_STATUS_OPTIONS,
    ProjectProgressSchemaBootstrapper,
)
from src.project_progress import notion_sync as ns


def _make_mock_client(properties: Dict[str, Any]):
    """造一个 mock client. Notion 2025-09-03+ schema 在 data_sources 下,
    所以 mock GET data_sources 返回 properties; PATCH data_sources 接收 schema 改动.
    """
    client = MagicMock()
    client.database_id = "db-test"

    async def fake_request(method: str, url: str, **kwargs):
        if method == "GET" and "/data_sources/" in url:
            return {"properties": properties}
        if method == "GET" and "/databases/" in url:
            # 仅在 get_data_source_id 真被走时用到; 这里 mock 已绕过该路径
            return {"data_sources": [{"id": "ds-test"}]}
        if method == "PATCH" and "/data_sources/" in url:
            return {"id": "ds-test"}
        raise NotImplementedError(method, url)

    client._request = AsyncMock(side_effect=fake_request)

    # mock get_data_source_id 异步方法
    async def fake_get_ds_id():
        return "ds-test"
    client.get_data_source_id = AsyncMock(side_effect=fake_get_ds_id)

    return client


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_bootstrap_creates_missing_properties():
    """全部 7 字段都缺 → PATCH 调用一次, 全建."""
    client = _make_mock_client(properties={})
    bs = ProjectProgressSchemaBootstrapper(client)

    ns.KNOWN_DB_PROPS.clear()
    _run(bs.ensure_schema())

    patch_calls = [
        call for call in client._request.call_args_list
        if call.args[0] == "PATCH" and "/data_sources/" in call.args[1]
    ]
    assert len(patch_calls) == 1
    body = patch_calls[0].kwargs["json_body"]
    assert "properties" in body
    for prop_name in EXPECTED_PROPERTIES:
        assert prop_name in body["properties"]


def test_bootstrap_skips_when_all_present():
    """所有期望字段都在 → 不调 PATCH."""
    full = {name: spec for name, spec in EXPECTED_PROPERTIES.items()}
    full["BU"] = {"select": {}}
    full["Status"] = {"status": {"options": [{"name": n} for n in EXPECTED_STATUS_OPTIONS]}}
    client = _make_mock_client(properties=full)
    bs = ProjectProgressSchemaBootstrapper(client)

    _run(bs.ensure_schema())
    patch_calls = [c for c in client._request.call_args_list
                   if c.args[0] == "PATCH" and "/data_sources/" in c.args[1]]
    assert len(patch_calls) == 0


def test_bootstrap_partial_missing():
    """部分字段缺 → PATCH 只加缺失的几个."""
    half = {
        "立项时间": {"date": {}},
        "期望交期": {"date": {}},
        "BU": {"select": {}},
    }
    client = _make_mock_client(properties=half)
    bs = ProjectProgressSchemaBootstrapper(client)

    _run(bs.ensure_schema())
    patch_calls = [c for c in client._request.call_args_list
                   if c.args[0] == "PATCH" and "/data_sources/" in c.args[1]]
    assert len(patch_calls) == 1
    body = patch_calls[0].kwargs["json_body"]
    added = set(body["properties"].keys())
    assert "立项时间" not in added
    assert "期望交期" not in added
    assert "预计出货" in added
    assert "实际出货" in added
    assert "暂停时间" in added
    assert "进度异常" in added
    assert "当前状态" in added


def test_bootstrap_status_suspended_missing_only_warns():
    """Status property 存在但缺 Suspended option → 只 log warning, 不抛错."""
    props = {
        **{name: spec for name, spec in EXPECTED_PROPERTIES.items()},
        "Status": {"status": {"options": [
            {"name": "In progress"}, {"name": "Done"},
        ]}},
    }
    client = _make_mock_client(properties=props)
    bs = ProjectProgressSchemaBootstrapper(client)

    _run(bs.ensure_schema())
    patch_calls = [c for c in client._request.call_args_list
                   if c.args[0] == "PATCH" and "/data_sources/" in c.args[1]]
    assert len(patch_calls) == 0


def test_bootstrap_fills_known_db_props():
    """ensure_schema 后 ns.KNOWN_DB_PROPS 应被填充."""
    full_props = {name: spec for name, spec in EXPECTED_PROPERTIES.items()}
    full_props["BU"] = {"select": {}}
    full_props["项目名称"] = {"title": {}}
    client = _make_mock_client(properties=full_props)
    bs = ProjectProgressSchemaBootstrapper(client)

    ns.KNOWN_DB_PROPS.clear()
    assert len(ns.KNOWN_DB_PROPS) == 0

    _run(bs.ensure_schema())
    assert "BU" in ns.KNOWN_DB_PROPS
    assert "项目名称" in ns.KNOWN_DB_PROPS
    for prop_name in EXPECTED_PROPERTIES:
        assert prop_name in ns.KNOWN_DB_PROPS


def test_bootstrap_5min_cache():
    """5min 内重复调 ensure_schema 应直接返回缓存, 不再 GET."""
    full_props = {name: spec for name, spec in EXPECTED_PROPERTIES.items()}
    full_props["BU"] = {"select": {}}
    client = _make_mock_client(properties=full_props)
    bs = ProjectProgressSchemaBootstrapper(client)

    async def two_calls():
        await bs.ensure_schema()
        first = client._request.call_count
        await bs.ensure_schema()
        return first, client._request.call_count

    first, second = _run(two_calls())
    assert second == first, "second call should hit cache, not GET"
