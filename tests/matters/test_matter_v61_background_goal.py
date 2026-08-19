"""v61 —— matter.description → background + 新列 goal（2026-08-19）。

owner 推翻 08-18 那版「合存单字段、靠 `## 背景` / `## 目标` 小标题分段」的方案，
理由是避开解析的异常面。数据规则：**存量整串默认算背景，目标留空**；唯一例外是那一版
短命 UI（08-18 23:53 落地、次日推翻）写出的行首整行小标题，按段拆开落两列。

盯六形态：
① v60 老库升级：列改名 + 值**一字不改**地带过来，goal 为空串；
② 例外分支：真带行首整行小标题的行按段拆开（另一套安装可能有这种行）；
③ 假阳性不许误伤：`## 背景` 出现在行中间（不是整行）时整串仍算背景；
④ 重入幂等：version 拨回 60 重跑，两列都不再动，也不炸；
⑤ fresh create 与迁移后 matter **列集**等价（列序有偏移是 ALTER ADD 的既有事实）；
⑥ 检索投影两段都进：只喂 background 会让「按目标里的词搜事项」当场失效。

🔴 降级模拟用 RENAME COLUMN 的逆操作 + DROP 掉 v61 新增的 goal 列。仓内「迁移测试禁
DROP COLUMN」那条针对的是**丢数据列**；这里 drop 的是本迁移自己刚加的空列，是老形状的
精确还原。为稳妥仍走 SQLite 原生 `DROP COLUMN`（3.35+），不重建表。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore, split_legacy_matter_description
from src.matters.repository import MatterRepository
from src.matters.service import Actor, MatterService

NOW = 1_760_000_000_000
USER = Actor(kind="user", actor_id="me")

#: 那一版短命 UI 的产物：`## 背景` / `## 目标` 两个行首整行小标题。
HEADED = "## 背景\n三方排期互相不认\n\n## 目标\n拿到一份都认的排期"
#: 绝大多数存量行长这样 —— 一段没有任何小标题的散文。
PLAIN = "把 Atlas 推上生产，Q3 前完成验收。"
#: 假阳性诱饵：`## 背景` 在行**中间**，不是小标题。
INLINE = "会上讨论了 ## 背景 这个提法，最后没采纳。"


def _version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def _columns(path, table: str) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _downgrade_to_v60(path) -> None:
    """matter 退回 v60 形状（background → description，去掉 goal），version 拨回 60。"""
    with sqlite3.connect(path) as conn:
        conn.execute("ALTER TABLE matter DROP COLUMN goal")
        conn.execute("ALTER TABLE matter RENAME COLUMN background TO description")
        conn.execute("UPDATE sync_state SET value='60' WHERE key='db_version'")
        conn.commit()


def _seed_v60_rows(path, texts: list[str]) -> None:
    """直接按 v60 形状插行（走 SQL 而不是 service —— service 已经只认新列了）。"""
    with sqlite3.connect(path) as conn:
        for index, text in enumerate(texts, start=1):
            conn.execute(
                "INSERT INTO matter (public_id,title,description,tags_json,"
                "goal_checks_json,status,health,priority,source,version,"
                "created_at,updated_at) "
                "VALUES (?,?,?,'[]','[]','inbox','unknown','p1','test',1,?,?)",
                (f"MAT-{9000 + index}", f"seed-{index}", text, NOW, NOW),
            )
        conn.commit()


def _rows(path) -> dict[str, tuple[str, str]]:
    with sqlite3.connect(path) as conn:
        return {
            row[0]: (row[1], row[2])
            for row in conn.execute("SELECT public_id, background, goal FROM matter")
        }


@pytest.fixture
def migrated(tmp_path):
    """v61 fresh 库 → 降到 v60 → 灌三种形态的老行 → 重新迁到 v61。"""
    path = tmp_path / "v61.db"
    SyncStore(str(path))
    fresh_columns = _columns(path, "matter")
    _downgrade_to_v60(path)
    _seed_v60_rows(path, [PLAIN, HEADED, INLINE])
    SyncStore(str(path))
    return path, fresh_columns


# ============================================================
# ① 默认规则：整串原样进 background，goal 留空
# ============================================================

def test_plain_prose_moves_into_background_verbatim(migrated):
    path, _ = migrated
    assert _version(path) == "61"
    assert _rows(path)["MAT-9001"] == (PLAIN, "")


# ============================================================
# ② 例外：行首整行小标题按段拆开
# ============================================================

def test_the_short_lived_heading_shape_is_split_into_two_columns(migrated):
    """🔴 本机活库 0 条这种行，但别的安装可能有 —— 不拆 = 两段连着标题一起塞进背景。"""
    path, _ = migrated
    assert _rows(path)["MAT-9002"] == ("三方排期互相不认", "拿到一份都认的排期")


# ============================================================
# ③ 假阳性：`## 背景` 不在行首整行 → 不算小标题
# ============================================================

def test_inline_mention_of_a_heading_word_is_not_a_split_point(migrated):
    path, _ = migrated
    assert _rows(path)["MAT-9003"] == (INLINE, "")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("", ("", "")),
        ("只有正文", ("只有正文", "")),
        ("## 目标\n只有目标", ("", "只有目标")),
        # 小标题之前的散文归背景 —— 它本来就是交代来龙去脉的。
        ("前言\n## 目标\nG", ("前言", "G")),
        # 行尾空白允许，行首缩进不算小标题。
        ("## 背景  \nB", ("B", "")),
        ("  ## 背景\nB", ("  ## 背景\nB", "")),
        # 同名小标题出现多次 ⇒ 内容按出现顺序合并，不丢。
        ("## 目标\nA\n## 目标\nB", ("", "A\n\nB")),
    ],
)
def test_split_rule_edges(text, expected):
    assert split_legacy_matter_description(text) == expected


# ============================================================
# ④ 幂等：拨回 61 之前的版本重跑，结果一字不变
# ============================================================

def test_rerunning_the_migration_changes_nothing(migrated):
    path, _ = migrated
    before = _rows(path)
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE sync_state SET value='60' WHERE key='db_version'")
        conn.commit()
    SyncStore(str(path))
    assert _rows(path) == before


def test_owner_typing_a_heading_after_the_upgrade_is_never_re_split(migrated):
    """🔴 `goal = ''` 那道闸的意义：已经拆过的行不再进候选，owner 自己在背景里敲的
    `## 背景` 不会在下次重跑时被当成分段指令切走。"""
    path, _ = migrated
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE matter SET background = ? WHERE public_id = 'MAT-9002'",
            ("## 背景\nowner 自己敲的",),
        )
        conn.execute("UPDATE sync_state SET value='60' WHERE key='db_version'")
        conn.commit()
    SyncStore(str(path))
    assert _rows(path)["MAT-9002"] == ("## 背景\nowner 自己敲的", "拿到一份都认的排期")


# ============================================================
# ⑤ 迁移后的列集 == fresh 建库的列集
# ============================================================

def test_migrated_column_set_matches_a_fresh_database(migrated):
    path, fresh_columns = migrated
    assert _columns(path, "matter") == fresh_columns
    assert "description" not in fresh_columns
    assert {"background", "goal"} <= fresh_columns


# ============================================================
# ⑥ 检索投影：两段都得进那个文本桶
# ============================================================

def test_search_projection_carries_both_halves(tmp_path):
    """🔴 `matter_search_document.description` 是「背景 + 目标」合成的检索桶（有意不给
    fts5 改名）。只喂 background = 按目标里的词搜事项当场失效。"""
    path = tmp_path / "proj.db"
    SyncStore(str(path))
    service = MatterService(MatterRepository(str(path)), clock_ms=lambda: NOW)
    created = service.create_matter(
        {"title": "投影", "background": "背景里的独有词", "goal": "目标里的独有词"},
        idempotency_key="c",
        source="test",
        actor=USER,
    )["matter"]
    with sqlite3.connect(path) as conn:
        bucket = conn.execute(
            "SELECT d.description FROM matter_search_document d "
            "JOIN matter m ON m.id = d.matter_id WHERE m.public_id = ?",
            (created["public_id"],),
        ).fetchone()[0]
    assert "背景里的独有词" in bucket
    assert "目标里的独有词" in bucket
