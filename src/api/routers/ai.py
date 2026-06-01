"""ai 路由 — /api/ai/* (translation cache 读/删)。

Phase B 填充:
  - GET    /api/ai/translation/{internal_id}  getCached    (email_translation 读)
  - DELETE /api/ai/translation/{internal_id}  deleteCached (email_translation 删)

translateBatch **无 CLI** → defer (handoff §3 / gotcha #5; 是 Electron-main LLM 逻辑:
html block 提取 + pLimit + gateway, 服务端重写工作量大)。

读形状镜像 Electron handler ``frontend/.../handlers/translate.ts:readCache``:
``SELECT segments_json, model, source, updated_at FROM email_translation
WHERE internal_id=? AND target_lang=?`` → 命中返回 camelCase TranslationCache
``{internalId, targetLang, segments:[{src,tgt}], source, model, fetchedAt}``, 未命中
返回 ``data: null`` (前端 getCached 契约: ``TranslationCache | null``)。字段是 **camelCase**
(手写 TS interface, renderer 逐字读, 勿 snake_case)。

连接走 TranslationRepository._connect() (per-call open/close + WAL, gotcha #13 —— 与
mail-sync writer 并发安全, 不持长连接)。db_path 取自注入的 EmailRepository.db_path,
统一 db 来源 (deps.get_repository 单例)。删用 TranslationRepository.delete()。

统一响应走 app.success_envelope / app.APIError；鉴权挂 Depends(verify_cf_access)。
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Depends, Request

from src.api.app import success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_repository

if TYPE_CHECKING:
    from src.repository import EmailRepository

router = APIRouter(prefix="/api/ai", tags=["ai"])

# 前端只调 'zh' (EmailDetail.tsx getCached(id, 'zh') / deleteCached(id, 'zh')); 表
# DEFAULT 'zh'。允许 query 覆盖以备 'en', 默认对齐前端。
_DEFAULT_TARGET_LANG = "zh"


def _read_translation_cache(
    db_path: str, internal_id: int, target_lang: str
) -> Optional[dict]:
    """读 email_translation 一行 → camelCase TranslationCache, 未命中 None。

    镜像 Electron ``readCache``: 取 segments_json/model/source/updated_at, 解析 +
    清洗 segments (跳过非 {src,tgt} 字符串对 / 空白对), fetchedAt = updated_at。
    JSON 损坏 / 非 list → None (当未命中, 与 Electron 一致)。
    """
    from src.repository import TranslationRepository

    repo_t = TranslationRepository(db_path=db_path)
    conn = repo_t._connect()
    try:
        row = conn.execute(
            "SELECT segments_json, model, source, updated_at "
            "FROM email_translation WHERE internal_id = ? AND target_lang = ?",
            (internal_id, target_lang),
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        return None
    try:
        parsed = json.loads(row["segments_json"])
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, list):
        return None

    segments: list[dict] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        src = item.get("src")
        tgt = item.get("tgt")
        if not isinstance(src, str) or not isinstance(tgt, str):
            continue
        if not src.strip() or not tgt.strip():
            continue
        segments.append({"src": src.strip(), "tgt": tgt.strip()})

    return {
        "internalId": internal_id,
        "targetLang": target_lang,
        "segments": segments,
        "source": row["source"],
        "model": row["model"],
        "fetchedAt": row["updated_at"],
    }


# ============================================================
# GET /api/ai/translation/{internal_id}  (读, email_translation)
# ============================================================
@router.get("/translation/{internal_id}")
async def ai_get_cached(
    internal_id: int,
    request: Request,
    target_lang: str = _DEFAULT_TARGET_LANG,
    _: None = Depends(verify_cf_access),
    repo: "EmailRepository" = Depends(get_repository),
):
    """读沉浸式翻译缓存 (镜像 IPC ``translation:get`` / frontend AiApi.getCached)。

    命中 → data = TranslationCache (camelCase); 未命中 → data = null (合法状态, 200 ——
    前端 useQuery 据 null 决定是否触发 translateBatch)。target_lang 默认 'zh' (前端唯一
    调用值)。meta.source='sqlite'。
    """
    data = _read_translation_cache(str(repo.db_path), internal_id, target_lang)
    return success_envelope(data, request=request, source="sqlite")


# ============================================================
# DELETE /api/ai/translation/{internal_id}  (删, email_translation)
# ============================================================
@router.delete("/translation/{internal_id}")
async def ai_delete_cached(
    internal_id: int,
    request: Request,
    target_lang: str = _DEFAULT_TARGET_LANG,
    _: None = Depends(verify_cf_access),
    repo: "EmailRepository" = Depends(get_repository),
):
    """删翻译缓存 (镜像 IPC ``translation:delete`` / frontend AiApi.deleteCached)。

    用户点 "重新翻译" 触发。data = {deleted: bool} (是否真删了一行; 未命中 deleted=false,
    仍 200)。target_lang 默认 'zh'。meta.source='sqlite'。

    注: 这是单表幂等删除 (renderer-initiated, 不冲突 mail-sync), 走 TranslationRepository
    直删而非 CLI/outbox —— 与 Electron 主进程 readwrite 单例同语义。
    """
    from src.repository import TranslationRepository

    repo_t = TranslationRepository(db_path=str(repo.db_path))
    deleted = repo_t.delete(internal_id, target_lang=target_lang)
    return success_envelope({"deleted": deleted}, request=request, source="sqlite")
