#!/usr/bin/env python3
"""Phase 3 §P2-a — frontend i18n key audit.

扫所有 `t('xxx.yyy')` / `i18n.t('xxx.yyy')` / 等价调用 vs zh-CN + en-US locale
tree, 检 3 类问题:

1. **Missing**: 代码中用了但 locale tree 没定义 (silent fallback to key string)
2. **Collision**: 同 key 在 zh 是 string 在 en 是 object (or vice versa) —
   i18next 解析时炸. F16 之前出过 calendar.empty string-vs-object 这种.
3. **Parity gap**: 一边定义另一边漏 — i18next silent fallback 到 default lng.

Usage:
    python scripts/dev/i18n_audit.py
    python scripts/dev/i18n_audit.py --check-only  # CI 模式, 有问题 exit 1
    python scripts/dev/i18n_audit.py --prefix calendar.  # 只看 calendar.* keys

Exit codes:
    0 — clean
    1 — found issues (use --check-only for CI gate)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_SRC = REPO_ROOT / "frontend" / "src"
LOCALES_DIR = FRONTEND_SRC / "shared" / "i18n" / "locales"

# 抓取 t('foo.bar') / t("foo.bar") / i18n.t('foo.bar') / useTranslation hook.
# 跳过 t(`...`) 模板字面量 / 动态 key 变量, 没法静态 audit.
T_CALL_RE = re.compile(
    r"""
    \b(?:i18n\.)?t\(           # t( or i18n.t(
    \s*['"]([\w.\-]+)['"]      # 'key.path' or "key.path"
    """,
    re.VERBOSE,
)


def find_used_keys() -> Dict[str, List[Path]]:
    """扫所有 .ts/.tsx, 抓 t('key') 用. 返 {key: [files referencing]}."""
    used: Dict[str, List[Path]] = {}
    for path in FRONTEND_SRC.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in {".ts", ".tsx"}:
            continue
        # 跳过 d.ts (类型声明, 没 runtime t() 调用)
        if path.name.endswith(".d.ts"):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for m in T_CALL_RE.finditer(text):
            key = m.group(1)
            # 至少有 1 个 dot — 单 word ('test', 'abc') 大概率是普通函数调用
            # (translate / time / type 等), 跳过减误报
            if "." not in key:
                continue
            used.setdefault(key, []).append(path.relative_to(REPO_ROOT))
    return used


def load_locale(lng: str) -> Dict[str, Any]:
    """读 zh-CN/common.json / en-US/common.json."""
    path = LOCALES_DIR / lng / "common.json"
    if not path.exists():
        raise FileNotFoundError(f"locale file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def lookup(tree: Dict[str, Any], dotted_key: str) -> Tuple[bool, Any]:
    """按 dotted key 在 nested dict 找. 返 (found, value).

    value 可能是 str (叶子) 或 dict (中间节点 / collision). value=str 才能给
    t() 用; dict 表示该 key 是"目录"非"文件".
    """
    parts = dotted_key.split(".")
    cur: Any = tree
    for p in parts:
        if not isinstance(cur, dict):
            return False, None
        if p not in cur:
            return False, None
        cur = cur[p]
    return True, cur


def flatten_keys(tree: Dict[str, Any], prefix: str = "") -> Set[str]:
    """递归把 nested dict 平铺成 dotted key set (只含 string 叶子)."""
    out: Set[str] = set()
    for k, v in tree.items():
        key = f"{prefix}{k}" if not prefix else f"{prefix}.{k}"
        if isinstance(v, dict):
            out.update(flatten_keys(v, prefix=key))
        else:
            out.add(key)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        description="frontend i18n key audit",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="CI 模式, 找到问题 exit 1 (默认 exit 0 仅打印)",
    )
    parser.add_argument(
        "--prefix",
        default="",
        help="只 audit 指定前缀的 keys (e.g. 'calendar.')",
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        help="只打 summary, 不列每个问题 key",
    )
    args = parser.parse_args()

    zh = load_locale("zh-CN")
    en = load_locale("en-US")

    used = find_used_keys()
    zh_keys = flatten_keys(zh)
    en_keys = flatten_keys(en)

    # Filter by prefix
    if args.prefix:
        used = {k: v for k, v in used.items() if k.startswith(args.prefix)}
        zh_keys = {k for k in zh_keys if k.startswith(args.prefix)}
        en_keys = {k for k in en_keys if k.startswith(args.prefix)}

    # 1. Missing — code references but neither locale has
    missing: List[Tuple[str, List[Path]]] = []
    for key, refs in sorted(used.items()):
        zh_found, _zh_val = lookup(zh, key)
        en_found, _en_val = lookup(en, key)
        if not zh_found and not en_found:
            missing.append((key, refs))

    # 2. Collisions — key resolves to dict in one locale, string in other
    #    OR key resolves to dict in BOTH but code expects leaf string.
    collisions: List[Tuple[str, str, str]] = []  # (key, zh_type, en_type)
    for key in sorted(used.keys()):
        zh_found, zh_val = lookup(zh, key)
        en_found, en_val = lookup(en, key)
        zh_type = (
            "(missing)" if not zh_found
            else "dict" if isinstance(zh_val, dict)
            else "string"
        )
        en_type = (
            "(missing)" if not en_found
            else "dict" if isinstance(en_val, dict)
            else "string"
        )
        if zh_found and en_found and zh_type != en_type:
            collisions.append((key, zh_type, en_type))
        elif zh_found and zh_type == "dict" and not en_found:
            collisions.append((key, "dict", "(missing)"))
        elif en_found and en_type == "dict" and not zh_found:
            collisions.append((key, "(missing)", "dict"))

    # 3. Parity gap — key in one locale tree but not the other
    only_zh: Set[str] = zh_keys - en_keys
    only_en: Set[str] = en_keys - zh_keys

    # ============================
    # Report
    # ============================
    issues_found = bool(missing or collisions or only_zh or only_en)

    print("=" * 70)
    print(
        f"i18n audit — {len(used)} keys used in code, "
        f"{len(zh_keys)} zh, {len(en_keys)} en"
    )
    if args.prefix:
        print(f"  (filtered by prefix={args.prefix!r})")
    print("=" * 70)

    print(
        f"\n[1] Missing keys (code references, "
        f"absent in both locales): {len(missing)}"
    )
    if missing and not args.quiet:
        for key, refs in missing[:30]:
            sample = refs[0] if refs else "(?)"
            extra = f" (+{len(refs) - 1} more files)" if len(refs) > 1 else ""
            print(f"  - {key!r}  used in {sample}{extra}")
        if len(missing) > 30:
            print(f"  ... ({len(missing) - 30} more)")

    print(f"\n[2] Type collisions (string vs dict): {len(collisions)}")
    if collisions and not args.quiet:
        for key, zh_type, en_type in collisions:
            print(f"  - {key!r}  zh={zh_type}  en={en_type}")

    print(
        f"\n[3] Parity gap — only in zh-CN: {len(only_zh)}, "
        f"only in en-US: {len(only_en)}"
    )
    if not args.quiet:
        if only_zh:
            print("  only-in-zh:")
            for k in sorted(only_zh)[:30]:
                print(f"    + {k}")
            if len(only_zh) > 30:
                print(f"    ... ({len(only_zh) - 30} more)")
        if only_en:
            print("  only-in-en:")
            for k in sorted(only_en)[:30]:
                print(f"    + {k}")
            if len(only_en) > 30:
                print(f"    ... ({len(only_en) - 30} more)")

    print()
    if issues_found:
        print("⚠ issues found — see above")
    else:
        print("✓ clean — no missing / collision / parity gap")

    if args.check_only and issues_found:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
