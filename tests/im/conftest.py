"""tests/im 共享替身 —— **全部离线**，绝不建真飞书连接、绝不 import lark_oapi。

🔴 纪律：``src/im`` 的模块顶层没有任何 lark import（见 ``src/im/connection.py``
的红字）；测试也不许打破它 —— 一旦某个测试在主线程 import 了 lark，
``lark_oapi.ws.client`` 的模块级全局 loop 就被钉在测试线程上了。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest


class FakeStateStore:
    """``get_state`` / ``set_state`` 的内存替身（``SyncStore`` 的 KV 子集）。"""

    def __init__(self, initial: Optional[Dict[str, str]] = None) -> None:
        self.data: Dict[str, str] = dict(initial or {})
        self.read_fail = False
        self.write_fail = False

    def get_state(self, key: str) -> Optional[str]:
        if self.read_fail:
            raise RuntimeError("simulated sync_state read failure")
        return self.data.get(key)

    def set_state(self, key: str, value: str) -> bool:
        if self.write_fail:
            raise RuntimeError("simulated sync_state write failure")
        self.data[key] = value
        return True


class FakeSender:
    """``src/im/delivery.py::MessageSender`` 的替身。

    ``fail_first_n`` 让前 N 次调用返回 None（模拟瞬时失败 → 触发重试路径）。
    """

    def __init__(self, *, fail_first_n: int = 0, always_fail: bool = False) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.fail_first_n = fail_first_n
        self.always_fail = always_fail
        self._seq = 0

    def create_message(
        self, receive_id: str, msg_type: str, content: dict
    ) -> Optional[str]:
        self._seq += 1
        self.calls.append(
            {"receive_id": receive_id, "msg_type": msg_type, "content": content}
        )
        if self.always_fail or self._seq <= self.fail_first_n:
            return None
        return f"om_fake_{self._seq}"

    @property
    def sent_texts(self) -> List[str]:
        return [c["content"].get("text", "") for c in self.calls]


class InlineSubmit:
    """``executor.submit`` 的同步替身 —— 测试里立刻执行，不起线程。"""

    def __init__(self) -> None:
        self.submitted = 0

    def __call__(self, fn, *args):
        self.submitted += 1
        fn(*args)
        return None


class FakeAlerter:
    """带**真实 send_alert / alert_recovery 签名**的告警替身。

    签名逐字对齐 ``FeishuAlertNotifier``（镜像 tests/notify 的既有纪律）：通用
    ``__getattr__`` mock 会吞掉传错的 kwarg，测不出「告警从未发出」这类 bug。
    ``delivered=False`` 模拟投递失败（level 门 / cooldown 门 / 网络挂）。
    """

    def __init__(self, delivered: bool = True) -> None:
        self.delivered = delivered
        self.alerts: List[Dict[str, Any]] = []
        self.recoveries: List[str] = []

    async def send_alert(
        self, level, title, content, source="MailAgent", details=None, alert_key=""
    ) -> bool:
        self.alerts.append(
            {"level": level, "title": title, "content": content, "alert_key": alert_key}
        )
        return self.delivered

    async def alert_recovery(self, component: str) -> bool:
        self.recoveries.append(component)
        return self.delivered


class FakeMessageEvent:
    """``P2ImMessageReceiveV1`` 的最小结构替身（只含 parse 用到的路径）。"""

    def __init__(
        self,
        *,
        event_id: str = "evt_1",
        message_id: str = "om_1",
        chat_id: str = "oc_1",
        chat_type: str = "p2p",
        message_type: str = "text",
        open_id: str = "ou_owner",
        text: str = "hello",
    ) -> None:
        import json
        from types import SimpleNamespace

        self.header = SimpleNamespace(event_id=event_id)
        self.event = SimpleNamespace(
            message=SimpleNamespace(
                message_id=message_id,
                chat_id=chat_id,
                chat_type=chat_type,
                message_type=message_type,
                content=json.dumps({"text": text}),
            ),
            sender=SimpleNamespace(sender_id=SimpleNamespace(open_id=open_id)),
        )


@pytest.fixture
def fake_store() -> FakeStateStore:
    return FakeStateStore()


@pytest.fixture
def fake_sender() -> FakeSender:
    return FakeSender()
