#!/usr/bin/env python3
"""测试通过 CGEventPost 远程解锁屏幕
用法（从 Mac Mini SSH 到 MacBook 后执行）:
  python3 scripts/test_remote_unlock.py --test-type     # 仅测试能否在锁屏上打字（不输入密码）
  python3 scripts/test_remote_unlock.py --unlock         # 从 Keychain 读取密码并解锁

密码存储（在 MacBook 上执行一次）:
  security add-generic-password -s "mailagent-unlock" -a "$USER" -w "你的登录密码" -U

原理:
  CGEventPost(kCGHIDEventTap) 在 HID 层注入键盘事件
  相当于物理键盘输入，理论上可以穿透锁屏
"""
import os
import sys
import time
import subprocess
import ctypes
import ctypes.util


def wake_display():
    """唤醒显示器"""
    subprocess.run(["caffeinate", "-u", "-t", "5"], capture_output=True)
    time.sleep(2)


def is_screen_locked() -> bool:
    """检查屏幕是否已锁定（兼容 SSH 远程调用）

    从 SSH 会话中，Quartz CGSession/CGWindowList API 看不到控制台状态。
    使用多种方法组合检测。
    """
    # 方法 1: ioreg 检查 IOConsoleUsers 中的锁定状态
    try:
        result = subprocess.run(
            ["ioreg", "-n", "Root", "-d1"],
            capture_output=True, text=True
        )
        for line in result.stdout.split("\n"):
            if "CGSSessionScreenIsLocked" in line and "= 1" in line:
                return True
    except Exception:
        pass

    # 方法 2: 检查 SecurityAgent 进程（锁屏密码框激活时才运行）
    try:
        result = subprocess.run(["pgrep", "-x", "SecurityAgent"], capture_output=True)
        if result.returncode == 0:
            return True
    except Exception:
        pass

    # 方法 3: Quartz CGSession（本地会话时有效）
    try:
        import Quartz
        d = Quartz.CGSessionCopyCurrentDictionary()
        if d and d.get("CGSSessionScreenIsLocked", 0):
            return True
    except Exception:
        pass

    # 方法 4: 检查系统空闲时间 — 如果空闲很长且 MDM 强制锁屏，很可能已锁
    try:
        result = subprocess.run(
            ["ioreg", "-c", "IOHIDSystem", "-d", "4"],
            capture_output=True, text=True
        )
        for line in result.stdout.split("\n"):
            if "HIDIdleTime" in line:
                ns = int(line.split("=")[-1].strip())
                idle_sec = ns / 1_000_000_000
                if idle_sec > 600:  # 空闲 > 10 分钟，大概率已锁
                    return True
                break
    except Exception:
        pass

    return False


# ── HID 键盘模拟（通过 ctypes 调用 CoreGraphics C API，无需 PyObjC）──
_cg = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")

# CGEventRef CGEventCreateKeyboardEvent(CGEventSourceRef, CGKeyCode, bool keyDown)
_cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
_cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p

# void CGEventPost(CGEventTapLocation, CGEventRef)
_cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]

# void CGEventKeyboardSetUnicodeString(CGEventRef, UniCharCount, const UniChar*)
_cg.CGEventKeyboardSetUnicodeString.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p]

# CFRelease
_cf = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
_cf.CFRelease.argtypes = [ctypes.c_void_p]

kCGHIDEventTap = 0  # HID 层事件注入点


def _press_key(keycode: int):
    """模拟按下并释放一个键"""
    event_down = _cg.CGEventCreateKeyboardEvent(None, keycode, True)
    _cg.CGEventPost(kCGHIDEventTap, event_down)
    _cf.CFRelease(event_down)
    time.sleep(0.02)
    event_up = _cg.CGEventCreateKeyboardEvent(None, keycode, False)
    _cg.CGEventPost(kCGHIDEventTap, event_up)
    _cf.CFRelease(event_up)
    time.sleep(0.02)


