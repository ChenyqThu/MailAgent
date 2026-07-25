"""src/kos/stats.py — 台账聚合单源的单测 (PRD R6/R8)。

fixture 只建 ``kos_ingest_log`` + ``sync_state`` 两张表 (聚合函数只读这两张)，
不跑整套 SyncStore migration。台账 DDL 从 ``sync_store`` 的单源常量取，不手抄
—— 手抄一份就是第四份 schema，改列时静默漂移。
"""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from src.kos.ingest_log import (
    STATE_HEALTH_CHECKED_AT,
    STATE_HEALTH_CONSEC_FAILURES,
    STATE_HEALTH_ERROR,
    STATE_HEALTH_STATUS,
    STATE_LAST_SUCCESS_AT,
)
from src.kos.stats import collect_kos_stats
from src.mail.sync_store import KOS_INGEST_LOG_TABLE_DDL as _DDL_LOG

_DDL_STATE = """
CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at REAL
)
"""


@pytest.fixture()
def db(tmp_path: Path) -> Path:
    """空库 —— 两张表都建好，无数据。"""
    path = tmp_path / "sync_store.db"
    conn = sqlite3.connect(str(path))
    conn.execute(_DDL_LOG)
    conn.execute(_DDL_STATE)
    conn.commit()
    conn.close()
    return path


@pytest.fixture()
def bare_db(tmp_path: Path) -> Path:
    """裸库 —— 一张表都没有 (全新 install / KOS 从未启用)。"""
    path = tmp_path / "bare.db"
    sqlite3.connect(str(path)).close()
    return path


# v41 之前 BulkIngester._ensure_log_table() 惰性建的 6 列老形状 (无 error_code /
# retry_count / next_retry_at / source)。本机两个真库上线时都是这个状态。
_DDL_LOG_LEGACY = """
CREATE TABLE kos_ingest_log (
    internal_id INTEGER PRIMARY KEY,
    slug TEXT,
    status TEXT,
    chunks INTEGER,
    error TEXT,
    pushed_at REAL
)
"""


@pytest.fixture()
def legacy_db(tmp_path: Path) -> Path:
    """老形状库 —— 表在但缺 v41 新列 (装了新版、后端还没重启跑迁移的窗口)。"""
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(str(path))
    conn.execute(_DDL_LOG_LEGACY)
    conn.execute(_DDL_STATE)
    conn.commit()
    conn.close()
    return path


@pytest.fixture(autouse=True)
def _pin_enabled_env(monkeypatch: pytest.MonkeyPatch):
    """把 enabled 判据钉成 disabled —— 否则会热读开发机真 .env, 结果随机器漂。"""
    monkeypatch.setenv("MAILAGENT_KOS_INGEST_ENABLED", "false")


