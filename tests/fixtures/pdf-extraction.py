"""Synthetic sources with known text, a ruled table, and an image-only page."""
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

# Fixture fonts must not assume one OS. The first existing candidate wins; the
# caller reads the printed JSON to skip cases this machine cannot render.
LATIN_FONTS = [
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
]
CJK_FONTS = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
]


def pick_font(candidates, size):
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return None


def text_at(x, y, text):
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"BT /F1 12 Tf {x} {y} Td ({escaped}) Tj ET"


def digital_pdf(path, commands):
    writer = PdfWriter()
    page = writer.add_blank_page(width=595, height=842)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    content = DecodedStreamObject()
    content.set_data("\n".join(commands).encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(content)
    writer.write(path)

directory = Path(sys.argv[1])
latin_font = pick_font(LATIN_FONTS, 48)
font = latin_font or ImageFont.load_default()
image = Image.new("RGB", (1600, 1000), "white")
draw = ImageDraw.Draw(image)
draw.text((70, 120), "Sample B: NiFe2O4 prepared at 500 C", font=font, fill="black")
draw.text((70, 210), "for 2 hours using nickel and iron salts.", font=font, fill="black")
image.save(directory / "scanned.pdf", "PDF", resolution=120)

commands = [text_at(50, 770, "Preparation conditions for synthetic spinel samples")]
for x in [50, 170, 320]:
    commands.append(f"{x} 590 m {x} 680 l S")
for y in [590, 620, 650, 680]:
    commands.append(f"50 {y} m 320 {y} l S")
for y, cells in [(661, ["Sample", "Temperature"]), (631, ["A", "400 C"]), (601, ["B", "500 C"])]:
    for x, text in zip([60, 180], cells):
        commands.append(text_at(x, y, text))
digital_pdf(directory / "digital.pdf", commands)
writer = PdfWriter()
writer.append(directory / "digital.pdf")
writer.append(directory / "scanned.pdf")
writer.write(directory / "mixed.pdf")

digital_pdf(directory / "numbered-si.pdf", [text_at(20, 800 - index * 20, str(index)) for index in range(1, 10)] + [text_at(20, 600, "10 Supporting Information"), text_at(20, 575, "11 Preparation conditions for synthetic samples.")])

image = Image.new("RGB", (1600, 1000), "white")
draw = ImageDraw.Draw(image)
draw.text((70, 120), "Supporting Information", font=font, fill="black")
draw.text((70, 210), "Synthetic preparation details for sample B.", font=font, fill="black")
image.save(directory / "scanned-si.pdf", "PDF", resolution=120)

cjk_font = pick_font(CJK_FONTS, 64)
if cjk_font:
    image = Image.new("RGB", (1600, 1000), "white")
    draw = ImageDraw.Draw(image)
    draw.text((70, 120), "样品加热两小时", font=cjk_font, fill="black")
    draw.text((70, 240), "Sample B prepared at 500 C for 2 hours.", font=font, fill="black")
    image.save(directory / "scanned-cn.pdf", "PDF", resolution=120)

print(json.dumps({"latin": latin_font is not None, "cjk": cjk_font is not None}))
