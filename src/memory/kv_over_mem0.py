"""kv-over-mem0 适配层（M5a-1）。

把 `agent_memory_kv` 的 `(scope, key, value_json, priority)` 语义映射到 mem0 独立 store，供
`MAILAGENT_MEMORY_KV_RETIRE` flag-on 时 4 个 `/api/chat/memory` 端点（list/get/upsert/delete）
改接（M5a-2）。flag-off 时端点照走 `ChatDb.agent_memory_kv`，本模块无人调用。

懒加载红线：顶层**不** import `mem0_engine`（其顶部 `from src.config import ...` 会拉起 config，
真正 store 访问才触发 mem0/fastembed/faiss ~150MB 重依赖）。所有函数内 `get_mem0_engine()` ——
import 本模块零副作用，对齐 `src/memory/__init__.py` PEP 562 「函数内才 import mem0_engine」纪律。

数据模型映射（spike `research/mem0-metadata-spike.md` §2 定死）：
- `value_json` → memory 文本（mem0 `content`/`data`）；mem0 会 embed 它（kv 不语义搜，浪费可忽略）。
- `{scope, key, priority, kind}` → metadata（落 faiss 扁平 payload，`get_all` 服务端精确过滤）。
  `kind=KV_KIND` discriminator 把 kv 适配行与 M1/M2 capture 自动抽取的事实隔离（同 store + 同
  user_id="owner"，但 capture metadata 无 scope/key）—— 见 engine 的 KV_KIND 注释（codex HIGH-1）。
- `(scope, key)` 唯一 → 靠 `upsert_kv` 模拟（mem0 `add(infer=False)` 不 dedup）。
- `created_at`/`updated_at` → mem0 原生 ISO 字符串 → 转 **epoch ms int**（钉 wire 契约
  AgentMemoryEntry.created_at/updated_at = number，model.ts:129-130；codex HIGH/MEDIUM-2）。
- provenance（`source_*`）**不**落 mem0（kv 里 write-only-never-read，M5b 随表删），但 wire 形态
  必须带 4 个 source_* = None（前端 memory.ts:190 读回它们）。

复合写（upsert/delete）的原子性 + `_store_lock` 单次持锁在 engine 侧（`upsert_kv`/`delete_kv`）；
本壳只做编解码 + 只读 `find` 委托。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional


def _iso_to_ms(value: Any) -> Optional[int]:
    """mem0 ISO8601 时间字符串（`datetime.now(timezone.utc).isoformat()`，含 +00:00 偏移）→ epoch
    ms int，钉死 wire 契约（AgentMemoryEntry.created_at/updated_at = number）。已是数值则透传；
    None / 无法解析 → None（前端 number|nullable 容忍，实际 mem0 恒有 ISO 时间）。"""
    if value is None or isinstance(value, bool):  # bool 是 int 子类，显式排除
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(datetime.fromisoformat(value).timestamp() * 1000)
        except ValueError:
            return None
    return None


def _row_to_kv(row: Dict[str, Any]) -> Dict[str, Any]:
    """mem0 `get_all`/`get` 行 → **完整 AgentMemoryEntry** 形态（model.ts:116-131），让 M5a-2 端点
    flag-on 返回的 row 与 ChatDb kv 行 wire 兼容 → 前端零改（codex M5a-1 MEDIUM-2）。自定义字段在
    `row["metadata"]`（spike §4.8），value 在顶层 `row["memory"]`，时间在顶层 ISO 字符串 → epoch ms。

    provenance 4 列（source_*）= None：kv 里本就 write-only-never-read，不落 mem0（M5b 随表删），但
    wire 形态必须带它们（前端 memory.ts:190 读回 entry.source_session_id 等）。"""
    md = row.get("metadata") or {}
    return {
        "scope": md.get("scope"),
        "key": md.get("key"),
        "value_json": row.get("memory"),
        "source_wiki_path": None,
        "source_session_id": None,
        "source_message_id": None,
        "source_tool_use_id": None,
        "priority": md.get("priority", 0),
        "created_at": _iso_to_ms(row.get("created_at")),
        "updated_at": _iso_to_ms(row.get("updated_at")),
    }


def kv_upsert(
    scope: str, key: str, value_json: str, priority: Optional[int] = None
) -> None:
    """UPSERT `(scope,key)=value_json` over mem0（委托 engine 单 `_store_lock` span 复合）。
    ``priority=None`` = COALESCE 语义：update 保留旧值、insert 默认 0（codex HIGH-2，见 engine.upsert_kv）。"""
    from src.memory.mem0_engine import get_mem0_engine

    get_mem0_engine().upsert_kv(scope, key, value_json, priority)


def kv_get(scope: str, key: str) -> Optional[Dict[str, Any]]:
    """单条 `(scope,key)` → kv dict | None（服务端精确 metadata 过滤，spike Q2）。
    kind=KV_KIND filter + scope/key 非 None 兜底（codex HIGH-1）→ 绝不返回 capture 事实。"""
    from src.memory.mem0_engine import DEFAULT_USER_ID, KV_KIND, get_mem0_engine

    rows = get_mem0_engine().find(
        {"user_id": DEFAULT_USER_ID, "kind": KV_KIND, "scope": scope, "key": key}
    )
    if not rows:
        return None
    entry = _row_to_kv(rows[0])
    # 兜底防线（HIGH-1）：即便 filter 误匹配，scope/key 缺失的非 kv 行也绝不上抛。
    if entry["scope"] is None or entry["key"] is None:
        return None
    return entry


def kv_list(scope: Optional[str] = None) -> List[Dict[str, Any]]:
    """列条目（可选 scope 过滤）→ kv dict 列表，按 updated_at 倒序（镜像 ChatDb `ORDER BY updated_at
    DESC`，db.py:606）。`scope=None` → 全量（仅 user_id + kind 过滤）。

    kind=KV_KIND filter + scope/key 非 None 兜底（codex HIGH-1）→ capture 事实绝不混入 KV 列表；
    find 默认 top_k=KV_FETCH_CAP（codex MEDIUM-1）→ 不被 mem0 默认 20 截断。"""
    from src.memory.mem0_engine import DEFAULT_USER_ID, KV_KIND, get_mem0_engine

    filters: Dict[str, Any] = {"user_id": DEFAULT_USER_ID, "kind": KV_KIND}
    if scope:
        filters["scope"] = scope
    rows = [_row_to_kv(r) for r in get_mem0_engine().find(filters)]
    # 兜底防线（HIGH-1）：只留结构完整的 kv 行（scope+key 非 None），排除任何漏网的 capture 事实。
    rows = [r for r in rows if r["scope"] is not None and r["key"] is not None]
    rows.sort(key=lambda r: r["updated_at"] or 0, reverse=True)
    return rows


def kv_delete(scope: str, key: str) -> int:
    """删 `(scope,key)` → 删除数（幂等，委托 engine 单 `_store_lock` span 复合，kind=KV_KIND 隔离）。"""
    from src.memory.mem0_engine import get_mem0_engine

    return get_mem0_engine().delete_kv(scope, key)
