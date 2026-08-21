"""database_id → data_source_id 解析：显式配置优先 vs 老的 data_sources[0]（task 08-20 Lane 5）。

被修的缺陷：Notion 2025-09-03 起 database 是容器、schema 在 data source，一个 database
可含多个 data source；解析侧历来恒取 ``data_sources[0]``，而 OAuth 库选择器是按 data
source 粒度让用户选的 —— 选中的不是第一个时，Python 会解析到另一个数据源、同步静默
写错地方。修法 = OAuth 把选中的 data source id 写 env，解析侧优先读它。

两向都要钉住：
  * 配了 → 直接用，**一次 API 都不调**（调了就说明还在盲取第一个）；
  * 没配 → 老路径逐字节不变（存量用户全是单 data source）。
"""

import pytest

from src.config import config, configured_data_source_id
from src.notion.client import NotionClient, resolve_data_source_id


class _RecordingDatabases:
    """``databases.retrieve`` 替身：记录调用次数 + 返多 data source 的库。"""

    def __init__(self, data_sources):
        self.calls = []
        self._data_sources = data_sources

    async def retrieve(self, **kwargs):
        self.calls.append(kwargs.get("database_id"))
        return {"object": "database", "data_sources": self._data_sources}


class _ExplodingDatabases:
    """配了显式 data source 时**不该**被调到的替身。"""

    async def retrieve(self, **kwargs):  # pragma: no cover - 被调到即测试失败
        raise AssertionError("配置了 data_source_id 时不应再调 databases.retrieve")


def _fake_client(databases):
    return type("FakeAsyncClient", (), {"databases": databases})()


_TWO_SOURCES = [{"id": "ds-first"}, {"id": "ds-second"}]


# ---- 纯查表 configured_data_source_id -------------------------------------


def test_configured_lookup_matches_by_database_id(monkeypatch):
    monkeypatch.setattr(config, "email_database_id", "db-email")
    monkeypatch.setattr(config, "email_data_source_id", "ds-second")
    monkeypatch.setattr(config, "calendar_database_id", "db-cal")
    monkeypatch.setattr(config, "calendar_data_source_id", "ds-cal-2")

    assert configured_data_source_id("db-email") == "ds-second"
    assert configured_data_source_id("db-cal") == "ds-cal-2"
    # 第三个库（如项目周报库）没有配置承接 → 空，调用方走 API 解析。
    assert configured_data_source_id("db-other") == ""
    assert configured_data_source_id("") == ""


def test_configured_lookup_is_dash_insensitive(monkeypatch):
    """同一 id 有带/不带连字符两种写法（URL vs API），不能因写法不同而漏配。"""
    monkeypatch.setattr(config, "email_database_id", "1f2e3d4c5b6a7890abcdef0123456789")
    monkeypatch.setattr(config, "email_data_source_id", "ds-x")
    monkeypatch.setattr(config, "calendar_database_id", "")
    monkeypatch.setattr(config, "calendar_data_source_id", "")

    assert configured_data_source_id("1f2e3d4c-5b6a-7890-abcd-ef0123456789") == "ds-x"


def test_configured_lookup_empty_when_only_database_id_set(monkeypatch):
    """存量用户（只有库 ID、没有 data source ID）必须落回老路径。"""
    monkeypatch.setattr(config, "email_database_id", "db-email")
    monkeypatch.setattr(config, "email_data_source_id", "")
    monkeypatch.setattr(config, "calendar_database_id", "db-cal")
    monkeypatch.setattr(config, "calendar_data_source_id", "   ")

    assert configured_data_source_id("db-email") == ""
    assert configured_data_source_id("db-cal") == ""


# ---- resolve_data_source_id 两向 ------------------------------------------


@pytest.mark.asyncio
async def test_resolve_uses_configured_without_api_call(monkeypatch):
    monkeypatch.setattr(config, "email_database_id", "db-email")
    monkeypatch.setattr(config, "email_data_source_id", "ds-second")
    monkeypatch.setattr(config, "calendar_database_id", "")
    monkeypatch.setattr(config, "calendar_data_source_id", "")

    client = _fake_client(_ExplodingDatabases())
    assert await resolve_data_source_id(client, "db-email") == "ds-second"


