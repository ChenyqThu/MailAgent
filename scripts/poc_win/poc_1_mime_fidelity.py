"""P0 PoC #1: MIME 重组保真度 (go/no-go 先行闸门核心, task 08-12 Phase 0).

连本机 classic Outlook, 取收件箱最近 N 封 (默认 50), 逐封走**正式模块**链路:

    OutlookComBackend._snapshot_item (STA 线程, COM 属性抽取)
        → outlook_mime.rebuild_rfc822 (纯函数, MIME 重组)
        → EmailReader.parse_email_source (本仓解析链入口)

按邮件维度记录字段保真度, 输出终端摘要 + JSON 报告 + go/no-go 判定。

go/no-go 阈值 (prd §3 P0 行 + §5 风险 1):
    - crash == 0            重组/解析链任何未捕获异常 (逐封 try 住并计数)
    - parse 成功率 >= 99%    parse_email_source 返回非 None
    - 常规邮件字段保真 >= 98%  常规 = 有 transport headers 且有 Message-ID 的邮件,
                             全部字段检查 (subject/from/to/date/message_id/html/
                             附件数/中文) 通过才算该封保真
    以上三条全过 = GO; 任一不过 = NO-GO。
    特殊类别 (.ics / 内联图 / 合成 Message-ID / 无 transport headers 占比 /
    Exchange DN 解析失败率) 只计数入报告, 不进 go/no-go 硬阈值 —— 它们是
    v1 已知降级面, 数据供人工评估。

运行 (Windows, classic Outlook 已登录):
    python scripts\\poc_win\\poc_1_mime_fidelity.py [--count 50]

对应 POC_CHECKLIST (tests/mail/backend/test_outlook_mime.py) 自动化覆盖:
    #1 transport headers 可达率 → headers_missing 计数
    #2 HTMLBody mojibake      → CJK 完整性断言 (U+FFFD / CJK 存活)
    #3 OLE SaveAsFile         → raw vs extracted 附件数差值计数
    #4 Content-ID 形态        → cid 引用命中/未命中计数
    #6 坏头 compat32 兜底     → loguru 日志计数 (retrying compat32)
    #7 Exchange DN 解析失败率  → sender_unresolved 计数
    #5 (.ics 会议邀请是否成 MailItem) 无法纯自动判定 → 人工检查提示
"""
from __future__ import annotations

import argparse
import re
import time
import traceback
from typing import Any, Optional

import poc_common
from poc_common import (
    EXIT_GO,
    EXIT_NO_GO,
    LoguruCounter,
    print_header,
    print_verdict,
    write_report,
)

poc_common.bootstrap_sys_path()
poc_common.ensure_env()

# 正式模块 (纯 Python 面, mac 可 import; COM 触达全在 win32 闸后) —— PoC 纪律:
# 直接调用要上线的代码, 不做独立拷贝。
from src.mail.backend.outlook_mime import ItemSnapshot, rebuild_rfc822  # noqa: E402

# --- 阈值 (docstring 表格的机器可读版) ---
THRESHOLD_PARSE_RATE = 0.99
THRESHOLD_FIDELITY_RATE = 0.98
DATE_TOLERANCE_SEC = 6 * 3600  # Date 头(原件) vs ReceivedTime(投递) 允许差

_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")


def _has_cjk(text: Optional[str]) -> bool:
    return bool(text and _CJK_RE.search(text))


