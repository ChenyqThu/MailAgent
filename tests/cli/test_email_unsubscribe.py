"""CLI ``mailagent email unsubscribe`` 测试 (RFC 2369 / RFC 8058 智能退订).

灵动岛 (ping-island) archive_and_unsubscribe action handler 调本命令. raw MIME
经 backend.arm.fetch_email_content_by_id 重抽, 解析 List-Unsubscribe header 智能执行:
  - one_click_post: List-Unsubscribe-Post=One-Click + https URI → httpx POST
  - open_url:       https URI (无 one-click) → open 浏览器
  - open_mailto:    只有 mailto URI → open 邮件客户端
  - none:           无 List-Unsubscribe header

覆盖:
- 纯函数: _parse_list_unsubscribe / _is_one_click / _pick_unsubscribe_method
- integration (CliRunner + seeded_db + fake backend fetch + mock httpx / open)
全 mock — 不真发 HTTP / 不真 open。
"""

from __future__ import annotations

from src.cli.commands.email import (
    _is_one_click,
    _parse_list_unsubscribe,
    _pick_unsubscribe_method,
)
from tests.cli.conftest import extract_last_json_object as _last_json


# ─────────────────────────────────────────────────────────────────────────────
# 纯函数: _parse_list_unsubscribe (RFC 2369 多 URI 尖括号列表 + scheme 白名单)
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_list_unsubscribe_https_and_mailto():
    val = "<https://example.com/unsub?token=x>, <mailto:unsub@example.com>"
    assert _parse_list_unsubscribe(val) == [
        "https://example.com/unsub?token=x",
        "mailto:unsub@example.com",
    ]


def test_parse_list_unsubscribe_single_https():
    assert _parse_list_unsubscribe("<https://a.com/u>") == ["https://a.com/u"]


def test_parse_list_unsubscribe_mailto_only():
    assert _parse_list_unsubscribe("<mailto:x@y.com>") == ["mailto:x@y.com"]


def test_parse_list_unsubscribe_drops_http_and_unknown_schemes():
    # 安全硬约束: http (明文) / javascript / data 都丢弃, 只留 https/mailto
    val = (
        "<http://insecure.com/u>, <javascript:alert(1)>, "
        "<data:text/html,x>, <https://safe.com/u>"
    )
    assert _parse_list_unsubscribe(val) == ["https://safe.com/u"]


def test_parse_list_unsubscribe_empty():
    assert _parse_list_unsubscribe("") == []
    assert _parse_list_unsubscribe("no brackets here") == []


def test_parse_list_unsubscribe_whitespace_in_brackets():
    # RFC 允许尖括号内有空白 — strip 后保留
    assert _parse_list_unsubscribe("< https://a.com/u >") == ["https://a.com/u"]


# ─────────────────────────────────────────────────────────────────────────────
# 纯函数: _is_one_click (List-Unsubscribe-Post header)
# ─────────────────────────────────────────────────────────────────────────────


def test_is_one_click_true():
    assert _is_one_click("List-Unsubscribe=One-Click") is True


def test_is_one_click_case_insensitive():
    assert _is_one_click("list-unsubscribe=one-click") is True


def test_is_one_click_false_when_empty():
    assert _is_one_click("") is False
    assert _is_one_click(None) is False


def test_is_one_click_false_when_other_value():
    assert _is_one_click("something-else") is False


# ─────────────────────────────────────────────────────────────────────────────
# 纯函数: _pick_unsubscribe_method (决策树)
# ─────────────────────────────────────────────────────────────────────────────


def test_pick_method_one_click_post_when_https_and_oneclick():
    method, uri = _pick_unsubscribe_method(
        ["https://a.com/u", "mailto:x@y.com"], one_click=True,
    )
    assert method == "one_click_post"
    assert uri == "https://a.com/u"


def test_pick_method_open_url_when_https_no_oneclick():
    method, uri = _pick_unsubscribe_method(["https://a.com/u"], one_click=False)
    assert method == "open_url"
    assert uri == "https://a.com/u"


