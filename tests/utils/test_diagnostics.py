"""build_diagnostic_bundle — 诊断包装配 (E4 第二批 WP2a, 拍板 D2)。

覆盖: 五件套齐 / 7 天 mtime 过滤 / 超大文件 skipped / --no-quick-check 等价路径 /
config_snapshot 值级邮箱脱敏 (含 user_email 场景) / 单件失败降级不烧穿。
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import zipfile
from pathlib import Path

from src.utils.diagnostics import build_diagnostic_bundle, redact_email_values


def _make_logs(tmp_path: Path) -> Path:
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "backend-process.log").write_text("recent backend log")
    (logs / "sync.log").write_text("recent sync log")
    return logs


def _make_db(tmp_path: Path, name: str) -> Path:
    db = tmp_path / name
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)")
    conn.commit()
    conn.close()
    return db


class TestRedactEmailValues:
    def test_values_redacted_keys_and_non_strings_untouched(self):
        obj = {
            "user_email": "lucien.chen@example-corp.com",
            "note": "contact a.b+tag@c.io please",
            "count": 42,
            "flag": True,
            "nothing": None,
            "nested": {"list": ["pm@ex.co", 7]},
        }
        out = redact_email_values(obj)
        assert out["user_email"] == "***@***"
        assert out["note"] == "contact ***@*** please"
        assert out["count"] == 42
        assert out["flag"] is True
        assert out["nothing"] is None
        assert out["nested"]["list"] == ["***@***", 7]
        # key 不动 (字段名非用户数据)
        assert "user_email" in out


class TestBuildDiagnosticBundle:
    def test_five_pieces_present(self, tmp_path: Path):
        logs = _make_logs(tmp_path)
        db = _make_db(tmp_path, "sync_store.db")
        agent_db = _make_db(tmp_path, "agent_config.db")
        result = build_diagnostic_bundle(
            logs_dir=logs,
            db_paths={"sync_store.db": db, "agent_config.db": agent_db},
            health={"healthy": True},
            config_snapshot={"user_email": {"value": "a@b.com"}},
            app_version="1.6.0",
            out_dir=tmp_path / "out",
        )
        zip_path = Path(result["zip_path"])
        assert zip_path.exists()
        assert result["size_bytes"] == zip_path.stat().st_size > 0
        assert result["skipped"] == []
        with zipfile.ZipFile(zip_path) as zf:
            names = set(zf.namelist())
            assert {
                "health.json", "config_snapshot.json",
                "db_check.json", "manifest.json",
                "logs/backend-process.log", "logs/sync.log",
            } == names
            assert result["entry_count"] == len(names) == 6

            health = json.loads(zf.read("health.json"))
            assert health["healthy"] is True

            db_check = json.loads(zf.read("db_check.json"))
            assert db_check["ran"] is True
            assert db_check["results"]["sync_store.db"]["ok"] is True
            assert db_check["results"]["agent_config.db"]["ok"] is True

            manifest = json.loads(zf.read("manifest.json"))
            assert manifest["app_version"] == "1.6.0"
            assert manifest["db_files"]["sync_store.db"] > 0
            assert manifest["generated_at"]
            assert manifest["platform"]

    def test_logs_mtime_filter_seven_days(self, tmp_path: Path):
        logs = _make_logs(tmp_path)
        old = logs / "old.log"
        old.write_text("ancient content")
        stale_ts = time.time() - 8 * 86400
        os.utime(old, (stale_ts, stale_ts))
        result = build_diagnostic_bundle(
            logs_dir=logs, db_paths={}, health={}, config_snapshot={},
            run_quick_check=False, out_dir=tmp_path / "out",
        )
        with zipfile.ZipFile(result["zip_path"]) as zf:
            names = set(zf.namelist())
        assert "logs/old.log" not in names
        assert "logs/sync.log" in names
        # 超龄是静默排除 (非异常), 不记 skipped
        assert not any("old.log" in s for s in result["skipped"])

    def test_oversized_log_skipped(self, tmp_path: Path):
        logs = _make_logs(tmp_path)
        (logs / "huge.log").write_text("x" * 2048)
        result = build_diagnostic_bundle(
            logs_dir=logs, db_paths={}, health={}, config_snapshot={},
            run_quick_check=False, max_log_file_bytes=1024,
            out_dir=tmp_path / "out",
        )
        with zipfile.ZipFile(result["zip_path"]) as zf:
            assert "logs/huge.log" not in zf.namelist()
        assert any("huge.log" in s for s in result["skipped"])

    def test_no_quick_check_records_skipped(self, tmp_path: Path):
        logs = _make_logs(tmp_path)
        db = _make_db(tmp_path, "sync_store.db")
        result = build_diagnostic_bundle(
            logs_dir=logs, db_paths={"sync_store.db": db},
            health={}, config_snapshot={},
            run_quick_check=False, out_dir=tmp_path / "out",
        )
        with zipfile.ZipFile(result["zip_path"]) as zf:
            db_check = json.loads(zf.read("db_check.json"))
        assert db_check["ran"] is False
        assert db_check["results"] == {}
        assert any("quick_check skipped" in s for s in result["skipped"])

    def test_config_snapshot_email_redaction(self, tmp_path: Path):
        """值级第二道脱敏: user_email / project_progress_sender 字段名不含敏感词,
        _is_sensitive 盖不住 → 邮箱正则必须把值脱掉 (研究 §2e)。"""
        snapshot = {
            "user_email": {
                "env_var": "USER_EMAIL",
                "value": "lucien.chen@example-corp.com",
                "sensitive": False,
            },
            "project_progress_sender": {"value": "pm+weekly@ex.co"},
            "nested": {"list": ["contact a.b@c.io please", 42, None]},
        }
        result = build_diagnostic_bundle(
            logs_dir=tmp_path / "no-logs", db_paths={}, health=None,
            config_snapshot=snapshot, run_quick_check=False,
            out_dir=tmp_path / "out",
        )
        with zipfile.ZipFile(result["zip_path"]) as zf:
            text = zf.read("config_snapshot.json").decode("utf-8")
        assert "lucien.chen@example-corp.com" not in text
        assert "pm+weekly@ex.co" not in text
        assert "a.b@c.io" not in text
        assert "***@***" in text
        data = json.loads(text)
        assert data["user_email"]["value"] == "***@***"
        assert data["nested"]["list"][0] == "contact ***@*** please"
        assert data["nested"]["list"][1] == 42

    def test_missing_pieces_degrade_to_skipped(self, tmp_path: Path):
        """D2 防御基调: logs 目录缺失 / health & snapshot 缺席 / 库损坏或不存在
        → 全部降级记 skipped, zip 照出、manifest/db_check 照写, 命令不炸。"""
        corrupt = tmp_path / "corrupt.db"
        corrupt.write_bytes(b"this is not a sqlite database at all" * 40)
        result = build_diagnostic_bundle(
            logs_dir=tmp_path / "no-such-logs",
            db_paths={
                "sync_store.db": corrupt,
                "agent_config.db": tmp_path / "ghost.db",
            },
            health=None,
            config_snapshot=None,
            app_version=None,
            out_dir=tmp_path / "out",
        )
        zip_path = Path(result["zip_path"])
        assert zip_path.exists()
        with zipfile.ZipFile(zip_path) as zf:
            names = set(zf.namelist())
            assert "manifest.json" in names
            assert "db_check.json" in names
            assert "health.json" not in names
            assert "config_snapshot.json" not in names

            db_check = json.loads(zf.read("db_check.json"))
            # 损坏库: quick_check 返回 (False, detail), 不抛
            assert db_check["results"]["sync_store.db"]["ok"] is False
            # 不存在的库: ok=null (首启/未启用是正常态)
            assert db_check["results"]["agent_config.db"]["ok"] is None

            manifest = json.loads(zf.read("manifest.json"))
            assert manifest["app_version"] is None
            assert manifest["db_files"]["agent_config.db"] is None
        assert any(s.startswith("logs/") for s in result["skipped"])
        assert any("health.json" in s for s in result["skipped"])
        assert any("config_snapshot.json" in s for s in result["skipped"])
