"""Enriched email view endpoints (src/api/routers/email_views.py).

Exercises the 6 enriched read endpoints against the shared temp-DB fixture
(tests/api/conftest.py). That fixture's DDL deliberately OMITS the v13/v14
migration columns (ai_priority / ai_action / processing_status) and the
llm_processing table — so these tests double as the **graceful-degradation**
contract (gotcha #4): the endpoints must still return correct metadata with AI
fields degraded to null, never 500 on schema drift.

Wire shapes mirror the Electron main handler (handlers/email.ts) so the web
HttpApi can map 1:1 onto EnrichedEmailMeta / MailboxSummary / AIFields.
"""

from __future__ import annotations

from tests.api.conftest import EMAIL_ID, EMAIL_NO_BODY_ID


def _ok_envelope(payload: dict) -> None:
    assert payload["status"] == "success"
    assert payload["schema_version"] == 1
    assert payload["error"] is None
    assert payload["meta"]["source"] == "sqlite"
    assert payload["meta"]["duration_ms"] >= 0


# ---------------------------------------------------------------------------
# GET /api/email/list-enriched
# ---------------------------------------------------------------------------


def test_list_enriched_shape_and_degraded_ai(client):
    r = client.get("/api/email/list-enriched")
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    data = body["data"]
    assert isinstance(data, list)
    ids = {row["internal_id"] for row in data}
    # Both seeded emails present (neither is 'skipped').
    assert {EMAIL_ID, EMAIL_NO_BODY_ID}.issubset(ids)

    item = next(row for row in data if row["internal_id"] == EMAIL_ID)
    # EnrichedEmailMeta = list-item + enriched extras.
    for key in (
        "snippet", "lang", "ai_priority", "ai_action",
        "ai_category", "attach_count", "is_important", "processing_status",
        "notion_url", "subject", "sender", "is_read", "is_flagged",
    ):
        assert key in item, f"missing enriched key {key!r}"
    assert item["snippet"].startswith("Hello **redis**")
    no_body = next(row for row in data if row["internal_id"] == EMAIL_NO_BODY_ID)
    assert no_body["snippet"] is None
    # attach_count excludes inline (all 3 fixture attachments are is_inline=0).
    assert item["attach_count"] == 3
    # is_important promoted from the column.
    assert item["is_important"] is True
    # Degraded AI schema (no ai_priority col / no llm_processing) → null fields,
    # 'unknown' lang. Must NOT 500.
    assert item["ai_priority"] is None
    assert item["ai_action"] is None
    assert item["ai_category"] is None
    assert item["lang"] == "unknown"
    assert item["processing_status"] is None

    meta = body["meta"]
    assert meta["count"] == len(data)
    assert meta["limit"] == 100
    assert meta["offset"] == 0


def test_list_enriched_filter_mailbox_and_flag(client):
    r = client.get(
        "/api/email/list-enriched",
        params={"mailbox": "收件箱", "isFlagged": "true"},
    )
    assert r.status_code == 200
    data = r.json()["data"]
    # Only EMAIL_ID is flagged.
    assert [row["internal_id"] for row in data] == [EMAIL_ID]


