"""S5 W5a — project_progress agent_config 行内热读 + v31 迁移 seed + 行为等价回归。

核心验收：迁移 seed 后从行热读重建的 ProjectProgressDetector，与旧 env-detector 逐输入同判定
（trigger_json 复用 email_filter 字段名，但走子串-sender / 正则-subject 语义，逐字不变）。
"""
from __future__ import annotations

import json
import sqlite3

from src.mail.sync_store import SyncStore
from src.project_progress.agent_config import (
    PROJECT_PROGRESS_AGENT_ID,
    get_project_progress_agent_config,
)
from src.project_progress.detector import ProjectProgressDetector


def _seed_env(monkeypatch, *, auto: bool, subject: str, sender: str) -> None:
    """把迁移 seed 读的 env（pydantic config 单例）设成受控值。"""
    from src.config import config

    monkeypatch.setattr(config, "project_progress_auto_sync_enabled", auto)
    monkeypatch.setattr(config, "project_progress_subject_pattern", subject)
    monkeypatch.setattr(config, "project_progress_sender", sender)


def _row(db) -> sqlite3.Row | None:
    conn = sqlite3.connect(str(db))
    try:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM report_agent WHERE id = ?", (PROJECT_PROGRESS_AGENT_ID,)
        ).fetchone()
    finally:
        conn.close()


# ── 迁移 seed ────────────────────────────────────────────────────────────────


def test_v31_seeds_row_from_env(tmp_path, monkeypatch):
    _seed_env(monkeypatch, auto=True, subject=r"\[weekly\] progress", sender="weekly@corp.com")
    db = tmp_path / "s.db"
    SyncStore(str(db))
    row = _row(db)
    assert row is not None
    assert row["type"] == "project_progress"
    assert row["enabled"] == 1  # auto=True → enabled=1
    trig = json.loads(row["trigger_json"])
    assert trig == {
        "v": 1,
        "kind": "email_filter",
        "subject_pattern": r"\[weekly\] progress",
        "sender_pattern": "weekly@corp.com",
    }


def test_v31_seed_disabled_when_auto_off(tmp_path, monkeypatch):
    _seed_env(monkeypatch, auto=False, subject="X", sender="")
    db = tmp_path / "s.db"
    SyncStore(str(db))
    assert _row(db)["enabled"] == 0


def test_v31_seed_empty_env_stores_empty_patterns(tmp_path, monkeypatch):
    """env 全空 → trigger 空 pattern（detector 永不匹配 = 现状"全空永不匹配"）。"""
    _seed_env(monkeypatch, auto=True, subject="", sender="")
    db = tmp_path / "s.db"
    SyncStore(str(db))
    trig = json.loads(_row(db)["trigger_json"])
    assert trig["subject_pattern"] == ""
    assert trig["sender_pattern"] == ""


def test_v31_seed_idempotent_no_overwrite(tmp_path, monkeypatch):
    """INSERT OR IGNORE：用户改过行（enabled/trigger）后重跑迁移不覆盖。"""
    _seed_env(monkeypatch, auto=True, subject="orig", sender="")
    db = tmp_path / "s.db"
    SyncStore(str(db))
    # 模拟用户在 Settings 改了触发规则 + 关掉。
    conn = sqlite3.connect(str(db))
    conn.execute(
        "UPDATE report_agent SET enabled = 0, trigger_json = ? WHERE id = ?",
        (json.dumps({"v": 1, "kind": "email_filter", "subject_pattern": "edited"}), PROJECT_PROGRESS_AGENT_ID),
    )
    conn.commit()
    conn.close()
    # env 改回 auto=True/subject=orig，重跑迁移 → INSERT OR IGNORE 跳过，用户编辑保留。
    _seed_env(monkeypatch, auto=True, subject="orig", sender="")
    SyncStore(str(db))
    row = _row(db)
    assert row["enabled"] == 0
    assert json.loads(row["trigger_json"])["subject_pattern"] == "edited"


# ── 行内热读 helper ──────────────────────────────────────────────────────────


