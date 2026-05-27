#!/usr/bin/env bash
# PostToolUse(Edit|Write) — 按文件类型自动 lint-fix / format
#   *.py            → venv/bin/ruff check --fix（按项目 lint 配置，含删未用 import）
#   frontend/*.ts(x)→ frontend 本地 prettier --write
# 静默运行；工具缺失时跳过，不阻断编辑。
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
input=$(cat)
fp=$(printf '%s' "$input" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)
[ -z "$fp" ] && exit 0
[ -f "$fp" ] || exit 0
case "$fp" in
  *.py)
    ruff="$root/venv/bin/ruff"
    [ -x "$ruff" ] || ruff="$(command -v ruff)"
    [ -n "$ruff" ] && "$ruff" check --fix "$fp" >/dev/null 2>&1
    ;;
  "$root"/frontend/*.ts | "$root"/frontend/*.tsx | "$root"/frontend/*.js | "$root"/frontend/*.jsx)
    pretty="$root/frontend/node_modules/.bin/prettier"
    [ -x "$pretty" ] && (cd "$root/frontend" && "$pretty" --write "$fp" >/dev/null 2>&1)
    ;;
esac
exit 0
