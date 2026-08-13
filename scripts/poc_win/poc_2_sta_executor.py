"""P0 PoC #2: STA executor 真机冒烟 (task 08-12 Phase 0).

验证 OutlookComBackend 的线程纪律与自愈在真 Outlook 上成立:

    1. probe_readiness      — Dispatch + Namespace + 三默认文件夹可达
    2. STA 线程唯一性        — 连续多次 _com 调用发生在同一工作线程 (≠ 主线程)
    3. marker 水位          — get_current_max_row_id 返回合法 epoch 秒
    4. Restrict 窗口计数    — check_for_changes(1h 前水位) 返回计数 + 每次调用延迟
    5. _reconnect 自愈 (交互, --reconnect 开启) — 提示手动重启 Outlook 后
       再次调用, OutlookSession.call 应识别死对象 HRESULT 并 reconnect 成功

判定: 步骤 1-4 全过 = GO (步骤 5 是交互项, 结果只入报告不进硬阈值 ——
无人值守跑法 `--no-reconnect` 即跳过)。

运行 (Windows, classic Outlook 已登录):
    python scripts\\poc_win\\poc_2_sta_executor.py [--reconnect]
"""
from __future__ import annotations

import argparse
import datetime
import threading
import time
from typing import Any, Optional

import poc_common
from poc_common import EXIT_GO, EXIT_NO_GO, print_header, print_verdict, write_report

poc_common.bootstrap_sys_path()
poc_common.ensure_env()


def main(argv: Optional[list[str]] = None) -> int:
    poc_common.exit_if_not_win32("STA executor 冒烟 (需要本机 classic Outlook COM)")

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--reconnect",
        action="store_true",
        help="启用交互式 _reconnect 自愈演练 (提示手动重启 Outlook)",
    )
    args = parser.parse_args(argv)

    from types import SimpleNamespace

    from src.mail.backend.outlook_com_backend import OutlookComBackend

    print_header("PoC #2: STA executor 冒烟")
    backend = OutlookComBackend(SimpleNamespace(), SimpleNamespace())
    results: dict[str, Any] = {}
    checks: list[tuple[str, bool]] = []

    # -- 1. probe --
    ok, why = backend.probe_readiness()
    print(f"[1] probe_readiness: ok={ok} — {why}")
    print(f"    sent_folder={backend.sent_folder!r} drafts_folder={backend.drafts_folder!r}")
    results["probe"] = {"ok": ok, "why": why}
    checks.append(("probe_readiness", ok))
    if not ok:
        print_verdict(False, ["probe 失败, 后续步骤无法执行"])
        write_report("poc2-sta-executor", {"poc": "poc_2_sta_executor", **results, "verdict": "NO-GO"})
        return EXIT_NO_GO

    # -- 2. STA 线程唯一性 --
    main_tid = threading.get_ident()
    tids = {backend._com(lambda s: threading.get_ident(), op=f"poc2-tid-{i}") for i in range(5)}
    sta_ok = len(tids) == 1 and main_tid not in tids
    print(f"[2] STA 线程唯一性: 主线程={main_tid}, 5 次调用线程集={tids} → {'过' if sta_ok else '不过'}")
    results["sta_thread"] = {"main_tid": main_tid, "worker_tids": sorted(tids), "ok": sta_ok}
    checks.append(("sta_thread_identity", sta_ok))

    # -- 3. marker 水位 --
    marker_ok = False
    marker = None
    try:
        marker = backend.get_current_max_row_id()
        now = int(time.time())
        # 合法性: 正数 epoch, 不在未来 1 天外, 不早于 2000 年 (垃圾值闸)
        marker_ok = 946684800 < marker <= now + 86400
        human = datetime.datetime.fromtimestamp(marker).isoformat()
        print(
            f"[3] marker 水位: {marker} ({human}), "
            f"延迟 {backend.last_op_latency_ms}ms → {'过' if marker_ok else '不过'}"
        )
    except Exception as e:  # noqa: BLE001 — PoC 报告失败原因
        print(f"[3] marker 水位: 异常 {type(e).__name__}: {e} → 不过")
        results["marker_error"] = str(e)
    results["marker"] = {"value": marker, "latency_ms": backend.last_op_latency_ms, "ok": marker_ok}
    checks.append(("marker_watermark", marker_ok))

    # -- 4. Restrict 窗口计数 --
    restrict_ok = False
    est = None
    if marker_ok:
        try:
            since = marker - 3600  # 最近 1 小时窗口
            has_new, current, est = backend.check_for_changes(since)
            restrict_ok = isinstance(est, int) and est >= 0 and current >= marker
            print(
                f"[4] Restrict 窗口 (1h): has_new={has_new} count={est} "
                f"延迟 {backend.last_op_latency_ms}ms → {'过' if restrict_ok else '不过'}"
            )
        except Exception as e:  # noqa: BLE001
            print(f"[4] Restrict 窗口: 异常 {type(e).__name__}: {e} → 不过")
            results["restrict_error"] = str(e)
    else:
        print("[4] Restrict 窗口: 跳过 (marker 不可用)")
    results["restrict"] = {"count_1h": est, "latency_ms": backend.last_op_latency_ms, "ok": restrict_ok}
    checks.append(("restrict_window_count", restrict_ok))

    # -- 5. reconnect 自愈演练 (交互, 不进硬阈值) --
    reconnect_result = "skipped"
    if args.reconnect:
        print_header("[5] _reconnect 自愈演练")
        print(
            "  请现在**完全退出 Outlook** (文件→退出, 或任务管理器结束 OUTLOOK.EXE),\n"
            "  等 5 秒后按 Enter 继续 —— 脚本将再次调用 COM, 预期 OutlookSession.call\n"
            "  识别死对象 HRESULT → reconnect (Dispatch 会重新拉起 Outlook) → 调用成功。"
        )
        try:
            input("  按 Enter 继续 > ")
            marker2 = backend.get_current_max_row_id()
            reconnect_result = "ok"
            print(f"  重连后 marker={marker2} — 自愈成功 (查看日志应有 dead COM object/reconnecting)")
        except Exception as e:  # noqa: BLE001
            reconnect_result = f"failed: {type(e).__name__}: {e}"
            print(f"  自愈失败: {e}")
            print("  排查: Outlook 是否卡在登录/配置向导; 日志里 HRESULT 是否在 DEAD_OBJECT_HRESULTS 白名单")
    results["reconnect_drill"] = reconnect_result

    go = all(ok for _, ok in checks)
    print_verdict(go, [f"{name}: {'过' if ok else '不过'}" for name, ok in checks] + [f"reconnect_drill: {reconnect_result} (不进硬阈值)"])

    report = {
        "poc": "poc_2_sta_executor",
        **results,
        "checks": {name: ok for name, ok in checks},
        "verdict": "GO" if go else "NO-GO",
    }
    path = write_report("poc2-sta-executor", report)
    print(f"\nJSON 报告: {path}")

    backend.shutdown()
    return EXIT_GO if go else EXIT_NO_GO


if __name__ == "__main__":
    raise SystemExit(main())
