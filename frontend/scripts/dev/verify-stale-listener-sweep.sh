#!/usr/bin/env bash
# 手工复现: 启动自愈 stale-listener sweep 的真实 OS 行为验证 (L4, fork 02fa941c 半取)。
#
# vitest 单测把 lsof/ps/kill 全 mock 了; 本脚本验证被 mock 掉的真实系统假设:
#   1. `lsof -ti tcp:<port> -sTCP:LISTEN` 能拿到监听者 pid;
#   2. macOS `ps -o command=` 输出完整命令行 (不截断) 且含归属 marker;
#   3. SIGTERM→短等→SIGKILL 序列真实可回收进程 + 端口释放;
#   4. 负样本 (无 marker 的 listener) 被正确判定为「不清理」。
#
# 全程用非生产端口 (19200/19201/19202), 绝不碰真实 8200/9200。
# 用法: bash frontend/scripts/dev/verify-stale-listener-sweep.sh
set -u

MARKER="prog_name='mailagent'"
POS_PORT=19200   # 正样本 A: 含 marker + 响应 SIGTERM
STUB_PORT=19201  # 正样本 B: 含 marker + 无视 SIGTERM (模拟 graceful >11s 的孤儿)
NEG_PORT=19202   # 负样本: 无 marker 的无关 listener

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

POS_PID='' STUB_PID='' NEG_PID=''
cleanup() {
  for p in "$POS_PID" "$STUB_PID" "$NEG_PID"; do
    [ -n "$p" ] && kill -KILL "$p" 2>/dev/null
  done
}
trap cleanup EXIT

# 起一个假 listener 并等它 bind 完成; $1=port $2=extra python 头部代码 (如 SIGTERM 屏蔽)
start_fake_listener() {
  local port="$1" extra="${2:-pass}"
  # 命令行刻意模仿打包 wrapper 形状 (python … -c "… app(prog_name='mailagent') …"),
  # marker 落在与真实 wrapper 相近的偏移, 顺带验证 ps 不截断。
  # 🔴 stdio 必须重定向走: 本函数经 $(…) 命令替换调用, 后台进程若继承替换管道的
  # stdout, 管道不关 → $(…) 阻塞到 python 600s 退出 (实测踩过)。
  python3 -c "
# fake stale MailAgent backend for sweep verification -- app(prog_name='mailagent') serve
import socket, time, signal
$extra
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', $port))
s.listen(1)
time.sleep(600)
" >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 50); do
    lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.1
  done
  echo "$pid"
}

echo "== 1. 正样本 A: lsof 定位 + ps 命令行/marker/截断 =="
POS_PID=$(start_fake_listener "$POS_PORT")
LSOF_PID=$(lsof -ti "tcp:$POS_PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ "$LSOF_PID" = "$POS_PID" ]; then
  ok "lsof -ti tcp:$POS_PORT -sTCP:LISTEN → pid=$LSOF_PID (= 我们起的 $POS_PID)"
else
  bad "lsof pid=$LSOF_PID != spawned pid=$POS_PID"
fi
CMDLINE=$(ps -o command= -p "$POS_PID" 2>/dev/null || true)
echo "  ps 命令行长度: ${#CMDLINE} chars"
case "$CMDLINE" in
  *"$MARKER"*) ok "ps -o command= 含 marker (未截断, marker 完整可匹配)" ;;
  *) bad "ps 输出不含 marker (截断/异常?): $CMDLINE" ;;
esac

echo "== 2. 正样本 A: SIGTERM 短等回收 (graceful 路径) =="
kill -TERM "$POS_PID"
for _ in 1 2 3 4 5; do kill -0 "$POS_PID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$POS_PID" 2>/dev/null; then
  bad "SIGTERM 500ms 内未回收 (python 默认应立即死)"
else
  ok "SIGTERM 短等 (≤500ms) 内进程回收, 无需 SIGKILL"
fi
if lsof -ti "tcp:$POS_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  bad "端口 $POS_PORT 未释放"
else
  ok "端口 $POS_PORT 已释放"
fi
POS_PID=''

echo "== 3. 正样本 B: 无视 SIGTERM 的孤儿 → SIGKILL 升级路径 =="
STUB_PID=$(start_fake_listener "$STUB_PORT" "signal.signal(signal.SIGTERM, signal.SIG_IGN)")
kill -TERM "$STUB_PID"
for _ in 1 2 3 4 5; do kill -0 "$STUB_PID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$STUB_PID" 2>/dev/null; then
  ok "SIGTERM 被无视 (模拟 graceful >11s 孤儿), 按策略升级 SIGKILL"
  kill -KILL "$STUB_PID"
  for _ in $(seq 1 10); do kill -0 "$STUB_PID" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$STUB_PID" 2>/dev/null; then
    bad "SIGKILL 1s 内未回收"
  else
    ok "SIGKILL 后进程回收 + 端口 $STUB_PORT 释放: $(lsof -ti tcp:$STUB_PORT -sTCP:LISTEN 2>/dev/null || echo '无监听者')"
  fi
else
  bad "SIGTERM 竟然生效了 (SIG_IGN 未安装?)"
fi
STUB_PID=''

echo "== 4. 负样本: 无 marker 的 listener → 判定为不清理 =="
python3 -m http.server "$NEG_PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
NEG_PID=$!
for _ in $(seq 1 50); do
  lsof -ti "tcp:$NEG_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.1
done
NEG_CMD=$(ps -o command= -p "$NEG_PID" 2>/dev/null || true)
case "$NEG_CMD" in
  *"$MARKER"*) bad "负样本命令行竟含 marker: $NEG_CMD" ;;
  *) ok "负样本 (pid=$NEG_PID, '$NEG_CMD') 无 marker → sweep 会跳过不 kill" ;;
esac
kill -KILL "$NEG_PID" 2>/dev/null
wait "$NEG_PID" 2>/dev/null # 收尸, 顺带压掉 bash 的 "Killed: 9" job-control 噪音
NEG_PID=''

echo "== 5. 无监听者常态: lsof 非零退出 =="
if lsof -ti "tcp:$POS_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  bad "端口 $POS_PORT 应无监听者"
else
  ok "空端口 lsof exit=$? (非零, sweep 按常态跳过, 零耗时)"
fi

echo
echo "结果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