def _insert(db: Path, rows: list[tuple]) -> None:
    conn = sqlite3.connect(str(db))
    conn.executemany(
        "INSERT INTO kos_ingest_log "
        "(internal_id, status, pushed_at, retry_count, next_retry_at, error_code, source) "
        "VALUES (?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()


def _set_state(db: Path, pairs: dict[str, str]) -> None:
    conn = sqlite3.connect(str(db))
    conn.executemany(
        "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?,?,?)",
        [(k, v, time.time()) for k, v in pairs.items()],
    )
    conn.commit()
    conn.close()


# ============================================================
# 边界 / 防御
# ============================================================

def test_days_zero_rejected(db: Path):
    with pytest.raises(ValueError):
        collect_kos_stats(db, days=0)


def test_table_missing_returns_zero_shape(bare_db: Path):
    """裸库不抛 —— 零值 + 与 live_query 完全一致的字段集。"""
    data = collect_kos_stats(bare_db, days=7)

    assert data["_source"] == "table_missing"
    assert data["total"] == 0
    assert data["by_status"] == {"pushed": 0, "failed": 0, "dead": 0, "skipped": 0}
    assert data["by_error_code"] == {}
    assert data["pending_retry"] == 0
    assert data["dead_count"] == 0
    assert data["last_success_ts"] is None
    assert data["health"] is None  # 从未探活 → null, 不是字段全 null 的对象
    assert len(data["daily"]) == 7  # 空日照样补齐, Sparkline 要等距


def test_table_missing_and_live_share_field_set(bare_db: Path, db: Path):
    """两个分支的 key 集合必须一致 —— 前端不该为 table_missing 分支写特例。"""
    assert set(collect_kos_stats(bare_db, days=7)) == set(collect_kos_stats(db, days=7))


# ============================================================
# 老形状库 (v41 前的 6 列) —— 不崩, 且不清零真实数据
# ============================================================

def test_legacy_schema_does_not_crash(legacy_db: Path):
    """缺 error_code 列时不抛 OperationalError (前端拿 traceback = 「加载失败」)。"""
    now = time.time()
    conn = sqlite3.connect(str(legacy_db))
    conn.executemany(
        "INSERT INTO kos_ingest_log (internal_id, status, pushed_at) VALUES (?,?,?)",
        [(1, "pushed", now), (2, "pushed", now), (3, "failed", now)],
    )
    conn.commit()
    conn.close()

    data = collect_kos_stats(legacy_db, days=7, now=now)

    assert data["_source"] == "schema_stale"
    # 老形状里 status / pushed_at 都在 → 真实数据照常统计, 不清零。
    assert data["by_status"]["pushed"] == 2
    assert data["by_status"]["failed"] == 1
    assert data["total"] == 3
    assert data["pending_retry"] == 1
    assert sum(d["pushed"] for d in data["daily"]) == 2
    # 只有错误码分布拿不到 (老形状没这列)。
    assert data["by_error_code"] == {}


def test_legacy_schema_shares_field_set(legacy_db: Path, db: Path):
    assert set(collect_kos_stats(legacy_db, days=7)) == set(collect_kos_stats(db, days=7))


def test_empty_table(db: Path):
    data = collect_kos_stats(db, days=7)
    assert data["_source"] == "live_query"
    assert data["total"] == 0
    assert data["by_status"] == {"pushed": 0, "failed": 0, "dead": 0, "skipped": 0}


def test_sync_state_missing_table_tolerated(tmp_path: Path):
    """只有台账表、没有 sync_state (两条链路独立) → 健康块降级为空, 不抛。"""
    path = tmp_path / "no_state.db"
    conn = sqlite3.connect(str(path))
    conn.execute(_DDL_LOG)
    conn.commit()
    conn.close()

    data = collect_kos_stats(path, days=7)
    assert data["_source"] == "live_query"
    assert data["health"] is None
    assert data["last_success_ts"] is None


# ============================================================
# status / error_code 分布
# ============================================================

def test_by_status_all_four(db: Path):
    now = time.time()
    _insert(db, [
        (1, "pushed", now, 0, None, None, "producer"),
        (2, "pushed", now, 0, None, None, "bulk"),
        (3, "failed", now, 2, now + 300, "E_KOS_NETWORK", "producer"),
        (4, "dead", now, 5, None, "E_KOS_TOKEN_NETWORK", "producer"),
        (5, "skipped", now, 0, None, None, "producer"),
    ])

    data = collect_kos_stats(db, days=7)
    assert data["by_status"] == {"pushed": 2, "failed": 1, "dead": 1, "skipped": 1}
    assert data["total"] == 5


def test_by_error_code_covers_failed_and_dead(db: Path):
    """dead 也是失败终态 —— 错误码分布要含它, 否则「失败集中在哪个码」会漏报。"""
    now = time.time()
    _insert(db, [
        (1, "failed", now, 1, now, "E_KOS_NETWORK", "producer"),
        (2, "failed", now, 1, now, "E_KOS_NETWORK", "producer"),
        (3, "dead", now, 5, None, "E_KOS_TOKEN_NETWORK", "producer"),
        (4, "pushed", now, 0, None, None, "producer"),   # 成功行不进错误码分布
        (5, "skipped", now, 0, None, None, "producer"),  # 跳过行同理
    ])

    data = collect_kos_stats(db, days=7)
    assert data["by_error_code"] == {"E_KOS_NETWORK": 2, "E_KOS_TOKEN_NETWORK": 1}


def test_null_error_code_bucketed(db: Path):
    now = time.time()
    _insert(db, [(1, "failed", now, 1, now, None, "producer")])
    assert collect_kos_stats(db, days=7)["by_error_code"] == {"(null)": 1}


def test_unknown_status_preserved(db: Path):
    """值域外的 status 不吞 —— 出现即可见 (否则 total 与四个已知桶对不上)。"""
    now = time.time()
    _insert(db, [(1, "weird", now, 0, None, None, "producer")])
    data = collect_kos_stats(db, days=7)
    assert data["by_status"]["weird"] == 1
    assert data["total"] == 1


# ============================================================
# 窗口语义
# ============================================================

def test_window_filters_by_pushed_at(db: Path):
    now = time.time()
    old = now - 30 * 86400
    _insert(db, [
        (1, "pushed", now, 0, None, None, "producer"),
        (2, "pushed", old, 0, None, None, "producer"),
    ])

    assert collect_kos_stats(db, days=7)["by_status"]["pushed"] == 1
    assert collect_kos_stats(db, days=-1)["by_status"]["pushed"] == 2


def test_backlog_counts_ignore_window(db: Path):
    """10 天前失败的行今天照样要重试 —— 按窗口裁掉会谎报「没有积压」。"""
    now = time.time()
    old = now - 30 * 86400
    _insert(db, [
        (1, "failed", old, 2, old, "E_KOS_NETWORK", "producer"),
        (2, "dead", old, 5, None, "E_KOS_RPC", "producer"),
    ])

    data = collect_kos_stats(db, days=7)
    assert data["by_status"]["failed"] == 0  # 窗口内确实没有
    assert data["pending_retry"] == 1        # 但积压是全量事实
    assert data["dead_count"] == 1


def test_since_ts_set_only_for_positive_days(db: Path):
    assert collect_kos_stats(db, days=7)["since_ts"] is not None
    assert collect_kos_stats(db, days=-1)["since_ts"] is None


# ============================================================
# daily 分桶
# ============================================================

def test_daily_buckets_zero_filled_and_ordered(db: Path):
    now = time.time()
    day_ago = now - 86400
    _insert(db, [
        (1, "pushed", now, 0, None, None, "producer"),
        (2, "pushed", now, 0, None, None, "producer"),
        (3, "failed", now, 1, now, "E_KOS_NETWORK", "producer"),
        (4, "dead", day_ago, 5, None, "E_KOS_RPC", "producer"),
    ])

    daily = collect_kos_stats(db, days=3, now=now)["daily"]
    assert [d["date"] for d in daily] == sorted(d["date"] for d in daily)
    assert len(daily) == 3

    today = datetime.fromtimestamp(now).date().isoformat()
    yesterday = (datetime.fromtimestamp(now).date() - timedelta(days=1)).isoformat()
    by_date = {d["date"]: d for d in daily}
    assert by_date[today] == {"date": today, "pushed": 2, "failed": 1}
    assert by_date[yesterday] == {"date": yesterday, "pushed": 0, "failed": 1}


def test_daily_not_zero_filled_for_all_time(db: Path):
    """days=-1 只返有数据的日子 —— 从最早一行补到今天可能是几千个点。"""
    now = time.time()
    _insert(db, [(1, "pushed", now - 400 * 86400, 0, None, None, "bulk")])
    assert len(collect_kos_stats(db, days=-1)["daily"]) == 1


def test_daily_skips_null_pushed_at(db: Path):
    """pushed_at 为空的行 (理论上不该有) 不进任何桶, 也不炸。"""
    now = time.time()
    _insert(db, [
        (1, "failed", None, 1, now, "E_KOS_NETWORK", "producer"),
        (2, "pushed", now, 0, None, None, "producer"),
    ])
    daily = collect_kos_stats(db, days=2, now=now)["daily"]
    assert sum(d["pushed"] for d in daily) == 1
    assert sum(d["failed"] for d in daily) == 0


# ============================================================
# sync_state (kos.*) 读侧
# ============================================================

def test_health_and_last_success_from_sync_state(db: Path):
    _set_state(db, {
        STATE_LAST_SUCCESS_AT: "1753400000.5",
        STATE_HEALTH_STATUS: "ok",
        STATE_HEALTH_CHECKED_AT: "1753400001.0",
        STATE_HEALTH_ERROR: "",
        STATE_HEALTH_CONSEC_FAILURES: "0",
    })

    data = collect_kos_stats(db, days=7)
    assert data["last_success_ts"] == pytest.approx(1753400000.5)
    assert data["health"] == {
        "ok": True,
        "checked_at": pytest.approx(1753400001.0),
        "detail": None,  # 空串 → None (「没有失败原因」而不是「原因是空字符串」)
        "consecutive_failed_rounds": 0,
    }


def test_unhealthy_state(db: Path):
    _set_state(db, {
        STATE_HEALTH_STATUS: "error",
        STATE_HEALTH_ERROR: "E_KOS_HEALTH: health request failed",
        STATE_HEALTH_CONSEC_FAILURES: "3",
    })
    health = collect_kos_stats(db, days=7)["health"]
    assert health["ok"] is False
    assert health["detail"] == "E_KOS_HEALTH: health request failed"
    assert health["consecutive_failed_rounds"] == 3


def test_health_is_none_when_never_probed(db: Path):
    """🔴 从未探活必须返 None, 不是字段全 null 的对象。

    前端判据 ``health == null ? 未探测 : health.ok ? 正常 : 异常`` —— 返回一个
    ``ok`` 缺席的对象会让 ``health == null`` 为 false、``health.ok`` 为 undefined
    → falsy → 刚升级、从未探活过的机器全部误报「KOS 异常」。
    """
    assert collect_kos_stats(db, days=7)["health"] is None

    # 只有 last_success 没有 health.* 时同样是「从未探活」。
    _set_state(db, {STATE_LAST_SUCCESS_AT: "1753400000.0"})
    assert collect_kos_stats(db, days=7)["health"] is None

    # 空串 status 也算从未探活 (写侧从没落过有效值)。
    _set_state(db, {STATE_HEALTH_STATUS: "  "})
    assert collect_kos_stats(db, days=7)["health"] is None


def test_health_none_in_every_branch(bare_db: Path, legacy_db: Path, db: Path):
    """三个降级分支都走同一个 _health_block —— 不能有哪个分支漏成对象。"""
    for path in (bare_db, legacy_db, db):
        assert collect_kos_stats(path, days=7)["health"] is None


def test_timestamps_accept_iso(db: Path):
    """写侧的 canonical 格式是 ISO (``datetime.now().isoformat()``)。"""
    _set_state(db, {STATE_LAST_SUCCESS_AT: "2026-07-25T10:00:00"})
    assert collect_kos_stats(db, days=7)["last_success_ts"] == pytest.approx(
        datetime.fromisoformat("2026-07-25T10:00:00").timestamp()
    )


def test_timestamps_accept_epoch(db: Path):
    """epoch 字符串也吃 —— 写侧曾是 epoch, 老库里可能还留着这种值。"""
    _set_state(db, {STATE_LAST_SUCCESS_AT: "1753400000.5"})
    assert collect_kos_stats(db, days=7)["last_success_ts"] == pytest.approx(1753400000.5)


# ============================================================
# 🔴 跨模块 round-trip: 用写侧真函数落盘, 读侧解出来
# ============================================================
# 上面那些用例都是手写 fixture —— 手写的格式对不代表写侧真的写这个格式。
# 时间戳格式在本 task 中途从 epoch 改过 ISO 一次, 只有真调写侧函数的闸能挡住
# 下一次格式漂移 (手写 fixture 会跟着我改, 两边一起绿, 运行时静默错)。

def test_roundtrip_health_from_real_writer(db: Path):
    from src.kos import ingest_log

    ingest_log.record_health(str(db), healthy=False, error="E_KOS_HEALTH: refused")
    health = collect_kos_stats(db, days=7)["health"]

    assert health is not None, "写侧探过活了, 读侧不该报「从未探活」"
    assert health["ok"] is False
    assert health["detail"] == "E_KOS_HEALTH: refused"
    assert health["consecutive_failed_rounds"] == 1
    # 解析失败会是 None —— 那正是格式漂移的症状。
    assert health["checked_at"] == pytest.approx(time.time(), abs=10)

    ingest_log.record_health(str(db), healthy=True)
    health = collect_kos_stats(db, days=7)["health"]
    assert health["ok"] is True
    assert health["detail"] is None  # 恢复时写侧置 '' → 读侧归一成 None
    assert health["consecutive_failed_rounds"] == 0


def test_roundtrip_last_success_from_real_writer(db: Path):
    from src.kos import ingest_log

    ingest_log.record_pushed(
        str(db), internal_id=42, slug="sources/email/42", chunks=3, source="producer",
    )
    data = collect_kos_stats(db, days=7)

    assert data["last_success_ts"] == pytest.approx(time.time(), abs=10)
    assert data["by_status"]["pushed"] == 1


def test_dirty_state_values_tolerated(db: Path):
    """脏值不炸 —— 读侧不因写侧写歪一个键就整块 500。"""
    _set_state(db, {
        STATE_LAST_SUCCESS_AT: "not-a-timestamp",
        STATE_HEALTH_CONSEC_FAILURES: "n/a",
    })
    data = collect_kos_stats(db, days=7)
    assert data["last_success_ts"] is None
    assert data["health"] is None  # STATE_HEALTH_STATUS 没落过 → 从未探活


# ============================================================
# enabled 判据 (producer 面, env 派生)
# ============================================================

def _set_producer_env(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    """四个键全显式落 os.environ —— 不落的键会热读开发机 .env, 测试就不确定了。"""
    env = {
        "MAILAGENT_KOS_INGEST_ENABLED": "true",
        "KOS_MCP_BASE": "https://kos.example.test",
        "MAILAGENT_BULK_CLIENT_ID": "cid",
        "MAILAGENT_BULK_CLIENT_SECRET": "secret",
    }
    env.update(overrides)
    for k, v in env.items():
        monkeypatch.setenv(k, v)


def test_enabled_true_when_flag_and_all_credentials(db: Path, monkeypatch):
    _set_producer_env(monkeypatch)
    assert collect_kos_stats(db, days=7)["enabled"] is True


def test_enabled_false_when_flag_off(db: Path, monkeypatch):
    _set_producer_env(monkeypatch, MAILAGENT_KOS_INGEST_ENABLED="false")
    assert collect_kos_stats(db, days=7)["enabled"] is False


@pytest.mark.parametrize(
    "missing",
    ["KOS_MCP_BASE", "MAILAGENT_BULK_CLIENT_ID", "MAILAGENT_BULK_CLIENT_SECRET"],
)
def test_enabled_false_when_any_credential_blank(db: Path, monkeypatch, missing: str):
    """开关开着但凭据缺一个 → disabled (推不出去, 监控区显示了也是恒空)。"""
    _set_producer_env(monkeypatch, **{missing: "   "})
    assert collect_kos_stats(db, days=7)["enabled"] is False


def test_enabled_ignores_consumer_credentials(db: Path, monkeypatch):
    """🔴 判据是 producer 面 —— chat 的 KOS_OAUTH_CLIENT_* 配齐也不算数。

    两套凭据混用会让「chat 能读但从没推送过」的机器显示一个恒空监控区。
    """
    _set_producer_env(
        monkeypatch, MAILAGENT_BULK_CLIENT_ID="", MAILAGENT_BULK_CLIENT_SECRET=""
    )
    monkeypatch.setenv("KOS_OAUTH_CLIENT_ID", "consumer-cid")
    monkeypatch.setenv("KOS_OAUTH_CLIENT_SECRET", "consumer-secret")
    assert collect_kos_stats(db, days=7)["enabled"] is False


def test_enabled_present_in_every_branch(bare_db: Path, legacy_db: Path, db: Path, monkeypatch):
    _set_producer_env(monkeypatch)
    for path in (bare_db, legacy_db, db):
        assert collect_kos_stats(path, days=7)["enabled"] is True
