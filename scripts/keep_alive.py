#!/usr/bin/env python3
"""防锁屏保活服务 — 随机模拟用户活动，防止 MDM 自动锁屏

用法:
  python3 scripts/keep_alive.py daemon [--dim] [--force]  # 常驻模式（--force 忽略工作时段）
  python3 scripts/keep_alive.py start [--duration 30]    # 手动启动（默认 30 分钟后停止）
  python3 scripts/keep_alive.py stop                     # 停止保活
  python3 scripts/keep_alive.py status                   # 查看状态
  python3 scripts/keep_alive.py dim                      # 亮度调到最低
  python3 scripts/keep_alive.py restore                  # 恢复亮度

daemon 模式调度规则:
  - 工作日 9:00-12:00, 13:00-18:00 → 暂停（用户在工位）
  - 其他时间 → 自动保活
  - 检测到真人操作(鼠标大幅移动) → 暂停，等待空闲后恢复
  - 空闲超过 3 分钟且非工作时段 → 自动恢复保活

可通过 SSH 从 Mac Mini 远程启动:
  ssh user@macbook "cd MailAgent && nohup python3 scripts/keep_alive.py daemon --dim &"
"""
import os
import sys
import time
import random
import signal
import json
import ctypes
import ctypes.util
import subprocess
import threading
from datetime import datetime, timedelta

STATE_FILE = os.path.expanduser("~/.mailagent_keep_alive.json")
PID_FILE = os.path.expanduser("~/.mailagent_keep_alive.pid")

# ── CoreGraphics (ctypes, 不依赖 PyObjC) ──
_cg = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")


class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


# CGEventCreateMouseEvent
_cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
_cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p

# CGEventGetLocation
_cg.CGEventCreate.argtypes = [ctypes.c_void_p]
_cg.CGEventCreate.restype = ctypes.c_void_p
_cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
_cg.CGEventGetLocation.restype = CGPoint

# CGEventPost
_cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]

# CFRelease
_cf = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
_cf.CFRelease.argtypes = [ctypes.c_void_p]

kCGHIDEventTap = 0
kCGEventMouseMoved = 5


def _get_mouse_pos() -> tuple:
    evt = _cg.CGEventCreate(None)
    pt = _cg.CGEventGetLocation(evt)
    _cf.CFRelease(evt)
    return (pt.x, pt.y)


def _move_mouse(x: float, y: float):
    pt = CGPoint(x, y)
    evt = _cg.CGEventCreateMouseEvent(None, kCGEventMouseMoved, pt, 0)
    _cg.CGEventPost(kCGHIDEventTap, evt)
    _cf.CFRelease(evt)


# ── 亮度控制 (DisplayServices) ──
def _load_ds():
    try:
        ds = ctypes.cdll.LoadLibrary(
            "/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices"
        )
        cg2 = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))
        display_id = cg2.CGMainDisplayID()
        return ds, display_id
    except Exception:
        return None, None


def get_brightness() -> float:
    ds, did = _load_ds()
    if not ds:
        return -1
    val = ctypes.c_float()
    ds.DisplayServicesGetBrightness.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_float)]
    ds.DisplayServicesGetBrightness(did, ctypes.byref(val))
    return round(val.value, 3)


def set_brightness(level: float):
    ds, did = _load_ds()
    if not ds:
        return False
    ds.DisplayServicesSetBrightness.argtypes = [ctypes.c_uint32, ctypes.c_float]
    ds.DisplayServicesSetBrightness(did, ctypes.c_float(max(0.0, min(1.0, level))))
    return True


# ── 调度规则 ──
# 工作时段：工作日 9-12, 13-18 不保活（用户在工位）
WORK_HOURS = [(9, 12), (13, 18)]  # (start_hour, end_hour)
IDLE_THRESHOLD = 180  # 空闲超过 3 分钟视为用户离开
USER_PAUSE_COOLDOWN = 300  # 检测到真人后暂停 5 分钟再检查空闲


def is_work_hours(now: datetime = None) -> bool:
    """判断当前是否为工作时段（工作日 9-12, 13-18）"""
    now = now or datetime.now()
    if now.weekday() >= 5:  # 周六日
        return False
    for start_h, end_h in WORK_HOURS:
        if start_h <= now.hour < end_h:
            return True
    return False


