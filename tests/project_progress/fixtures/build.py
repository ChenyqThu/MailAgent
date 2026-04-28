"""从 v1 (单 sheet) 真实邮件附件抽 20 行 ENBU 子集作为 xlsx test fixture.

不应提交包含真实业务数据的 xlsx (.gitignore 已屏蔽 sample_*.xlsx).
本脚本在本地开发者机器上跑一次, 生成 sample_enbu.xlsx 到 fixtures/.

Usage:
    python tests/project_progress/fixtures/build.py
"""

import hashlib
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(ROOT))

# 默认源 xlsx 路径; 用户可设环境变量 V1_SRC_XLSX 覆盖
import os
SRC_XLSX = Path(os.environ.get("V1_SRC_XLSX", str(ROOT / "data" / "_probe_tmp" / "v1-source.xlsx")))
OUT = Path(__file__).parent / "sample_enbu.xlsx"


def main() -> int:
    if not SRC_XLSX.exists():
        print(
            f"ERROR: source xlsx not found at {SRC_XLSX}\n"
            "Set V1_SRC_XLSX env var to a v1-format xlsx (single 'Project  Ongoing' sheet) "
            "or place one at the default path."
        )
        return 1
    df = pd.read_excel(SRC_XLSX, sheet_name="Project  Ongoing", engine="calamine")
    enbu = df[df["BU"] == "TPS-ENBU"].head(20).copy()
    with pd.ExcelWriter(OUT, engine="openpyxl") as writer:
        enbu.to_excel(writer, sheet_name="Project  Ongoing", index=False)
    md5 = hashlib.md5(OUT.read_bytes()).hexdigest()
    print(f"Wrote {OUT} ({OUT.stat().st_size} bytes, md5={md5[:8]}…)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
