"""P0 PoC #3: 环境探测 (task 08-12 Phase 0).

不碰 COM (除非 --dispatch), 纯注册表 + 进程探测, 回答四个问题:

    1. classic Outlook 装了吗?  (HKCR Outlook.Application ProgID + CurVer 版本)
       New Outlook (olk.exe) 在跑吗? —— New Outlook 无 COM 对象模型 (硬前提)
    2. Programmatic Access 策略是什么档?  (ObjectModelGuard 等注册表值 ——
       决定首次 COM 访问会不会弹「允许访问」警告)
    3. 位数: Python 位数 + Outlook Bitness (out-of-proc COM 跨位数可通,
       但要留档进报告)
    4. Outlook 版本号 / 是否正在运行

判定: 检出 classic Outlook ProgID = GO; 否则 NO-GO (New Outlook-only 或未装)。
Programmatic Access / 位数只入报告不进硬阈值。

运行 (Windows):
    python scripts\\poc_win\\poc_3_environment.py [--dispatch]

--dispatch: 额外做一次真 COM Dispatch 读 Application.Version (需 pywin32,
可能触发 Programmatic Access 弹窗 —— 这本身就是 checklist 要观察的行为)。
"""
from __future__ import annotations

import argparse
import struct
import subprocess
from typing import Any, Optional

import poc_common
from poc_common import EXIT_GO, EXIT_NO_GO, print_header, print_verdict, write_report

poc_common.bootstrap_sys_path()

# Programmatic Access 检查的注册表位 (HKCU 用户档 + HKLM 策略档, GPO 下发走 Policies)
_SECURITY_KEY_TEMPLATES = (
    ("HKCU", r"Software\Microsoft\Office\{ver}\Outlook\Security"),
    ("HKLM", r"Software\Microsoft\Office\{ver}\Outlook\Security"),
    ("HKCU", r"Software\Policies\Microsoft\Office\{ver}\Outlook\Security"),
    ("HKLM", r"Software\Policies\Microsoft\Office\{ver}\Outlook\Security"),
)
_OFFICE_VERSIONS = ("16.0", "15.0")  # 2016+/365 = 16.0; 2013 = 15.0

#: ObjectModelGuard 值语义 (Microsoft 文档)
_OMG_MEANING = {
    0: "0 = 杀软状态有效时不弹窗 (默认); 杀软缺失/过期时弹警告",
    1: "1 = 恒弹警告 (最严)",
    2: "2 = 恒不弹 (最松, 企业 GPO 常用)",
}


def _read_reg(root_name: str, path: str, value: Optional[str] = None) -> Any:
    """读注册表值; 键/值不存在返回 None. 仅 win32 调用 (winreg 是 Windows 专属 stdlib)."""
    import winreg

    root = {"HKCU": winreg.HKEY_CURRENT_USER, "HKLM": winreg.HKEY_LOCAL_MACHINE,
            "HKCR": winreg.HKEY_CLASSES_ROOT}[root_name]
    try:
        with winreg.OpenKey(root, path) as key:
            if value is None:
                return winreg.QueryValueEx(key, "")[0]
            return winreg.QueryValueEx(key, value)[0]
    except OSError:
        return None


def _process_running(image_name: str) -> Optional[bool]:
    """tasklist 查进程; 探测本身失败返回 None (不猜)."""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {image_name}", "/NH"],
            capture_output=True, text=True, timeout=15, check=False,
        ).stdout
        return image_name.lower() in (out or "").lower()
    except Exception:  # noqa: BLE001 — 探测失败 ≠ 没在跑
        return None


