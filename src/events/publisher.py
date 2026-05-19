"""EventPublisher — Sprint 15 Stage 2 SSE 派发的发送端.

各组件（OutboxRepository / FanoutWorker / new_watcher / SyncStore / LLMProcessingStore）
向 Redis channel ``mailagent:events:v1`` publish JSON 事件；
webhook-server 的 ``/api/events/stream`` SSE endpoint 订阅同 channel，
推给前端 / 看板 / 外部观察者。

设计要点:
- 同步 redis 客户端（caller 直接 publisher.publish() 不需 await），单次 publish
  TCP send + 立即 fire-and-forget，~1ms 阻塞，可接受
- 失败 silent (主链路不被 SSE 烧穿)
- redis_url 为空 → 整个 publisher noop
- module-level 单例 ``get_publisher()`` 复用全局 src.config

事件类型 (docs/sse-events.md 列全):
- email.new / email.synced / email.failed / email.dead_letter
- outbox.enqueued / outbox.done / outbox.failed
- llm.success / llm.failed
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, Optional

from loguru import logger


# Redis channel; v1 留个版本号方便未来 schema 变化加 v2 channel 并行
DEFAULT_CHANNEL = "mailagent:events:v1"


class EventPublisher:
    """同步 publish 包装. 用 redis-py 同步客户端的 publish() (~1ms)."""

    def __init__(
        self,
        *,
        redis_url: str,
        redis_db: int = 2,
        channel: str = DEFAULT_CHANNEL,
        socket_timeout: float = 2.0,
    ):
        self.redis_url = redis_url
        self.redis_db = redis_db
        self.channel = channel
        self.socket_timeout = socket_timeout
        self._client = None  # lazy

    def _client_or_none(self):
        """lazy init redis sync client; redis_url 空时返 None."""
        if not self.redis_url:
            return None
        if self._client is None:
            try:
                import redis as redis_sync  # 同步客户端
                self._client = redis_sync.from_url(
                    f"{self.redis_url}/{self.redis_db}",
                    decode_responses=False,
                    socket_timeout=self.socket_timeout,
                    socket_connect_timeout=self.socket_timeout,
                )
            except Exception as e:
                logger.warning(f"[publisher] init failed (will retry): {e}")
                return None
        return self._client

    def publish(
        self,
        event_type: str,
        *,
        internal_id: Optional[int] = None,
        data: Optional[Dict[str, Any]] = None,
        source: str = "mailagent",
    ) -> bool:
        """publish to mailagent:events:v1.

        Args:
            event_type: 事件类型 (见 docs/sse-events.md)
            internal_id: 邮件级事件附带 internal_id
            data: 事件特定 payload (json-serializable)
            source: 事件来源 (mailagent / outbox / fanout / handler / cli)

        Returns:
            True 写入 redis 成功; False redis 不可用 / publish 抛异常 (silent).
        """
        client = self._client_or_none()
        if client is None:
            return False
        payload = {
            "event_type": event_type,
            "ts": time.time(),
            "internal_id": internal_id,
            "data": data or {},
            "source": source,
        }
        try:
            client.publish(
                self.channel,
                json.dumps(payload, ensure_ascii=False, default=str),
            )
            return True
        except Exception as e:
            logger.debug(f"[publisher] publish failed (event_type={event_type}): {e}")
            return False

    def close(self) -> None:
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None


# ============================================================
# Module-level singleton (lazy)
# ============================================================

_publisher_singleton: Optional[EventPublisher] = None


def get_publisher() -> EventPublisher:
    """返回 process-wide publisher 单例. 从 src.config 取 redis_url/db."""
    global _publisher_singleton
    if _publisher_singleton is None:
        from src.config import config
        _publisher_singleton = EventPublisher(
            redis_url=config.redis_url,
            redis_db=config.redis_db,
        )
    return _publisher_singleton


def reset_publisher_for_tests() -> None:
    """测试用; 不写到 __all__."""
    global _publisher_singleton
    if _publisher_singleton is not None:
        _publisher_singleton.close()
    _publisher_singleton = None


# ============================================================
# Convenience: publish with logging on failure
# ============================================================

def safe_publish(
    event_type: str,
    *,
    internal_id: Optional[int] = None,
    data: Optional[Dict[str, Any]] = None,
    source: str = "mailagent",
) -> None:
    """便利函数: get_publisher().publish 包一层 try; 任何异常都 silent.

    使用场景: caller 不关心 SSE 失败，主链路不被烧穿.
    例: outbox.mark_done() → safe_publish('outbox.done', internal_id=...).
    """
    try:
        get_publisher().publish(
            event_type, internal_id=internal_id, data=data, source=source
        )
    except Exception as e:
        logger.debug(f"[publisher] safe_publish swallowed: {event_type}: {e}")