@pytest.mark.asyncio
async def test_resolve_falls_back_to_first_data_source(monkeypatch):
    monkeypatch.setattr(config, "email_database_id", "db-email")
    monkeypatch.setattr(config, "email_data_source_id", "")
    monkeypatch.setattr(config, "calendar_database_id", "")
    monkeypatch.setattr(config, "calendar_data_source_id", "")

    dbs = _RecordingDatabases(_TWO_SOURCES)
    assert await resolve_data_source_id(_fake_client(dbs), "db-email") == "ds-first"
    assert dbs.calls == ["db-email"]


@pytest.mark.asyncio
async def test_resolve_raises_when_database_has_no_data_source(monkeypatch):
    monkeypatch.setattr(config, "email_database_id", "db-email")
    monkeypatch.setattr(config, "email_data_source_id", "")

    with pytest.raises(ValueError, match="No data sources found"):
        await resolve_data_source_id(_fake_client(_RecordingDatabases([])), "db-email")


@pytest.mark.asyncio
async def test_resolve_ignores_stale_config_for_other_database(monkeypatch):
    """配的是邮件库的 data source，问的是别的库 → 不能张冠李戴。"""
    monkeypatch.setattr(config, "email_database_id", "db-email")
    monkeypatch.setattr(config, "email_data_source_id", "ds-second")
    monkeypatch.setattr(config, "calendar_database_id", "")
    monkeypatch.setattr(config, "calendar_data_source_id", "")

    dbs = _RecordingDatabases(_TWO_SOURCES)
    assert await resolve_data_source_id(_fake_client(dbs), "db-other") == "ds-first"
    assert dbs.calls == ["db-other"]


# ---- 两个消费点（邮件 NotionClient / 日历 CalendarNotionSync） --------------


@pytest.mark.asyncio
async def test_notion_client_get_data_source_id_prefers_config(monkeypatch):
    monkeypatch.setattr(config, "email_database_id", "db-email")
    monkeypatch.setattr(config, "email_data_source_id", "ds-second")
    monkeypatch.setattr(config, "calendar_database_id", "")
    monkeypatch.setattr(config, "calendar_data_source_id", "")

    client = NotionClient(token="t", email_db_id="db-email")
    client.client = _fake_client(_ExplodingDatabases())
    assert await client.get_data_source_id("db-email") == "ds-second"


@pytest.mark.asyncio
async def test_notion_client_get_data_source_id_caches_api_result(monkeypatch):
    monkeypatch.setattr(config, "email_database_id", "db-email")
    monkeypatch.setattr(config, "email_data_source_id", "")
    monkeypatch.setattr(config, "calendar_database_id", "")
    monkeypatch.setattr(config, "calendar_data_source_id", "")

    dbs = _RecordingDatabases(_TWO_SOURCES)
    client = NotionClient(token="t", email_db_id="db-email")
    client.client = _fake_client(dbs)
    assert await client.get_data_source_id("db-email") == "ds-first"
    assert await client.get_data_source_id("db-email") == "ds-first"
    assert dbs.calls == ["db-email"], "第二次应命中缓存"


@pytest.mark.asyncio
async def test_calendar_sync_prefers_config(monkeypatch):
    from src.calendar_notion.sync import CalendarNotionSync

    monkeypatch.setattr(config, "email_database_id", "")
    monkeypatch.setattr(config, "email_data_source_id", "")
    monkeypatch.setattr(config, "calendar_database_id", "db-cal")
    monkeypatch.setattr(config, "calendar_data_source_id", "ds-cal-2")

    sync = CalendarNotionSync()
    sync.database_id = "db-cal"
    sync.client = _fake_client(_ExplodingDatabases())
    assert await sync._get_data_source_id() == "ds-cal-2"


@pytest.mark.asyncio
async def test_calendar_sync_falls_back_to_first_data_source(monkeypatch):
    from src.calendar_notion.sync import CalendarNotionSync

    monkeypatch.setattr(config, "email_database_id", "")
    monkeypatch.setattr(config, "email_data_source_id", "")
    monkeypatch.setattr(config, "calendar_database_id", "db-cal")
    monkeypatch.setattr(config, "calendar_data_source_id", "")

    dbs = _RecordingDatabases(_TWO_SOURCES)
    sync = CalendarNotionSync()
    sync.database_id = "db-cal"
    sync.client = _fake_client(dbs)
    assert await sync._get_data_source_id() == "ds-first"
    assert dbs.calls == ["db-cal"]