def main(argv: Optional[list[str]] = None) -> int:
    poc_common.exit_if_not_win32("Outlook 环境探测 (注册表/进程, Windows 专属)")

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dispatch", action="store_true",
        help="额外真 COM Dispatch 读版本 (需 pywin32, 可能触发 Programmatic Access 弹窗)",
    )
    args = parser.parse_args(argv)

    print_header("PoC #3: 环境探测")
    report: dict[str, Any] = {"poc": "poc_3_environment"}

    # -- 1. classic Outlook COM 注册 --
    curver = _read_reg("HKCR", r"Outlook.Application\CurVer")
    clsid = _read_reg("HKCR", r"Outlook.Application\CLSID")
    classic_registered = bool(curver or clsid)
    print(f"[1] classic Outlook COM 注册: CurVer={curver!r} CLSID={clsid!r} → "
          f"{'检出' if classic_registered else '未检出'}")
    report["classic_outlook"] = {"curver": curver, "clsid": clsid, "registered": classic_registered}

    # New Outlook 迹象 (olk.exe 进程 + 切换开关注册表)
    olk_running = _process_running("olk.exe")
    use_new = None
    for ver in _OFFICE_VERSIONS:
        v = _read_reg("HKCU", rf"Software\Microsoft\Office\{ver}\Outlook\Preferences", "UseNewOutlook")
        if v is not None:
            use_new = v
            break
    print(f"    New Outlook: olk.exe 运行={olk_running} UseNewOutlook={use_new!r}")
    if olk_running or (isinstance(use_new, int) and use_new == 1):
        print("    ⚠️ 检测到 New Outlook 迹象 —— New Outlook 无 COM 对象模型, backend 需要 classic Outlook")
    report["new_outlook"] = {"olk_running": olk_running, "use_new_outlook": use_new}

    # -- 2. Programmatic Access --
    print("[2] Programmatic Access (ObjectModelGuard):")
    pa: list[dict] = []
    for root, tpl in _SECURITY_KEY_TEMPLATES:
        for ver in _OFFICE_VERSIONS:
            path = tpl.format(ver=ver)
            omg = _read_reg(root, path, "ObjectModelGuard")
            adminonly = _read_reg(root, path, "AdminSecurityMode")
            if omg is not None or adminonly is not None:
                meaning = _OMG_MEANING.get(omg, f"{omg!r} (未知值)") if omg is not None else "(未设)"
                print(f"    {root}\\{path}: ObjectModelGuard={omg!r} → {meaning}; AdminSecurityMode={adminonly!r}")
                pa.append({"root": root, "path": path, "object_model_guard": omg,
                           "admin_security_mode": adminonly})
    if not pa:
        print("    未找到任何 Security 键 → 走 Outlook 默认行为 (杀软有效=不弹; 否则首次访问弹「允许访问」)")
    report["programmatic_access"] = pa

    # -- 3. 位数 --
    py_bits = struct.calcsize("P") * 8
    outlook_bitness = None
    for root in ("HKLM",):
        for ver in _OFFICE_VERSIONS:
            v = _read_reg(root, rf"Software\Microsoft\Office\{ver}\Outlook", "Bitness")
            if v:
                outlook_bitness = v
                break
    print(f"[3] 位数: Python={py_bits}-bit, Outlook Bitness={outlook_bitness!r} "
          "(out-of-proc COM 跨位数可通, 仅留档)")
    report["bitness"] = {"python_bits": py_bits, "outlook_bitness": outlook_bitness}

    # -- 4. 版本 / 运行状态 --
    outlook_running = _process_running("OUTLOOK.EXE")
    print(f"[4] OUTLOOK.EXE 运行中: {outlook_running}")
    report["outlook_running"] = outlook_running

    if args.dispatch:
        print("    --dispatch: 真 COM 读版本 (Outlook 未运行会被拉起; 观察是否弹 Programmatic Access 警告)…")
        try:
            import win32com.client  # 懒 import: --dispatch 显式要求时才触达 pywin32

            app = win32com.client.Dispatch("Outlook.Application")
            version = str(app.Version)
            print(f"    Application.Version = {version}")
            report["dispatch"] = {"ok": True, "version": version}
        except Exception as e:  # noqa: BLE001 — 探测失败原样入报告
            print(f"    Dispatch 失败: {type(e).__name__}: {e}")
            report["dispatch"] = {"ok": False, "error": str(e)}

    go = classic_registered
    print_verdict(go, [
        f"classic Outlook COM 注册: {'检出' if classic_registered else '未检出 (未装或 New Outlook-only)'}",
        "Programmatic Access / 位数 / 运行状态仅留档, 不进硬阈值",
    ])

    report["verdict"] = "GO" if go else "NO-GO"
    path = write_report("poc3-environment", report)
    print(f"\nJSON 报告: {path}")
    return EXIT_GO if go else EXIT_NO_GO


if __name__ == "__main__":
    raise SystemExit(main())
