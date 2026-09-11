"""DASL 探针 (只读): 真机确认 outlook_com 的两处假设 (task 09-11-outlook-com-dasl-utc-fix R6).

1. DASL 日期字面量按 UTC 解释: 窗口下界 = 收件箱最新一封的 ReceivedTime − 1h, 分别用
   本地 / UTC 字面量、带秒 / 不带秒做 Items.Restrict, 打印四个计数, 并和逐封按 ReceivedTime
   数出来的真实数对照。UTC 字面量应与真实数一致; 东八区下本地字面量会偏少 (查的是 8 小时后)。
2. message-id 反查的属性名: 对最新一封分别用 MAPI proptag (0x1035001F) 与
   ``urn:schemas:mailheader:message-id`` 做 Items.Find (带尖括号 / 不带各一次), 打印命中情况,
   再跑一次正式代码 ``_find_by_message_id``。

只读: 不 Save、不改任何 item、不写报告文件, 结果只打印到终端。
判定: 正式代码的 Restrict 计数 == 真实数 且 ``_find_by_message_id`` 命中 = GO。

运行 (Windows, classic Outlook 已登录):
    python scripts\\poc_win\\poc_4_dasl_probe.py
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Optional

import poc_common
from poc_common import EXIT_GO, EXIT_NO_GO, print_header, print_verdict

poc_common.bootstrap_sys_path()
poc_common.ensure_env()

WINDOW_SEC = 3600
#: 逐封数真实数的上限 (最新一封往前 1 小时通常远少于此; 防超大收件箱卡住 STA 线程)
MAX_TRUTH_SCAN = 2000


def _literal(epoch: float, *, utc: bool, seconds: bool) -> str:
    dt = datetime.fromtimestamp(epoch, timezone.utc) if utc else datetime.fromtimestamp(epoch)
    return dt.strftime("%Y-%m-%d %H:%M:%S" if seconds else "%Y-%m-%d %H:%M")


def main(argv: Optional[list[str]] = None) -> int:
    poc_common.exit_if_not_win32("DASL 时区与 message-id 属性名探针 (需要本机 classic Outlook COM)")

    from types import SimpleNamespace

    from src.mail.backend.com_client import (
        MESSAGE_ID_FIND_PROPS,
        OL_FOLDER_INBOX,
        PR_INTERNET_MESSAGE_ID,
    )
    from src.mail.backend.outlook_com_backend import (
        OutlookComBackend,
        _com_get,
        _dasl_quote,
        _prop,
        _to_epoch,
    )
    from src.mail.mailbox_semantics import INBOX_LABEL

    print_header("PoC #4: DASL 时区 + message-id 属性名 (只读)")
    print(f"本机时区: tzname={time.tzname} utcoffset={datetime.now().astimezone().utcoffset()}")

    backend = OutlookComBackend(SimpleNamespace(), SimpleNamespace())
    ok, why = backend.probe_readiness()
    print(f"probe_readiness: ok={ok} — {why}")
    if not ok:
        print_verdict(False, ["probe 失败, 无法探测"])
        return EXIT_NO_GO

    def _probe(session: Any) -> dict[str, Any]:
        inbox = backend._default_folder(session, OL_FOLDER_INBOX)
        items = inbox.Items
        items.Sort("[ReceivedTime]", True)  # descending
        newest = items.GetFirst()
        if newest is None:
            return {"empty": True}
        newest_epoch = _to_epoch(_com_get(newest, "ReceivedTime"))
        window = newest_epoch - WINDOW_SEC
        window_minute = window - window % 60

        # 真实数: 按 ReceivedTime 逐封数 (降序, 出窗即停)
        truth = truth_minute = scanned = 0
        item = newest
        while item is not None and scanned < MAX_TRUTH_SCAN:
            scanned += 1
            epoch = _to_epoch(_com_get(item, "ReceivedTime"))
            if epoch is None or epoch < window_minute:
                break
            truth_minute += 1
            truth += epoch >= window
            item = items.GetNext()

        def _count(flt: str) -> Any:
            try:
                return int(_com_get(inbox.Items.Restrict(flt), "Count", -1))
            except Exception as e:  # noqa: BLE001 — 字面量被拒也是探测结果
                return f"error: {e}"

        counts = {}
        for utc in (False, True):
            for seconds in (True, False):
                literal = _literal(window, utc=utc, seconds=seconds)
                key = f"{'UTC' if utc else '本地'}{'带秒' if seconds else '到分钟'} '{literal}'"
                counts[key] = _count(
                    f"@SQL=\"urn:schemas:httpmail:datereceived\" >= '{literal}'"
                )
        production = _count(backend._since_filter(window))

        mid = str(_prop(newest, PR_INTERNET_MESSAGE_ID, "") or "").strip().strip("<>")
        finds = {}
        for prop in MESSAGE_ID_FIND_PROPS:
            for literal in (f"<{mid}>", mid):
                flt = f"@SQL=\"{prop}\" = '{_dasl_quote(literal)}'"
                try:
                    finds[f"{prop} = {literal!r}"] = (
                        "命中" if inbox.Items.Find(flt) is not None else "未命中"
                    )
                except Exception as e:  # noqa: BLE001
                    finds[f"{prop} = {literal!r}"] = f"error: {e}"
        resolved = mid and backend._find_by_message_id(session, mid, INBOX_LABEL) is not None

        return {
            "empty": False,
            "newest_raw": repr(_com_get(newest, "ReceivedTime")),
            "newest_epoch": newest_epoch,
            "window": window,
            "truth": truth,
            "truth_minute": truth_minute,
            "truth_capped": scanned >= MAX_TRUTH_SCAN,
            "counts": counts,
            "production": production,
            "message_id": mid,
            "finds": finds,
            "resolved": bool(resolved),
        }

    r = backend._com(_probe, op="poc4-dasl-probe")
    backend.shutdown()
    if r["empty"]:
        print_verdict(False, ["收件箱为空, 无法探测"])
        return EXIT_NO_GO

    print(f"\n最新一封 ReceivedTime (pywin32 原值): {r['newest_raw']}")
    print(f"  按本地墙钟换算的 epoch: {r['newest_epoch']} "
          f"= {datetime.fromtimestamp(r['newest_epoch'], timezone.utc).isoformat()}")
    print(f"窗口下界 (最新 − {WINDOW_SEC}s): epoch {r['window']}")
    capped = " (达到逐封上限, 偏小)" if r["truth_capped"] else ""
    print(f"真实数: 精确到秒 {r['truth']} / 下界取整到分钟 {r['truth_minute']}{capped}")
    print("\nRestrict 计数:")
    for key, count in r["counts"].items():
        print(f"  {key}: {count}")
    print(f"  正式代码 _since_filter: {r['production']}  (应 == 取整到分钟的真实数)")

    print(f"\nItems.Find (message_id={r['message_id']!r}):")
    for key, hit in r["finds"].items():
        print(f"  {key}: {hit}")
    print(f"  正式代码 _find_by_message_id: {'命中' if r['resolved'] else '未命中'}")

    reasons = []
    if r["production"] != r["truth_minute"]:
        reasons.append(f"Restrict 计数 {r['production']} != 真实数 {r['truth_minute']}")
    if not r["resolved"]:
        reasons.append("_find_by_message_id 未命中最新一封")
    print_verdict(not reasons, reasons or ["UTC 字面量计数与真实数一致, message-id 反查命中"])
    print("请把以上输出贴回 docs/reference/architecture/outlook-com-backend.md §5。")
    return EXIT_GO if not reasons else EXIT_NO_GO


if __name__ == "__main__":
    raise SystemExit(main())