def test_pick_method_open_mailto_when_only_mailto():
    # one_click=True 但无 https → 不能 POST, 降到 open mailto
    method, uri = _pick_unsubscribe_method(["mailto:x@y.com"], one_click=True)
    assert method == "open_mailto"
    assert uri == "mailto:x@y.com"


def test_pick_method_none_when_no_uris():
    method, uri = _pick_unsubscribe_method([], one_click=False)
    assert method == "none"
    assert uri is None


# ─────────────────────────────────────────────────────────────────────────────
# integration helpers
# ─────────────────────────────────────────────────────────────────────────────


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


def _build_mime(*, list_unsub: str = "", list_unsub_post: str = "") -> str:
    """构造含 (或不含) List-Unsubscribe header 的 raw MIME 文本。"""
    lines = [
        "From: newsletter@acme.com",
        "To: me@mycorp.com",
        "Subject: Weekly Digest",
    ]
    if list_unsub:
        lines.append(f"List-Unsubscribe: {list_unsub}")
    if list_unsub_post:
        lines.append(f"List-Unsubscribe-Post: {list_unsub_post}")
    lines.extend(["", "Body content here."])
    return "\r\n".join(lines)


class _FakeArm:
    """fake backend.arm: fetch_email_content_by_id 返回固定 source MIME。"""

    def __init__(self, source: str):
        self._source = source
        self.calls: list[tuple] = []

    def fetch_email_content_by_id(self, internal_id, mailbox=None):
        self.calls.append((internal_id, mailbox))
        return {"source": self._source, "message_id": "<msg-12345@example.com>"}


class _FakeBackend:
    def __init__(self, source: str):
        self.arm = _FakeArm(source)


def _patch_backend_source(monkeypatch, source: str) -> _FakeBackend:
    """让 CliContext.backend 返回 fake backend (固定 source MIME)。"""
    fake = _FakeBackend(source)
    from src.mail.backend import factory as factory_mod
    monkeypatch.setattr(factory_mod, "create_backend", lambda *a, **k: fake)
    return fake


def _bypass_auth(monkeypatch):
    monkeypatch.setattr("src.cli.context.CliContext.require_auth", lambda self: None)


def _stub_mark_done(monkeypatch):
    """mark_done 走 outbox + sync_store, integration 里直接 stub 成 True 避免依赖
    OutboxRepository / v10 schema 细节 (那条路径 test_email_flag 已覆盖)。"""
    calls: list[int] = []

    def fake(cli, internal_id):
        calls.append(internal_id)
        return True

    monkeypatch.setattr("src.cli.commands.email._mark_done_via_outbox", fake)
    return calls


class _FakeResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code


class _FakeHttpxClient:
    """记录 POST 入参 (URL / content / headers) + 构造参数 (timeout / follow_redirects)。"""

    last_init: dict = {}
    last_post: dict = {}

    def __init__(self, *, timeout=None, follow_redirects=None, **kwargs):
        _FakeHttpxClient.last_init = {
            "timeout": timeout,
            "follow_redirects": follow_redirects,
        }
        self._status = getattr(_FakeHttpxClient, "_next_status", 200)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def post(self, url, *, content=None, headers=None):
        _FakeHttpxClient.last_post = {
            "url": url, "content": content, "headers": headers,
        }
        return _FakeResponse(self._status)


def _patch_httpx(monkeypatch, status: int = 200):
    import httpx
    _FakeHttpxClient._next_status = status
    _FakeHttpxClient.last_init = {}
    _FakeHttpxClient.last_post = {}
    monkeypatch.setattr(httpx, "Client", _FakeHttpxClient)


def _patch_open(monkeypatch):
    """抓 _run_open 入参; 不真 open。"""
    calls: list[str] = []

    def fake_open(target):
        calls.append(target)
        return True

    monkeypatch.setattr("src.cli.commands.email._run_open", fake_open)
    return calls


# ─────────────────────────────────────────────────────────────────────────────
# integration: not-found / no-source
# ─────────────────────────────────────────────────────────────────────────────


def test_unsubscribe_not_found(cli_runner, seeded_db):
    r = _invoke(cli_runner, "email", "unsubscribe", "99999999", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] == "E_NOT_FOUND"


