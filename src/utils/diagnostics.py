"""诊断包装配 — ``mailagent admin export-diagnostics`` 的核心 (E4 第二批 WP2a, 拍板 D2)。

zip 五件套:
  1. ``logs/``               logs_dir (DATA_ROOT/logs) 下 mtime ≤ 7 天的文件
                             (单文件 > 50MB 跳过并记 skipped; 日志**原样**打包 —— 脱敏
                             范围拍板只盖 config_snapshot, 导出是用户主动动作)
  2. ``health.json``         CLI 面 admin_health 的 data 组装结果 (调用方传入, 本模块不组装)
  3. ``config_snapshot.json`` ``_collect_settings(show_secrets=False)`` 输出, 写入前恒过
                             :func:`redact_email_values` 值级邮箱脱敏
  4. ``db_check.json``       ``db_safety.quick_check`` × {sync_store.db, agent_config.db}
                             (大库最坏 ~24s/库; ``run_quick_check=False`` 跳过并记 skipped)
  5. ``manifest.json``       app_version / generated_at / platform / DB 文件大小

防御基调 (D2): 任何一件装配失败 → 降级记 skipped, 绝不让整个导出炸。
app_version 由前端传 ``app.getVersion()`` (Python pyproject 的 3.0.0 与发布版本 SSoT
脱节, 不自报); 未传 → ``manifest.app_version = null``。
zip 落 ``tempfile.mkdtemp()`` 下 ``mailagent-diagnostics-<YYYYMMDD-HHMMSS>.zip``,
由前端 copy 到用户选择的位置后清理 tmp。
"""

from __future__ import annotations

import json
import platform
import re
import tempfile
import time
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from src.mail.db_safety import quick_check

PathLike = Union[str, Path]

# D2 拍板常数: 只打包近 7 天日志; 单文件 >50MB 跳过 (参数化仅为测试注入, 默认即契约)。
MAX_LOG_AGE_DAYS = 7
MAX_LOG_FILE_BYTES = 50 * 1024 * 1024

# D2 拍板正则: 对所有字符串值跑 → '***@***'。
_EMAIL_VALUE_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")


