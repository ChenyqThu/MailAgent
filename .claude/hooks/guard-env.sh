#!/usr/bin/env bash
# PreToolUse(Edit|Write) — 阻止直接修改含生产密钥的 .env 文件
# 放行 .env.example；拦截 .env / .env.local / .env.production 等
input=$(cat)
fp=$(printf '%s' "$input" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)
[ -z "$fp" ] && exit 0
base=$(basename "$fp")
case "$base" in
  .env.example)
    exit 0
    ;;
  .env | .env.*)
    echo "阻止修改 ${fp} : 该文件含生产密钥（NOTION_TOKEN / LLM_API_KEY / DAVMAIL_CIPHER_KEY / KOS OAuth secrets）。确需修改请手动编辑该文件，或改 .env.example。" >&2
    exit 2
    ;;
esac
exit 0
