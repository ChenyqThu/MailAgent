"""从 Evelyn internal_id 51793 的邮件抽 20 行 ENBU 子集作为 xlsx test fixture。

不应提交包含真实业务数据的 xlsx。本脚本在本地开发者机器上跑一次，
生成 sample_enbu.xlsx 到 gitignore 之外的位置（或手动 gitignore）。

Usage:
    python tests/evelyn_project/fixtures/build.py
"""

import hashlib
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(ROOT))

SRC_XLSX = ROOT / "data" / "_probe_tmp" / "evelyn-51793.xlsx"
OUT = Path(__file__).parent / "sample_enbu.xlsx"


def main() -> int:
    if not SRC_XLSX.exists():
        print(
            f"ERROR: source xlsx not found at {SRC_XLSX}\n"
            "先手动运行本项目 CLI 拉取一次 Evelyn 邮件让文件生成，"
            "或将你手上的 xlsx 放到该路径。"
        )
        return 1
    df = pd.read_excel(SRC_XLSX, sheet_name="Project  Ongoing", engine="calamine")
    enbu = df[df["BU"] == "TPS-ENBU"].head(20).copy()
    # 写出 fixture
    with pd.ExcelWriter(OUT, engine="openpyxl") as writer:
        enbu.to_excel(writer, sheet_name="Project  Ongoing", index=False)
    md5 = hashlib.md5(OUT.read_bytes()).hexdigest()
    print(f"Wrote {OUT} ({OUT.stat().st_size} bytes, md5={md5[:8]}…)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
