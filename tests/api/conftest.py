"""Shared fixtures for the FastAPI remote-access backend tests (src/api).

Strategy
--------
- We exercise the real FastAPI app (src.api.app:app) through Starlette's
  TestClient — full middleware + exception-handler + router stack, no mocking of
  the framework layer.
- Reads hit a REAL EmailRepository pointed at a throwaway SQLite DB built per
  test session (schema mirrors the production tables the routers/repo query:
  email_metadata / email_body / email_attachment / email_body_fts / sync_state).
  We override the `get_repository` FastAPI dependency rather than the global
  config singleton, so no `.env` (NOTION_TOKEN etc.) is needed.
- Auth: `MAILAGENT_API_AUTH_DISABLED=true` is exported in conftest *before* any
  `src.api.*` import, because both src/api/auth.py and src/api/app.py read it at
  module-import time. The default client is therefore the "bypass on" client.
  The 401 / live-verify tests flip `src.api.auth.AUTH_DISABLED` back off via
  monkeypatch (the dependency re-reads the module global on each request).

The temp DB is wired to a temp AttachmentStore base dir so the path-traversal
guard's allowed root is the temp tree, letting us construct an escaping
`local_path` deterministically.
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import time
from pathlib import Path
from typing import Iterator

import pytest

# --- MUST run before importing src.api.* (import-time env reads) -------------
# auth.py:  AUTH_DISABLED = os.environ.get("MAILAGENT_API_AUTH_DISABLED", ...)
# app.py:   ALLOWED_ORIGINS extension keyed on the same var.
os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
# agent_config.db (Phase -1 / 0A): /chat/config now computes agentProfileHash +
# installedSkillsHash against the AgentConfigStore. Pin it to a throwaway temp dir
# so api tests never seed/touch a real agent_config.db (the resolver would otherwise
# fall to the dev machine's sync_store sibling or ./data on a bare worktree).
os.environ.setdefault(
    "MAILAGENT_AGENT_CONFIG_DB_PATH",
    os.path.join(tempfile.mkdtemp(prefix="mailagent-test-agentcfg-"), "agent_config.db"),
)
# auth.py (codex C2): auth bypass is dev-only — it RuntimeErrors at import unless an
# explicit dev context is declared. The test suite IS a dev/CI context, so declare it.
os.environ.setdefault("MAILAGENT_API_DEV", "true")
# app.py (A4): the loopback-bind guard (_assert_bind_loopback, run by the FastAPI
# lifespan on TestClient __enter__) is now FAIL-CLOSED — an unset MAILAGENT_API_HOST
# raises instead of defaulting to 127.0.0.1. The TestClient stands in for `mailagent
# serve-api`, which always hard-binds loopback, so declare the same host here.
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from fastapi.testclient import TestClient  # noqa: E402

from src.api.app import app  # noqa: E402
from src.api.deps import get_repository  # noqa: E402
from src.repository import AttachmentStore, EmailRepository  # noqa: E402


# ---------------------------------------------------------------------------
# Schema + seed for the throwaway DB
# ---------------------------------------------------------------------------

# Trimmed-but-faithful DDL: only the columns the routers + EmailRepository
# actually SELECT. Kept in sync with the real schema (dumped from
# data/sync_store.db) — extra production columns (imap_uid, backend_origin, ...)
# are omitted because no code path under test reads them.
_DDL = """
CREATE TABLE email_metadata (
    internal_id INTEGER PRIMARY KEY,
    message_id TEXT UNIQUE,
    thread_id TEXT,
    subject TEXT,
    sender TEXT,
    sender_name TEXT,
    to_addr TEXT,
    cc_addr TEXT,
    date_received TEXT,
    mailbox TEXT,
    is_read INTEGER DEFAULT 0,
    is_flagged INTEGER DEFAULT 0,
    sync_status TEXT DEFAULT 'pending',
    notion_page_id TEXT,
    notion_thread_id TEXT,
    sync_error TEXT,
    retry_count INTEGER DEFAULT 0,
    next_retry_at REAL,
    created_at REAL,
    updated_at REAL,
    is_pinned INTEGER DEFAULT 0,
    pinned_at REAL,
    is_important INTEGER DEFAULT 0,
    snippet TEXT
);

