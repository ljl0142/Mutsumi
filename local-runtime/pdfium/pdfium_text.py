import json
import math
import sys


def die(message):
    sys.stderr.write(message)
    sys.exit(1)


try:
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_raw
except Exception:
    die("pypdfium2 is not installed. Install it with: python -m pip install pypdfium2")


def normalize_text(text):
    if text == "\r" or text == "\n":
        return "\n"
    if text == "\x02" or text == "\ufffe":
        return ""
    return text


def viewport_box(left, bottom, right, top, page_width, page_height, scale, rotation):
    rotation = rotation % 360
    if rotation == 90:
        x1 = bottom * scale
        y1 = left * scale
        x2 = top * scale
        y2 = right * scale
    elif rotation == 180:
        x1 = (page_width - right) * scale
        y1 = bottom * scale
        x2 = (page_width - left) * scale
        y2 = top * scale
    elif rotation == 270:
        x1 = (page_height - top) * scale
        y1 = (page_width - right) * scale
        x2 = (page_height - bottom) * scale
        y2 = (page_width - left) * scale
    else:
        x1 = left * scale
        y1 = (page_height - top) * scale
        x2 = right * scale
        y2 = (page_height - bottom) * scale

    x = min(x1, x2)
    y = min(y1, y2)
    width = abs(x2 - x1)
    height = abs(y2 - y1)
    return {
        "x": x,
        "y": y,
        "width": max(width, 0.5 * scale),
        "height": max(height, 1.0 * scale),
    }


def get_char_text(textpage, index):
    try:
        codepoint = pdfium_raw.FPDFText_GetUnicode(textpage, index)
        if not codepoint:
            return ""
        return normalize_text(chr(codepoint))
    except Exception:
        return ""


def get_char_box(textpage, index):
    try:
        box = textpage.get_charbox(index)
    except TypeError:
        box = textpage.get_charbox(index, loose=True)

    if isinstance(box, tuple) or isinstance(box, list):
        return tuple(float(value) for value in box[:4])

    return (
        float(getattr(box, "left")),
        float(getattr(box, "bottom")),
        float(getattr(box, "right")),
        float(getattr(box, "top")),
    )


def build_text_model(textpage, page_width, page_height, scale, rotation):
    full_text = ""
    line_text_start = 0
    line_chars = []
    lines = []
    runs = []
    indexed_chars = []
    previous_was_newline = False

    def finish_line():
        nonlocal line_text_start, line_chars
        if line_chars:
            visual_groups = split_visual_lines(line_chars)
        else:
            visual_groups = []

        for visual_chars in visual_groups:
            line_start = min(item["index"] for item in visual_chars)
            line_end = max(item["index"] + 1 for item in visual_chars)
            text = full_text[line_start:line_end].strip()
            if not text:
                continue
            line_index = len(lines)
            normalized_chars = []
            for offset, item in enumerate(sorted(visual_chars, key=lambda value: value["index"])):
                box = {
                    **item,
                    "line": line_index,
                    "run": len(runs),
                    "offset": offset,
                }
                normalized_chars.append(box)
                indexed_chars.append(box)

            lines.append({
                "text": text,
                "top": min(item["y"] for item in normalized_chars),
                "bottom": max(item["y"] + item["height"] for item in normalized_chars),
                "left": min(item["x"] for item in normalized_chars),
                "right": max(item["x"] + item["width"] for item in normalized_chars),
                "start": line_start,
                "end": line_end,
                "line": line_index,
            })
            runs.append(make_run(len(runs), line_index, line_start, line_end, normalized_chars))
        line_text_start = len(full_text)
        line_chars = []

    for source_index in range(textpage.count_chars()):
        char = get_char_text(textpage, source_index)
        if not char:
            continue

        if char == "\n":
            if not previous_was_newline:
                finish_line()
                full_text += "\n"
                line_text_start = len(full_text)
            previous_was_newline = True
            continue

        previous_was_newline = False
        text_index = len(full_text)
        full_text += char

        if char.isspace():
            continue

        try:
            left, bottom, right, top = get_char_box(textpage, source_index)
        except Exception:
            continue

        if not all(math.isfinite(value) for value in (left, bottom, right, top)):
            continue

        box = viewport_box(left, bottom, right, top, page_width, page_height, scale, rotation)
        line_chars.append({
            "char": char,
            "index": text_index,
            "sourceIndex": source_index,
            **box,
        })

    finish_line()

    return {
        "text": full_text.rstrip(),
        "chars": indexed_chars,
        "lines": lines,
        "runs": runs,
    }


def split_visual_lines(chars):
    if len(chars) <= 1:
        return [chars]

    heights = sorted(item["height"] for item in chars if math.isfinite(item["height"]) and item["height"] > 0)
    median_height = heights[len(heights) // 2] if heights else 8
    threshold = max(2.0, median_height * 0.65)
    groups = []

    for char in sorted(chars, key=lambda item: item["y"] + item["height"] / 2):
        center = char["y"] + char["height"] / 2
        target = None
        for group in groups:
            group_centers = [item["y"] + item["height"] / 2 for item in group]
            group_center = sorted(group_centers)[len(group_centers) // 2]
            if abs(center - group_center) <= threshold:
                target = group
                break
        if target is None:
            groups.append([char])
        else:
            target.append(char)

    return [
        sorted(group, key=lambda item: item["index"])
        for group in sorted(groups, key=lambda group: min(item["y"] for item in group))
    ]


def make_run(run_id, line_index, start, end, chars):
    return {
        "id": run_id,
        "line": line_index,
        "text": "".join(item["char"] for item in chars),
        "start": start,
        "end": end,
        "left": min(item["x"] for item in chars),
        "right": max(item["x"] + item["width"] for item in chars),
        "top": min(item["y"] for item in chars),
        "bottom": max(item["y"] + item["height"] for item in chars),
        "chars": chars,
    }


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
    textpage = page.get_textpage()
    model = build_text_model(textpage, page_width, page_height, scale, rotation)
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
        **model,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