def test_get_config_reads_seeded_row(tmp_path, monkeypatch):
    _seed_env(monkeypatch, auto=True, subject="sub-pat", sender="snd@x.com")
    db = tmp_path / "s.db"
    SyncStore(str(db))
    cfg = get_project_progress_agent_config(str(db))
    assert cfg.row_exists is True
    assert cfg.enabled is True
    assert cfg.subject_pattern == "sub-pat"
    assert cfg.sender == "snd@x.com"


def test_get_config_missing_row_row_exists_false(tmp_path):
    """无 project_progress 行（表存在但行缺）→ row_exists=False（caller 回退 env）。"""
    db = tmp_path / "s.db"
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE report_agent (id TEXT PRIMARY KEY, enabled INTEGER, trigger_json TEXT)")
    conn.commit()
    conn.close()
    cfg = get_project_progress_agent_config(str(db))
    assert cfg.row_exists is False


def test_get_config_missing_table_row_exists_false(tmp_path):
    """表都不存在（迁移前老库）→ graceful row_exists=False。"""
    db = tmp_path / "empty.db"
    sqlite3.connect(str(db)).close()
    cfg = get_project_progress_agent_config(str(db))
    assert cfg.row_exists is False


def test_get_config_bad_trigger_json_empty_patterns(tmp_path):
    db = tmp_path / "s.db"
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE report_agent (id TEXT PRIMARY KEY, enabled INTEGER, trigger_json TEXT)")
    conn.execute(
        "INSERT INTO report_agent (id, enabled, trigger_json) VALUES (?, 1, 'not-json')",
        (PROJECT_PROGRESS_AGENT_ID,),
    )
    conn.commit()
    conn.close()
    cfg = get_project_progress_agent_config(str(db))
    assert cfg.row_exists is True
    assert cfg.enabled is True
    assert cfg.sender == "" and cfg.subject_pattern == ""


# ── 行为等价矩阵：seed→read 重建的 detector == 直接 env-detector ─────────────

# (subject_pattern, sender) 配置态 × 邮件输入。含：sender 配置/未配、subject 边界、大小写。
_CFG_CASES = [
    (r"\[weekly\] progress", "weekly@corp.com"),  # 双判定
    (r"\[weekly\] progress", ""),                 # env 未配 sender → 仅 subject
    (r"^WEEKLY:", ""),                            # 边界正则（锚点）
    ("", ""),                                     # 全空 → 永不匹配
]
_EMAIL_INPUTS = [
    ("Weekly Sender <weekly-corp@corp.com>", "[weekly] progress 0420"),
    ("WEEKLY@CORP.COM", "[weekly] progress"),      # 大小写：detector 子串 .lower()
    ("other@x.com", "[weekly] progress"),          # sender 不含子串
    ("weekly@corp.com", "WEEKLY: report"),         # 边界正则命中
    ("weekly@corp.com", "weekly: lowercased"),     # 边界正则不命中（大小写敏感 subject）
    (None, None),
    ("weekly@corp.com", None),
]


def test_equivalence_seeded_detector_matches_env_detector(tmp_path, monkeypatch):
    """迁移 seed 后从行重建的 detector，与直接 env-detector 对每个输入同判定（行为等价证明）。"""
    for cfg_idx, (subject, sender) in enumerate(_CFG_CASES):
        _seed_env(monkeypatch, auto=True, subject=subject, sender=sender)
        db = tmp_path / f"eq-{cfg_idx}.db"
        SyncStore(str(db))
        row_cfg = get_project_progress_agent_config(str(db))
        seeded = ProjectProgressDetector(
            sender=row_cfg.sender, subject_pattern=row_cfg.subject_pattern
        )
        env_direct = ProjectProgressDetector(sender=sender, subject_pattern=subject)
        for e_sender, e_subject in _EMAIL_INPUTS:
            assert seeded.is_match(sender=e_sender, subject=e_subject) == env_direct.is_match(
                sender=e_sender, subject=e_subject
            ), f"cfg={(subject, sender)} input={(e_sender, e_subject)} 判定不等价"
