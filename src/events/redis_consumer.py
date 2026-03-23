"""
Redis 事件消费者

BLPOP 用户专属队列 mailagent:{database_id}:events，
将事件分发给对应的 handler。
"""

import asyncio
import json
from typing import Callable, Awaitable, Dict, Optional

import redis.asyncio as redis
from loguru import logger


class RedisConsumer:
    """Redis 队列消费者"""

    RECONNECT_BASE = 5       # 初始重连间隔（秒）
    RECONNECT_MAX = 120      # 最大重连间隔（秒）

    def __init__(
        self,
        redis_url: str,
        redis_db: int,
        queue_key: str,
        blpop_timeout: int = 10,
    ):
        self.redis_url = redis_url
        self.redis_db = redis_db
        self.queue_key = queue_key
        self.blpop_timeout = blpop_timeout
        self._pool: Optional[redis.Redis] = None
        self._running = False
        self._handlers: Dict[str, Callable[[Dict], Awaitable[None]]] = {}
        self._stats = {"received": 0, "processed": 0, "errors": 0}
        self._consecutive_failures = 0

    def on(self, event_type: str, handler: Callable[[Dict], Awaitable[None]]):
        """注册事件处理器

        Args:
            event_type: 事件类型 (flag_changed, ai_reviewed, page_updated)
            handler: async handler(event_data)
        """
        self._handlers[event_type] = handler

    async def _ensure_connection(self):
        """重建 Redis 连接"""
        try:
            if self._pool:
                await self._pool.close()
        except Exception:
            pass
        self._pool = redis.from_url(
            f"{self.redis_url}/{self.redis_db}",
            decode_responses=True,
            socket_timeout=30,
            socket_connect_timeout=10,
            socket_keepalive=True,
            socket_keepalive_options={},
            health_check_interval=15,
        )

    def _get_reconnect_delay(self) -> float:
        """指数退避重连间隔"""
        delay = min(self.RECONNECT_BASE * (2 ** self._consecutive_failures), self.RECONNECT_MAX)
        return delay

    async def start(self, shutdown_event: asyncio.Event = None):
        """启动消费循环"""
        await self._ensure_connection()
        self._running = True
        logger.info(f"Redis consumer started: queue={self.queue_key}")

        while self._running:
            if shutdown_event and shutdown_event.is_set():
                break

            try:
                result = await self._pool.blpop(self.queue_key, timeout=self.blpop_timeout)
                if result is None:
                    # 连接正常，重置失败计数
                    if self._consecutive_failures > 0:
                        logger.info(f"Redis connection restored after {self._consecutive_failures} failures")
                        self._consecutive_failures = 0
                    continue

                # 连接正常，重置失败计数
                if self._consecutive_failures > 0:
                    logger.info(f"Redis connection restored after {self._consecutive_failures} failures")
                    self._consecutive_failures = 0

                _, raw_message = result
                self._stats["received"] += 1

                event = json.loads(raw_message)
                event_type = event.get("type", "page_updated")

                # Try specific handler, then fallback to page_updated
                handler = self._handlers.get(event_type) or self._handlers.get("page_updated")
                if handler:
                    try:
                        await handler(event)
                        self._stats["processed"] += 1
                    except Exception as e:
                        logger.error(f"Event handler error for {event_type}: {e}")
                        self._stats["errors"] += 1
                else:
                    logger.warning(f"No handler for event type: {event_type}")

            except asyncio.CancelledError:
                break
            except (redis.ConnectionError, redis.TimeoutError, ConnectionError, OSError) as e:
                self._consecutive_failures += 1
                delay = self._get_reconnect_delay()
                logger.error(
                    f"Redis connection error ({self._consecutive_failures}x): {e}, "
                    f"reconnecting in {delay:.0f}s..."
                )
                self._stats["errors"] += 1
                await asyncio.sleep(delay)
                # 重建连接
                try:
                    await self._ensure_connection()
                    logger.info("Redis connection rebuilt, resuming consumer...")
                except Exception as re_err:
                    logger.error(f"Redis reconnect failed: {re_err}")
            except Exception as e:
                self._consecutive_failures += 1
                delay = self._get_reconnect_delay()
                logger.error(
                    f"Consumer error ({self._consecutive_failures}x): {e}, "
                    f"retrying in {delay:.0f}s..."
                )
                self._stats["errors"] += 1
                await asyncio.sleep(delay)
                # 非连接错误也尝试重建，防止连接对象损坏
                try:
                    await self._ensure_connection()
                except Exception:
                    pass

        logger.info("Redis consumer stopped")

    async def stop(self):
        self._running = False
        if self._pool:
            await self._pool.close()
            self._pool = None

    def get_stats(self) -> Dict:
        return {**self._stats, "queue": self.queue_key, "running": self._running}

    async def publish_result(self, event_id: str, result: Dict):
        """将事件执行结果写入 Redis，供 webhook-server 轮询"""
        if not self._pool:
            return
        key = f"mailagent:results:{event_id}"
        await self._pool.set(key, json.dumps(result, ensure_ascii=False), ex=3600)
