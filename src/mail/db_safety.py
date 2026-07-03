"""启动期数据库安全网 (E0-WP2, task 07-02-e0-safety-net)。

背景 (architecture-review-2026-07 P0-2): 用户数据 (sync_store.db / agent_config.db)
无自动备份、无完整性检查 —— app 已分发非开发者用户, DB 损坏 = 无回退。

本模块提供 serve 启动早期 (worker 未起、SyncStore 尚未打开 DB) 的一次安全通道:

    quick_check 通过 → VACUUM INTO 滚动备份 (保最近 keep 份) → 继续启动
    quick_check 失败 → 写 marker 供 Electron main 弹「数据库校验失败」→
                       raise DbIntegrityError → 调用方 fail-fast 退出
                       (**不做备份、不轮转** —— 保住已有好备份)

节流: 距 stem 最新备份 < ``min_interval_hours`` (默认 24h) 时整个通道跳过 (零成本)。
实测本机 1.5 GB sync_store.db: quick_check ~24s、VACUUM INTO ~13s —— 每次启动都跑
不可接受, 24h 节流后代价 = 每天一次 ~40s (且不阻塞前端开窗: backend_lifecycle 的
waitReady 直读 SQLite 文件判就绪, 已迁移库立即放行)。

设计要点:
- 只在 `mailagent serve` (src/service.py run_service) 调用 —— serve-api / CLI 不跑,
  backups/ 目录单写者, 无并发轮转竞态。
- 备份用 ``VACUUM INTO`` (读快照, WAL 下与并发写共存), **不许**直接 copy 文件
  (WAL 未 checkpoint 的数据在 -wal 里, 单拷主文件 = 撕裂备份)。
- ai_chat.db 是前端 Electron (chat_db.ts) owned, 首期不纳入 —— 已知边界, 见
  docs/reference/packaging/packaging-release.md「数据恢复」。
- 失败 marker (`db_integrity_failure.json`, 与 sync_store.db 同目录) 由 Electron
  main 在 waitReady 失败分支读取 (backend_lifecycle.ts readDbIntegrityFailure),
  文件名两侧手抄必须一致。安全通道成功完成时清除 marker。
"""

import json
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Sequence, Tuple, Union

from loguru import logger

PathLike = Union[str, Path]

# Electron main (backend_lifecycle.ts DB_INTEGRITY_MARKER_FILENAME) 手抄同名 —— 改动必须两侧同步。
INTEGRITY_MARKER_FILENAME = "db_integrity_failure.json"

# 备份文件名: <stem>-YYYYMMDD-HHMMSS.db (零填充时间戳, 字典序 = 时间序)
_BACKUP_TS_FORMAT = "%Y%m%d-%H%M%S"


class DbIntegrityError(RuntimeError):
    """启动期 PRAGMA quick_check 未通过 —— 调用方应 fail-fast 拒绝启动。"""


def integrity_failure_marker_path(sync_store_db_path: PathLike) -> Path:
    """marker 落点 = sync_store.db 同目录 (Electron 侧从 resolveDbPath() 同样推导)。"""
    return Path(sync_store_db_path).resolve().parent / INTEGRITY_MARKER_FILENAME


def quick_check(db_path: PathLike) -> Tuple[bool, str]:
    """对单库跑 ``PRAGMA quick_check`` (只读连接, 不改库)。

    Returns:
        (ok, detail): ok=True 时 detail=='ok'; 失败时 detail 为错误列表/异常信息
        (连接失败 —— 如「file is not a database」的头部损坏 —— 同样算失败)。
    """
    p = Path(db_path)
    try:
        # as_uri() 做 percent-encoding, 特殊字符路径安全; mode=ro 防对损坏库产生任何写。
        conn = sqlite3.connect(p.resolve().as_uri() + "?mode=ro", uri=True, timeout=30.0)
        try:
            rows = conn.execute("PRAGMA quick_check").fetchall()
        finally:
            conn.close()
    except sqlite3.Error as e:
        return False, f"{type(e).__name__}: {e}"
    detail = "; ".join(str(r[0]) for r in rows) if rows else "(quick_check 无输出)"
    return detail == "ok", detail


def _newest_backup_age_hours(backups_dir: Path, stem: str) -> Optional[float]:
    """stem 最新备份距现在的小时数; 无备份返回 None。按 mtime 取最新。"""
    if not backups_dir.exists():
        return None
    files = list(backups_dir.glob(f"{stem}-*.db"))
    if not files:
        return None
    newest = max(f.stat().st_mtime for f in files)
    return max(0.0, (time.time() - newest) / 3600.0)


