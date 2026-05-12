"""Redis 队列服务。写操作通过 LPUSH 入队，由 MailAgent EventHandlers 消费。"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

import redis.asyncio as aioredis
from loguru import logger

from web.api.config import web_config

_pool: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    global _pool
    if _pool is None:
        _pool = aioredis.from_url(
            web_config.redis_url,
            db=web_config.redis_db,
            decode_responses=True,
        )
    return _pool


async def close_redis() -> None:
    global _pool
    if _pool is not None:
        await _pool.aclose()
        _pool = None


async def push_event(event: Dict[str, Any]) -> None:
    """推送事件到 MailAgent 事件队列。"""
    r = await get_redis()
    queue_key = f"mailagent:{web_config.email_database_id}"
    payload = json.dumps(event, ensure_ascii=False)
    await r.lpush(queue_key, payload)
    logger.debug(f"[web-redis] pushed event: {event.get('event')}")
