"""Synthetic sources with known text, a ruled table, and an image-only page."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject


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
image = Image.new("RGB", (1600, 1000), "white")
draw = ImageDraw.Draw(image)
font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 48)
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

image = Image.new("RGB", (1600, 1000), "white")
draw = ImageDraw.Draw(image)
font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 64)
draw.text((70, 120), "样品加热两小时", font=font, fill="black")
draw.text((70, 240), "Sample B prepared at 500 C for 2 hours.", font=ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 48), fill="black")
image.save(directory / "scanned-cn.pdf", "PDF", resolution=120)
