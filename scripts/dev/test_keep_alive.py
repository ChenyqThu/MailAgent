#!/usr/bin/env python3
"""测试屏幕保活 + 亮度控制
用法:
  python3 scripts/test_keep_alive.py dim        # 亮度调到最低
  python3 scripts/test_keep_alive.py restore    # 恢复亮度
  python3 scripts/test_keep_alive.py jiggle     # 模拟鼠标活动（单次）
  python3 scripts/test_keep_alive.py status     # 查看当前亮度和空闲时间
"""
import sys
import ctypes
import ctypes.util
import subprocess


# ── 亮度控制（DisplayServices 私有框架）──
def _load_display_services():
    try:
        ds = ctypes.cdll.LoadLibrary(
            "/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices"
        )
        cg = ctypes.cdll.LoadLibrary(
            ctypes.util.find_library("CoreGraphics")
        )
        display_id = cg.CGMainDisplayID()
        return ds, display_id
    except Exception as e:
        print(f"无法加载 DisplayServices: {e}")
        return None, None


def get_brightness() -> float:
    ds, display_id = _load_display_services()
    if not ds:
        return -1
    val = ctypes.c_float()
    ds.DisplayServicesGetBrightness.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_float)]
    ds.DisplayServicesGetBrightness(display_id, ctypes.byref(val))
    return round(val.value, 3)


def set_brightness(level: float):
    ds, display_id = _load_display_services()
    if not ds:
        return False
    ds.DisplayServicesSetBrightness.argtypes = [ctypes.c_uint32, ctypes.c_float]
    ds.DisplayServicesSetBrightness(display_id, ctypes.c_float(max(0.0, min(1.0, level))))
    return True


# ── 鼠标微移（Quartz）──
def mouse_jiggle():
    try:
        import Quartz
        pos = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))
        for dx in [1, -1]:
            evt = Quartz.CGEventCreateMouseEvent(
                None, Quartz.kCGEventMouseMoved, (pos.x + dx, pos.y), 0
            )
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)
            import time; time.sleep(0.05)
        return True
    except Exception as e:
        print(f"鼠标微移失败: {e}")
        return False


# ── 系统空闲时间 ──
def get_idle_seconds() -> float:
    try:
        result = subprocess.run(
            ["ioreg", "-c", "IOHIDSystem", "-d", "4"],
            capture_output=True, text=True
        )
        for line in result.stdout.split("\n"):
            if "HIDIdleTime" in line:
                # 值是纳秒
                ns = int(line.split("=")[-1].strip())
                return ns / 1_000_000_000
    except Exception:
        pass
    return -1


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"

    if cmd == "dim":
        cur = get_brightness()
        print(f"当前亮度: {cur}")
        if set_brightness(0.0):
            print(f"已调至最低: {get_brightness()}")
        else:
            print("调整失败")

    elif cmd == "restore":
        if set_brightness(0.5):
            print(f"已恢复亮度: {get_brightness()}")

    elif cmd == "jiggle":
        if mouse_jiggle():
            print("鼠标微移完成")
            idle = get_idle_seconds()
            print(f"空闲时间已重置: {idle:.1f}s")

    elif cmd == "status":
        brightness = get_brightness()
        idle = get_idle_seconds()
        print(f"当前亮度: {brightness}")
        print(f"系统空闲: {idle:.1f}s")

    else:
        print(__doc__)