def get_idle_seconds() -> float:
    """获取系统空闲时间（秒）；ioreg 失败/超时返回 -1（调用方按"未知"处理）"""
    try:
        # 必须带 timeout：ioreg 偶发卡死会永久阻塞单线程主循环
        # （正常 <10ms，5s 已是充分容错）
        result = subprocess.run(
            ["ioreg", "-c", "IOHIDSystem", "-d", "4"],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.split("\n"):
            if "HIDIdleTime" in line:
                ns = int(line.split("=")[-1].strip())
                return ns / 1_000_000_000
    except Exception:
        pass
    return -1


# ── 保活主逻辑 ──
def jiggle_mouse():
    """随机微移鼠标，模拟用户活动"""
    x, y = _get_mouse_pos()
    # 随机偏移 1~3 像素，随机方向
    dx = random.choice([-1, 1]) * random.randint(1, 3)
    dy = random.choice([-1, 1]) * random.randint(1, 3)
    _move_mouse(x + dx, y + dy)
    time.sleep(0.05 + random.random() * 0.1)
    _move_mouse(x, y)  # 移回原位


def detect_real_user(last_pos: tuple) -> bool:
    """检测是否有真人操作（鼠标大幅移动 > 50px）"""
    cur = _get_mouse_pos()
    dx = abs(cur[0] - last_pos[0])
    dy = abs(cur[1] - last_pos[1])
    return dx > 50 or dy > 50


def save_state(state: dict):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f)


def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def run_keep_alive(duration_min: int = 30, dim: bool = False):
    """运行保活循环"""
    pid = os.getpid()
    start_time = time.time()
    end_time = start_time + duration_min * 60
    original_brightness = get_brightness() if dim else None

    # 保存 PID
    with open(PID_FILE, 'w') as f:
        f.write(str(pid))

    # 保存状态
    save_state({
        "active": True,
        "pid": pid,
        "start": datetime.now().isoformat(),
        "duration_min": duration_min,
        "dim": dim,
        "original_brightness": original_brightness,
    })

    # 信号处理（优雅退出）
    def _shutdown(signum, frame):
        print(f"\n收到信号 {signum}，停止保活...")
        _cleanup(original_brightness)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    # 调低亮度
    if dim:
        set_brightness(0.0)
        print(f"亮度已调至最低（原始: {original_brightness}）")

    print(f"保活已启动 | PID={pid} | 持续 {duration_min} 分钟 | 到 {datetime.fromtimestamp(end_time).strftime('%H:%M:%S')}")

    last_jiggle_pos = _get_mouse_pos()
    jiggle_count = 0

    try:
        while time.time() < end_time:
            # 检测真人操作
            if detect_real_user(last_jiggle_pos):
                print("检测到用户操作，停止保活")
                _cleanup(original_brightness)
                return

            # 随机间隔 2~5 分钟
            interval = random.randint(120, 300) + random.random() * 30
            # 分段 sleep，便于及时响应信号和用户检测
            sleep_end = time.time() + interval
            while time.time() < sleep_end and time.time() < end_time:
                time.sleep(min(5, sleep_end - time.time()))
                # 每 5 秒检查真人操作
                if detect_real_user(last_jiggle_pos):
                    print("检测到用户操作，停止保活")
                    _cleanup(original_brightness)
                    return

            if time.time() >= end_time:
                break

            # 执行 jiggle
            jiggle_mouse()
            last_jiggle_pos = _get_mouse_pos()
            jiggle_count += 1

            remaining = int((end_time - time.time()) / 60)
            print(f"  jiggle #{jiggle_count} | 剩余 {remaining} 分钟")

    except KeyboardInterrupt:
        pass
    finally:
        print(f"保活结束 | 共 jiggle {jiggle_count} 次")
        _cleanup(original_brightness)


def _cleanup(original_brightness):
    """恢复亮度，清理状态"""
    if original_brightness is not None and original_brightness > 0:
        set_brightness(original_brightness)
        print(f"亮度已恢复: {original_brightness}")
    save_state({"active": False})
    try:
        os.unlink(PID_FILE)
    except OSError:
        pass


