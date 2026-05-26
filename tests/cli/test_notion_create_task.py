"""CLI ``mailagent notion create-task`` 测试 (Phase 2 F3).

灵动岛 convert_to_notion_task → 本命令. 覆盖 not-found / dry-run (LLM mock) /
真创建 (LLM + Notion pages.create + Email Inbox relation + mark done) mock.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from src.llm_agent.task_extractor import TaskFields
from tests.cli.conftest import extract_last_json_object as _last_json

_BJ = timezone(timedelta(hours=8))


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


_FAKE_FIELDS = TaskFields(
    task_title="Review PCI DSS v4.0.1 合规文档高亮",
    schedule_type="🎯 工作·专注",
    priority="🟠 高",
    suggested_time_iso="2026-05-27T14:00:00+08:00",
    is_all_day=False,
    description="Chi/Mengyue 起草合规文档, 需 R&D 核查高亮部分",
)


def _patch_extract(monkeypatch, fields=_FAKE_FIELDS):
    """mock task_extractor.extract_task_fields (避免真调 LLM)."""
    import src.llm_agent.task_extractor as te

    async def fake_extract(**kwargs):
        return fields

    # notion.py 内 from src.llm_agent.task_extractor import extract_task_fields
    # (函数内 import) — patch 源模块即可
    monkeypatch.setattr(te, "extract_task_fields", fake_extract)


class _FakePages:
    def __init__(self):
        self.created = []
        self.updated = []

    async def create(self, **kwargs):
        self.created.append(kwargs)
        return {"object": "page", "id": "task-page-id-0001"}

    async def update(self, **kwargs):
        self.updated.append(kwargs)
        return {"object": "page", "id": kwargs.get("page_id")}


class _FakeDatabases:
    async def retrieve(self, **kwargs):
        return {"data_sources": [{"id": "ds-cal-001", "name": "Calendar Events"}]}


def _patch_notion(monkeypatch, fake_pages):
    """stub NotionClient: databases.retrieve 返 data_source, pages.create 记录."""
    from src.notion import client as client_mod
    from src.notion import sync as sync_mod

    class _StubNotionClient:
        def __init__(self, *args, **kwargs):
            self.email_db_id = kwargs.get("email_db_id") or "stub"
            self.client = type("NS", (), {})()
            self.client.pages = fake_pages
            self.client.databases = _FakeDatabases()

    monkeypatch.setattr(client_mod, "NotionClient", _StubNotionClient)
    monkeypatch.setattr(sync_mod, "NotionClient", _StubNotionClient)


def _bypass_auth(monkeypatch):
    monkeypatch.setattr("src.cli.context.CliContext.require_auth", lambda self: None)


def test_create_task_not_found(cli_runner, seeded_db, monkeypatch):
    _patch_extract(monkeypatch)
    r = _invoke(cli_runner, "notion", "create-task", "99999999", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] == "E_NOT_FOUND"


def test_create_task_dry_run_emits_plan(cli_runner, seeded_db, monkeypatch):
    _patch_extract(monkeypatch)
    r = _invoke(cli_runner, "notion", "create-task", "12345", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    plan = data["data"]
    assert plan["dry_run"] is True
    assert plan["internal_id"] == 12345
    assert plan["task_title"] == "Review PCI DSS v4.0.1 合规文档高亮"
    assert plan["schedule_type"] == "🎯 工作·专注"
    assert plan["priority"] == "🟠 高"
    assert plan["suggested_time"] == "2026-05-27T14:00:00+08:00"
    assert plan["would_mark_done"] is True


def test_create_task_real_writes_page_with_relation(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    _patch_extract(monkeypatch)
    fake_pages = _FakePages()
    _patch_notion(monkeypatch, fake_pages)

    r = _invoke(cli_runner, "notion", "create-task", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    assert data["data"]["task_page_id"] == "task-page-id-0001"
    assert data["data"]["marked_done"] is True

    # pages.create 真被调 + properties 正确
    assert len(fake_pages.created) == 1
    create = fake_pages.created[0]
    assert create["parent"] == {"data_source_id": "ds-cal-001"}
    props = create["properties"]
    assert props["Title"]["title"][0]["text"]["content"] == "Review PCI DSS v4.0.1 合规文档高亮"
    assert props["日程类型"]["select"]["name"] == "🎯 工作·专注"
    assert props["优先级"]["select"]["name"] == "🟠 高"
    assert props["Time"]["date"]["start"] == "2026-05-27T14:00:00+08:00"
    # Email Inbox relation 指向原邮件 page (seeded_db notion_page_id)
    assert props["Email Inbox"]["relation"][0]["id"] == "abc12345-0000-0000-0000-000000000001"
    # 正文 children: callout 来源邮件 + link_to_page
    assert "children" in create
    types = [b["type"] for b in create["children"]]
    assert "callout" in types
    assert "link_to_page" in types


def test_create_task_no_mark_done_flag(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    _patch_extract(monkeypatch)
    fake_pages = _FakePages()
    _patch_notion(monkeypatch, fake_pages)

    r = _invoke(cli_runner, "notion", "create-task", "12345", "--no-mark-done",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    assert data["data"]["marked_done"] is False
    # pages.update (mark done via update_page_mail_sync_status) 不应被调
    # (note: update_page_mail_sync_status 内部走 data_sources.query + pages.update,
    #  这里只断言 marked_done=False — flow 没进 mark 分支)


def test_create_task_as_meeting_flag(cli_runner, seeded_db, monkeypatch):
    """--as-meeting (add_to_calendar): extract_task_fields 收到 as_meeting=True."""
    import src.llm_agent.task_extractor as te
    captured = {}

    async def fake_extract(**kwargs):
        captured.update(kwargs)
        return TaskFields(
            task_title="产品评审会", schedule_type="💼 工作·会议",
            priority="🟡 中", suggested_time_iso="2026-05-29T10:00:00+08:00",
        )

    monkeypatch.setattr(te, "extract_task_fields", fake_extract)
    _bypass_auth(monkeypatch)
    fake_pages = _FakePages()
    _patch_notion(monkeypatch, fake_pages)

    r = _invoke(cli_runner, "notion", "create-task", "12345", "--as-meeting",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    assert captured.get("as_meeting") is True
    # 会议日程类型写进 page
    props = fake_pages.created[0]["properties"]
    assert props["日程类型"]["select"]["name"] == "💼 工作·会议"


def test_create_task_time_omitted_when_empty(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    # suggested_time 空 → properties 不含 Time
    fields = TaskFields(
        task_title="读一下周报", schedule_type="📚 阅读", priority="🟢 低",
        suggested_time_iso="", description="",
    )
    _patch_extract(monkeypatch, fields)
    fake_pages = _FakePages()
    _patch_notion(monkeypatch, fake_pages)

    r = _invoke(cli_runner, "notion", "create-task", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    props = fake_pages.created[0]["properties"]
    assert "Time" not in props  # 空时间不写
    assert "Description" not in props  # 空描述不写
