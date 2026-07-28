"""SSE 常量的**跨部署一致性闸**（本地 src/ ↔ 远程 webhook-server/，issue #68）。

``mailagent:events:v1`` 这个 Redis channel 名与 15s 心跳间隔在三处出现：
``src/events/publisher.py``（publish 端 = 真源）/ ``src/sse_server.py``（本地 9200
订阅端）/ ``webhook-server/app.py:SSE_CHANNEL``（远程 VPS 上的第二个订阅端）。

**为什么必须建闸而不是全单源**：webhook-server 独立部署在 `170.106.181.89`，
`/opt/MailAgent/webhook-server` 是自带 requirements 的独立 FastAPI 应用，**import 不到
本仓 `src/`**。本地那两份已在 issue #68 收敛（``sse_server.SSE_CHANNEL = DEFAULT_CHANNEL``），
剩下的跨部署副本消灭不掉 → 建闸，纪律见 CLAUDE.md「跨语言手抄常量必建一致性闸」。

🔴 **这条漂了不会报错**：Redis pub/sub 对「订阅的 channel 与 publish 的不匹配」既不抛
也不警告，只是**零投递** —— 发布端日志正常、订阅端连接正常、事件一条不到。远程看板会
表现为「实时事件突然没了」，而两侧都查不出毛病。心跳同理：漂了会让中间代理按空闲超时
掐断长连接，症状是「SSE 隔几分钟断一次」。

**两侧都抽真源，本文件不持任何期望值副本**：本地侧 ``import``（Python 能真 import，比
文本抽取强）；webhook-server 侧从源码文本抽（唯一可行的读法）。抽取失败一律断言红而不是
静默跳过 —— 有人把 webhook-server 的常量改成 f-string / 从 env 读 / 换个名字，必须回来
更新本闸并顺手核对镜像仍一致。反向用例用**合成源码**证明闸真会红。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from src.events.publisher import DEFAULT_CHANNEL
from src.sse_server import SSE_CHANNEL, SSE_HEARTBEAT_SEC

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WEBHOOK_APP = _REPO_ROOT / "webhook-server/app.py"


def _extract_str_const(src: str, name: str, *, origin: str) -> str:
    m = re.search(rf'^{name}\s*=\s*"([^"]+)"\s*$', src, re.M)
    assert m, (
        f"{origin}: 没抽到 `{name} = \"...\"` —— 常量被改名 / 改成 f-string / 改成从 env 读了？"
        "更新本闸的抽取器，并核对镜像仍与本地真源一致"
    )
    return m.group(1)


def _extract_int_const(src: str, name: str, *, origin: str) -> int:
    m = re.search(rf"^{name}\s*=\s*(\d+)\s*$", src, re.M)
    assert m, (
        f"{origin}: 没抽到 `{name} = <int>` —— 常量被改名 / 改成表达式了？更新本闸的抽取器"
    )
    return int(m.group(1))


def _read(path: Path) -> str:
    assert path.exists(), f"镜像文件搬家了？{path}"
    return path.read_text(encoding="utf-8")


# ── 本地两份：已单源，这里钉住「别再退回手抄」────────────────────────────────

def test_local_subscriber_channel_is_the_publisher_constant():
    """sse_server 的 channel 必须**就是** publisher 的常量对象，不是相等的字面量副本。

    退回 `SSE_CHANNEL = "mailagent:events:v1"` 时值仍相等，本断言仍绿 —— 故下面
    `test_local_subscriber_does_not_hardcode_channel` 从源码文本堵这条退路。
    """
    assert SSE_CHANNEL == DEFAULT_CHANNEL


def test_local_subscriber_does_not_hardcode_channel():
    """sse_server.py 源码里不许再出现 channel 字面量（只能 import）。"""
    src = _read(_REPO_ROOT / "src/sse_server.py")
    body = "\n".join(
        line for line in src.splitlines() if not line.lstrip().startswith("#")
    )
    assert f'"{DEFAULT_CHANNEL}"' not in body, (
        "src/sse_server.py 又硬编码了 channel 字面量 —— 订阅端必须 import "
        "src.events.publisher.DEFAULT_CHANNEL（漂了是零投递零报错）"
    )


# ── 跨部署那份：与本地真源对撞 ───────────────────────────────────────────────

def test_webhook_server_channel_matches_publisher():
    remote = _extract_str_const(
        _read(_WEBHOOK_APP), "SSE_CHANNEL", origin=str(_WEBHOOK_APP)
    )
    assert remote == DEFAULT_CHANNEL, (
        f"webhook-server 订阅 {remote!r} 而 publisher 发到 {DEFAULT_CHANNEL!r} —— "
        "Redis pub/sub 对此不报错只零投递: 远程看板的实时事件会静默全丢。"
        "改 channel 名必须同批改两处 + 重新部署 webhook-server "
        "(./scripts/deploy-webhook.sh)"
    )


def test_webhook_server_heartbeat_matches_local():
    remote = _extract_int_const(
        _read(_WEBHOOK_APP), "SSE_HEARTBEAT_SEC", origin=str(_WEBHOOK_APP)
    )
    assert remote == SSE_HEARTBEAT_SEC, (
        f"webhook-server 心跳 {remote}s 与本地 {SSE_HEARTBEAT_SEC}s 漂移 —— "
        "两端的空闲断连行为会不一致（心跳变长 = 中间代理按 idle timeout 掐长连接）"
    )


# ── 反向用例：合成源码证明闸真会红 ───────────────────────────────────────────

_SYNTHETIC_DRIFTED = 'SSE_CHANNEL = "mailagent:events:v2"\nSSE_HEARTBEAT_SEC = 30\n'
_SYNTHETIC_REFACTORED = (
    'SSE_CHANNEL = os.environ.get("SSE_CHANNEL", "mailagent:events:v1")\n'
    "SSE_HEARTBEAT_SEC = HEARTBEAT_DEFAULT\n"
)


def test_gate_channel_drift_would_go_red():
    drifted = _extract_str_const(_SYNTHETIC_DRIFTED, "SSE_CHANNEL", origin="<synthetic>")
    assert drifted != DEFAULT_CHANNEL, "合成的 v2 channel 竟与真源相等 —— 本闸对漂移无感"


def test_gate_heartbeat_drift_would_go_red():
    drifted = _extract_int_const(
        _SYNTHETIC_DRIFTED, "SSE_HEARTBEAT_SEC", origin="<synthetic>"
    )
    assert drifted != SSE_HEARTBEAT_SEC, "合成的 30s 心跳竟与真源相等 —— 本闸对漂移无感"


def test_gate_extractor_failure_would_go_red():
    """常量改写法（env / 别名）时必须断言失败，不是静默返回空值恒绿。"""
    with pytest.raises(AssertionError):
        _extract_str_const(_SYNTHETIC_REFACTORED, "SSE_CHANNEL", origin="<synthetic>")
    with pytest.raises(AssertionError):
        _extract_int_const(
            _SYNTHETIC_REFACTORED, "SSE_HEARTBEAT_SEC", origin="<synthetic>"
        )