def run_daemon(dim: bool = False, force: bool = False):
    """常驻 daemon 模式：根据时间表自动保活/暂停（--force 忽略工作时段限制）"""
    pid = os.getpid()
    original_brightness = get_brightness() if dim else None

    with open(PID_FILE, 'w') as f:
        f.write(str(pid))

    def _shutdown(signum, frame):
        print(f"\n收到信号 {signum}，退出 daemon...")
        if original_brightness is not None and original_brightness > 0:
            set_brightness(original_brightness)
            print(f"亮度已恢复: {original_brightness}")
        save_state({"active": False, "mode": "daemon"})
        try:
            os.unlink(PID_FILE)
        except OSError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    if force:
        print(f"daemon 启动 | PID={pid} | --force 模式，忽略工作时段限制")
    else:
        print(f"daemon 启动 | PID={pid} | 工作时段暂停: 工作日 9-12, 13-18")

    # 状态机: active(保活中) / paused_work(工作时段) / paused_user(真人在用)
    state = "active" if force or not is_work_hours() else "paused_work"
    last_jiggle_pos = _get_mouse_pos()
    jiggle_count = 0
    user_pause_until = 0  # 真人暂停冷却时间戳
    dimmed = False

    save_state({
        "active": True, "mode": "daemon", "pid": pid,
        "start": datetime.now().isoformat(), "dim": dim,
        "original_brightness": original_brightness, "state": state,
    })

    try:
        while True:
            now = datetime.now()
            work = is_work_hours(now)
            idle = get_idle_seconds()

            # ── 状态转换 ──

            if state == "active":
                # 工作时段 → 暂停（--force 跳过）
                if work and not force:
                    state = "paused_work"
                    if dimmed:
                        set_brightness(original_brightness or 0.5)
                        dimmed = False
                    print(f"[{now.strftime('%H:%M')}] 进入工作时段，暂停保活")
                    _update_daemon_state(state, jiggle_count)
                    time.sleep(60)
                    continue

                # 真人操作 → 暂停
                if detect_real_user(last_jiggle_pos):
                    state = "paused_user"
                    user_pause_until = time.time() + USER_PAUSE_COOLDOWN
                    if dimmed:
                        set_brightness(original_brightness or 0.5)
                        dimmed = False
                    print(f"[{now.strftime('%H:%M')}] 检测到用户操作，暂停保活")
                    _update_daemon_state(state, jiggle_count)
                    last_jiggle_pos = _get_mouse_pos()
                    time.sleep(30)
                    continue

                # 正常保活：调暗 + jiggle
                if dim and not dimmed:
                    set_brightness(0.0)
                    dimmed = True

                jiggle_mouse()
                last_jiggle_pos = _get_mouse_pos()
                jiggle_count += 1
                print(f"[{now.strftime('%H:%M')}] jiggle #{jiggle_count} | idle={idle:.0f}s")

                # 随机等待 2~5 分钟（分段 sleep 检测用户）
                wait = random.randint(120, 300) + random.random() * 30
                _interruptible_sleep(wait, last_jiggle_pos)

            elif state == "paused_work":
                # 离开工作时段 → 检查是否应恢复
                if not work or force:
                    if idle > IDLE_THRESHOLD:
                        state = "active"
                        print(f"[{now.strftime('%H:%M')}] 工作时段结束 + 空闲{idle:.0f}s，恢复保活")
                        _update_daemon_state(state, jiggle_count)
                        continue
                    else:
                        # 用户还在操作，转为 user 暂停
                        state = "paused_user"
                        user_pause_until = time.time() + USER_PAUSE_COOLDOWN
                        print(f"[{now.strftime('%H:%M')}] 工作时段结束但用户活跃，等待空闲")
                        _update_daemon_state(state, jiggle_count)
                time.sleep(60)

            elif state == "paused_user":
                # 用户暂停冷却期过了 → 检查空闲
                if time.time() > user_pause_until:
                    if idle > IDLE_THRESHOLD and (not work or force):
                        state = "active"
                        last_jiggle_pos = _get_mouse_pos()
                        print(f"[{now.strftime('%H:%M')}] 用户已离开(空闲{idle:.0f}s)，恢复保活")
                        _update_daemon_state(state, jiggle_count)
                        continue
                    elif work and not force:
                        state = "paused_work"
                        print(f"[{now.strftime('%H:%M')}] 进入工作时段，继续暂停")
                        _update_daemon_state(state, jiggle_count)
                    elif idle <= IDLE_THRESHOLD:
                        # 用户还在操作，重置冷却
                        user_pause_until = time.time() + USER_PAUSE_COOLDOWN
                        last_jiggle_pos = _get_mouse_pos()
                time.sleep(30)

    except KeyboardInterrupt:
        pass
    finally:
        print(f"daemon 退出 | 共 jiggle {jiggle_count} 次")
        if dimmed and original_brightness is not None and original_brightness > 0:
            set_brightness(original_brightness)
            print(f"亮度已恢复: {original_brightness}")
        save_state({"active": False, "mode": "daemon"})
        try:
            os.unlink(PID_FILE)
        except OSError:
            pass