def test_list_enriched_mailbox_matches_label_variants(client, temp_db):
    """内建视图按判定集 IN(...) 认变体行 (issue #42 后续)。

    fork 生产实证: 库里 mailbox='INBOX' 的历史行, 之前恒精确匹配 '收件箱' → 在收件箱
    视图**不可见**, 只在「所有邮件」露出, 而判定面 (Sent 游标/报告) 已认全变体。
    owner 库零变体行 → 本行为对其逐字节等价, 故这里显式造一行验证。
    """
    import sqlite3

    variant_id = 990001
    conn = sqlite3.connect(str(temp_db))
    try:
        conn.execute(
            """INSERT INTO email_metadata
               (internal_id, message_id, subject, sender, date_received, mailbox,
                is_read, is_flagged, sync_status, retry_count)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                variant_id, "<variant-inbox@example.com>", "Variant label row",
                "eve@example.com", "2026-05-02 09:00:00", "INBOX",
                0, 0, "synced", 0,
            ),
        )
        conn.commit()

        r = client.get("/api/email/list-enriched", params={"mailbox": "收件箱"})
        assert r.status_code == 200
        assert variant_id in {row["internal_id"] for row in r.json()["data"]}

        # 传变体本身同解 (远程 web 端可能带 IMAP 原名)
        r = client.get("/api/email/list-enriched", params={"mailbox": "INBOX"})
        assert r.status_code == 200
        assert {EMAIL_ID, variant_id}.issubset({row["internal_id"] for row in r.json()["data"]})
    finally:
        conn.execute("DELETE FROM email_metadata WHERE internal_id = ?", (variant_id,))
        conn.commit()
        conn.close()


def test_list_enriched_custom_folder_stays_exact(client, temp_db):
    """自定义文件夹视图维持精确匹配 —— 变体展开不得泄漏到自定义文件夹。

    🔴 已知取舍的反向锁: 名为 'ProjectX' 的自定义文件夹只认自己, 不会因为某个内建
    变体集而多带行。(反向的重复显示 —— 自定义文件夹恰好叫 'Sent' 时同时出现在
    发件箱视图 —— 是有意接受的降级, 见 mailbox_semantics.filter_labels_for_mailbox。)
    """
    import sqlite3

    folder_id = 990002
    conn = sqlite3.connect(str(temp_db))
    try:
        conn.execute(
            """INSERT INTO email_metadata
               (internal_id, message_id, subject, sender, date_received, mailbox,
                is_read, is_flagged, sync_status, retry_count)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                folder_id, "<custom-folder@example.com>", "Custom folder row",
                "frank@example.com", "2026-05-03 09:00:00", "ProjectX",
                0, 0, "synced", 0,
            ),
        )
        conn.commit()

        r = client.get("/api/email/list-enriched", params={"mailbox": "ProjectX"})
        assert r.status_code == 200
        assert [row["internal_id"] for row in r.json()["data"]] == [folder_id]

        # 该行不因内建视图展开而混进收件箱
        r = client.get("/api/email/list-enriched", params={"mailbox": "收件箱"})
        assert folder_id not in {row["internal_id"] for row in r.json()["data"]}
    finally:
        conn.execute("DELETE FROM email_metadata WHERE internal_id = ?", (folder_id,))
        conn.commit()
        conn.close()


def test_list_enriched_internalids_whitelist(client):
    r = client.get(
        "/api/email/list-enriched",
        params={"internalIds": f"{EMAIL_NO_BODY_ID}"},
    )
    assert r.status_code == 200
    ids = [row["internal_id"] for row in r.json()["data"]]
    assert ids == [EMAIL_NO_BODY_ID]


