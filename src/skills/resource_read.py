"""只读 skill 资源读取 / 检索（通用替代特定行业工具：read / search bundled references/ 等）。

支持已安装 skill（``<skills>/<name>/``）与内置 skill（``src/skills/docs/<name>/``）：
- 目录列举：不传 ``path`` 或指向目录时递归列举安全文件（限深度与条数）
- 结构化 JSON：``json_path`` 路径下钻、``search`` 关键字匹配（``name``/``id``/key 精确命中优先，32 KiB 封顶）、
  大于 24 KiB 时默认返回顶层结构摘要（防止一次性塞爆上下文）
- 文本文件：``offset_line`` + ``max_lines`` 分片读取，或 ``search`` 返回命中行 ±1 行上下文

安全边界：
- 拒绝 ``.``、``..``、前导斜杠、反斜杠、空字节及 symlink
- ``realpath`` 必须严格落在 skill 根目录内
- 禁止读取根目录 ``config.json``、``.env*``、``*.pem``、``*.key`` 等敏感文件及 ``.git`` / ``__pycache__``
- 拒绝二进制文件
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Optional

from src.agent_config.store import _SKILL_NAME_RE
from src.skills.pack_verify import PackError

_MAX_OUTPUT_BYTES = 32 * 1024
_LARGE_JSON_THRESHOLD_BYTES = 24 * 1024
_MAX_READ_FILE_BYTES = 4 * 1024 * 1024
_MAX_DIR_ENTRIES = 200
_MAX_DIR_DEPTH = 4
_DEFAULT_MAX_LINES = 200
_MAX_LINES_LIMIT = 500
_DEFAULT_SEARCH_LIMIT = 20
_MAX_SEARCH_LIMIT = 50

_BLOCKED_SEGMENTS = frozenset({".git", "__pycache__", "node_modules", ".quarantine"})
_BLOCKED_SUFFIXES = (".pem", ".key", ".p12", ".pfx")
_JSON_PATH_TOKEN_RE = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


def _resolve_skill_root(skill_name: str) -> tuple[str, str]:
    """解析 skill 根目录 ``(root_realpath, source_kind)``；不存在或非法名抛 ``PackError``。"""
    name = (skill_name or "").strip()
    if not _SKILL_NAME_RE.match(name):
        raise PackError("E_INVALID_ARG", f"invalid skill name: {skill_name!r}", http_status=400)

    from src.skills.registry import builtin_doc_file

    builtin_path = builtin_doc_file(name)
    if builtin_path is not None:
        root_dir = os.path.realpath(os.path.dirname(builtin_path))
        if not os.path.isdir(root_dir):
            raise PackError("E_NOT_FOUND", f"skill not found: {name}", http_status=404)
        return root_dir, "builtin"

    from src.skills.pack_fetch import skill_dir, skills_data_root

    base_root = os.path.realpath(skills_data_root())
    target_dir = skill_dir(name)
    if os.path.islink(target_dir):
        raise PackError("E_INVALID_ARG", "skill root symlink is not allowed", http_status=400)
    real_dir = os.path.realpath(target_dir)
    if real_dir != base_root and not real_dir.startswith(base_root + os.sep):
        raise PackError("E_INVALID_ARG", "skill name escapes skills root", http_status=400)
    if not os.path.isdir(real_dir):
        raise PackError("E_NOT_FOUND", f"skill not found: {name}", http_status=404)
    return real_dir, "installed"


def _is_blocked_rel_segments(parts: list[str]) -> Optional[str]:
    """返回命中的违禁原因，安全返回 None。"""
    if not parts:
        return None
    if len(parts) == 1 and parts[0].lower() == "config.json":
        return "config.json is blocked"
    for seg in parts:
        low = seg.lower()
        if seg in (".", "..") or "\x00" in seg:
            return f"invalid path segment: {seg!r}"
        if low in _BLOCKED_SEGMENTS:
            return f"access to {seg!r} is blocked"
        if low == ".env" or low.startswith(".env."):
            return "environment files are blocked"
    last_low = parts[-1].lower()
    if last_low.endswith(_BLOCKED_SUFFIXES):
        return "key/certificate files are blocked"
    return None


def _resolve_resource_target(root_real: str, rel_path: Optional[str]) -> tuple[str, str]:
    """校验相对路径并解析真实路径 ``(rel_posix, target_realpath)``。"""
    if rel_path is None or rel_path.strip() == "":
        return "", root_real

    raw = rel_path.strip()
    if "\x00" in raw or raw.startswith("/") or raw.startswith("\\") or "\\" in raw:
        raise PackError("E_INVALID_ARG", f"invalid resource path: {rel_path!r}", http_status=400)
    if len(raw) >= 2 and raw[1] == ":" and raw[0].isalpha():
        raise PackError("E_INVALID_ARG", f"invalid resource path: {rel_path!r}", http_status=400)

    parts = raw.split("/")
    if any(p == "" for p in parts):
        raise PackError("E_INVALID_ARG", f"invalid resource path: {rel_path!r}", http_status=400)

    blocked = _is_blocked_rel_segments(parts)
    if blocked:
        raise PackError("E_INVALID_ARG", f"resource path denied ({blocked}): {rel_path!r}", http_status=400)

    cur = root_real
    for seg in parts:
        cur = os.path.join(cur, seg)
        if os.path.islink(cur):
            raise PackError("E_INVALID_ARG", f"symlink resource is not allowed: {rel_path!r}", http_status=400)

    target_real = os.path.realpath(cur)
    if target_real != root_real and not target_real.startswith(root_real + os.sep):
        raise PackError("E_INVALID_ARG", f"resource path escapes skill root: {rel_path!r}", http_status=400)
    return "/".join(parts), target_real


def _list_directory(
    skill_name: str,
    source_kind: str,
    root_real: str,
    rel_prefix: str,
    dir_real: str,
    search: Optional[str],
) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    truncated = False
    query = (search or "").strip().lower()

    def _walk(cur_dir: str, cur_parts: list[str], depth: int) -> None:
        nonlocal truncated
        if depth > _MAX_DIR_DEPTH or truncated:
            return
        try:
            names = sorted(os.listdir(cur_dir))
        except OSError:
            return
        for entry_name in names:
            full = os.path.join(cur_dir, entry_name)
            if os.path.islink(full):
                continue
            next_parts = [*cur_parts, entry_name]
            if _is_blocked_rel_segments(next_parts):
                continue
            rel_posix = "/".join(next_parts)
            is_dir = os.path.isdir(full)
            if not query or query in rel_posix.lower():
                if len(entries) >= _MAX_DIR_ENTRIES:
                    truncated = True
                    return
                item: dict[str, Any] = {
                    "path": rel_posix,
                    "type": "dir" if is_dir else "file",
                }
                if not is_dir:
                    try:
                        item["sizeBytes"] = os.path.getsize(full)
                    except OSError:
                        item["sizeBytes"] = 0
                entries.append(item)
            if is_dir and depth < _MAX_DIR_DEPTH:
                _walk(full, next_parts, depth + 1)

    start_parts = rel_prefix.split("/") if rel_prefix else []
    _walk(dir_real, start_parts, 0)
    return {
        "skill": skill_name,
        "source": source_kind,
        "path": rel_prefix or ".",
        "mode": "directory",
        "entries": entries,
        "truncated": truncated,
    }


def _read_text_bytes(file_path: str, rel_posix: str) -> str:
    try:
        size = os.path.getsize(file_path)
    except OSError as exc:
        raise PackError("E_NOT_FOUND", f"cannot stat resource: {rel_posix}", http_status=404) from exc
    if size > _MAX_READ_FILE_BYTES:
        raise PackError(
            "E_PACK_TOO_LARGE",
            f"resource exceeds 4 MiB read cap: {rel_posix} ({size} bytes)",
            http_status=413,
        )
    try:
        with open(file_path, "rb") as f:
            raw = f.read(_MAX_READ_FILE_BYTES + 1)
    except OSError as exc:
        raise PackError("E_INTERNAL", f"cannot read resource {rel_posix}: {exc}", http_status=500) from exc
    if b"\x00" in raw:
        raise PackError("E_PACK_UNSUPPORTED_MEDIA", f"binary resource is not supported: {rel_posix}", http_status=415)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PackError("E_PACK_UNSUPPORTED_MEDIA", f"binary or non-UTF-8 resource: {rel_posix}", http_status=415) from exc


def _resolve_json_path(data: Any, expr: str) -> Any:
    raw = (expr or "").strip()
    if not raw or raw in ("$", "."):
        return data
    if raw.startswith("$."):
        raw = raw[2:]
    elif raw.startswith("$"):
        raw = raw[1:]

    pos = 0
    tokens: list[tuple[str, Any]] = []
    while pos < len(raw):
        if raw[pos] == ".":
            pos += 1
            continue
        m = _JSON_PATH_TOKEN_RE.match(raw, pos)
        if not m:
            raise PackError("E_INVALID_ARG", f"invalid json_path syntax: {expr!r}", http_status=400)
        if m.group(1) is not None:
            tokens.append(("key", m.group(1)))
        else:
            tokens.append(("index", int(m.group(2))))
        pos = m.end()

    cur = data
    for kind, token in tokens:
        if kind == "key":
            if isinstance(cur, dict) and token in cur:
                cur = cur[token]
            elif isinstance(cur, list) and token.isdigit():
                idx = int(token)
                if 0 <= idx < len(cur):
                    cur = cur[idx]
                else:
                    raise PackError("E_NOT_FOUND", f"json_path not found: {expr}", http_status=404)
            else:
                raise PackError("E_NOT_FOUND", f"json_path not found: {expr}", http_status=404)
        else:
            if isinstance(cur, list) and 0 <= token < len(cur):
                cur = cur[token]
            else:
                raise PackError("E_NOT_FOUND", f"json_path not found: {expr}", http_status=404)
    return cur


def _truncate_utf8(text: str, max_bytes: int) -> tuple[str, bool]:
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text, False
    return encoded[:max_bytes].decode("utf-8", errors="ignore"), True


def _json_overview(data: Any) -> Any:
    if isinstance(data, dict):
        summary: dict[str, Any] = {}
        for k, v in list(data.items())[:50]:
            if isinstance(v, list):
                sample_keys: list[str] = []
                if v and isinstance(v[0], dict):
                    sample_keys = [str(sk) for sk in list(v[0].keys())[:8]]
                entry: dict[str, Any] = {"type": "array", "length": len(v)}
                if sample_keys:
                    entry["itemKeys"] = sample_keys
                summary[k] = entry
            elif isinstance(v, dict):
                summary[k] = {"type": "object", "keyCount": len(v), "keys": [str(sk) for sk in list(v.keys())[:15]]}
            else:
                summary[k] = v
        return summary
    if isinstance(data, list):
        return {
            "type": "array",
            "length": len(data),
            "sample": data[:3],
        }
    return data


def _search_json(data: Any, query: str, limit: int) -> tuple[list[dict[str, Any]], bool]:
    q = query.strip().lower()
    if not q:
        return [], False

    hits: list[tuple[int, str, Any]] = []
    id_fields = ("name", "id", "slug", "tag", "title", "symbol")

    def _visit(node: Any, path_str: str, key_name: Optional[str]) -> bool:
        """返回当前子树下是否已有强命中，避免父容器重复膨胀上报。"""
        if isinstance(node, dict):
            child_matched = False
            for k, v in node.items():
                child_path = f"{path_str}.{k}" if path_str else str(k)
                if _visit(v, child_path, str(k)):
                    child_matched = True

            # 判定本 dict 自身作为记录条目是否命中（name/id/title/key 或标量属性）
            best_score = 0
            if key_name is not None:
                kl = key_name.lower()
                if kl == q:
                    best_score = max(best_score, 3)
                elif q in kl:
                    best_score = max(best_score, 2)
            for idf in id_fields:
                val = node.get(idf)
                if isinstance(val, str):
                    vl = val.lower()
                    if vl == q:
                        best_score = max(best_score, 3)
                    elif q in vl:
                        best_score = max(best_score, 2)

            if best_score > 0:
                hits.append((best_score, path_str or "$", node))
                return True

            # 若某个直接标量属性命中且没有更深的 dict/list 子命中，则上报该记录对象
            if not child_matched:
                scalar_hit = any(
                    isinstance(v, (str, int, float, bool)) and q in str(v).lower()
                    for v in node.values()
                )
                if scalar_hit:
                    hits.append((1, path_str or "$", node))
                    return True
            return child_matched

        if isinstance(node, list):
            any_hit = False
            for idx, item in enumerate(node):
                child_path = f"{path_str}[{idx}]" if path_str else f"[{idx}]"
                if _visit(item, child_path, None):
                    any_hit = True
            return any_hit

        # 顶层或数组元素中的裸标量
        val_str = str(node) if node is not None else ""
        if q in val_str.lower() or (key_name and q in key_name.lower()):
            score = 3 if (key_name and key_name.lower() == q) or val_str.lower() == q else 1
            if key_name is None or path_str.endswith("]"):
                hits.append((score, path_str or "$", node))
                return True
        return False

    _visit(data, "", None)

    # key 级匹配兜底：如果只有 dict 标量键值命中而未在对象层收集
    hits.sort(key=lambda item: (-item[0], len(item[1]), item[1]))

    selected: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    used_bytes = 2
    truncated = False

    for score, p, val in hits:
        if p in seen_paths:
            continue
        seen_paths.add(p)
        if len(selected) >= limit:
            truncated = True
            break
        serialized = json.dumps({"path": p, "score": score, "value": val}, ensure_ascii=False)
        cost = len(serialized.encode("utf-8")) + 1
        if used_bytes + cost > _MAX_OUTPUT_BYTES:
            if not selected:
                clipped, _ = _truncate_utf8(json.dumps(val, ensure_ascii=False, indent=2), _MAX_OUTPUT_BYTES - 256)
                selected.append({"path": p, "score": score, "valuePreview": clipped})
            truncated = True
            break
        used_bytes += cost
        selected.append({"path": p, "score": score, "value": val})

    return selected, truncated


def _search_text(text: str, query: str, limit: int) -> tuple[list[dict[str, Any]], bool]:
    q = query.strip().lower()
    if not q:
        return [], False
    lines = text.splitlines()
    matches: list[dict[str, Any]] = []
    used_bytes = 2
    truncated = False
    for idx, line in enumerate(lines):
        if q not in line.lower():
            continue
        if len(matches) >= limit:
            truncated = True
            break
        hunk = {
            "lineNumber": idx + 1,
            "before": lines[idx - 1] if idx > 0 else None,
            "line": line,
            "after": lines[idx + 1] if idx + 1 < len(lines) else None,
        }
        cost = len(json.dumps(hunk, ensure_ascii=False).encode("utf-8")) + 1
        if used_bytes + cost > _MAX_OUTPUT_BYTES:
            truncated = True
            break
        used_bytes += cost
        matches.append(hunk)
    return matches, truncated


def read_skill_resource(
    skill_name: str,
    *,
    path: Optional[str] = None,
    search: Optional[str] = None,
    json_path: Optional[str] = None,
    offset_line: int = 1,
    max_lines: int = _DEFAULT_MAX_LINES,
    limit: int = _DEFAULT_SEARCH_LIMIT,
) -> dict[str, Any]:
    """只读读取/检索某个 skill 目录内的文件或目录结构。"""
    root_real, source_kind = _resolve_skill_root(skill_name)
    rel_posix, target_real = _resolve_resource_target(root_real, path)

    if not os.path.exists(target_real):
        raise PackError("E_NOT_FOUND", f"resource not found: {rel_posix or '.'}", http_status=404)

    if os.path.isdir(target_real):
        return _list_directory(skill_name, source_kind, root_real, rel_posix, target_real, search)

    text = _read_text_bytes(target_real, rel_posix)
    file_size = os.path.getsize(target_real)
    safe_limit = max(1, min(_MAX_SEARCH_LIMIT, int(limit or _DEFAULT_SEARCH_LIMIT)))
    safe_offset = max(1, int(offset_line or 1))
    safe_max_lines = max(1, min(_MAX_LINES_LIMIT, int(max_lines or _DEFAULT_MAX_LINES)))

    if rel_posix.lower().endswith(".json"):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
        if parsed is not None:
            if json_path and json_path.strip():
                resolved = _resolve_json_path(parsed, json_path)
                rendered = json.dumps(resolved, ensure_ascii=False, indent=2)
                content, truncated = _truncate_utf8(rendered, _MAX_OUTPUT_BYTES)
                return {
                    "skill": skill_name,
                    "source": source_kind,
                    "path": rel_posix,
                    "mode": "json_path",
                    "jsonPath": json_path.strip(),
                    "content": content,
                    "truncated": truncated,
                    "sizeBytes": file_size,
                }
            if search and search.strip():
                matches, truncated = _search_json(parsed, search, safe_limit)
                return {
                    "skill": skill_name,
                    "source": source_kind,
                    "path": rel_posix,
                    "mode": "json_search",
                    "query": search.strip(),
                    "matches": matches,
                    "truncated": truncated,
                    "sizeBytes": file_size,
                }
            if file_size > _LARGE_JSON_THRESHOLD_BYTES and safe_offset == 1:
                overview = _json_overview(parsed)
                rendered = json.dumps(overview, ensure_ascii=False, indent=2)
                content, truncated = _truncate_utf8(rendered, _MAX_OUTPUT_BYTES)
                return {
                    "skill": skill_name,
                    "source": source_kind,
                    "path": rel_posix,
                    "mode": "json_overview",
                    "content": content,
                    "truncated": truncated,
                    "sizeBytes": file_size,
                    "hint": "Large JSON file; pass search or json_path (or offset_line > 1) to inspect entries.",
                }

    if search and search.strip():
        matches, truncated = _search_text(text, search, safe_limit)
        return {
            "skill": skill_name,
            "source": source_kind,
            "path": rel_posix,
            "mode": "text_search",
            "query": search.strip(),
            "matches": matches,
            "truncated": truncated,
            "sizeBytes": file_size,
        }

    lines = text.splitlines()
    total_lines = len(lines)
    start_idx = safe_offset - 1
    selected = lines[start_idx : start_idx + safe_max_lines]
    joined = "\n".join(selected)
    content, byte_truncated = _truncate_utf8(joined, _MAX_OUTPUT_BYTES)
    line_truncated = (start_idx + len(selected)) < total_lines
    end_line = start_idx + len(content.splitlines()) if content else safe_offset - 1
    return {
        "skill": skill_name,
        "source": source_kind,
        "path": rel_posix,
        "mode": "text",
        "content": content,
        "startLine": safe_offset,
        "endLine": end_line,
        "totalLines": total_lines,
        "truncated": byte_truncated or line_truncated,
        "sizeBytes": file_size,
    }
