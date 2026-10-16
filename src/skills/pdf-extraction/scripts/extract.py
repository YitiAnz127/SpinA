"""Read source PDF text/layout/tables; render sparse image pages for local OCR."""
import argparse
import json
import sys
from pathlib import Path

import pdfplumber
from pypdf import PdfReader


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf")
    parser.add_argument("--images", required=True)
    args = parser.parse_args()
    output = Path(args.images)
    output.mkdir(parents=True, exist_ok=True)
    fallback = None
    pages = []
    with pdfplumber.open(args.pdf) as pdf:
        for page in pdf.pages:
            warnings = []
            method = "pdfplumber"
            try:
                text = page.extract_text() or ""
                layout = (page.extract_text(layout=True) or "").strip()
            except Exception as error:
                if fallback is None:
                    fallback = PdfReader(args.pdf)
                text = fallback.pages[page.page_number - 1].extract_text() or ""
                layout = text
                method = "pypdf"
                warnings.append(f"pdfplumber text extraction failed; used pypdf: {error}")
            tables = []
            try:
                for table in page.find_tables():
                    rows = table.extract()
                    if len(rows) >= 2 and any(len(row) >= 2 for row in rows):
                        tables.append({"bbox": list(table.bbox), "rows": rows})
            except Exception as error:
                warnings.append(f"Table extraction failed; inspect the page image: {error}")
            item = {"number": page.page_number, "text": text.strip(), "layout_text": layout,
                    "tables": tables, "extraction_method": method}
            # Sparse text plus embedded images includes scanned pages in mixed PDFs.
            if len(text.strip()) < 30 and page.images:
                image = output / f"page-{page.page_number}.png"
                page.to_image(resolution=240).save(str(image))
                item["ocr_image"] = str(image)
            if warnings:
                item["warnings"] = warnings
            pages.append(item)
            page.close()
    print(json.dumps(pages, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"PDF extraction failed: {error}", file=sys.stderr)
        sys.exit(1)
