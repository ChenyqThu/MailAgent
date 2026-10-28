#!/usr/bin/env bash
# 重新生成 DavMail token 加密的 golden 样本，并让 DavMail 自己读回 Python 写出的 token 文件。
# 只用 GenGolden.java 里的假字符串，绝不碰真实 token。
#
#   bash tests/mail/davmail_golden/regen.sh [davmail-jar-目录，默认 davmail-poc/jar]
#
# 产物：本目录的 golden.properties、token.dat（提交进仓库，由 test_davmail_reauth.py 读取）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
JAR_DIR="${1:-$REPO/davmail-poc/jar}"
CP="$JAR_DIR/davmail.jar:$JAR_DIR/lib/*"

java -cp "$CP" "$HERE/GenGolden.java" generate "$HERE"

# 反方向：Python 加密 + 写 token 文件 → DavMail 的 Settings.loadRefreshToken + StringEncryptor 读回
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"$REPO/venv/bin/python" - "$HERE/golden.properties" "$TMP/token.dat" <<'EOF'
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]).resolve().parents[3]))
from src.mail.davmail_reauth import _split_line, encrypt_token, write_token_file

props = dict(p for p in map(_split_line, Path(sys.argv[1]).read_text("latin-1").splitlines()) if p)
write_token_file(Path(sys.argv[2]), props["username"], encrypt_token(props["plain.long"], props["password"]))
EOF
GOLDEN_USER="$(grep '^username=' "$HERE/golden.properties" | cut -d= -f2)"
GOLDEN_PASS="$(grep '^password=' "$HERE/golden.properties" | cut -d= -f2)"
java -cp "$CP" "$HERE/GenGolden.java" verify "$TMP/token.dat" "$GOLDEN_USER" "$GOLDEN_PASS" \
  "0.FAKE-REFRESH-TOKEN.mailagent-golden_sample~not-a-real-secret/AbCdEf+123="