def _update_daemon_state(state: str, jiggle_count: int):
    """更新 daemon 状态文件"""
    cur = load_state()
    cur["state"] = state
    cur["jiggle_count"] = jiggle_count
    cur["updated"] = datetime.now().isoformat()
    save_state(cur)


def _interruptible_sleep(seconds: float, last_pos: tuple, check_fn=None):
    """分段 sleep，每 5 秒检查真人操作"""
    end = time.time() + seconds
    while time.time() < end:
        time.sleep(min(5, end - time.time()))
        if detect_real_user(last_pos):
            return True  # 被打断
    return False


def stop_keep_alive():
    """停止保活进程"""
    if not os.path.exists(PID_FILE):
        print("保活未运行")
        return
    try:
        with open(PID_FILE) as f:
            pid = int(f.read().strip())
        os.kill(pid, signal.SIGTERM)
        print(f"已发送停止信号给 PID={pid}")
    except ProcessLookupError:
        print("进程已不存在，清理状态")
        _cleanup(None)
    except Exception as e:
        print(f"停止失败: {e}")


def show_status():
    state = load_state()
    if not state or not state.get("active"):
        print("保活状态: 未运行")
    else:
        mode = state.get("mode", "manual")
        print(f"保活状态: 运行中 ({mode})")
        print(f"  PID: {state.get('pid')}")
        print(f"  启动: {state.get('start')}")
        if mode == "daemon":
            daemon_state = state.get("state", "unknown")
            state_labels = {
                "active": "保活中",
                "paused_work": "工作时段暂停",
                "paused_user": "用户活跃暂停",
            }
            print(f"  当前: {state_labels.get(daemon_state, daemon_state)}")
            print(f"  jiggle: {state.get('jiggle_count', 0)} 次")
            if state.get("updated"):
                print(f"  更新: {state.get('updated')}")
        else:
            print(f"  持续: {state.get('duration_min')} 分钟")
        print(f"  调暗: {state.get('dim')}")
        # 检查进程是否还在
        try:
            os.kill(state.get('pid', 0), 0)
        except (ProcessLookupError, PermissionError):
            print("  ⚠ 进程已不存在")
    now = datetime.now()
    work = is_work_hours(now)
    idle = get_idle_seconds()
    print(f"当前亮度: {get_brightness()}")
    print(f"系统空闲: {idle:.0f}s")
    print(f"工作时段: {'是' if work else '否'} ({now.strftime('%A %H:%M')})")


