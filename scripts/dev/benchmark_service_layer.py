#!/usr/bin/env python3
"""D2c 性能基线: fork-CLI vs in-process service 写编排延迟 (全 dry-run, 零真写).

量化 ``~/.claude/plans/cli-streamed-brook.md`` 的核心断言:

  写慢的税 = **每次 fork 一个新 Python 进程 + 重载配置与领域服务**, 不是认证
  (auth 是 ``hmac.compare_digest``, <1ms)。serve-api 旧写端点把 fork 税从前端
  搬到服务端, 服务化重构 (A2-A4) 把它换成 in-process service 调用。

三条路径跑**同一个** dry-run flag 编排 (``plan_flags``):

  fork-cli      : subprocess ``mailagent email flag --dry-run`` —— 旧 serve-api
                  ``run_cli`` 模型 (每次新 Python 进程 + 全量 import + 编排)
  inproc-perreq : 进程内每次新建 ``ServiceContext`` + ``plan_flags`` —— 新 serve-api
                  per-request 语义 (``deps.get_service_ctx()`` 每请求新建)
  inproc-warm   : 复用 ``ServiceContext``, 纯 ``plan_flags`` 编排 —— 理论下界

``--dry-run`` 不写 Notion / Mail / SQLite / outbox + 跳过 auth / pm2 → fork 税与
真实 IO 干净解耦, 数字可复现、与是否配置真实凭证无关。临时库 (``mkdtemp``) + 假
env, 退出即清理, **绝不碰 data/sync_store.db**。

用法::

    ./venv/bin/python3 scripts/dev/benchmark_service_layer.py [--fork-runs N] [--inproc-runs N]
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INTERNAL_ID = 12345

# 假 env: dry-run 不调 Notion, 仅满足 load_cli_config 必填项 (不读生产 .env 凭证)。
FAKE_ENV = {
    "NOTION_TOKEN": "bench-fake-token",
    "EMAIL_DATABASE_ID": "bench-fake-db",
    "USER_EMAIL": "bench@example.com",
    "MAIL_ACCOUNT_NAME": "bench",
    "MAILAGENT_CLI_API_KEY": "",
    "MAILAGENT_CLI_ALLOW_CONCURRENT": "true",
}


def _seed_db(db_path: str) -> None:
    """建 v4 schema 空库 + 种 internal_id=12345 (复刻 tests/cli/conftest.py seeded_db 最小字段)."""
    from src.mail.sync_store import SyncStore

    SyncStore(db_path)  # _init_database 建 email_metadata / email_body / ... schema
    now = time.time()
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """INSERT INTO email_metadata
                 (internal_id, message_id, thread_id, subject, sender, sender_name,
                  to_addr, cc_addr, date_received, mailbox, is_read, is_flagged,
                  sync_status, notion_page_id, retry_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                INTERNAL_ID, "<msg-12345@example.com>", "<thread-1@example.com>",
                "Hello Test", "alice@example.com", "Alice", "bob@example.com", "",
                "2026-05-15 10:00:00", "收件箱", 1, 0, "synced",
                "abc12345-0000-0000-0000-000000000001", 0, now, now,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def bench_fork(db_path: str, runs: int) -> list[float]:
    """subprocess fork ``mailagent ... email flag --dry-run`` (1 次 warmup 不计)。"""
    cmd = [
        str(REPO_ROOT / "venv" / "bin" / "mailagent"),
        "--db-path", db_path, "email", "flag", str(INTERNAL_ID),
        "--is-read", "--dry-run", "-o", "json",
    ]
    env = {**os.environ, **FAKE_ENV}
    subprocess.run(cmd, env=env, capture_output=True, cwd=str(REPO_ROOT))  # warmup
    samples: list[float] = []
    for _ in range(runs):
        t0 = time.perf_counter()
        r = subprocess.run(cmd, env=env, capture_output=True, cwd=str(REPO_ROOT))
        samples.append((time.perf_counter() - t0) * 1000.0)
        if r.returncode != 0:
            sys.stderr.write(r.stdout.decode(errors="replace") + r.stderr.decode(errors="replace"))
            raise SystemExit(f"fork CLI 非 0 退出: {r.returncode}")
    return samples


def bench_inproc_perreq(db_path: str, runs: int) -> list[float]:
    """进程内每次新建 ServiceContext + plan_flags (serve-api per-request 语义)。"""
    from src.cli.config import load_cli_config
    from src.services.context import ServiceContext
    from src.services.mail_write import MailWriteService

    for k, v in FAKE_ENV.items():
        os.environ.setdefault(k, v)

    def _once() -> None:
        ctx = ServiceContext(load_cli_config(flag_overrides={"sync_store_db_path": db_path}))
        MailWriteService(ctx).plan_flags([INTERNAL_ID], is_read=True)

    _once()  # warmup (首次 import / 编译缓存)
    samples: list[float] = []
    for _ in range(runs):
        t0 = time.perf_counter()
        _once()
        samples.append((time.perf_counter() - t0) * 1000.0)
    return samples


def bench_inproc_warm(db_path: str, runs: int) -> list[float]:
    """复用 ServiceContext, 纯 plan_flags 编排 (理论下界)。"""
    from src.cli.config import load_cli_config
    from src.services.context import ServiceContext
    from src.services.mail_write import MailWriteService

    for k, v in FAKE_ENV.items():
        os.environ.setdefault(k, v)
    svc = MailWriteService(
        ServiceContext(load_cli_config(flag_overrides={"sync_store_db_path": db_path}))
    )
    svc.plan_flags([INTERNAL_ID], is_read=True)  # warmup
    samples: list[float] = []
    for _ in range(runs):
        t0 = time.perf_counter()
        svc.plan_flags([INTERNAL_ID], is_read=True)
        samples.append((time.perf_counter() - t0) * 1000.0)
    return samples


def _stats(samples: list[float]) -> dict[str, float]:
    s = sorted(samples)
    n = len(s)
    return {
        "runs": n,
        "mean": statistics.mean(s),
        "p50": s[n // 2],
        "p95": s[min(n - 1, int(n * 0.95))],
        "min": s[0],
        "max": s[-1],
    }


def _fmt(ms: float) -> str:
    """自适应精度: ≥1ms 用 2 位, 亚毫秒用 4 位 (避免纯编排下界四舍五入成 0)。"""
    return f"{ms:.2f}ms" if ms >= 1.0 else f"{ms:.4f}ms"


def _print_report(results: dict[str, dict[str, float]]) -> None:
    print("| 路径 | runs | mean | p50 | p95 | min | max |")
    print("|---|--:|--:|--:|--:|--:|--:|")
    for label, st in results.items():
        print(
            f"| {label} | {int(st['runs'])} "
            f"| {_fmt(st['mean'])} | {_fmt(st['p50'])} | {_fmt(st['p95'])} "
            f"| {_fmt(st['min'])} | {_fmt(st['max'])} |"
        )
    fork = next(v for k, v in results.items() if k.startswith("fork"))
    perreq = next(v for k, v in results.items() if "perreq" in k)
    warm = next(v for k, v in results.items() if "warm" in k)
    print()
    print(
        f"加速比 (mean): fork→perreq = {fork['mean'] / perreq['mean']:.0f}x · "
        f"fork→warm = {fork['mean'] / warm['mean']:.0f}x"
    )
    print(
        f"结论: dry-run 隔离下 fork 一次 CLI ≈ {fork['mean']:.0f}ms (Python 进程冷启 + "
        f"全量 import + 编排), in-process 同编排 ≈ {perreq['mean']:.1f}ms → 验证 plan "
        "断言「税在 fork 进程 + 重载配置/服务」。"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="D2c service-layer perf baseline (dry-run)")
    ap.add_argument("--fork-runs", type=int, default=15)
    ap.add_argument("--inproc-runs", type=int, default=200)
    args = ap.parse_args()

    sys.path.insert(0, str(REPO_ROOT))
    tmpdir = tempfile.mkdtemp(prefix="mailagent-bench-")
    db_path = str(Path(tmpdir) / "sync_store.db")
    try:
        _seed_db(db_path)
        print(f"# 临时库: {db_path} (退出即删, 不碰生产库 data/sync_store.db)")
        print(f"# fork-runs={args.fork_runs} inproc-runs={args.inproc_runs}\n")
        results = {
            "fork-cli (旧 serve-api run_cli)": _stats(bench_fork(db_path, args.fork_runs)),
            "inproc-perreq (新 serve-api/请求)": _stats(
                bench_inproc_perreq(db_path, args.inproc_runs)
            ),
            "inproc-warm (纯编排下界)": _stats(bench_inproc_warm(db_path, args.inproc_runs)),
        }
        _print_report(results)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    main()
