#!/usr/bin/env bash
# build-python-venv.sh — 构建可重定位的嵌入式 CPython 后端运行时 (打包 P1-1)。
#
# 为什么用 python-build-standalone 而不是 `python3 -m venv`:
#   普通 venv 把 base 解释器的绝对路径硬编码进 pyvenv.cfg + bin/python 符号链接,
#   拷进 .app (路径变化) 即失效。python-build-standalone 的 install_only 构建是
#   自包含、可重定位的 CPython, 把后端依赖装进它的 site-packages 即可随 .app 分发。
#
# 产物: frontend/resources/python/  (bin/python3.11 + bin/mailagent + lib/site-packages 含 src/)
#   - 经 electron-builder extraResources 注入到 .app/Contents/Resources/python/
#   - 运行时经解释器调用 (python3 bin/mailagent) 绕过 console script 绝对 shebang
#
# 用法: frontend/scripts/build-python-venv.sh [arm64|x64]   (默认 arm64)
set -euo pipefail

ARCH="${1:-arm64}"
PBS_TAG="20260510"            # python-build-standalone release tag
PYVER="3.11.15"
case "$ARCH" in
  arm64) PBS_TRIPLE="aarch64-apple-darwin" ;;
  x64)   PBS_TRIPLE="x86_64-apple-darwin" ;;
  *) echo "[build-python-venv] 未知 arch: $ARCH (支持 arm64|x64)" >&2; exit 2 ;;
esac

FRONTEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND_DIR/.." && pwd)"
OUT="$FRONTEND_DIR/resources/python"
CACHE="$FRONTEND_DIR/.cache/pbs"
TARBALL="cpython-${PYVER}+${PBS_TAG}-${PBS_TRIPLE}-install_only.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${TARBALL}"

echo "[build-python-venv] arch=$ARCH py=$PYVER out=$OUT"

# 1. 下载 standalone CPython (带缓存)
mkdir -p "$CACHE"
if [ ! -f "$CACHE/$TARBALL" ]; then
  echo "[build-python-venv] 下载 $TARBALL ..."
  curl -fSL --retry 3 -o "$CACHE/$TARBALL.tmp" "$URL"
  mv "$CACHE/$TARBALL.tmp" "$CACHE/$TARBALL"
else
  echo "[build-python-venv] 命中缓存 $CACHE/$TARBALL"
fi

# 2. 解出到 resources/ (tarball 顶层就是 python/)
rm -rf "$OUT"
mkdir -p "$FRONTEND_DIR/resources"
tar -xzf "$CACHE/$TARBALL" -C "$FRONTEND_DIR/resources"
PYBIN="$OUT/bin/python3.11"
[ -x "$PYBIN" ] || { echo "[build-python-venv] 解压后未找到 $PYBIN" >&2; exit 1; }

# 3. 装后端依赖 (核心依赖在 requirements.txt, 不在 pyproject [project.dependencies])
echo "[build-python-venv] pip install requirements + .[cli] ..."
"$PYBIN" -m pip install --upgrade pip -q
"$PYBIN" -m pip install -q -r "$REPO_ROOT/requirements.txt"
# 非 editable 安装: 把 src/ (含 src/service.py) 复制进 site-packages, 并生成 bin/mailagent
( cd "$REPO_ROOT" && "$PYBIN" -m pip install -q ".[cli]" )
# 清理 setuptools 在仓库根留下的 bdist 产物 (egg-info 已被 .gitignore 忽略, build/ 也忽略但顺手清掉)
rm -rf "$REPO_ROOT/build"

# 3.5 把 pip 生成的 console script (绝对 shebang, 不可重定位) 换成自定位 sh wrapper。
#     pip 生成的 bin/mailagent shebang 写死构建机的 python3.11 绝对路径, 拷进 .app
#     (路径变化) 即失效。改成 #!/bin/sh wrapper: 算出自身目录 → exec 同目录 python3.11
#     跑 CLI 入口, 与 .app 实际落点无关; 且保持前端 execa(mailagentBin, args) 调用约定不变。
cat > "$OUT/bin/mailagent" <<'WRAPPER'
#!/bin/sh
# 自定位 launcher (打包可重定位) —— 由 build-python-venv.sh 生成, 勿手改。
# -B: 禁写 .pyc。签名后的 .app 是 sealed bundle, 运行时往 Resources 写 __pycache__ 会
#   破坏 codesign 签名 (实测 verify 报 "file modified: ...pyc")。
# -P (Python 3.11+): 禁止把 cwd 加入 sys.path。否则 serve 以 cwd=DATA_ROOT 运行时,
#   若该目录 (或调用方 cwd) 含 src/ 目录会遮蔽 bundle site-packages 里的后端 src 包,
#   导致 import 到错误/旧代码 (实测: cwd=老仓库根时 serve 子命令消失)。
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/python3.11" -B -P -c "from src.cli.main import app; app(prog_name='mailagent')" "$@"
WRAPPER
chmod +x "$OUT/bin/mailagent"

# 4. 瘦身 (去测试/缓存/不需要的 stdlib 子树)
find "$OUT" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT" -type f -name "*.pyc" -delete 2>/dev/null || true
rm -rf "$OUT/lib/python3.11/test" "$OUT/lib/python3.11/idlelib" \
       "$OUT/lib/python3.11/tkinter" "$OUT/lib/python3.11/turtledemo" 2>/dev/null || true

# 5. 自检: 经 wrapper (sh → python3.11 → CLI) 跑通, 验证可重定位调用链。
#    注: src.config 有模块级 config=Config() 单例, import 即需必填字段; 构建环境无
#    .env, 故注入 dummy env 让单例构造成功 (仅自检用, 不写入产物)。
echo "[build-python-venv] 自检 (经 wrapper 跑 mailagent --help) ..."
NOTION_TOKEN=_smoke EMAIL_DATABASE_ID=_smoke USER_EMAIL=smoke@example.com \
  "$OUT/bin/mailagent" --help >/dev/null \
  || { echo "[build-python-venv] 自检失败: mailagent wrapper 调用链不通" >&2; exit 1; }
echo "  wrapper + CLI import 链 OK"

echo "[build-python-venv] 完成: $OUT ($(du -sh "$OUT" | cut -f1))"