class KeepAliveDaemon:
    """可嵌入的保活 daemon，支持线程运行 + 外部 toggle 控制"""

    def __init__(self, dim: bool = False):
        self.dim = dim
        self._stop_event = threading.Event()
        self._force_event = threading.Event()  # 强制激活（无视时间表）
        self._wake_event = threading.Event()   # 中断 sleep 立即响应
        self._thread: threading.Thread | None = None
        self._state = "idle"
        self._jiggle_count = 0

    @property
    def active(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def forced(self) -> bool:
        return self._force_event.is_set()

    def start(self):
        """启动 daemon 线程"""
        if self.active:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="keep-alive")
        self._thread.start()

    def stop(self):
        """停止 daemon"""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=10)

    def toggle(self):
        """切换强制激活状态（SIGUSR1 调用），立即生效"""
        if self._force_event.is_set():
            self._force_event.clear()
            print(f"[keep-alive] 手动关闭强制保活")
        else:
            self._force_event.set()
            print(f"[keep-alive] 手动激活保活（无视时间表）")
        # 唤醒 sleep 循环，立即响应状态变化
        self._wake_event.set()

    def get_stats(self) -> dict:
        return {
            "active": self.active,
            "state": self._state,
            "forced": self.forced,
            "jiggle_count": self._jiggle_count,
        }

    def _run(self):
        original_brightness = get_brightness() if self.dim else None
        last_pos = _get_mouse_pos()
        dimmed = False
        user_pause_until = 0

        self._state = "starting"
        save_state({
            "active": True, "mode": "embedded", "pid": os.getpid(),
            "start": datetime.now().isoformat(), "dim": self.dim,
        })

        try:
            while not self._stop_event.is_set():
                now = datetime.now()
                forced = self._force_event.is_set()
                work = is_work_hours(now)
                idle = get_idle_seconds()

                if self._state in ("starting", "active"):
                    self._state = "active"

                    # 工作时段且非强制 → 暂停
                    if work and not forced:
                        self._state = "paused_work"
                        if dimmed:
                            set_brightness(original_brightness or 0.5)
                            dimmed = False
                        self._sleep(60)
                        continue

                    # 真人操作 → 暂停（强制模式下自动退出 forced 并恢复亮度）
                    if detect_real_user(last_pos):
                        if forced:
                            self._force_event.clear()
                            print("[keep-alive] 检测到用户操作，自动退出强制保活")
                        self._state = "paused_user"
                        user_pause_until = time.time() + USER_PAUSE_COOLDOWN
                        if dimmed:
                            set_brightness(original_brightness or 0.5)
                            dimmed = False
                        last_pos = _get_mouse_pos()
                        self._sleep(30)
                        continue

                    # 保活
                    if self.dim and not dimmed:
                        set_brightness(0.0)
                        dimmed = True
                    jiggle_mouse()
                    last_pos = _get_mouse_pos()
                    self._jiggle_count += 1

                    wait = random.randint(120, 300) + random.random() * 30
                    self._sleep(wait, last_pos)

                elif self._state == "paused_work":
                    # 强制模式 → 立即激活
                    if forced:
                        self._state = "active"
                        last_pos = _get_mouse_pos()
                        continue
                    if not work:
                        if idle > IDLE_THRESHOLD:
                            self._state = "active"
                            continue
                        else:
                            self._state = "paused_user"
                            user_pause_until = time.time() + USER_PAUSE_COOLDOWN
                    self._sleep(60)

                elif self._state == "paused_user":
                    # 强制模式 → 立即激活
                    if forced:
                        self._state = "active"
                        last_pos = _get_mouse_pos()
                        continue
                    if time.time() > user_pause_until:
                        if idle > IDLE_THRESHOLD and not work:
                            self._state = "active"
                            last_pos = _get_mouse_pos()
                            continue
                        elif work:
                            self._state = "paused_work"
                        elif idle <= IDLE_THRESHOLD:
                            user_pause_until = time.time() + USER_PAUSE_COOLDOWN
                            last_pos = _get_mouse_pos()
                    self._sleep(30)

        finally:
            if dimmed and original_brightness is not None and original_brightness > 0:
                set_brightness(original_brightness)
            save_state({"active": False, "mode": "embedded"})

    def _sleep(self, seconds: float, check_pos: tuple = None):
        """可中断的 sleep，响应 stop/wake 事件"""
        end = time.time() + seconds
        while time.time() < end and not self._stop_event.is_set():
            # wake_event 被 toggle() 设置时立即中断
            if self._wake_event.wait(timeout=min(5, end - time.time())):
                self._wake_event.clear()
                return
            if check_pos and detect_real_user(check_pos):
                return


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"

    if cmd == "daemon":
        dim = "--dim" in sys.argv
        force = "--force" in sys.argv
        run_daemon(dim=dim, force=force)

    elif cmd == "start":
        duration = 30
        dim = "--dim" in sys.argv
        for i, arg in enumerate(sys.argv):
            if arg == "--duration" and i + 1 < len(sys.argv):
                duration = int(sys.argv[i + 1])
        run_keep_alive(duration_min=duration, dim=dim)

    elif cmd == "stop":
        stop_keep_alive()

    elif cmd == "status":
        show_status()

    elif cmd == "dim":
        cur = get_brightness()
        set_brightness(0.0)
        print(f"亮度: {cur} → {get_brightness()}")

    elif cmd == "restore":
        set_brightness(0.5)
        print(f"亮度已恢复: {get_brightness()}")

    else:
        print(__doc__)