def _rotate_backups(backups_dir: Path, stem: str, keep: int) -> None:
    """按 mtime 保留 stem 最新 keep 份, 删除更旧的。删除失败仅告警不阻断。"""
    files = sorted(
        backups_dir.glob(f"{stem}-*.db"),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    for old in files[keep:]:
        try:
            old.unlink()
            logger.info(f"[db_safety] 轮转删除旧备份 {old.name}")
        except OSError as e:
            logger.warning(f"[db_safety] 删除旧备份 {old.name} 失败: {e}")


def create_backup(db_path: PathLike, backups_dir: PathLike, *, keep: int = 3) -> Path:
    """``VACUUM INTO`` 一份带时间戳的备份, 然后轮转保留最新 keep 份。

    仅应在 quick_check 通过后调用 (坏库不备份, 防覆盖好备份)。
    VACUUM 失败时清掉半成品文件再抛出 —— 半成品不得混进轮转集。
    """
    src = Path(db_path)
    dest_dir = Path(backups_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime(_BACKUP_TS_FORMAT)
    dest = dest_dir / f"{src.stem}-{ts}.db"
    if dest.exists():  # 同秒重跑 (测试/极端), 自有命名空间, 直接覆盖
        dest.unlink()
    try:
        conn = sqlite3.connect(src.resolve().as_uri() + "?mode=ro", uri=True, timeout=30.0)
        try:
            conn.execute("VACUUM INTO ?", (str(dest),))
        finally:
            conn.close()
    except BaseException:
        if dest.exists():
            try:
                dest.unlink()
            except OSError:
                pass
        raise
    _rotate_backups(dest_dir, src.stem, keep)
    return dest


def _write_marker(marker_path: Path, failures: List[dict], backups_dir: Path) -> None:
    try:
        marker_path.parent.mkdir(parents=True, exist_ok=True)
        marker_path.write_text(
            json.dumps(
                {
                    "failed": failures,
                    "backups_dir": str(backups_dir),
                    "checked_at": datetime.now().astimezone().isoformat(),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except OSError as e:
        logger.warning(f"[db_safety] 写完整性失败 marker 失败 (仍会 fail-fast): {e}")


def run_startup_db_safety(
    db_paths: Sequence[PathLike],
    backups_dir: PathLike,
    *,
    keep: int = 3,
    min_interval_hours: float = 24.0,
    marker_path: Optional[PathLike] = None,
) -> None:
    """启动安全通道: 对每个存在的库做 (节流的) quick_check + 滚动备份。

    Args:
        db_paths: 要保护的库 (不存在的跳过 —— 首启/未启用是正常态)。
        backups_dir: 备份目录 (``<DATA_ROOT>/data/backups/``, dev 态在 gitignored data/ 下)。
        keep: 每库保留的备份份数。
        min_interval_hours: 距该库最新备份不足此时长 → 本次跳过 (check+backup 都省)。
        marker_path: 完整性失败 marker 落点 (None = 不写 marker, 测试用)。

    Raises:
        DbIntegrityError: 任一库 quick_check 失败 (所有库都检完、失败合并上报;
            失败库不做备份、不轮转, 已有备份原样保留)。
    """
    dest_dir = Path(backups_dir)
    failures: List[dict] = []
    for raw in db_paths:
        p = Path(raw)
        if not p.exists():
            logger.debug(f"[db_safety] {p} 不存在, 跳过 (首启/未启用)")
            continue
        age = _newest_backup_age_hours(dest_dir, p.stem)
        if age is not None and age < min_interval_hours:
            logger.debug(
                f"[db_safety] {p.name}: 最新备份 {age:.1f}h 前 (<{min_interval_hours}h), 本次跳过"
            )
            continue
        t0 = time.time()
        ok, detail = quick_check(p)
        logger.info(
            f"[db_safety] quick_check {p.name}: {'ok' if ok else 'FAILED'} "
            f"({time.time() - t0:.1f}s)"
        )
        if not ok:
            failures.append({"db": str(p), "detail": detail})
            continue  # 坏库不备份; 好备份不轮转
        try:
            t0 = time.time()
            dest = create_backup(p, dest_dir, keep=keep)
            logger.info(
                f"[db_safety] 备份 {p.name} → {dest.name} "
                f"({time.time() - t0:.1f}s, {dest.stat().st_size / 1e6:.1f} MB)"
            )
        except Exception as e:
            # 备份失败不阻断启动 (安全网不能让启动变得更不可靠); 下次启动仍 due 会重试。
            logger.warning(f"[db_safety] 备份 {p.name} 失败 (不阻断启动): {e}")

    resolved_marker = Path(marker_path) if marker_path is not None else None
    if failures:
        if resolved_marker is not None:
            _write_marker(resolved_marker, failures, dest_dir)
        summary = "; ".join(f"{f['db']}: {f['detail']}" for f in failures)
        raise DbIntegrityError(
            f"数据库完整性校验失败 —— {summary}。已有备份保留在 {dest_dir}, "
            f"恢复步骤见 docs/reference/packaging/packaging-release.md「数据恢复」。"
        )
    if resolved_marker is not None and resolved_marker.exists():
        try:
            resolved_marker.unlink()
            logger.info("[db_safety] 完整性恢复, 已清除失败 marker")
        except OSError as e:
            logger.warning(f"[db_safety] 清除失败 marker 失败: {e}")
