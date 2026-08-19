"""v62 folder_pref — 建表 / env 播种 / CRUD / 重命名与删除时的行迁移。

覆盖三件容易静默出错的事:
1. **播种跨名字空间且两键极性相反** —— env 存 mailbox 显示名, 表 PK 是 IMAP 原始名;
   notify 是白名单 (在名单 → 1), llm 是黑名单 (在名单 → 1)。抄反了行为完全颠倒,
   而两列都是 0/1, 类型上看不出来。
2. **重命名让 pref 行变孤儿** —— PK 是 imap 路径, IMAP RENAME 之后原行再也匹配不上,
   图标和两个开关静默丢失且没有任何报错。
3. **迁移必须可重复执行** —— 老库升级路上每个中间版本都可能重放。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import (
    FolderGates,
    SyncStore,
    _folder_pref_seed_rows,
)


# ============================================================
# 建表
# ============================================================

def test_fresh_db_has_folder_pref_table_and_label_index(tmp_path):
    """全新库走满梯子 → 表 + 热读索引都在, 版本到 62。"""
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='folder_pref'"
        ).fetchone() is not None
        assert conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_folder_pref_label'"
        ).fetchone() is not None
        assert conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0] == str(SyncStore.DB_VERSION)
    assert SyncStore.DB_VERSION >= 62


def test_folder_pref_column_defaults_are_the_gate_defaults(tmp_path):
    """只给 PK 建行 → 两列都是 0。

    🔴 0 的含义两列**不同**: notify_enabled=0 是「不推飞书」, llm_disabled=0 是
    「照跑 LLM」—— 建行不该顺手把 AI 关掉。
    """
    store = SyncStore(str(tmp_path / "d.db"))
    row = store.upsert_folder_pref("Teams")
    assert row["notify_enabled"] is False
    assert row["llm_disabled"] is False
    assert row["icon"] is None
    assert store.get_folder_gates("Teams") == FolderGates(
        row_exists=True, notify_enabled=False, llm_disabled=False
    )


# ============================================================
# env → 行 的播种映射 (v62 迁移的数据规则)
# ============================================================

class _FakeSettings:
    def __init__(self, sync_folders="", notify="", llm=""):
        self.sync_folders = sync_folders
        self.folder_notify_enabled = notify
        self.folder_llm_disabled = llm


@pytest.fixture()
def seed_env(monkeypatch):
    """替换 ``src.config.config`` 单例 —— 播种函数是在调用时才 import 它的。"""

    def _apply(**kwargs):
        monkeypatch.setattr("src.config.config", _FakeSettings(**kwargs), raising=False)

    return _apply


def test_seed_maps_display_name_to_imap_name(seed_env):
    """env 里的显示名 → SYNC_FOLDERS 里对应的 IMAP 原始名 (decode 后相等的那个)。"""
    seed_env(
        sync_folders='["Teams","DMS&VvpO9lPRXgM-"]',
        notify='["DMS固件发布"]',
    )
    assert _folder_pref_seed_rows() == [("DMS&VvpO9lPRXgM-", "DMS固件发布", 1, 0)]


def test_seed_polarity_notify_is_whitelist_llm_is_blacklist(seed_env):
    """🔴 两键极性相反: 同一个文件夹同时进两个名单 → notify=1 且 llm_disabled=1。

    这个断言是整批里最容易写反的一处 —— 抄反的实现会得到 (0, 0)。
    """
    seed_env(sync_folders='["Teams"]', notify='["Teams"]', llm='["Teams"]')
    assert _folder_pref_seed_rows() == [("Teams", "Teams", 1, 1)]


def test_seed_polarity_in_notify_only(seed_env):
    """只进白名单 → 推飞书 (1) + 照跑 LLM (llm_disabled=0)。"""
    seed_env(sync_folders='["Teams"]', notify='["Teams"]')
    assert _folder_pref_seed_rows() == [("Teams", "Teams", 1, 0)]


def test_seed_polarity_in_llm_blacklist_only(seed_env):
    """只进黑名单 → 不推飞书 (notify=0) + 跳过 LLM (llm_disabled=1)。"""
    seed_env(sync_folders='["Teams"]', llm='["Teams"]')
    assert _folder_pref_seed_rows() == [("Teams", "Teams", 0, 1)]


def test_seed_skips_all_default_folders(seed_env):
    """白名单里配置全默认的文件夹不占行 —— 「行缺失 = 默认」与 gate 的回退语义自洽。"""
    seed_env(sync_folders='["Teams","DMS&VvpO9lPRXgM-"]', llm='["Teams"]')
    assert _folder_pref_seed_rows() == [("Teams", "Teams", 0, 1)]


def test_seed_empty_env_seeds_nothing(seed_env):
    """两个键都空 (owner 本机现状) → 一行都不播, 表空 = 全默认 = 升级前行为。"""
    seed_env(sync_folders='["Teams","DMS&VvpO9lPRXgM-"]')
    assert _folder_pref_seed_rows() == []


def test_seed_ignores_names_absent_from_sync_folders(seed_env):
    """env 里有、SYNC_FOLDERS 里没有 → 无 imap_name 可作 PK, 不播种并 warning。"""
    seed_env(sync_folders='["Teams"]', notify='["Jira"]')
    assert _folder_pref_seed_rows() == []


def test_seed_skips_inbox(seed_env):
    """INBOX 走主路径, 不是自定义文件夹 (两个 gate 也不管它) → 不播种。"""
    seed_env(sync_folders='["INBOX","Teams"]', notify='["INBOX","Teams"]')
    assert _folder_pref_seed_rows() == [("Teams", "Teams", 1, 0)]


# ============================================================
# 迁移: 落库 + 幂等
# ============================================================

def _downgrade_to_v61(path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE sync_state SET value='61' WHERE key='db_version'")
        conn.commit()


def test_migration_seeds_rows_from_env(tmp_path, seed_env):
    seed_env(sync_folders='["Teams","DMS&VvpO9lPRXgM-"]', notify='["Teams"]', llm='["DMS固件发布"]')
    path = tmp_path / "seed.db"
    SyncStore(str(path))
    rows = SyncStore(str(path)).list_folder_prefs()
    assert [(r["imap_name"], r["mailbox_label"], r["notify_enabled"], r["llm_disabled"]) for r in rows] == [
        ("DMS&VvpO9lPRXgM-", "DMS固件发布", False, True),
        ("Teams", "Teams", True, False),
    ]


def test_migration_is_repeatable_and_does_not_clobber_user_edits(tmp_path, seed_env):
    """重放 v62: 结果不变, 且**不覆盖**用户在 UI 改过的值 (INSERT OR IGNORE)。"""
    seed_env(sync_folders='["Teams"]', notify='["Teams"]')
    path = tmp_path / "replay.db"
    store = SyncStore(str(path))
    # 用户在 Settings 里把通知关掉 + 选了个图标。
    store.upsert_folder_pref("Teams", icon="folder-check", notify_enabled=False)

    _downgrade_to_v61(path)
    store2 = SyncStore(str(path))          # 重跑 v62

    rows = store2.list_folder_prefs()
    assert len(rows) == 1
    assert rows[0]["notify_enabled"] is False   # 播种没把它翻回 1
    assert rows[0]["icon"] == "folder-check"


def test_migration_survives_unavailable_settings(tmp_path, monkeypatch):
    """config 取不到 (裸测试环境) → 不播种, 建表照常, 版本照常前进。"""
    def _boom(*a, **k):
        raise RuntimeError("no settings")

    monkeypatch.setattr("src.mail.sync_store._folder_pref_seed_rows", _boom)
    path = tmp_path / "nocfg.db"
    store = SyncStore(str(path))
    assert store.list_folder_prefs() == []
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0] == str(SyncStore.DB_VERSION)
    assert SyncStore.DB_VERSION >= 62


# ============================================================
# 部分更新
# ============================================================

def test_upsert_is_partial_and_icon_none_clears(tmp_path):
    """省略的字段保持原值; ``icon=None`` 是**清除**而不是"不改"。"""
    store = SyncStore(str(tmp_path / "p.db"))
    store.upsert_folder_pref("Teams", icon="folder-check", notify_enabled=True, llm_disabled=True)

    row = store.upsert_folder_pref("Teams", notify_enabled=False)   # 只动 notify
    assert row["icon"] == "folder-check"
    assert row["llm_disabled"] is True
    assert row["notify_enabled"] is False

    row = store.upsert_folder_pref("Teams", icon=None)              # 只清 icon
    assert row["icon"] is None
    assert row["llm_disabled"] is True
    assert row["notify_enabled"] is False


def test_has_any_llm_disabled_probe(tmp_path):
    store = SyncStore(str(tmp_path / "probe.db"))
    assert store.has_any_llm_disabled() is False
    store.upsert_folder_pref("Teams", notify_enabled=True)      # 开通知不算关 AI
    assert store.has_any_llm_disabled() is False
    store.upsert_folder_pref("Teams", llm_disabled=True)
    assert store.has_any_llm_disabled() is True


# ============================================================
# 🔴 重命名 / 删除时的行迁移 (不做就是静默丢配置)
# ============================================================

def test_rename_moves_pref_row_to_new_imap_name(tmp_path):
    """改名后配置跟着走 —— 旧名查不到, 新名拿回原来的图标与两个开关。"""
    store = SyncStore(str(tmp_path / "r.db"))
    store.upsert_folder_pref("Teams", icon="folder-check", notify_enabled=True, llm_disabled=True)

    moved = store.rename_folder_pref("Teams", "TeamWork")
    assert moved == 1

    assert store.get_folder_gates("Teams").row_exists is False
    row = store.list_folder_prefs()[0]
    assert row["imap_name"] == "TeamWork"
    assert row["icon"] == "folder-check"
    assert row["notify_enabled"] is True
    assert row["llm_disabled"] is True


def test_rename_recomputes_mailbox_label(tmp_path):
    """派生列跟着重算 —— 否则热读 (按 label 查) 在改名后就再也命中不了。"""
    store = SyncStore(str(tmp_path / "rl.db"))
    store.upsert_folder_pref("Teams", llm_disabled=True)

    store.rename_folder_pref("Teams", "DMS&VvpO9lPRXgM-")

    assert store.get_folder_gates("Teams").row_exists is False
    assert store.get_folder_gates("DMS固件发布") == FolderGates(
        row_exists=True, notify_enabled=False, llm_disabled=True
    )


def test_rename_parent_migrates_child_rows(tmp_path):
    """重命名父文件夹 → 子文件夹的 imap 路径也变了, 它们的 pref 行同样要搬。

    只做精确匹配会漏掉每一个子文件夹 (与 _rename_local_mailbox 的子前缀处理同理)。
    """
    store = SyncStore(str(tmp_path / "rc.db"))
    store.upsert_folder_pref("Proj", icon="folder-open")
    store.upsert_folder_pref("Proj/DMS&VvpO9lPRXgM-", icon="folder-sync", llm_disabled=True)
    store.upsert_folder_pref("Other", icon="folder")

    moved = store.rename_folder_pref("Proj", "Project")
    assert moved == 2

    names = {r["imap_name"]: r for r in store.list_folder_prefs()}
    assert set(names) == {"Project", "Project/DMS&VvpO9lPRXgM-", "Other"}
    child = names["Project/DMS&VvpO9lPRXgM-"]
    assert child["icon"] == "folder-sync"
    assert child["llm_disabled"] is True
    # 派生列按新全路径重算 (不是字符串拼接 —— 前缀含中文时 base64 段边界会变)。
    assert child["mailbox_label"] == "Project/DMS固件发布"
    assert names["Other"]["icon"] == "folder"      # 无关行没被波及


def test_rename_noop_cases(tmp_path):
    store = SyncStore(str(tmp_path / "rn.db"))
    store.upsert_folder_pref("Teams", icon="folder-check")
    assert store.rename_folder_pref("Teams", "Teams") == 0    # 同名
    assert store.rename_folder_pref("", "X") == 0
    assert store.rename_folder_pref("Nope", "X") == 0         # 没有这一行
    assert store.list_folder_prefs()[0]["icon"] == "folder-check"


def test_delete_removes_row_and_children(tmp_path):
    store = SyncStore(str(tmp_path / "del.db"))
    store.upsert_folder_pref("Proj", icon="folder-open")
    store.upsert_folder_pref("Proj/Sub", icon="folder-sync")
    store.upsert_folder_pref("Project", icon="folder")        # 前缀相近但不是子文件夹

    assert store.delete_folder_pref("Proj") == 2
    assert [r["imap_name"] for r in store.list_folder_prefs()] == ["Project"]