CREATE TABLE email_body (
    internal_id INTEGER PRIMARY KEY,
    message_id TEXT,
    body_html TEXT,
    body_markdown TEXT,
    body_format TEXT,
    body_size_bytes INTEGER,
    has_inline_images INTEGER DEFAULT 0,
    raw_mime_sha256 TEXT,
    fetched_at REAL NOT NULL,
    fetched_source TEXT NOT NULL,
    FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
);

CREATE TABLE email_attachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    internal_id INTEGER NOT NULL,
    content_id TEXT,
    filename TEXT NOT NULL,
    content_type TEXT,
    size_bytes INTEGER,
    is_inline INTEGER DEFAULT 0,
    local_path TEXT,
    sha256 TEXT,
    derived_from INTEGER,
    derived_format TEXT,
    notion_file_id TEXT,
    notion_block_id TEXT,
    created_at REAL NOT NULL,
    FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE email_body_fts USING fts5(
    body_markdown,
    subject,
    sender,
    tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at REAL
);
"""

# Stable IDs the tests reference.
EMAIL_ID = 1001          # full email: metadata + body + attachments
EMAIL_NO_BODY_ID = 1002  # metadata only (no email_body row)
MISSING_ID = 999999      # never inserted → 404 path

ATT_NORMAL_ID = 1        # local_path inside the store base dir (good)
ATT_ESCAPE_ID = 2        # local_path escapes the base dir (→ 403)
ATT_NOPATH_ID = 3        # local_path NULL (→ 404 "no stored file")


def _seed(db_path: Path, attach_dir: Path) -> None:
    """Create schema + insert a deterministic corpus into the throwaway DB."""
    now = time.time()
    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(_DDL)

        # --- emails -------------------------------------------------------
        conn.execute(
            """INSERT INTO email_metadata
               (internal_id, message_id, thread_id, subject, sender, sender_name,
                to_addr, cc_addr, date_received, mailbox, is_read, is_flagged,
                sync_status, notion_page_id, notion_thread_id, sync_error,
                retry_count, next_retry_at, created_at, updated_at,
                is_pinned, pinned_at, is_important, snippet)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                EMAIL_ID, "<msg-1001@example.com>", "thread-A",
                "Quarterly redis timeout review", "alice@example.com", "Alice",
                "bob@example.com", "cc@example.com", "2026-05-01 09:00:00",
                "收件箱", 0, 1, "synced",
                "31a15375830d81798e75fcfce933808b", None, None,
                0, None, now, now, 0, None, 1, "Hello **redis** timeout body",
            ),
        )
        conn.execute(
            """INSERT INTO email_metadata
               (internal_id, message_id, subject, sender, sender_name, to_addr,
                cc_addr, date_received, mailbox, is_read, is_flagged, sync_status,
                retry_count, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                EMAIL_NO_BODY_ID, "<msg-1002@example.com>",
                "Standalone no-body email", "carol@example.com", "Carol",
                "dave@example.com", "", "2026-04-15 12:00:00",
                "收件箱", 1, 0, "pending", 0, now, now,
            ),
        )

        # --- body (only for EMAIL_ID) ------------------------------------
        conn.execute(
            """INSERT INTO email_body
               (internal_id, message_id, body_html, body_markdown, body_format,
                body_size_bytes, has_inline_images, raw_mime_sha256,
                fetched_at, fetched_source)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                EMAIL_ID, "<msg-1001@example.com>",
                "<p>Hello <b>redis</b> timeout body</p>",
                "Hello **redis** timeout body",
                "html", 38, 0, "a" * 64, now, "davmail",
            ),
        )

        # --- FTS row (rowid MUST equal internal_id; repo joins on it) ----
        conn.execute(
            "INSERT INTO email_body_fts (rowid, body_markdown, subject, sender) "
            "VALUES (?,?,?,?)",
            (
                EMAIL_ID, "Hello redis timeout body",
                "Quarterly redis timeout review", "alice@example.com",
            ),
        )

        # --- attachments --------------------------------------------------
        # base dir is the temp store; a file that genuinely lives under it.
        good_path = attach_dir / str(EMAIL_ID) / "report.pdf"
        good_path.parent.mkdir(parents=True, exist_ok=True)
        good_path.write_bytes(b"%PDF-1.4 fake pdf bytes")

        conn.execute(
            """INSERT INTO email_attachment
               (id, internal_id, content_id, filename, content_type, size_bytes,
                is_inline, local_path, sha256, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                ATT_NORMAL_ID, EMAIL_ID, None, "report.pdf", "application/pdf",
                good_path.stat().st_size, 0, str(good_path), "f" * 64, now,
            ),
        )
        # Escaping path: absolute path that resolves OUTSIDE attach_dir.
        escape_path = attach_dir.parent / "secret.env"
        conn.execute(
            """INSERT INTO email_attachment
               (id, internal_id, content_id, filename, content_type, size_bytes,
                is_inline, local_path, sha256, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                ATT_ESCAPE_ID, EMAIL_ID, None, "secret.env", "text/plain",
                123, 0, str(escape_path), "0" * 64, now,
            ),
        )
        # NULL local_path: no stored file → 404.
        conn.execute(
            """INSERT INTO email_attachment
               (id, internal_id, content_id, filename, content_type, size_bytes,
                is_inline, local_path, sha256, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                ATT_NOPATH_ID, EMAIL_ID, None, "ghost.bin",
                "application/octet-stream", 0, 0, None, None, now,
            ),
        )

        # --- sync_state (admin/health reads db_version) ------------------
        from src.mail.sync_store import SyncStore

        conn.execute(
            "INSERT INTO sync_state (key, value, updated_at) VALUES (?,?,?)",
            ("db_version", str(SyncStore.DB_VERSION), now),
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def attach_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Temp AttachmentStore base dir (the path-traversal allowed root)."""
    d = tmp_path_factory.mktemp("attachments")
    return d.resolve()


@pytest.fixture(scope="session")
def temp_db(tmp_path_factory: pytest.TempPathFactory, attach_dir: Path) -> Path:
    """Throwaway sqlite DB seeded with the test corpus."""
    db = tmp_path_factory.mktemp("db") / "test_sync_store.db"
    _seed(db, attach_dir)
    return db


@pytest.fixture(scope="session")
def repo(temp_db: Path, attach_dir: Path) -> EmailRepository:
    """Real EmailRepository bound to the temp DB + temp attachment store."""
    return EmailRepository(
        db_path=str(temp_db),
        attachment_store=AttachmentStore(base_dir=str(attach_dir)),
    )


@pytest.fixture()
def client(repo: EmailRepository) -> Iterator[TestClient]:
    """TestClient with get_repository overridden to the temp-DB repo.

    Auth bypass is ON by default (MAILAGENT_API_AUTH_DISABLED=true exported at
    import time). Tests that need the locked-down behavior monkeypatch
    src.api.auth.AUTH_DISABLED = False.
    """
    app.dependency_overrides[get_repository] = lambda: repo
    # raise_server_exceptions=False so the app's own 500 exception handler runs
    # (otherwise TestClient re-raises and we can't assert the error envelope).
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.pop(get_repository, None)


# ===========================================================================
# Phase B — calendar fixtures
# ---------------------------------------------------------------------------
# The calendar router does NOT use EmailRepository; it builds its own
# CalendarService from `get_settings().sync_store_db_path`. Its tables
# (calendar_event / calendar_sync_state) carry NOT-NULL logic the trimmed
# `_DDL` above deliberately omits, so we build a SEPARATE DB via the REAL
# `SyncStore._init_database()` and seed a deterministic corpus. The
# `cal_folder_client` overrides `get_settings` to point the router at this DB.
# ===========================================================================

# Stable calendar identifiers the tests reference.
CAL_EVENT_UID = "uid-meet-1"        # single in-window caldav event
CAL_DELETED_UID = "uid-del"          # soft-deleted → excluded from names/list
CAL_NAME = "Work"
# Window the seeded event falls in (UTC).
CAL_WINDOW_FROM = "2026-06-01"
CAL_WINDOW_TO = "2026-06-03"
# 阶段 2.1 (P1-3) — email_meeting 映射 (email-link / source-email 端点)。
CAL_INVITE_EMAIL_ID = 9001           # 最新 REQUEST 邀请邮件 → CAL_EVENT_UID
CAL_INVITE_EMAIL_OLD_ID = 9002       # 同 uid 更早一封 (CANCEL)
CAL_PLAIN_EMAIL_ID = 9003            # 无会议映射的普通邮件 → email-link 404
CAL_NOCAL_EMAIL_ID = 9004            # 映射到无日历行的 uid
CAL_NOCAL_UID = "uid-no-cal"


def _seed_cal_folder(db_path: Path) -> None:
    """Seed calendar_event / calendar_sync_state into a real SyncStore-initialised DB."""
    import json
    from datetime import datetime, timezone

    from src.mail.sync_store import SyncStore

    # Real schema init (creates every table; calendar_event + calendar_sync_state).
    SyncStore(str(db_path))

    now = time.time()
    ev_start = datetime(2026, 6, 1, 10, 0, 0, tzinfo=timezone.utc).timestamp()
    ev_end = datetime(2026, 6, 1, 11, 0, 0, tzinfo=timezone.utc).timestamp()

    conn = sqlite3.connect(str(db_path))
    try:
        # One confirmed single caldav event inside the window.
        conn.execute(
            """INSERT INTO calendar_event
               (ical_uid, sequence, calendar_name, summary, description, location,
                organizer, attendees_json, dtstart_utc, dtend_utc, is_all_day,
                status, response_status, url, source, last_synced_at,
                created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                CAL_EVENT_UID, 0, CAL_NAME, "Sprint Planning", "desc", "Room A",
                "boss@example.com", json.dumps([{"email": "a@example.com"}]),
                ev_start, ev_end, 0, "confirmed", "accepted",
                "https://teams.example/x", "caldav", now, now, now,
            ),
        )
        # A soft-deleted event (deleted_at set) — must be excluded from
        # list_calendar_names() and the window query.
        conn.execute(
            """INSERT INTO calendar_event
               (ical_uid, calendar_name, summary, dtstart_utc, dtend_utc, source,
                last_synced_at, deleted_at, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (CAL_DELETED_UID, "GhostCal", "Deleted", ev_start, ev_end, "caldav",
             now, now, now, now),
        )
        conn.execute(
            """INSERT INTO calendar_sync_state
               (calendar_name, ctag, sync_token, last_full_sync_at,
                last_incremental_sync_at, last_error, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (CAL_NAME, "ctag-1", "tok-1", now, now, None, now, now),
        )
        # 阶段 2.1 (P1-3) — email_meeting 映射 + 邮件元数据 (email-link /
        # source-email 端点)。9001=最新 REQUEST → CAL_EVENT_UID; 9002=同 uid 更早
        # CANCEL; 9003=无映射普通邮件; 9004=映射到无日历行的 uid。
        emails = [
            (CAL_INVITE_EMAIL_ID, "<invite-new@x>", "Sprint Planning invite",
             "2026-06-01T09:00:00+08:00"),
            (CAL_INVITE_EMAIL_OLD_ID, "<invite-old@x>", "Sprint Planning cancel",
             "2026-05-30T09:00:00+08:00"),
            (CAL_PLAIN_EMAIL_ID, "<plain@x>", "Plain email",
             "2026-06-01T10:00:00+08:00"),
            (CAL_NOCAL_EMAIL_ID, "<nocal@x>", "Orphan invite",
             "2026-06-01T11:00:00+08:00"),
        ]
        for iid, mid, subject, date in emails:
            conn.execute(
                "INSERT INTO email_metadata (internal_id, message_id, subject, "
                "sender, sender_name, date_received, mailbox, sync_status, "
                "created_at, updated_at) "
                "VALUES (?, ?, ?, 'boss@example.com', 'Boss', ?, '收件箱', "
                "'synced', ?, ?)",
                (iid, mid, subject, date, now, now),
            )
        meetings = [
            (CAL_INVITE_EMAIL_ID, CAL_EVENT_UID, "REQUEST"),
            (CAL_INVITE_EMAIL_OLD_ID, CAL_EVENT_UID, "CANCEL"),
            (CAL_NOCAL_EMAIL_ID, CAL_NOCAL_UID, "REQUEST"),
        ]
        for iid, uid, method in meetings:
            conn.execute(
                "INSERT INTO email_meeting (internal_id, ical_uid, method, "
                "sequence, is_recurring, created_at, updated_at) "
                "VALUES (?, ?, ?, 0, 0, ?, ?)",
                (iid, uid, method, now, now),
            )
        conn.commit()
    finally:
        conn.close()


@pytest.fixture(scope="session")
def cal_folder_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A real-schema SQLite DB seeded with calendar_event rows."""
    db = tmp_path_factory.mktemp("calfolder") / "cf_store.db"
    _seed_cal_folder(db)
    return db


@pytest.fixture()
def cal_folder_client(cal_folder_db: Path) -> Iterator[TestClient]:
    """TestClient whose `get_settings` points the calendar router at the
    real-schema seeded DB. A tiny stub Config supplies only the two attributes
    that router reads (`sync_store_db_path`, `calendar_caldav_sync_enabled`)."""
    from src.api.deps import get_settings

    db_path = cal_folder_db

    class _StubConfig:
        sync_store_db_path = str(db_path)
        calendar_caldav_sync_enabled = False

    app.dependency_overrides[get_settings] = lambda: _StubConfig()
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.pop(get_settings, None)


# ===========================================================================
# Phase 1 — Skill / Bearer-key fixtures (06-18-custom-ai-harness-agent)
# ---------------------------------------------------------------------------
# skills router invoke 经 FastAPI deps 注入 SkillContext (get_repository /
# get_report_store / get_settings) —— 与 email/reports 路由一致，dependency_overrides
# 指向临时 DB。report 表由真 SyncStore migration 建（ReportStore 自身不建表）。
# ===========================================================================


@pytest.fixture()
def skill_report_db(tmp_path_factory: pytest.TempPathFactory) -> str:
    """真 SyncStore 建全表（含 report_agent / report）+ 播一个 report agent + 一份 ready 报告。"""
    db = tmp_path_factory.mktemp("skillrep") / "store.db"
    from src.mail.sync_store import SyncStore
    from src.reports.store import ReportStore

    SyncStore(str(db))  # 建全部表（含 report_agent / report）
    store = ReportStore(db_path=str(db))
    store.create_agent("daily", type="report", enabled=True, title="Daily Digest")
    store.create_report(
        report_id="rep-1",
        agent_id="daily",
        cadence="daily",
        report_date="2026-06-01",
        window_start="2026-06-01T00:00:00Z",
        window_end="2026-06-02T00:00:00Z",
    )
    store.finish_report(
        "rep-1",
        status="ready",
        blocks_json='{"blocks": []}',
        counts_json='{"total": 3}',
        headline="3 emails today",
    )
    return str(db)


@pytest.fixture()
def skill_client(repo: EmailRepository, skill_report_db: str) -> Iterator[TestClient]:
    """TestClient with skills 路由所需 deps 全部 override（email repo + report store + config）。

    auth bypass 默认 ON（MAILAGENT_API_AUTH_DISABLED=true）；bearer / 401 测试自行
    monkeypatch src.api.auth.AUTH_DISABLED=False。
    """
    from src.api.deps import get_report_store, get_repository, get_settings
    from src.reports.store import ReportStore

    report_store = ReportStore(db_path=skill_report_db)

    class _Cfg:
        sync_store_db_path = skill_report_db
        calendar_caldav_sync_enabled = False

    app.dependency_overrides[get_repository] = lambda: repo
    app.dependency_overrides[get_report_store] = lambda: report_store
    app.dependency_overrides[get_settings] = lambda: _Cfg()
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    for dep in (get_repository, get_report_store, get_settings):
        app.dependency_overrides.pop(dep, None)


@pytest.fixture()
def api_key_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """临时 api_auth.db 上的 ApiKeyStore，并把 agent_auth 用的解析器指向它。"""
    from src.security import api_keys

    store = api_keys.ApiKeyStore(db_path=str(tmp_path / "api_auth.db"))
    monkeypatch.setattr(api_keys, "get_api_key_store", lambda: store)
    return store


@pytest.fixture()
def fresh_agent_cfg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Phase -1 / 0A：每测试一个干净 agent_config.db（覆盖 conftest session env + reset 单例）。

    /api/agent/* + /chat/config 的 hash/standingContext/skillOverrides 都经
    get_agent_config_store()（env 单例）读，故测试用独立临时库 + reset cache 隔离。
    """
    from src.agent_config import store as acstore

    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    acstore.reset_agent_config_store_cache()
    yield acstore.get_agent_config_store()
    acstore.reset_agent_config_store_cache()


@pytest.fixture()
def fresh_skills_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """S2 W2：每测试一个干净 skills 落盘目录（MAILAGENT_SKILLS_DIR 覆盖 → quarantine + <name>/ 落这）。"""
    d = tmp_path / "skills"
    monkeypatch.setenv("MAILAGENT_SKILLS_DIR", str(d))
    return d
