"""Outlook COM 客户端基建 (Windows outlook_com backend 专用).

从 MailAgentWin (同事 fork, 授权直搬) 的 ``outlook_com_arm.py`` / ``com_radar.py`` /
``draft_handler.py`` 萃取改造:

- **StaComExecutor**: 单线程 STA executor —— COM 对象绑定其创建线程的 apartment,
  backend 所有 COM 调用一进门转发到该专属线程 (per-thread ``pythoncom.CoInitialize()``),
  对调用方透明同步。这镜像本仓 ``serial_executor.run_backend_io`` 的"非并发安全 backend
  串行化"思路, 但由 backend 自持 (调用方不需要知道 STA 纪律 —— new_watcher 有不经
  run_backend_io 的直调点, 收在 backend 内部最稳)。
- **HRESULT 忙态白名单 + 指数退避**: Outlook 忙 (模态弹窗 / 启动中) 时 COM 调用抛
  ``RPC_E_CALL_REJECTED`` 等, 白名单命中 → 退避重试; 对象失效 (Outlook 重启) →
  reconnect 一次再试。
- **call_with_timeout**: ``.Send()`` / ``.Save()`` 可能被模态窗卡住且 COM 调用不可安全
  中断 —— 放独立线程 (COM 对象经 ``CoMarshalInterThreadInterfaceInStream`` 封送) +
  ``join(timeout)`` 放弃语义 (超时不杀线程, 主流程继续)。
- **DASL / proptag 常量**: PropertyAccessor 取 Internet 头用。

🔴 平台纪律: 本模块 **绝不 top-level import win32com/pythoncom** —— 本仓开发机是
macOS, pywin32 不存在。全部懒 import + 软着陆, mac 上 import 本模块必须零副作用
(有 import 冒烟测试)。测试用 fake Dispatch 注入, 不需要真 COM。
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional

from loguru import logger

# ---------------------------------------------------------------------------
# DASL / proptag 常量 (PropertyAccessor.GetProperty 用)
# ---------------------------------------------------------------------------

#: Internet Message-ID 头 (RFC 5322)。EntryID 会漂移 (移动文件夹即变), message_id
#: 才是稳定锚 —— 反查回写自愈全靠它。
PR_INTERNET_MESSAGE_ID = "http://schemas.microsoft.com/mapi/proptag/0x1035001F"

#: 完整 transport 头块 (仅 header, 不含 body)。MIME 重组的头来源。
PR_TRANSPORT_MESSAGE_HEADERS = "http://schemas.microsoft.com/mapi/proptag/0x007D001F"

#: 附件 Content-ID (识别内联图 cid: 引用)。
PR_ATTACH_CONTENT_ID = "http://schemas.microsoft.com/mapi/proptag/0x3712001F"

#: 发件人 SMTP 地址 (Exchange DN 发件人解析兜底)。
PR_SMTP_ADDRESS = "http://schemas.microsoft.com/mapi/proptag/0x39FE001F"

#: DASL 命名空间: 按 Internet 头做 Items.Restrict/Table filter。
DASL_MESSAGE_ID = "urn:schemas:mailheader:message-id"
DASL_DATE_RECEIVED = "urn:schemas:httpmail:datereceived"

# OlDefaultFolders 枚举 (Outlook 对象模型常量; pywin32 constants 需 makepy, 用字面量稳)
OL_FOLDER_DELETED_ITEMS = 3
OL_FOLDER_SENT_MAIL = 5
OL_FOLDER_INBOX = 6
OL_FOLDER_DRAFTS = 16
OL_FOLDER_JUNK = 23

# OlItemType
OL_MAIL_ITEM = 0

# OlMarkInterval (MarkAsTask)
OL_MARK_NO_DATE = 4

# ---------------------------------------------------------------------------
# HRESULT 分类 (MailAgentWin outlook_com_arm._BUSY_HRESULTS 直搬 + 扩充)
# ---------------------------------------------------------------------------

#: Outlook 忙 (模态弹窗 / 启动中): 退避后原对象重试即可。
#: -2147418111 = RPC_E_CALL_REJECTED (0x80010001)
#: -2147023170 = RPC_S_CALL_FAILED  (0x800706BE)
BUSY_HRESULTS = frozenset({-2147418111, -2147023170})

#: COM 对象已失效 (Outlook 重启 / RPC 服务器不可用): 必须 reconnect 重建对象。
#: -2147417848 = RPC_E_DISCONNECTED     (0x80010108)
#: -2147023174 = RPC_S_SERVER_UNAVAILABLE (0x800706BA)
DEAD_OBJECT_HRESULTS = frozenset({-2147417848, -2147023174})


def extract_hresult(exc: BaseException) -> Optional[int]:
    """从 COM 异常里抽 HRESULT (pywintypes.com_error 的 .hresult / args[0]).

    不依赖 pywintypes import —— duck-typing 取属性, mac 测试的 fake 异常同样可用。
    """
    hr = getattr(exc, "hresult", None)
    if isinstance(hr, int):
        return hr
    args = getattr(exc, "args", ())
    if args and isinstance(args[0], int):
        return args[0]
    return None


def is_busy_error(exc: BaseException) -> bool:
    return extract_hresult(exc) in BUSY_HRESULTS


def is_dead_object_error(exc: BaseException) -> bool:
    return extract_hresult(exc) in DEAD_OBJECT_HRESULTS


# ---------------------------------------------------------------------------
# STA 单线程 executor
# ---------------------------------------------------------------------------


class StaComExecutor:
    """单线程 executor: 所有 COM 调用固定在同一 STA 工作线程上执行.

    - 工作线程启动时 ``pythoncom.CoInitialize()`` (STA 单元); pythoncom 不可用
      (macOS 测试 / fake COM) 时软着陆跳过 —— fake 对象无 apartment 约束。
    - ``run()`` 若已在工作线程上 (backend 方法内部互调) 直接执行, 防自死锁。
    """

    def __init__(self, name: str = "outlook-com-sta"):
        self._thread_id: Optional[int] = None
        self._ready = threading.Event()
        self._executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix=name, initializer=self._init_thread
        )

    def _init_thread(self) -> None:
        self._thread_id = threading.get_ident()
        try:
            import pythoncom  # 懒 import: 仅 Windows 存在

            pythoncom.CoInitialize()
        except ImportError:
            pass  # mac 测试 / fake COM: 无需 apartment 初始化
        except Exception as e:  # noqa: BLE001 — CoInitialize 已初始化等非致命
            logger.warning(f"[com-client] CoInitialize failed (continuing): {e}")
        self._ready.set()

    def run(self, fn: Callable[..., Any], *args: Any, timeout: Optional[float] = None, **kwargs: Any) -> Any:
        """在 STA 线程上执行 fn 并同步等结果 (异常透传)."""
        if self._thread_id is not None and threading.get_ident() == self._thread_id:
            return fn(*args, **kwargs)
        future = self._executor.submit(fn, *args, **kwargs)
        return future.result(timeout=timeout)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False)


# ---------------------------------------------------------------------------
# Outlook 会话 (Application + MAPI Namespace, 自动 reconnect)
# ---------------------------------------------------------------------------


class OutlookSession:
    """持 Outlook ``Application`` + ``Namespace('MAPI')``; 断线自动重连.

    ``dispatch_factory``: 测试注入点 —— 返回 fake Application 的 callable。
    留 None 走真 ``win32com.client.Dispatch`` (仅 Windows)。

    所有方法都假定在 StaComExecutor 的工作线程上被调用 (由 backend 保证)。
    """

    def __init__(self, dispatch_factory: Optional[Callable[[str], Any]] = None):
        self._dispatch_factory = dispatch_factory
        self._app: Any = None
        self._ns: Any = None

    # -- 连接管理 --

    def _dispatch(self, prog_id: str) -> Any:
        if self._dispatch_factory is not None:
            return self._dispatch_factory(prog_id)
        import win32com.client  # 懒 import: 仅 Windows 存在

        return win32com.client.Dispatch(prog_id)

    def connect(self) -> None:
        """建立 (或重建) Application/Namespace。失败抛原始异常给上层分类."""
        self._app = self._dispatch("Outlook.Application")
        self._ns = self._app.GetNamespace("MAPI")

    def reconnect(self) -> None:
        self._app = None
        self._ns = None
        self.connect()

    @property
    def namespace(self) -> Any:
        if self._ns is None:
            self.connect()
        return self._ns

    @property
    def application(self) -> Any:
        if self._app is None:
            self.connect()
        return self._app

    # -- 带退避的调用包装 --

    def call(
        self,
        fn: Callable[["OutlookSession"], Any],
        *,
        attempts: int = 3,
        base_delay: float = 0.5,
        op: str = "com-call",
    ) -> Any:
        """执行 ``fn(session)``, 忙态退避重试 + 死对象 reconnect 重试.

        - busy HRESULT: sleep(base_delay * 2^n) 后原对象重试;
        - dead-object HRESULT: reconnect 后重试;
        - 其余异常 / 重试耗尽: 原样抛给调用方 (由 backend 翻译成协议异常 ——
          🔴 绝不在这里吞错返回 None/[], 三态纪律在 backend 层落实)。
        """
        last_exc: Optional[BaseException] = None
        for attempt in range(attempts):
            try:
                return fn(self)
            except Exception as e:  # noqa: BLE001 — 按 HRESULT 分类后决定重抛
                last_exc = e
                if is_dead_object_error(e):
                    logger.warning(
                        f"[com-client] {op}: dead COM object (attempt {attempt + 1}/"
                        f"{attempts}), reconnecting: {e}"
                    )
                    try:
                        self.reconnect()
                    except Exception as re_exc:  # noqa: BLE001
                        logger.warning(f"[com-client] {op}: reconnect failed: {re_exc}")
                elif is_busy_error(e):
                    delay = base_delay * (2 ** attempt)
                    logger.warning(
                        f"[com-client] {op}: Outlook busy (attempt {attempt + 1}/"
                        f"{attempts}), retry in {delay:.1f}s: {e}"
                    )
                    time.sleep(delay)
                else:
                    raise
        assert last_exc is not None
        raise last_exc


# ---------------------------------------------------------------------------
# 不可中断 COM 调用的超时保护 (draft_handler 三件套直搬改造)
# ---------------------------------------------------------------------------


def call_with_timeout(
    item: Any,
    action: Callable[[Any], Any],
    *,
    timeout_sec: float,
    op: str = "com-slow-call",
) -> bool:
    """在独立线程上执行 ``action(item)`` 并 ``join(timeout)``.

    Outlook 的 ``.Send()`` / ``.Save()`` 会被模态进度窗卡住, 且 COM 调用不可安全
    中断 —— 超时**放弃等待但不杀线程** (线程 daemon 自灭), 返回 False 让上层按
    失败处理; 线程内异常同样返回 False。

    COM 对象跨线程传递: pythoncom 可用时经
    ``CoMarshalInterThreadInterfaceInStream`` 封送 → 工作线程 ``CoInitialize`` +
    ``CoGetInterfaceAndReleaseStream`` 解封 → Dispatch 包回; 不可用 (mac 测试
    fake 对象) 时直接传引用。
    """
    marshal_stream = None
    try:
        import pythoncom  # 懒 import

        marshal_stream = pythoncom.CoMarshalInterThreadInterfaceInStream(
            pythoncom.IID_IDispatch, item._oleobj_  # noqa: SLF001 — pywin32 惯用法
        )
    except ImportError:
        pass  # fake COM: 对象线程无关, 直接传
    except Exception as e:  # noqa: BLE001 — 封送失败降级直传 (同线程模型的 fake)
        logger.debug(f"[com-client] {op}: marshal skipped: {e}")

    result: dict[str, Any] = {"ok": False, "error": None}

    def _worker() -> None:
        target = item
        pythoncom_mod = None
        try:
            if marshal_stream is not None:
                import pythoncom as pythoncom_mod  # type: ignore[no-redef]
                import win32com.client

                pythoncom_mod.CoInitialize()
                unmarshalled = pythoncom_mod.CoGetInterfaceAndReleaseStream(
                    marshal_stream, pythoncom_mod.IID_IDispatch
                )
                target = win32com.client.Dispatch(unmarshalled)
            action(target)
            result["ok"] = True
        except Exception as e:  # noqa: BLE001 — 线程内异常翻译成 False
            result["error"] = e
        finally:
            if pythoncom_mod is not None:
                try:
                    pythoncom_mod.CoUninitialize()
                except Exception:  # noqa: BLE001
                    pass

    thread = threading.Thread(target=_worker, name=f"{op}-worker", daemon=True)
    thread.start()
    thread.join(timeout=timeout_sec)
    if thread.is_alive():
        logger.warning(
            f"[com-client] {op}: timed out after {timeout_sec}s — abandoning wait "
            "(COM call cannot be safely interrupted; thread left to finish/die)"
        )
        return False
    if not result["ok"] and result["error"] is not None:
        logger.warning(f"[com-client] {op}: failed in worker: {result['error']}")
    return bool(result["ok"])


def start_progress_window_hider(duration_sec: float = 15.0) -> None:
    """隐藏 Outlook 发信模态进度窗 (win32gui hack, MailAgentWin 直搬).

    Outlook COM 发信会弹「正在发布/Publishing」进度窗打断自动化 (社区已知痛点)。
    起 daemon 线程持续 ``duration_sec`` 秒扫窗并 ``ShowWindow(SW_HIDE)``。
    win32gui 不可用 (mac / 未装 pywin32) 时静默 no-op。
    """
    try:
        import win32con
        import win32gui
    except ImportError:
        return

    keywords = ("正在发布", "Publishing", "正在发送", "Sending")

    def _hide_loop() -> None:
        deadline = time.monotonic() + duration_sec

        def _enum_handler(hwnd: int, _extra: Any) -> None:
            try:
                title = win32gui.GetWindowText(hwnd)
                if title and any(k in title for k in keywords):
                    win32gui.ShowWindow(hwnd, win32con.SW_HIDE)
            except Exception:  # noqa: BLE001 — 窗口枚举竞态, 忽略
                pass

        while time.monotonic() < deadline:
            try:
                win32gui.EnumWindows(_enum_handler, None)
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.5)

    threading.Thread(target=_hide_loop, name="outlook-progress-hider", daemon=True).start()


def epoch_to_dasl_local(epoch: float) -> str:
    """epoch 秒 → DASL 日期字面量 (本地时区 'YYYY-MM-DD HH:MM:SS').

    Items.Restrict 的 ``[ReceivedTime] >= '02/13/26 ...'`` 写法 locale 敏感 (已知坑);
    DASL ``@SQL=urn:schemas:httpmail:datereceived`` 接受 ISO 形状字面量且按**本地时区**
    解释, 与 locale 解耦。
    """
    from datetime import datetime

    return datetime.fromtimestamp(epoch).strftime("%Y-%m-%d %H:%M:%S")