def test_unsubscribe_no_source_errors(cli_runner, seeded_db, monkeypatch):
    _patch_backend_source(monkeypatch, "")  # backend 返回空 source
    r = _invoke(cli_runner, "email", "unsubscribe", "12345", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] == "E_NOT_FOUND"


# ─────────────────────────────────────────────────────────────────────────────
# integration: dry-run (只解析, 不执行)
# ─────────────────────────────────────────────────────────────────────────────


def test_unsubscribe_dry_run_one_click_plan(cli_runner, seeded_db, monkeypatch):
    source = _build_mime(
        list_unsub="<https://acme.com/unsub?t=abc>, <mailto:u@acme.com>",
        list_unsub_post="List-Unsubscribe=One-Click",
    )
    _patch_backend_source(monkeypatch, source)
    _patch_httpx(monkeypatch)
    open_calls = _patch_open(monkeypatch)

    r = _invoke(cli_runner, "email", "unsubscribe", "12345", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    plan = data["data"]
    assert plan["dry_run"] is True
    assert plan["method"] == "one_click_post"
    assert plan["unsubscribe_url"] == "https://acme.com/unsub?t=abc"
    assert plan["marked_done"] is False
    # dry-run 不执行 POST / open
    assert _FakeHttpxClient.last_post == {}
    assert open_calls == []


def test_unsubscribe_dry_run_no_header_method_none(cli_runner, seeded_db, monkeypatch):
    _patch_backend_source(monkeypatch, _build_mime())  # 无 List-Unsubscribe
    r = _invoke(cli_runner, "email", "unsubscribe", "12345", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    assert data["data"]["method"] == "none"
    assert data["data"]["unsubscribe_url"] is None


# ─────────────────────────────────────────────────────────────────────────────
# integration: one-click POST (mock httpx)
# ─────────────────────────────────────────────────────────────────────────────


def test_unsubscribe_one_click_post_success(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    source = _build_mime(
        list_unsub="<https://acme.com/unsub?t=abc>",
        list_unsub_post="List-Unsubscribe=One-Click",
    )
    _patch_backend_source(monkeypatch, source)
    _patch_httpx(monkeypatch, status=200)
    mark_calls = _stub_mark_done(monkeypatch)

    r = _invoke(cli_runner, "email", "unsubscribe", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    body = data["data"]
    assert body["method"] == "one_click_post"
    assert body["http_status"] == 200
    assert body["marked_done"] is True
    assert "error" not in body
    # POST 入参 — URL / body / Content-Type / follow_redirects=False
    assert _FakeHttpxClient.last_post["url"] == "https://acme.com/unsub?t=abc"
    assert _FakeHttpxClient.last_post["content"] == "List-Unsubscribe=One-Click"
    assert (
        _FakeHttpxClient.last_post["headers"]["Content-Type"]
        == "application/x-www-form-urlencoded"
    )
    assert _FakeHttpxClient.last_init["follow_redirects"] is False
    assert _FakeHttpxClient.last_init["timeout"] == 10.0
    assert mark_calls == [12345]


def test_unsubscribe_one_click_post_non_2xx_degrades(cli_runner, seeded_db, monkeypatch):
    """POST 返回非 2xx → 不崩, data.error 标降级提示, 仍 mark_done。"""
    _bypass_auth(monkeypatch)
    source = _build_mime(
        list_unsub="<https://acme.com/unsub?t=abc>",
        list_unsub_post="List-Unsubscribe=One-Click",
    )
    _patch_backend_source(monkeypatch, source)
    _patch_httpx(monkeypatch, status=500)
    mark_calls = _stub_mark_done(monkeypatch)

    r = _invoke(cli_runner, "email", "unsubscribe", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output  # 命令本身不失败
    body = data["data"]
    assert body["method"] == "one_click_post"
    assert body["http_status"] == 500
    assert "error" in body
    assert "500" in body["error"]
    assert "fallback_hint" in body  # https URI → 引导手动打开
    assert body["marked_done"] is True  # 退订失败仍 mark_done
    assert mark_calls == [12345]


def test_unsubscribe_one_click_post_timeout_degrades(cli_runner, seeded_db, monkeypatch):
    """POST 超时 / 网络异常 → http_status=None + error, 不崩, 仍 mark_done。"""
    _bypass_auth(monkeypatch)
    source = _build_mime(
        list_unsub="<https://acme.com/unsub?t=abc>",
        list_unsub_post="List-Unsubscribe=One-Click",
    )
    _patch_backend_source(monkeypatch, source)
    _stub_mark_done(monkeypatch)

    import httpx

    class _RaisingClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def post(self, *a, **k):
            raise httpx.TimeoutException("timed out")

    monkeypatch.setattr(httpx, "Client", _RaisingClient)

    r = _invoke(cli_runner, "email", "unsubscribe", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    body = data["data"]
    assert body["http_status"] is None
    assert "error" in body
    assert "TimeoutException" in body["error"]
    assert body["marked_done"] is True


# ─────────────────────────────────────────────────────────────────────────────
# integration: open URL / open mailto (mock _run_open)
# ─────────────────────────────────────────────────────────────────────────────


def test_unsubscribe_open_url_when_no_post_header(cli_runner, seeded_db, monkeypatch):
    """有 https URI 但无 List-Unsubscribe-Post → open 浏览器 (不 POST)。"""
    _bypass_auth(monkeypatch)
    source = _build_mime(list_unsub="<https://acme.com/unsub?t=abc>")
    _patch_backend_source(monkeypatch, source)
    _patch_httpx(monkeypatch)  # 确保不被调
    open_calls = _patch_open(monkeypatch)
    _stub_mark_done(monkeypatch)

    r = _invoke(cli_runner, "email", "unsubscribe", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    body = data["data"]
    assert body["method"] == "open_url"
    assert body["unsubscribe_url"] == "https://acme.com/unsub?t=abc"
    assert body["http_status"] is None
    assert open_calls == ["https://acme.com/unsub?t=abc"]
    assert _FakeHttpxClient.last_post == {}  # 没 POST


def test_unsubscribe_open_mailto_only(cli_runner, seeded_db, monkeypatch):
    """只有 mailto URI → open 邮件客户端。"""
    _bypass_auth(monkeypatch)
    source = _build_mime(list_unsub="<mailto:unsub@acme.com?subject=unsubscribe>")
    _patch_backend_source(monkeypatch, source)
    open_calls = _patch_open(monkeypatch)
    _stub_mark_done(monkeypatch)

    r = _invoke(cli_runner, "email", "unsubscribe", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    body = data["data"]
    assert body["method"] == "open_mailto"
    assert open_calls == ["mailto:unsub@acme.com?subject=unsubscribe"]


# ─────────────────────────────────────────────────────────────────────────────
# integration: no header → method=none (仅 archive, 不报错)
# ─────────────────────────────────────────────────────────────────────────────


def test_unsubscribe_no_header_marks_done_only(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    _patch_backend_source(monkeypatch, _build_mime())  # 无 List-Unsubscribe
    open_calls = _patch_open(monkeypatch)
    mark_calls = _stub_mark_done(monkeypatch)

    r = _invoke(cli_runner, "email", "unsubscribe", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    body = data["data"]
    assert body["method"] == "none"
    assert body["unsubscribe_url"] is None
    assert "error" not in body  # 无 header 不算错误
    assert body["marked_done"] is True
    assert mark_calls == [12345]  # 仍 mark_done
    assert open_calls == []  # 没 open


# ─────────────────────────────────────────────────────────────────────────────
# integration: --no-mark-done 跳过标记完成
# ─────────────────────────────────────────────────────────────────────────────


def test_unsubscribe_no_mark_done_flag(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    source = _build_mime(
        list_unsub="<https://acme.com/unsub>",
        list_unsub_post="List-Unsubscribe=One-Click",
    )
    _patch_backend_source(monkeypatch, source)
    _patch_httpx(monkeypatch, status=200)
    mark_calls = _stub_mark_done(monkeypatch)

    r = _invoke(cli_runner, "email", "unsubscribe", "12345", "--no-mark-done",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    assert data["data"]["marked_done"] is False
    assert mark_calls == []  # _mark_done_via_outbox 未被调