def test_list_enriched_bad_internalids_400(client):
    r = client.get("/api/email/list-enriched", params={"internalIds": "abc,def"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_list_enriched_limit_out_of_range_422(client):
    r = client.get("/api/email/list-enriched", params={"limit": 99999})
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# orderBy / sortDir — 2026-08 列表排序下沉 SQL（与桌面 DAO 逐条对账，闸见
# tests/config/test_email_sort_parity.py）。fixture 里两封：
#   1001 Alice / "Quarterly redis timeout review" / 2026-05-01 / 无 AI 列（降级）
#   1002 Carol / "Standalone no-body email"       / 2026-04-15 / 同上
# ---------------------------------------------------------------------------


def _ids(client, *, keep: "set[int] | None" = None, **params) -> list[int]:
    """list-enriched 的 id 序。

    ⚠️ 这个 DB fixture 是 **session 作用域**且被同目录别的测试插过行（跑单文件与跑
    全套的结果不同）。故一律用 ``keep`` 把结果收窄到本用例自己关心的 id 上，只断言
    它们**相对**的先后 —— 绝不写「整份列表恰好等于这两个」。
    """
    r = client.get("/api/email/list-enriched", params=params)
    assert r.status_code == 200, r.text
    ids = [row["internal_id"] for row in r.json()["data"]]
    return [i for i in ids if i in keep] if keep is not None else ids


PAIR = {EMAIL_ID, EMAIL_NO_BODY_ID}


def test_list_enriched_default_order_unchanged(client):
    """不传排序参数 = 历史行为（date DESC），远程端不因本次改动漂移。"""
    assert _ids(client, keep=PAIR) == [EMAIL_ID, EMAIL_NO_BODY_ID]


def test_list_enriched_order_by_date_both_directions(client):
    assert _ids(client, keep=PAIR, orderBy="date", sortDir="desc") == [
        EMAIL_ID,
        EMAIL_NO_BODY_ID,
    ]
    assert _ids(client, keep=PAIR, orderBy="date", sortDir="asc") == [
        EMAIL_NO_BODY_ID,
        EMAIL_ID,
    ]


def test_list_enriched_order_by_sender_uses_display_name(client):
    """sender 排序按显示名（Alice < Carol）；关键是两个方向对称且稳定。"""
    assert _ids(client, keep=PAIR, orderBy="sender", sortDir="asc") == [
        EMAIL_ID,
        EMAIL_NO_BODY_ID,
    ]
    assert _ids(client, keep=PAIR, orderBy="sender", sortDir="desc") == [
        EMAIL_NO_BODY_ID,
        EMAIL_ID,
    ]


def test_list_enriched_order_by_subject_case_insensitive(client, temp_db):
    """COLLATE NOCASE：小写 'aaa' 必须排在大写 'Quarterly' 之前（不加 NOCASE 时
    SQLite 的 BINARY 序会把所有大写字母排在小写之前 → 用户看到的是「乱序」）。"""
    import sqlite3

    row_id = 990010
    conn = sqlite3.connect(str(temp_db))
    try:
        conn.execute(
            """INSERT INTO email_metadata
               (internal_id, message_id, subject, sender, date_received, mailbox,
                is_read, is_flagged, sync_status, retry_count)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                row_id, "<sort-case@example.com>", "aaa lowercase subject",
                "zed@example.com", "2026-01-01 09:00:00", "收件箱",
                1, 0, "synced", 0,
            ),
        )
        conn.commit()
        # 只与 fixture 的 'Quarterly…' 比 —— 别的测试插的行不参与断言。
        order = _ids(client, keep={row_id, EMAIL_ID}, orderBy="subject", sortDir="asc")
        assert order == [row_id, EMAIL_ID]
    finally:
        conn.execute("DELETE FROM email_metadata WHERE internal_id = ?", (row_id,))
        conn.commit()
        conn.close()


def test_list_enriched_order_by_importance_unclassified_last_both_ways(client, temp_db):
    """🔴 未分类恒沉底 —— 升序也不许被顶到最前（null-guard 首列与方向无关）。

    fixture DDL 没有 ai_priority 列（降级路径），故 priority_raw 恒 NULL，两封
    都算未分类；这里另插一封带 labels_json 的行不可行（fixture 也没有
    llm_processing 表）。所以本用例验的是「全未分类时两个方向都不炸、且序稳定」，
    真正的名次断言在 frontend/tests/shared/emailSort.test.ts（SQL 模板）+
    emailListRows.test.ts（前端组排序）里。
    """
    desc = _ids(client, keep=PAIR, orderBy="importance", sortDir="desc")
    asc = _ids(client, keep=PAIR, orderBy="importance", sortDir="asc")
    assert set(desc) == set(asc) == PAIR
    # 全同名次 → 落到 internal_id 尾键，两个方向互为逆序。
    assert desc == list(reversed(asc))


def test_list_enriched_unknown_sort_params_fall_back_to_default(client):
    """非法值静默回落 date DESC（镜像 emailSort.ts::normalizeSortKey/Dir 的宽容
    语义），且**绝不**把输入拼进 SQL —— 注入串同样只是回落，不是 500。"""
    expected = [EMAIL_ID, EMAIL_NO_BODY_ID]
    assert _ids(client, keep=PAIR, orderBy="size", sortDir="sideways") == expected
    assert (
        _ids(
            client,
            keep=PAIR,
            orderBy="m.date_received; DROP TABLE email_metadata",
            sortDir="desc",
        )
        == expected
    )
    # 表还在（注入没落地）。
    assert _ids(client, keep=PAIR) == expected


def test_snippets_endpoint_removed(client):
    r = client.post("/api/email/snippets", json={"internalIds": [EMAIL_ID]})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/email/mailboxes
# ---------------------------------------------------------------------------


def test_list_mailboxes(client):
    r = client.get("/api/email/mailboxes")
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    data = body["data"]
    assert isinstance(data, list)
    inbox = next(m for m in data if m["mailbox"] == "收件箱")
    assert set(inbox) == {"mailbox", "total", "unread", "flagged", "failed"}
    # 2 emails in 收件箱; EMAIL_NO_BODY is read, EMAIL_ID unread+flagged.
    assert inbox["total"] == 2
    assert inbox["unread"] == 1
    assert inbox["flagged"] == 1
    assert body["meta"]["count"] == len(data)


# ---------------------------------------------------------------------------
# GET /api/email/thread/{thread_id}
# ---------------------------------------------------------------------------


def test_list_by_thread(client):
    # EMAIL_ID is on thread-A in the fixture.
    r = client.get("/api/email/thread/thread-A")
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    data = body["data"]
    assert [row["internal_id"] for row in data] == [EMAIL_ID]
    # list-item shape。2026-08 起含 to_addr —— 列表面的「收件人是我」筛选轴需要它，
    # 桌面 handlers/email.ts::shapeListItem 同步投影（两份 shaper 互为镜像）。
    assert data[0]["to_addr"] == "bob@example.com"
    assert "notion_url" in data[0]
    assert data[0]["snippet"].startswith("Hello **redis**")
    # v58 sender_email（task 08-14 WP-5）：本 conftest 的裸库**没有**这一列 ——
    # 键必须仍在 wire 上（前端 isBotSender 读它），值降级 None，靠 _probe_schema
    # 的 `NULL AS sender_email` 兜住。缺列时整条 query 报错才是真事故。
    assert data[0]["sender_email"] is None


def test_list_by_thread_unknown_empty(client):
    r = client.get("/api/email/thread/nonexistent-thread")
    assert r.status_code == 200
    assert r.json()["data"] == []


# ---------------------------------------------------------------------------
# POST /api/email/threads
# ---------------------------------------------------------------------------


def test_list_by_threads_batch(client):
    r = client.post(
        "/api/email/threads", json={"threadIds": ["thread-A", "ghost", "thread-A"]}
    )
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    data = body["data"]
    # Map keyed by thread_id; only thread-A has rows.
    assert set(data.keys()) == {"thread-A"}
    assert [row["internal_id"] for row in data["thread-A"]] == [EMAIL_ID]
    assert data["thread-A"][0]["snippet"].startswith("Hello **redis**")


def test_list_by_threads_empty_input(client):
    r = client.post("/api/email/threads", json={"threadIds": []})
    assert r.status_code == 200
    assert r.json()["data"] == {}
    # Missing key → also {}.
    r2 = client.post("/api/email/threads", json={})
    assert r2.status_code == 200
    assert r2.json()["data"] == {}


# ---------------------------------------------------------------------------
# POST /api/email/ai-fields
# ---------------------------------------------------------------------------


def test_ai_fields_degraded(client):
    r = client.post(
        "/api/email/ai-fields",
        json={"internalIds": [EMAIL_ID, EMAIL_NO_BODY_ID]},
    )
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    data = body["data"]
    # Both emails exist in metadata → both present, keyed by string id.
    assert {str(EMAIL_ID), str(EMAIL_NO_BODY_ID)}.issubset(data.keys())
    af = data[str(EMAIL_ID)]
    assert set(af) == {
        "internal_id", "processing_status", "mailbox", "is_read", "is_flagged",
        "ai_priority", "ai_action", "ai_review_status", "sentiment",
        "ai_model", "labels_raw",
        # task 08-27 P4a: 预处理执行详情的六个透传字段 (llm_processing 列名原样)。
        "llm_status", "latency_ms", "input_tokens", "output_tokens",
        "retry_count", "last_error",
    }
    assert af["mailbox"] == "收件箱"
    assert af["is_flagged"] is True
    # No llm_processing table / no processing_status col in fixture → degraded.
    assert af["ai_priority"] is None
    assert af["ai_review_status"] is None
    assert af["ai_model"] is None
    assert af["labels_raw"] is None
    assert af["processing_status"] is None
    for key in ("llm_status", "latency_ms", "input_tokens", "output_tokens",
                "retry_count", "last_error"):
        assert af[key] is None


def test_ai_fields_unknown_id_absent(client):
    r = client.post("/api/email/ai-fields", json={"internalIds": [424242]})
    assert r.status_code == 200
    assert r.json()["data"] == {}


def test_ai_fields_empty_input(client):
    r = client.post("/api/email/ai-fields", json={"internalIds": []})
    assert r.status_code == 200
    assert r.json()["data"] == {}


# ---------------------------------------------------------------------------
# C10 — batch size cap on IN(...) endpoints (threads / ai-fields /
# list-enriched internalIds). Over BATCH_IDS_MAX → 400 E_INVALID_ARG, before SQL.
# ---------------------------------------------------------------------------

from src.api.routers.email_views import BATCH_IDS_MAX  # noqa: E402

_OVER = BATCH_IDS_MAX + 1


def test_ai_fields_oversized_batch_400(client):
    r = client.post(
        "/api/email/ai-fields", json={"internalIds": list(range(_OVER))}
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_threads_oversized_batch_400(client):
    r = client.post(
        "/api/email/threads",
        json={"threadIds": [f"t-{i}" for i in range(_OVER)]},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_list_enriched_oversized_internalids_400(client):
    ids = ",".join(str(i) for i in range(_OVER))
    r = client.get("/api/email/list-enriched", params={"internalIds": ids})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_threads_dedupe_under_cap_ok(client):
    # C10 caps the DE-DUPED count: a body with > cap raw ids that collapses to
    # a handful of distinct values must pass (the IN(...) list is what matters).
    raw = ["thread-A"] * _OVER
    r = client.post("/api/email/threads", json={"threadIds": raw})
    assert r.status_code == 200
    assert set(r.json()["data"].keys()) == {"thread-A"}


# ---------------------------------------------------------------------------
# v58 sender_email 列的两条分支（task 08-14 WP-5）
# ---------------------------------------------------------------------------


def test_list_item_meta_cols_emits_sender_email_either_way():
    """键**恒在** wire 上：有列取列、无列取 NULL（本模块 conftest 的裸库走后者）。

    前端 `isBotSender` 读它；键缺席会让判据静默失效（`undefined` → 恒 false →
    机器人邮件全留在「重点」），而这正是本 WP 要消灭的失败形态。
    """
    from src.api.routers.email_views import _list_item_meta_cols

    with_col = _list_item_meta_cols({"sender_email", "snippet"})
    assert "sender_email AS sender_email" in with_col
    assert "NULL AS sender_email" not in with_col

    without_col = _list_item_meta_cols({"snippet"})
    assert "NULL AS sender_email" in without_col


# ---------------------------------------------------------------------------
# task 08-27 P4a: llm_processing 透传字段（失败行可见性修复, r10 §0）
# ---------------------------------------------------------------------------
# 本模块 conftest 的裸库没有 llm_processing 表（那些用例验降级）。这里用真
# SyncStore 建全表 + 播 success / failed 两行，验正路径：① ai-fields 六字段透传;
# ② list-enriched 带 llm_status —— 失败的预处理行 (没有 labels) 此前与「从没跑过」
# 在读侧无法区分，前端记录列因此永远看不见失败。


import pytest as _pytest  # noqa: E402


@_pytest.fixture()
def llm_client(tmp_path):
    """全 schema 临时库 (SyncStore) + 两行 llm_processing + repo 覆盖。"""
    import sqlite3 as _sqlite3
    import time as _time

    from src.api.app import app as _app
    from src.api.deps import get_repository as _get_repository
    from src.mail.sync_store import SyncStore as _SyncStore
    from src.repository import EmailRepository as _EmailRepository
    from fastapi.testclient import TestClient as _TestClient

    db = tmp_path / "llm_store.db"
    _SyncStore(str(db))
    now = _time.time()
    with _sqlite3.connect(str(db)) as conn:
        for iid, subject in ((21, "ok mail"), (22, "failed mail")):
            conn.execute(
                "INSERT INTO email_metadata (internal_id, message_id, subject, sender, "
                "mailbox, date_received, sync_status, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (iid, f"<m{iid}@x>", subject, "a@x.com", "收件箱",
                 "2026-08-28 09:00:00", "synced", now, now),
            )
        conn.execute(
            "INSERT INTO llm_processing (internal_id, status, model, input_tokens, "
            "output_tokens, latency_ms, retry_count, labels_json, created_at, updated_at) "
            "VALUES (21, 'success', 'mk', 900, 80, 1234, 0, "
            "'{\"priority\": \"🟡 重要\"}', ?, ?)",
            (now, now),
        )
        conn.execute(
            "INSERT INTO llm_processing (internal_id, status, retry_count, last_error, "
            "created_at, updated_at) VALUES (22, 'failed', 3, 'overloaded', ?, ?)",
            (now, now),
        )
        conn.commit()
    repo = _EmailRepository(db_path=str(db))
    _app.dependency_overrides[_get_repository] = lambda: repo
    with _TestClient(_app, raise_server_exceptions=False) as c:
        yield c
    _app.dependency_overrides.pop(_get_repository, None)


def test_ai_fields_projects_llm_processing_stats(llm_client):
    r = llm_client.post("/api/email/ai-fields", json={"internalIds": [21, 22]})
    assert r.status_code == 200
    data = r.json()["data"]
    ok = data["21"]
    assert ok["llm_status"] == "success"
    assert ok["latency_ms"] == 1234
    assert ok["input_tokens"] == 900 and ok["output_tokens"] == 80
    assert ok["retry_count"] == 0 and ok["last_error"] is None
    failed = data["22"]
    # 🔴 r10 §0 的缺陷根子: ai_review_status 把 failed 映成 'pending'，
    # llm_status 原始透传才让失败行在读侧分得出来。
    assert failed["ai_review_status"] == "pending"
    assert failed["llm_status"] == "failed"
    assert failed["retry_count"] == 3 and failed["last_error"] == "overloaded"


def test_list_enriched_carries_raw_llm_status(llm_client):
    r = llm_client.get("/api/email/list-enriched")
    assert r.status_code == 200
    by_id = {row["internal_id"]: row for row in r.json()["data"]}
    assert by_id[21]["llm_status"] == "success"
    # 失败行: 没有 labels ⇒ ai_priority 为 null, 但 llm_status 让它与
    # 「从没跑过」(llm_status null) 分得开 —— 前端按它筛记录列。
    assert by_id[22]["llm_status"] == "failed"
    assert by_id[22]["ai_priority"] is None