def redact_email_values(obj: Any) -> Any:
    """递归把所有字符串**值**里的邮箱替换成 ``***@***`` (值级第二道脱敏, D2)。

    ``_is_sensitive`` 的字段名黑名单 (token/secret/password/api_key) 盖不住
    ``user_email`` / ``project_progress_sender`` 这类「字段名无敏感词、值本身就是
    邮箱」的场景, 也盖不住任意字段值里意外内嵌的邮箱。本函数不改 ``_is_sensitive``
    语义, 只在 config_snapshot 装配时对值追加这一道。dict 的 key 不动 (字段名非用户数据)。
    """
    if isinstance(obj, str):
        return _EMAIL_VALUE_RE.sub("***@***", obj)
    if isinstance(obj, dict):
        return {k: redact_email_values(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [redact_email_values(v) for v in obj]
    return obj


def _write_json_entry(
    zf: zipfile.ZipFile, name: str, payload: Any, skipped: List[str],
) -> None:
    """写单个 JSON entry; 失败降级记 skipped (D2 防御基调)。"""
    try:
        zf.writestr(name, json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    except Exception as exc:  # noqa: BLE001 — 单件失败不烧穿整包
        skipped.append(f"{name}: write failed ({type(exc).__name__}: {exc})")


def _add_logs(
    zf: zipfile.ZipFile,
    logs_dir: Path,
    skipped: List[str],
    *,
    max_age_days: int,
    max_bytes: int,
) -> None:
    """logs_dir 顶层文件 → ``logs/<name>`` entries (mtime ≤ max_age_days 天)。

    超龄文件静默排除 (不是异常, 不记 skipped); 超大 / stat / 读取失败记 skipped。
    """
    if not logs_dir.is_dir():
        skipped.append(f"logs/: directory not found ({logs_dir})")
        return
    try:
        candidates = sorted(p for p in logs_dir.iterdir() if p.is_file())
    except OSError as exc:
        skipped.append(f"logs/: listing failed ({type(exc).__name__}: {exc})")
        return
    cutoff = time.time() - max_age_days * 86400
    for f in candidates:
        try:
            st = f.stat()
        except OSError as exc:
            skipped.append(f"logs/{f.name}: stat failed ({type(exc).__name__}: {exc})")
            continue
        if st.st_mtime < cutoff:
            continue
        if st.st_size > max_bytes:
            skipped.append(
                f"logs/{f.name}: {st.st_size} bytes > {max_bytes} bytes limit"
            )
            continue
        try:
            zf.write(f, arcname=f"logs/{f.name}")
        except Exception as exc:  # noqa: BLE001 — 单文件读失败不烧穿整包
            skipped.append(f"logs/{f.name}: read failed ({type(exc).__name__}: {exc})")


def _build_db_check(
    db_paths: Dict[str, PathLike], *, run_quick_check: bool, skipped: List[str],
) -> dict:
    """逐库 ``PRAGMA quick_check`` (db_safety.quick_check 复用, 只读连接不改库)。

    ``run_quick_check=False`` → ``{ran: false, results: {}}`` + skipped 注记
    (D2: --no-quick-check 跳过并记 skipped)。库文件不存在 → ok=null (首启/未启用是正常态)。
    """
    results: Dict[str, dict] = {}
    if not run_quick_check:
        skipped.append("db_check: quick_check skipped (--no-quick-check)")
        return {"ran": False, "results": results}
    for name, raw in db_paths.items():
        p = Path(raw)
        if not p.exists():
            results[name] = {"ok": None, "detail": "file not found"}
            continue
        try:
            ok, detail = quick_check(p)
            results[name] = {"ok": ok, "detail": detail}
        except Exception as exc:  # noqa: BLE001 — quick_check 自身已吞 sqlite3.Error, 这里兜底
            results[name] = {"ok": None, "detail": f"{type(exc).__name__}: {exc}"}
            skipped.append(f"db_check[{name}]: quick_check failed ({type(exc).__name__})")
    return {"ran": True, "results": results}


def _collect_db_sizes(db_paths: Dict[str, PathLike]) -> dict:
    """manifest 用: {库名: size_bytes | null} (只记大小不记绝对路径)。"""
    out: Dict[str, Optional[int]] = {}
    for name, raw in db_paths.items():
        try:
            p = Path(raw)
            out[name] = p.stat().st_size if p.exists() else None
        except OSError:
            out[name] = None
    return out


def build_diagnostic_bundle(
    *,
    logs_dir: PathLike,
    db_paths: Dict[str, PathLike],
    health: Optional[dict] = None,
    config_snapshot: Optional[dict] = None,
    app_version: Optional[str] = None,
    run_quick_check: bool = True,
    max_log_age_days: int = MAX_LOG_AGE_DAYS,
    max_log_file_bytes: int = MAX_LOG_FILE_BYTES,
    out_dir: Optional[PathLike] = None,
) -> dict:
    """装配诊断 zip, 返回 CLI 契约 data (跨 lane 接口, 前端按此对接不得变形)。

    Args:
        logs_dir: 日志目录 (DATA_ROOT/logs; Electron 的 backend-process.log /
            api-process.log 与 Python 的 sync.log 同目录, 一个 glob 根全覆盖)。
        db_paths: ``{"sync_store.db": path, "agent_config.db": path}``。
        health: admin health 的 data dict (None → 跳过 health.json 并记 skipped)。
        config_snapshot: ``_collect_settings(show_secrets=False)`` 输出
            (None → 跳过并记 skipped); 写入前恒过 :func:`redact_email_values`。
        app_version: 前端 ``app.getVersion()``; None → manifest.app_version=null。
        run_quick_check: False = 跳过 quick_check (CLI ``--no-quick-check``)。
        out_dir: zip 落点目录 (默认 ``tempfile.mkdtemp()``; 测试注入用)。

    Returns:
        ``{"zip_path": str, "size_bytes": int, "entry_count": int, "skipped": [str]}``
    """
    skipped: List[str] = []
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    if out_dir is not None:
        dest_dir = Path(out_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)
    else:
        dest_dir = Path(tempfile.mkdtemp(prefix="mailagent-diagnostics-"))
    zip_name = f"mailagent-diagnostics-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
    zip_path = dest_dir / zip_name

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # 1. logs/
        _add_logs(
            zf, Path(logs_dir), skipped,
            max_age_days=max_log_age_days, max_bytes=max_log_file_bytes,
        )

        # 2. health.json
        if health is not None:
            _write_json_entry(zf, "health.json", health, skipped)
        else:
            skipped.append("health.json: unavailable")

        # 3. config_snapshot.json (值级邮箱脱敏后写入)
        if config_snapshot is not None:
            try:
                redacted = redact_email_values(config_snapshot)
            except Exception as exc:  # noqa: BLE001 — 脱敏失败绝不写未脱敏原文
                redacted = None
                skipped.append(
                    f"config_snapshot.json: redaction failed ({type(exc).__name__}: {exc})"
                )
            if redacted is not None:
                _write_json_entry(zf, "config_snapshot.json", redacted, skipped)
        else:
            skipped.append("config_snapshot.json: unavailable")

        # 4. db_check.json
        _write_json_entry(
            zf, "db_check.json",
            _build_db_check(db_paths, run_quick_check=run_quick_check, skipped=skipped),
            skipped,
        )

        # 5. manifest.json
        _write_json_entry(
            zf, "manifest.json",
            {
                "app_version": app_version,
                "generated_at": generated_at,
                "platform": platform.platform(),
                "db_files": _collect_db_sizes(db_paths),
            },
            skipped,
        )

        entry_count = len(zf.namelist())

    try:
        size_bytes = zip_path.stat().st_size
    except OSError:
        size_bytes = 0

    return {
        "zip_path": str(zip_path),
        "size_bytes": size_bytes,
        "entry_count": entry_count,
        "skipped": skipped,
    }