def _check_one(snap: ItemSnapshot, raw_attachment_count: int, email: Any) -> dict:
    """单封字段保真检查 → {check_name: bool|None} (None = 该封不适用)."""
    checks: dict[str, Optional[bool]] = {}

    # subject: 空主题时 Email.__post_init__ 会写 "(No Subject)", 只比非空主题
    checks["subject"] = (email.subject == snap.subject) if snap.subject else None

    # from: COM 侧 SMTP 解析成功才可比 (失败单独计 sender_unresolved)
    if snap.sender_email and "@" in snap.sender_email:
        checks["from"] = snap.sender_email.lower() in (email.sender or "").lower()
    else:
        checks["from"] = None

    # to: Outlook To 是显示名分号串, transport 头里才是真地址 → 只做非空性检查
    checks["to"] = bool((email.to or "").strip()) if snap.to.strip() else None

    # date: 原件 Date 头与投递时间天然有分钟级差; 超过容差 = 时区级错误
    if snap.received_time is not None and email.date is not None:
        try:
            delta = abs((email.date - snap.received_time).total_seconds())
            checks["date"] = delta <= DATE_TOLERANCE_SEC
        except TypeError:  # naive/aware 混比 = 重组链时区处理有 bug, 记失败
            checks["date"] = False
    else:
        checks["date"] = None

    # message_id: COM 侧有值时必须逐字过解析链
    checks["message_id"] = (
        (email.message_id == snap.message_id) if snap.message_id else None
    )

    # html: 快照有 HTMLBody → 解析产物必须是非空 html
    if snap.html_body:
        checks["html"] = bool(
            email.content_type == "text/html" and (email.content or "").strip()
        )
    else:
        checks["html"] = None

    # 附件数: 解析产物 == 快照数 (快照已排除 OLE; raw 差值另行计数)
    checks["attachment_count"] = len(email.attachments) == len(snap.attachments)

    # CJK 完整性: 主题/正文有中文 → 解析产物无 U+FFFD 且中文存活
    src_text = f"{snap.subject}\n{snap.html_body or ''}\n{snap.plain_body or ''}"
    if _has_cjk(src_text):
        parsed_text = f"{email.subject}\n{email.content or ''}"
        checks["cjk"] = "\ufffd" not in parsed_text and _has_cjk(parsed_text)
    else:
        checks["cjk"] = None

    return checks


def _collect_snapshots(backend: Any, count: int) -> list[dict]:
    """STA 线程上枚举收件箱最近 count 封 → [{snap, raw_attachment_count, error}].

    单封快照失败不炸整批 (记 error 计入 crash 统计)。
    """

    def _scan(session: Any) -> list[dict]:
        # 收件箱定位走正式模块同一路径 (GetDefaultFolder)
        from src.mail.backend.outlook_com_backend import OL_FOLDER_INBOX

        folder = session.namespace.GetDefaultFolder(OL_FOLDER_INBOX)
        items = folder.Items
        items.Sort("[ReceivedTime]", True)  # descending: 最近优先
        out: list[dict] = []
        item = items.GetFirst()
        while item is not None and len(out) < count:
            try:
                if int(getattr(item, "Class", 43)) == 43:  # olMail only
                    raw_att = 0
                    atts = getattr(item, "Attachments", None)
                    if atts is not None:
                        raw_att = int(getattr(atts, "Count", 0) or 0)
                    snap = backend._snapshot_item(
                        item, want_attachments=True, want_headers=True
                    )
                    out.append(
                        {"snap": snap, "raw_attachment_count": raw_att, "error": None}
                    )
            except Exception as e:  # noqa: BLE001 — 单封失败计数, 不炸整批
                out.append(
                    {
                        "snap": None,
                        "raw_attachment_count": 0,
                        "error": f"{type(e).__name__}: {e}",
                    }
                )
            item = items.GetNext()
        return out

    return backend._com(_scan, op="poc1-scan-inbox")


