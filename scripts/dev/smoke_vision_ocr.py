"""PR-G smoke：真跑 macOS Vision OCR 一次（manual，不进 CI）。

生成一张含中英文字的图片 + 一份无文本层扫描件 PDF，经 `src.converter.vision_ocr`
真识别，打印结果。验证 pyobjc Vision/Quartz 桥 + 逐页渲染 + accurate 中英识别全链路。

  venv/bin/python scripts/dev/smoke_vision_ocr.py
"""

import tempfile
from pathlib import Path

from src.converter import vision_ocr


def _font(size: int):
    from PIL import ImageFont

    for fp in ("/System/Library/Fonts/PingFang.ttc",
               "/System/Library/Fonts/STHeiti Medium.ttc"):
        if Path(fp).exists():
            return ImageFont.truetype(fp, size)
    return None


def main() -> None:
    from PIL import Image, ImageDraw

    print(f"[smoke] ocr_available = {vision_ocr.ocr_available()}")
    if not vision_ocr.ocr_available():
        print("[smoke] Vision 不可用（缺 pyobjc？）— 退出")
        return

    # --- 1. 图片 OCR ---
    img = Image.new("RGB", (1000, 260), "white")
    draw = ImageDraw.Draw(img)
    font = _font(48)
    draw.text((30, 40), "合同条款 Redis timeout 配置", fill="black", font=font)
    draw.text((30, 150), "Hello World 项目评审 2026", fill="black", font=font)
    png = Path(tempfile.mktemp(suffix=".png"))
    img.save(png)
    print("\n[smoke] 图片 OCR (ocr_image_file):")
    print(vision_ocr.ocr_image_file(png))
    png.unlink(missing_ok=True)

    # --- 2. 扫描件 PDF OCR（PIL 存 PDF = 光栅化，无文本层）---
    pdf_img = Image.new("RGB", (1200, 400), "white")
    ImageDraw.Draw(pdf_img).text(
        (40, 120), "扫描件测试 Scanned invoice OCR 12345",
        fill="black", font=_font(56),
    )
    pdf = Path(tempfile.mktemp(suffix=".pdf"))
    pdf_img.save(pdf, "PDF", resolution=150.0)
    print("\n[smoke] 扫描件 PDF OCR (ocr_pdf_file):")
    out = vision_ocr.ocr_pdf_file(pdf)
    if out is None:
        print("  → None（渲染/OCR 失败）")
    else:
        text, truncated = out
        print(f"  truncated={truncated}\n{text}")
    pdf.unlink(missing_ok=True)

    print("\n[smoke] OK — Vision 图片 + Quartz 渲染扫描件 PDF 全链路通")


if __name__ == "__main__":
    main()
