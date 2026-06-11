import base64
import json
import sys

import pypdfium2 as pdfium

from pdfium_text import build_text_model


def parse_color(value):
    if not isinstance(value, str):
        return (255, 230, 111)
    value = value.strip()
    if value.startswith("#"):
        value = value[1:]
    if len(value) != 6:
        return (255, 230, 111)
    try:
        return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))
    except ValueError:
        return (255, 230, 111)


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def blend_highlights(buffer, width, height, stride, mode, annotations):
    if not annotations:
        return buffer

    channels = 4 if mode in ("RGBA", "BGRA", "RGBx", "BGRx") else 3
    if mode not in ("RGB", "BGR", "RGBA", "BGRA", "RGBx", "BGRx"):
        return buffer

    alpha = 0.62
    for annotation in annotations:
        if annotation.get("style") != "highlight":
            continue
        red, green, blue = parse_color(annotation.get("color"))
        factors = {
            "R": 1 - alpha + alpha * (red / 255),
            "G": 1 - alpha + alpha * (green / 255),
            "B": 1 - alpha + alpha * (blue / 255),
        }
        for rect in annotation.get("rects", []):
            left = clamp(int(float(rect.get("x", 0)) * width), 0, width)
            top = clamp(int(float(rect.get("y", 0)) * height), 0, height)
            right = clamp(int((float(rect.get("x", 0)) + float(rect.get("width", 0))) * width + 0.999), 0, width)
            bottom = clamp(int((float(rect.get("y", 0)) + float(rect.get("height", 0))) * height + 0.999), 0, height)
            if right <= left or bottom <= top:
                continue

            for y in range(top, bottom):
                row = y * stride
                for x in range(left, right):
                    offset = row + x * channels
                    if mode in ("RGBA", "RGBx"):
                        indices = {"R": offset, "G": offset + 1, "B": offset + 2}
                    elif mode in ("BGRA", "BGRx"):
                        indices = {"B": offset, "G": offset + 1, "R": offset + 2}
                    elif mode == "RGB":
                        indices = {"R": offset, "G": offset + 1, "B": offset + 2}
                    else:
                        indices = {"B": offset, "G": offset + 1, "R": offset + 2}

                    for channel, index in indices.items():
                        buffer[index] = int(buffer[index] * factors[channel])

    return buffer


def die(message):
    sys.stderr.write(message)
    sys.exit(1)


def main():
    request = json.loads(sys.stdin.read() or "{}")
    pdf_path = request.get("pdfPath")
    page_number = int(request.get("page", 1))
    scale = float(request.get("scale", 1))
    rotation = int(request.get("rotation", 0))
    annotations = request.get("annotations", [])

    if not pdf_path:
        die("pdfPath is required")

    document = pdfium.PdfDocument(pdf_path)
    page = document[page_number - 1]
    page_width, page_height = page.get_size()
    bitmap = page.render(scale=scale, rotation=rotation)
    bitmap_buffer = blend_highlights(
        bytearray(bytes(bitmap.buffer)),
        bitmap.width,
        bitmap.height,
        bitmap.stride,
        bitmap.mode,
        annotations if isinstance(annotations, list) else [],
    )

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
            "data": base64.b64encode(bytes(bitmap_buffer)).decode("ascii"),
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