def main(argv: Optional[list[str]] = None) -> int:
    poc_common.exit_if_not_win32("MIME 重组保真度 (需要本机 classic Outlook COM)")

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--count", type=int, default=50, help="取收件箱最近 N 封 (默认 50)")
    args = parser.parse_args(argv)

    from types import SimpleNamespace

    from src.mail.backend.outlook_com_backend import OutlookComBackend
    from src.mail.reader import EmailReader

    print_header(f"PoC #1: MIME 重组保真度 — 收件箱最近 {args.count} 封")

    # sync_store 仅 get_new_emails 分配 internal_id 时触达, PoC 不走那条路 → 占位
    backend = OutlookComBackend(SimpleNamespace(), SimpleNamespace())
    reader = EmailReader()

    ok, why = backend.probe_readiness()
    print(f"probe_readiness: ok={ok} — {why}")
    if not ok:
        print("[poc1] Outlook COM 不可达, 无法执行。先跑 poc_3_environment.py 排查。")
        return EXIT_NO_GO

    log_counter = LoguruCounter()
    log_counter.attach()

    t0 = time.time()
    entries = _collect_snapshots(backend, args.count)
    scan_sec = time.time() - t0
    print(f"快照完成: {len(entries)} 封, 耗时 {scan_sec:.1f}s")

    # --- 逐封重组 + 解析 + 检查 ---
    stats = {
        "total": len(entries),
        "snapshot_errors": 0,
        "rebuild_crashes": 0,
        "parse_failures": 0,
        "regular_total": 0,       # 有 transport headers 且有 Message-ID
        "regular_fidelity_ok": 0,
        "headers_missing": 0,     # checklist #1: 走合成头路径
        "synthetic_message_id": 0,  # COM 侧取不到 PR_INTERNET_MESSAGE_ID
        "sender_unresolved": 0,   # checklist #7: Exchange DN 解析失败
        "ics_emails": 0,
        "inline_image_emails": 0,
        "cid_ref_missing": 0,     # checklist #4: 有 content_id 附件但 html 无 cid: 引用
        "ole_skipped_attachments": 0,  # checklist #3: raw - extracted 差值
        "cjk_emails": 0,
    }
    check_fail_counts: dict[str, int] = {}
    failures: list[dict] = []  # 前 20 条失败明细进报告

    for idx, entry in enumerate(entries):
        if entry["error"]:
            stats["snapshot_errors"] += 1
            failures.append({"index": idx, "stage": "snapshot", "error": entry["error"]})
            continue
        snap: ItemSnapshot = entry["snap"]

        # 特殊类别计数 (与保真判定解耦)
        if not snap.transport_headers:
            stats["headers_missing"] += 1
        if not snap.message_id:
            stats["synthetic_message_id"] += 1
        if not (snap.sender_email and "@" in snap.sender_email):
            stats["sender_unresolved"] += 1
        if any((a.filename or "").lower().endswith(".ics") for a in snap.attachments):
            stats["ics_emails"] += 1
        inline_atts = [a for a in snap.attachments if a.content_id]
        if inline_atts:
            stats["inline_image_emails"] += 1
            html = snap.html_body or ""
            if "cid:" not in html.lower():
                stats["cid_ref_missing"] += 1
        ole_diff = entry["raw_attachment_count"] - len(snap.attachments)
        if ole_diff > 0:
            stats["ole_skipped_attachments"] += ole_diff
        if _has_cjk(snap.subject) or _has_cjk(snap.html_body) or _has_cjk(snap.plain_body):
            stats["cjk_emails"] += 1

        # 重组 → 解析 (正式链路; crash 逐封捕获计数)
        try:
            source = rebuild_rfc822(snap)
        except Exception as e:  # noqa: BLE001 — crash 是 go/no-go 硬指标, 必须记全
            stats["rebuild_crashes"] += 1
            failures.append(
                {
                    "index": idx,
                    "stage": "rebuild",
                    "subject": snap.subject[:80],
                    "error": f"{type(e).__name__}: {e}",
                    "traceback": traceback.format_exc(limit=5),
                }
            )
            continue

        email = reader.parse_email_source(
            source, snap.message_id, snap.is_read, snap.is_flagged
        )
        if email is None:
            stats["parse_failures"] += 1
            failures.append(
                {"index": idx, "stage": "parse", "subject": snap.subject[:80]}
            )
            continue

        # 字段保真
        checks = _check_one(snap, entry["raw_attachment_count"], email)
        failed = [k for k, v in checks.items() if v is False]
        for k in failed:
            check_fail_counts[k] = check_fail_counts.get(k, 0) + 1

        is_regular = bool(snap.transport_headers and snap.message_id)
        if is_regular:
            stats["regular_total"] += 1
            if not failed:
                stats["regular_fidelity_ok"] += 1
        if failed:
            failures.append(
                {
                    "index": idx,
                    "stage": "fidelity",
                    "subject": snap.subject[:80],
                    "failed_checks": failed,
                    "regular": is_regular,
                }
            )

    log_counter.detach()

    # --- 汇总 ---
    parsed = stats["total"] - stats["snapshot_errors"] - stats["rebuild_crashes"] - stats["parse_failures"]
    attempted = stats["total"] - stats["snapshot_errors"]
    parse_rate = (parsed / attempted) if attempted else 0.0
    fidelity_rate = (
        stats["regular_fidelity_ok"] / stats["regular_total"]
        if stats["regular_total"]
        else 0.0
    )
    crashes = stats["snapshot_errors"] + stats["rebuild_crashes"]

    print_header("统计")
    for k, v in stats.items():
        print(f"  {k:28s} = {v}")
    print(f"  {'parse_rate':28s} = {parse_rate:.1%}")
    print(f"  {'regular_fidelity_rate':28s} = {fidelity_rate:.1%}")
    if check_fail_counts:
        print("  按检查项失败计数:")
        for k, v in sorted(check_fail_counts.items()):
            print(f"    {k:26s} = {v}")
    print("  重组链兜底分支触发 (日志计数):")
    for k, v in log_counter.counts.items():
        print(f"    {k:26s} = {v}")

    # --- go/no-go ---
    reasons = [
        f"crash == 0: {'过' if crashes == 0 else f'不过 ({crashes})'}",
        f"parse 成功率 >= {THRESHOLD_PARSE_RATE:.0%}: "
        f"{'过' if parse_rate >= THRESHOLD_PARSE_RATE else '不过'} ({parse_rate:.1%})",
        f"常规邮件字段保真 >= {THRESHOLD_FIDELITY_RATE:.0%}: "
        f"{'过' if fidelity_rate >= THRESHOLD_FIDELITY_RATE else '不过'} "
        f"({fidelity_rate:.1%}, 样本 {stats['regular_total']} 封)",
    ]
    go = (
        crashes == 0
        and parse_rate >= THRESHOLD_PARSE_RATE
        and fidelity_rate >= THRESHOLD_FIDELITY_RATE
    )
    if stats["regular_total"] < 10:
        go = False
        reasons.append(
            f"常规邮件样本不足 (<10, 实际 {stats['regular_total']}) — 加大 --count 重跑"
        )
    print_verdict(go, reasons)

    # --- 人工检查提示 (POC_CHECKLIST 中不可自动化的点) ---
    print_header("人工检查提示 (自动化覆盖不到)")
    print(
        "  [#5 .ics 会议邀请] 请向本邮箱发一封真实会议邀请后重跑本脚本:\n"
        "      - Outlook 可能把邀请存成 AppointmentItem (Class != 43, 本脚本会跳过)\n"
        "      - 若 ics_emails 恒为 0 且收件箱确有邀请 → 需要 PR_ATTACH_METHOD 特判,\n"
        "        v1 会议邀请→日程链路在 outlook_com 上不可用 (记入报告给 owner)\n"
        "  [#2 HTMLBody 编码] 若 cjk_emails > 0 且 cjk 检查全过, 可判定 Outlook 已把\n"
        "      非 UTF-8 原件归一为 Unicode; 但建议人工开 1-2 封 gb2312 老邮件比对渲染\n"
        "  [#3 OLE 附件] ole_skipped_attachments > 0 时, 人工确认这些邮件在 Outlook\n"
        "      里的附件是否为嵌入对象 (.msg 嵌套/OLE), 而非真实文件附件被误跳"
    )

    report = {
        "poc": "poc_1_mime_fidelity",
        "count_requested": args.count,
        "scan_seconds": round(scan_sec, 1),
        "stats": stats,
        "parse_rate": parse_rate,
        "regular_fidelity_rate": fidelity_rate,
        "check_fail_counts": check_fail_counts,
        "rebuild_fallback_log_counts": log_counter.counts,
        "verdict": "GO" if go else "NO-GO",
        "verdict_reasons": reasons,
        "failures_sample": failures[:20],
    }
    path = write_report("poc1-mime-fidelity", report)
    print(f"\nJSON 报告: {path}")

    backend.shutdown()
    return EXIT_GO if go else EXIT_NO_GO


if __name__ == "__main__":
    raise SystemExit(main())