def type_string_hid(text: str):
    """通过 CGEventPost HID 层模拟键盘输入"""
    for char in text:
        event_down = _cg.CGEventCreateKeyboardEvent(None, 0, True)
        _cg.CGEventKeyboardSetUnicodeString(event_down, 1, char)
        _cg.CGEventPost(kCGHIDEventTap, event_down)
        _cf.CFRelease(event_down)
        time.sleep(0.02)

        event_up = _cg.CGEventCreateKeyboardEvent(None, 0, False)
        _cg.CGEventPost(kCGHIDEventTap, event_up)
        _cf.CFRelease(event_up)
        time.sleep(0.02)


def press_enter():
    """模拟按下 Enter 键"""
    _press_key(36)


def press_escape():
    """模拟按下 Escape 键"""
    _press_key(53)


def get_password() -> str:
    """读取解锁密码（文件 > Keychain fallback）"""
    # 方法 1: 从文件读取（锁屏时 Keychain 不可用，文件始终可读）
    pass_file = os.path.expanduser("~/.mailagent_unlock_pass")
    if os.path.exists(pass_file):
        try:
            with open(pass_file) as f:
                pw = f.read().strip()
            if pw:
                return pw
        except Exception:
            pass

    # 方法 2: Keychain fallback（屏幕未锁时可用）
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", "mailagent-unlock",
             "-a", subprocess.check_output(["whoami"]).decode().strip(), "-w"],
            capture_output=True, text=True
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass

    return ""


def unlock_screen(force=False):
    """解锁屏幕"""
    print("1. 检查锁屏状态...")
    locked = is_screen_locked()
    print(f"   锁屏: {locked}")

    if not locked and not force:
        print("   屏幕未锁定，无需解锁（用 --force 跳过检测）")
        return True

    if not locked and force:
        print("   检测为未锁定，但 --force 强制执行解锁流程")

    print("2. 唤醒显示器...")
    wake_display()

    print("3. 从 Keychain 读取密码...")
    password = get_password()
    if not password:
        print("   密码为空，请先存储: security add-generic-password -s 'mailagent-unlock' -a $USER -w '密码' -U")
        return False

    print(f"4. 输入密码 ({len(password)} 字符)...")
    # 先按 Escape 清除可能的残留输入
    press_escape()
    time.sleep(0.5)

    # 点击一下屏幕激活密码输入框（有些锁屏需要）
    _cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.Structure, ctypes.c_uint32]
    _cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p

    class CGPoint(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

    try:
        pt = CGPoint(400, 400)
        click_down = _cg.CGEventCreateMouseEvent(None, 1, pt, 0)  # kCGEventLeftMouseDown=1
        _cg.CGEventPost(kCGHIDEventTap, click_down)
        _cf.CFRelease(click_down)
        time.sleep(0.05)
        click_up = _cg.CGEventCreateMouseEvent(None, 2, pt, 0)  # kCGEventLeftMouseUp=2
        _cg.CGEventPost(kCGHIDEventTap, click_up)
        _cf.CFRelease(click_up)
    except Exception:
        pass
    time.sleep(0.5)

    # 输入密码
    type_string_hid(password)
    time.sleep(0.3)

    # 按 Enter
    press_enter()
    time.sleep(2)

    print("5. 验证解锁结果...")
    still_locked = is_screen_locked()
    if not still_locked:
        print("   解锁成功!")
        return True
    else:
        print("   解锁失败 - CGEventPost 可能无法穿透锁屏")
        # 清除输入的错误密码
        press_escape()
        return False


def test_type():
    """仅测试 HID 打字能力（不输入密码）"""
    print("测试 HID 键盘输入...")
    print("3 秒后将输入 'hello' — 请观察锁屏密码框或任何文本框")
    time.sleep(3)
    type_string_hid("hello")
    print("完成。检查是否有 'hello' 出现。")


if __name__ == "__main__":
    if "--unlock" in sys.argv:
        force = "--force" in sys.argv
        unlock_screen(force=force)
    elif "--test-type" in sys.argv:
        test_type()
    elif "--status" in sys.argv:
        locked = is_screen_locked()
        print(f"锁屏状态: {'已锁定' if locked else '未锁定'}")
    else:
        print(__doc__)
