#!/bin/bash
# create_reply_draft.sh — 在 Mail.app 中创建邮件草稿
#
# 支持三种模式:
#   --mode reply-all  (默认) Reply All：回复所有人，保留线程
#   --mode reply      Reply：仅回复发件人，保留线程
#   --mode new        New：新建邮件（不关联原始邮件）
#
# 用法:
#   bash create_reply_draft.sh \
#     --internal-id 48197 \
#     --reply-text "Hi Neil, ..." \
#     [--mode reply-all] \
#     [--to "nemo@tp-link.com"] \
#     [--to-name "Nemo Mo"] \
#     [--cc "alice@tp-link.com,bob@tp-link.com"] \
#     [--subject "Re: ..."] \
#     [--message-id "MWHPR05MB..."] \
#     [--mailbox "收件箱"] \
#     [--account "Exchange"] \
#     [--screenshot]
#
# Reply/Reply-All 模式:
#   优先用 internal_id 定位原始邮件（~1s），fallback 到 message_id（~100s）
#   找不到原始邮件则 fallback 到 new 模式
#   使用 System Events 粘贴内容（AppleScript set content 对 reply 无效）
#
# New 模式:
#   直接创建独立草稿，需提供 --to 和 --subject
#
# --screenshot: 保存前截取 Mail 窗口，路径在输出 JSON 的 screenshot_path 字段
#
# 输出: JSON { "success": true/false, "method": "...", "screenshot_path": "...", "error": "..." }

set -euo pipefail

# 默认值
MODE="reply-all"
INTERNAL_ID=""
MESSAGE_ID=""
TO_EMAIL=""
TO_NAME=""
CC_EMAILS=""
SUBJECT=""
REPLY_TEXT=""
MAILBOX="收件箱"
ACCOUNT="Exchange"
SCREENSHOT=false
CLIPBOARD_READY=false
SELF_EMAILS="lucien.chen@tp-link.com,yuanquan.chen@tp-link.com"
SCREENSHOT_DIR="/tmp/mail-drafts"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRA_TO=""
EXTRA_CC=""
_REPLY_WINDOW_OPEN=false
CLIPBOARD_HTML_FILE=""
PASTE_BASELINE_LEN=-1

# 失败时关闭残留的回复窗口
_cleanup_on_error() {
  local rc=$?
  if [[ $rc -ne 0 && "$_REPLY_WINDOW_OPEN" == "true" ]]; then
    osascript -e 'tell application "Mail"
      try
        close front window
      end try
    end tell' 2>/dev/null
  fi
}
trap '_cleanup_on_error' EXIT

# 解析参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --internal-id) INTERNAL_ID="$2"; shift 2 ;;
    --message-id) MESSAGE_ID="$2"; shift 2 ;;
    --to) TO_EMAIL="$2"; shift 2 ;;
    --to-name) TO_NAME="$2"; shift 2 ;;
    --cc) CC_EMAILS="$2"; shift 2 ;;
    --subject) SUBJECT="$2"; shift 2 ;;
    --reply-text) REPLY_TEXT="$2"; shift 2 ;;
    --mailbox) MAILBOX="$2"; shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    --extra-to) EXTRA_TO="$2"; shift 2 ;;
    --extra-cc) EXTRA_CC="$2"; shift 2 ;;
    --clipboard-ready) CLIPBOARD_READY=true; shift ;;
    --clipboard-html-file) CLIPBOARD_HTML_FILE="$2"; shift 2 ;;
    --screenshot) SCREENSHOT=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# 验证必填参数
if [[ -z "$REPLY_TEXT" ]]; then
  echo '{"success":false,"error":"Missing required arg: --reply-text"}'
  exit 1
fi
if [[ "$MODE" == "new" && ( -z "$TO_EMAIL" || -z "$SUBJECT" ) ]]; then
  echo '{"success":false,"error":"New mode requires --to and --subject"}'
  exit 1
fi

# mailbox 路由
AS_MAILBOX="$MAILBOX"
[[ "$MAILBOX" == "发件箱" ]] && AS_MAILBOX="已发送邮件"

