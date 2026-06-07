import base64
import json
import sys

import pypdfium2 as pdfium

from pdfium_text import build_text_model


def die(message):
    sys.stderr.write(message)
    sys.exit(1)


def main():
    request = json.loads(sys.stdin.read() or "{}")
    pdf_path = request.get("pdfPath")
    page_number = int(request.get("page", 1))
    scale = float(request.get("scale", 1))
    rotation = int(request.get("rotation", 0))

    if not pdf_path:
        die("pdfPath is required")

    document = pdfium.PdfDocument(pdf_path)
    page = document[page_number - 1]
    page_width, page_height = page.get_size()
    bitmap = page.render(scale=scale, rotation=rotation)

    textpage = page.get_textpage()
    text_model = build_text_model(textpage, page_width, page_height, scale, rotation)

    if rotation % 180 == 0:
        width = page_width * scale
        height = page_height * scale
    else:
        width = page_height * scale
        height = page_width * scale

    print(json.dumps({
        "available": True,
        "page": page_number,
        "width": width,
        "height": height,
        "bitmap": {
            "data": base64.b64encode(bytes(bitmap.buffer)).decode("ascii"),
            "width": bitmap.width,
            "height": bitmap.height,
            "stride": bitmap.stride,
            "mode": bitmap.mode,
        },
        "textModel": {
            "available": True,
            "page": page_number,
            "width": width,
            "height": height,
            **text_model,
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
