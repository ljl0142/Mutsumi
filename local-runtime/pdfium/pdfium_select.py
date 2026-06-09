import json
import math
import sys

from pdfium_text import get_char_box, viewport_box


def die(message):
    sys.stderr.write(message)
    sys.exit(1)


try:
    import pypdfium2 as pdfium
except Exception:
    die("pypdfium2 is not installed. Install it with: python -m pip install pypdfium2")


def page_point_from_viewport(point, page_width, page_height, scale, rotation):
    x = float(point.get("x", 0)) / scale
    y = float(point.get("y", 0)) / scale
    rotation = rotation % 360
    if rotation == 90:
        return y, x
    if rotation == 180:
        return page_width - x, y
    if rotation == 270:
        return page_width - y, page_height - x
    return x, page_height - y


def text_axis_from_viewport(point, box, rotation):
    rotation = rotation % 360
    if rotation in (90, 270):
        return point["y"], box["y"], box["height"]
    return point["x"], box["x"], box["width"]


def boundary_index(textpage, raw_index, point, page_width, page_height, scale, rotation):
    if raw_index is None or raw_index < 0:
        return None
    try:
        left, bottom, right, top = get_char_box(textpage, raw_index)
    except Exception:
        return raw_index
    if not all(math.isfinite(value) for value in (left, bottom, right, top)):
        return raw_index

    box = viewport_box(left, bottom, right, top, page_width, page_height, scale, rotation)
    axis, start, size = text_axis_from_viewport(point, box, rotation)
    if size <= 0:
        return raw_index
    return raw_index + 1 if axis >= start + size / 2 else raw_index


def clean_text(text):
    return (
        text.replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\ufffe", "")
        .replace("\x02", "")
        .strip()
    )


def main():
    request = json.loads(sys.stdin.read() or "{}")
    pdf_path = request.get("pdfPath")
    page_number = int(request.get("page", 1))
    scale = float(request.get("scale", 1))
    rotation = int(request.get("rotation", 0))
    start_point = request.get("start")
    end_point = request.get("end")

    if not pdf_path:
        die("pdfPath is required")
    if not start_point or not end_point:
        die("start and end points are required")

    document = pdfium.PdfDocument(pdf_path)
    page = document[page_number - 1]
    page_width, page_height = page.get_size()
    textpage = page.get_textpage()

    start_page = page_point_from_viewport(start_point, page_width, page_height, scale, rotation)
    end_page = page_point_from_viewport(end_point, page_width, page_height, scale, rotation)
    tolerance = max(2.0, 3.0 / scale)
    start_raw = textpage.get_index(start_page[0], start_page[1], tolerance, tolerance)
    end_raw = textpage.get_index(end_page[0], end_page[1], tolerance, tolerance)

    start_boundary = boundary_index(textpage, start_raw, start_point, page_width, page_height, scale, rotation)
    end_boundary = boundary_index(textpage, end_raw, end_point, page_width, page_height, scale, rotation)
    if start_boundary is None or end_boundary is None:
        print(json.dumps({"available": True, "page": page_number, "empty": True}, ensure_ascii=False))
        return

    start = min(start_boundary, end_boundary)
    end = max(start_boundary, end_boundary)
    if end <= start:
        end = min(textpage.count_chars(), start + 1)
    count = end - start
    text = clean_text(textpage.get_text_range(start, count))

    rects = []
    for rect_index in range(textpage.count_rects(start, count)):
        left, bottom, right, top = textpage.get_rect(rect_index)
        if not all(math.isfinite(value) for value in (left, bottom, right, top)):
            continue
        box = viewport_box(left, bottom, right, top, page_width, page_height, scale, rotation)
        rects.append(box)

    print(json.dumps({
        "available": True,
        "page": page_number,
        "empty": not text or not rects,
        "text": text,
        "start": start,
        "end": end,
        "rects": rects,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