# AppleScript 字符串转义
escape_as() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# CC AppleScript 片段构建（过滤自己）
build_cc_script() {
  local cc_input="$1"
  [[ -z "$cc_input" ]] && return
  local script=""
  IFS=',' read -ra CC_ARRAY <<< "$cc_input"
  for addr in "${CC_ARRAY[@]}"; do
    addr="$(echo "$addr" | xargs)"
    local skip=false
    IFS=',' read -ra SELF_ARRAY <<< "$SELF_EMAILS"
    for self_addr in "${SELF_ARRAY[@]}"; do
      [[ "$addr" == "$self_addr" ]] && skip=true && break
    done
    if [[ "$skip" == "false" && -n "$addr" ]]; then
      script="${script}
        make new cc recipient at end of cc recipients with properties {address:\"$(escape_as "$addr")\"}"
    fi
  done
  echo "$script"
}

# 构建额外收件人 AppleScript（用于 reply 模式注入到 replyMsg）
build_extra_recipients_script() {
  local extra_to="$1" extra_cc="$2"
  local lines=""
  if [[ -n "$extra_to" ]]; then
    IFS=',' read -ra ADDRS <<< "$extra_to"
    for addr in "${ADDRS[@]}"; do
      addr="$(echo "$addr" | xargs)"
      [[ -n "$addr" ]] && lines+="
          make new to recipient at end of to recipients with properties {address:\"$(escape_as "$addr")\"}"
    done
  fi
  if [[ -n "$extra_cc" ]]; then
    IFS=',' read -ra ADDRS <<< "$extra_cc"
    for addr in "${ADDRS[@]}"; do
      addr="$(echo "$addr" | xargs)"
      local skip=false
      IFS=',' read -ra SELF_ARRAY <<< "$SELF_EMAILS"
      for self_addr in "${SELF_ARRAY[@]}"; do
        [[ "$addr" == "$self_addr" ]] && skip=true && break
      done
      [[ "$skip" == "false" && -n "$addr" ]] && lines+="
          make new cc recipient at end of cc recipients with properties {address:\"$(escape_as "$addr")\"}"
    done
  fi
  if [[ -n "$lines" ]]; then
    echo "tell replyMsg${lines}
        end tell"
  fi
}

# 截图 Mail 前台窗口
capture_screenshot() {
  if [[ "$SCREENSHOT" != "true" ]]; then return; fi
  mkdir -p "$SCREENSHOT_DIR"
  SCREENSHOT_PATH="${SCREENSHOT_DIR}/draft_$(date +%Y%m%d_%H%M%S).png"
  # 用 AppleScript 获取 Mail 前台窗口边界，再用 screencapture -R 精确截取
  local bounds
  bounds=$(osascript -e '
    tell application "Mail"
      set b to bounds of front window
      set x to item 1 of b
      set y to item 2 of b
      set w to (item 3 of b) - x
      set h to (item 4 of b) - y
      return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)
    end tell
  ' 2>/dev/null || echo "")
  if [[ -n "$bounds" ]]; then
    screencapture -R "$bounds" -o "$SCREENSHOT_PATH" 2>/dev/null
  else
    screencapture -o "$SCREENSHOT_PATH" 2>/dev/null
  fi
}

# 唤醒显示器（防止屏幕休眠导致 System Events 失效）
wake_display() {
  caffeinate -u -t 10 &>/dev/null &
  sleep 2
}

# 重新设置剪贴板（用于重试）
reset_clipboard() {
  if [[ -n "$CLIPBOARD_HTML_FILE" && -f "$CLIPBOARD_HTML_FILE" ]]; then
    python3 "$SCRIPT_DIR/html_clipboard.py" --set-html < "$CLIPBOARD_HTML_FILE"
  else
    printf '%s' "$REPLY_TEXT" | python3 "$SCRIPT_DIR/html_clipboard.py"
  fi
}

# 直接读取 Mail.app 当前 reply 窗口的 outgoing message body 长度
# 不依赖键盘焦点 / 系统剪贴板，绕过"焦点在别处时假成功"的问题
get_outgoing_body_length() {
  osascript 2>/dev/null <<'ASEOF' || echo "-1"
tell application "Mail"
  try
    set msg to first outgoing message
    return length of (content of msg as string)
  on error
    return -1
  end try
end tell
ASEOF
}

# 直接读取 Mail.app 当前 reply 窗口的 outgoing message body
get_outgoing_body() {
  osascript 2>/dev/null <<'ASEOF' || echo "__NO_OUTGOING_MSG__"
tell application "Mail"
  try
    set msg to first outgoing message
    return content of msg as string
  on error
    return "__NO_OUTGOING_MSG__"
  end try
end tell
ASEOF
}

# 验证粘贴是否成功（直接通过 AppleScript 读 outgoing message，不依赖 System Events 焦点）
verify_paste() {
  # baseline 必须先被 do_reply 在 reply 窗口打开后设置
  if [[ "$PASTE_BASELINE_LEN" -lt 0 ]]; then
    echo "verify: baseline not set (reply window not opened)" >&2
    return 1
  fi

  local current_body
  current_body=$(get_outgoing_body)
  if [[ "$current_body" == "__NO_OUTGOING_MSG__" ]]; then
    echo "verify: no outgoing message (reply window closed or Mail not responsive)" >&2
    return 1
  fi

  local current_len=${#current_body}

  # body 长度必须比 baseline 增长（确认粘贴写入了 reply 窗口）
  local delta=$((current_len - PASTE_BASELINE_LEN))
  if [[ $delta -le 0 ]]; then
    echo "verify: body length not increased (baseline=$PASTE_BASELINE_LEN, current=$current_len)" >&2
    return 1
  fi

  # 非 rich text 模式：要求 body 包含 reply_text 第一行的特征文本
  if [[ "$REPLY_TEXT" != "(rich text)" ]]; then
    local expected
    expected=$(printf '%s' "$REPLY_TEXT" | sed '/^[[:space:]]*$/d' | head -1 | sed 's/[*#>`~_\[()]//g' | cut -c1-30 | xargs)
    if [[ -n "$expected" && ${#expected} -gt 3 ]]; then
      if printf '%s' "$current_body" | grep -qF "$expected" 2>/dev/null; then
        return 0
      fi
      echo "verify: expected text not found in outgoing message body (expected: '$expected', delta=$delta)" >&2
      return 1
    fi
  fi

  # Rich text 模式或没有可校验文本：要求 delta 至少 20 字节，避免极短输入误判
  if [[ $delta -ge 20 ]]; then
    return 0
  fi

  echo "verify: body length increase too small (delta=$delta)" >&2
  return 1
}

# System Events 粘贴内容 + 验证 + 截图 + 保存关闭
paste_and_save() {
  local text="$1"
  local max_attempts=3
  local attempt=1

  # 唤醒显示器
  wake_display

  # 首次设置剪贴板（如果 handler 未预设）
  if [[ "$CLIPBOARD_READY" != "true" ]]; then
    printf '%s' "$text" | python3 "$SCRIPT_DIR/html_clipboard.py"
  fi

  while [[ $attempt -le $max_attempts ]]; do
    if [[ $attempt -gt 1 ]]; then
      echo "Paste retry attempt $attempt/$max_attempts" >&2
      wake_display
      reset_clipboard
    fi

    # 激活 Mail 并粘贴
    osascript <<'ASEOF'
tell application "Mail" to activate
delay 1.5
tell application "System Events"
  tell process "Mail"
    keystroke "v" using command down
  end tell
end tell
ASEOF
    sleep 1

    # 验证粘贴结果
    if verify_paste; then
      # 粘贴成功 — 截图、保存、关闭
      capture_screenshot
      osascript <<'ASEOF'
tell application "System Events"
  tell process "Mail"
    keystroke "s" using command down
    delay 1
    keystroke "w" using command down
  end tell
end tell
ASEOF
      sleep 1
      return 0
    fi

    attempt=$((attempt + 1))
  done

  echo "Paste verification failed after $max_attempts attempts" >&2
  return 1
}

# 输出结果 JSON
output_result() {
  local success="$1" method="$2" note="${3:-}"
  local ss_field=""
  if [[ "$SCREENSHOT" == "true" && -f "${SCREENSHOT_PATH:-}" ]]; then
    ss_field=",\"screenshot_path\":\"$SCREENSHOT_PATH\""
  fi
  local note_field=""
  [[ -n "$note" ]] && note_field=",\"note\":\"$(escape_as "$note")\""
  echo "{\"success\":${success},\"method\":\"${method}\"${ss_field}${note_field}}"
}

# ── Reply / Reply-All 模式（窗口 + 粘贴 + 唤醒屏幕 + 验证）──
do_reply() {
  local reply_flag="$1"  # "" 或 " and reply to all"
  local method_suffix="$2"

  # 转义变量
  local esc_account esc_mailbox
  esc_account="$(escape_as "$ACCOUNT")"
  esc_mailbox="$(escape_as "$AS_MAILBOX")"

  local extra_recip
  extra_recip="$(build_extra_recipients_script "$EXTRA_TO" "$EXTRA_CC")"

  # 方法 1: internal_id（快速 ~1s）
  if [[ -n "$INTERNAL_ID" && "$INTERNAL_ID" != "null" ]]; then
    RESULT=$(osascript -e "
      tell application \"Mail\"
        try
          set origMsg to first message of mailbox \"${esc_mailbox}\" of account \"${esc_account}\" whose id is ${INTERNAL_ID}
          set replyMsg to reply origMsg with opening window${reply_flag}
          ${extra_recip}
          return \"ok\"
        on error errMsg
          return \"error:\" & errMsg
        end try
      end tell
    " 2>&1)
    if [[ "$RESULT" == "ok" ]]; then
      sleep 2
      _REPLY_WINDOW_OPEN=true
      PASTE_BASELINE_LEN=$(get_outgoing_body_length)
      if [[ "$PASTE_BASELINE_LEN" -lt 0 ]]; then
        echo "baseline read failed (reply window not accessible via AppleScript)" >&2
        osascript -e 'tell application "Mail" to try
          close front window saving no
        end try' 2>/dev/null
        _REPLY_WINDOW_OPEN=false
        echo "{\"success\":false,\"method\":\"${method_suffix}_internal_id\",\"error\":\"Cannot read reply window body before paste (Mail state error)\"}"
        exit 1
      fi
      if paste_and_save "$(printf '%s' "$REPLY_TEXT")"; then
        _REPLY_WINDOW_OPEN=false
        output_result "true" "${method_suffix}_internal_id"
        return 0
      else
        # 粘贴验证失败 — 关闭窗口不保存
        osascript -e 'tell application "Mail" to try
          close front window saving no
        end try' 2>/dev/null
        _REPLY_WINDOW_OPEN=false
        echo "{\"success\":false,\"method\":\"${method_suffix}_internal_id\",\"error\":\"Paste verification failed after retries\"}"
        exit 1
      fi
    fi
    echo "internal_id failed: $RESULT" >&2
  fi

  # 方法 2: message_id（慢 ~100s）
  if [[ -n "$MESSAGE_ID" && "$MESSAGE_ID" != "null" ]]; then
    local esc_msgid
    esc_msgid="$(escape_as "$MESSAGE_ID")"
    RESULT=$(osascript -e "
      tell application \"Mail\"
        try
          set origMsg to first message of mailbox \"${esc_mailbox}\" of account \"${esc_account}\" whose message id is \"${esc_msgid}\"
          set replyMsg to reply origMsg with opening window${reply_flag}
          ${extra_recip}
          return \"ok\"
        on error errMsg
          return \"error:\" & errMsg
        end try
      end tell
    " 2>&1)
    if [[ "$RESULT" == "ok" ]]; then
      sleep 2
      _REPLY_WINDOW_OPEN=true
      PASTE_BASELINE_LEN=$(get_outgoing_body_length)
      if [[ "$PASTE_BASELINE_LEN" -lt 0 ]]; then
        echo "baseline read failed (reply window not accessible via AppleScript)" >&2
        osascript -e 'tell application "Mail" to try
          close front window saving no
        end try' 2>/dev/null
        _REPLY_WINDOW_OPEN=false
        echo "{\"success\":false,\"method\":\"${method_suffix}_message_id\",\"error\":\"Cannot read reply window body before paste (Mail state error)\"}"
        exit 1
      fi
      if paste_and_save "$(printf '%s' "$REPLY_TEXT")"; then
        _REPLY_WINDOW_OPEN=false
        output_result "true" "${method_suffix}_message_id"
        return 0
      else
        osascript -e 'tell application "Mail" to try
          close front window saving no
        end try' 2>/dev/null
        _REPLY_WINDOW_OPEN=false
        echo "{\"success\":false,\"method\":\"${method_suffix}_message_id\",\"error\":\"Paste verification failed after retries\"}"
        exit 1
      fi
    fi
    echo "message_id failed: $RESULT" >&2
  fi

  # Fallback: 降级为 new 模式
  echo "Reply fallback to new mode" >&2
  do_new "standalone_fallback"
}

# ── New 模式（独立草稿）──
do_new() {
  local method="${1:-new}"
  local esc_subject esc_reply esc_to esc_to_name
  esc_subject="$(escape_as "$SUBJECT")"
  esc_reply="$(escape_as "$REPLY_TEXT")"
  esc_to="$(escape_as "$TO_EMAIL")"
  esc_to_name="$(escape_as "$TO_NAME")"
  local cc_script
  cc_script="$(build_cc_script "$CC_EMAILS")"
  if [[ -n "$EXTRA_TO" ]]; then
    IFS=',' read -ra _ET <<< "$EXTRA_TO"
    for _a in "${_ET[@]}"; do
      _a="$(echo "$_a" | xargs)"
      [[ -n "$_a" ]] && cc_script+="
        make new to recipient at end of to recipients with properties {address:\"$(escape_as "$_a")\"}"
    done
  fi
  [[ -n "$EXTRA_CC" ]] && cc_script+="$(build_cc_script "$EXTRA_CC")"

  # new 模式主题自动加 Re: 前缀（如果是 fallback）
  local subj_prefix=""
  [[ "$method" == "standalone_fallback" ]] && subj_prefix="Re: "

  RESULT=$(osascript -e "
    tell application \"Mail\"
      try
        set newMsg to make new outgoing message with properties {subject:\"${subj_prefix}${esc_subject}\", content:\"${esc_reply}\", visible:true}
        tell newMsg
          make new to recipient at end of to recipients with properties {address:\"${esc_to}\", name:\"${esc_to_name}\"}
          ${cc_script}
        end tell
        activate
        return \"ok\"
      on error errMsg
        return \"error:\" & errMsg
      end try
    end tell
  " 2>&1)

  if [[ "$RESULT" == "ok" ]]; then
    sleep 2
    capture_screenshot
    # 保存并关闭
    osascript <<'EOF'
tell application "System Events"
  tell process "Mail"
    keystroke "s" using command down
    delay 1
    keystroke "w" using command down
  end tell
end tell
EOF
    sleep 1
    local note=""
    [[ "$method" == "standalone_fallback" ]] && note="Original email not found, created standalone draft"
    output_result "true" "$method" "$note"
    return 0
  fi

  echo "{\"success\":false,\"method\":\"$method\",\"error\":\"$(escape_as "$RESULT")\"}"
  exit 1
}

# ── 主逻辑 ──
case "$MODE" in
  reply-all)
    do_reply " and reply to all" "reply_all"
    ;;
  reply)
    do_reply "" "reply"
    ;;
  new)
    do_new "new"
    ;;
  *)
    echo "{\"success\":false,\"error\":\"Unknown mode: $MODE. Use reply-all, reply, or new\"}"
    exit 1
    ;;
esac
