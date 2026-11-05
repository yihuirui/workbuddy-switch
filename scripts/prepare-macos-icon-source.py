#!/usr/bin/env python3
"""Create a reproducible antialiased macOS squircle from the unmasked artwork."""
from __future__ import annotations

import hashlib
import json
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "src-tauri/icons/account-switch"
SOURCE = ICON_DIR / "icon-source-20261031.png"
OUTPUT = ICON_DIR / "icon-source-macos-rounded-20261031.png"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
CORNER_RATIO = 0.2237
ANTIALIAS_SAMPLES = 4


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def decode_rgb_png(path: pathlib.Path) -> tuple[int, int, list[bytes]]:
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise SystemExit(f"Not a PNG file: {path}")
    width = height = bit_depth = color_type = interlace = None
    compressed: list[bytes] = []
    offset = len(PNG_SIGNATURE)
    while offset + 12 <= len(data):
        size = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + size]
        if len(payload) != size:
            raise SystemExit(f"Truncated PNG chunk in {path}")
        if kind == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", payload
            )
            if compression or filtering:
                raise SystemExit(f"Unsupported PNG compression/filter mode in {path}")
        elif kind == b"IDAT":
            compressed.append(payload)
        elif kind == b"IEND":
            break
        offset += size + 12
    if width is None or bit_depth != 8 or color_type != 2 or interlace:
        raise SystemExit(f"Expected an 8-bit non-interlaced RGB PNG: {path}")

    stride = width * 3
    packed = zlib.decompress(b"".join(compressed))
    if len(packed) != height * (stride + 1):
        raise SystemExit(f"Unexpected PNG pixel data size in {path}")
    rows: list[bytes] = []
    previous = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        filter_type = packed[start]
        row = bytearray(packed[start + 1 : start + 1 + stride])
        for x in range(stride):
            left = row[x - 3] if x >= 3 else 0
            above = previous[x]
            upper_left = previous[x - 3] if x >= 3 else 0
            if filter_type == 1:
                row[x] = (row[x] + left) & 0xFF
            elif filter_type == 2:
                row[x] = (row[x] + above) & 0xFF
            elif filter_type == 3:
                row[x] = (row[x] + (left + above) // 2) & 0xFF
            elif filter_type == 4:
                row[x] = (row[x] + paeth(left, above, upper_left)) & 0xFF
            elif filter_type != 0:
                raise SystemExit(f"Unsupported PNG row filter {filter_type} in {path}")
        rows.append(bytes(row))
        previous = row
    return width, height, rows


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)


def encode_rgba(width: int, height: int, rows: list[bytes]) -> bytes:
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    pixels = b"".join(b"\x00" + row for row in rows)
    return (
        PNG_SIGNATURE
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(pixels, level=9))
        + png_chunk(b"IEND", b"")
    )


def corner_alpha(x: int, y: int, width: int, height: int, radius: float) -> int:
    samples = ANTIALIAS_SAMPLES
    inside = 0
    left = x < radius
    top = y < radius
    scale = radius**2
    for sy in range(samples):
        py = y + (sy + 0.5) / samples
        local_y = py if top else height - py
        for sx in range(samples):
            px = x + (sx + 0.5) / samples
            local_x = px if left else width - px
            if local_x >= radius or local_y >= radius:
                inside += 1
                continue
            dx = radius - local_x
            dy = radius - local_y
            if dx**2 + dy**2 <= scale:
                inside += 1
    total = samples * samples
    return (inside * 255 + total // 2) // total


def main() -> int:
    width, height, source_rows = decode_rgb_png(SOURCE)
    if width != height:
        raise SystemExit("macOS app icon artwork must be square.")
    radius = min(width, height) * CORNER_RATIO
    extent = int(radius) + 1
    output_rows: list[bytes] = []
    transparent = partial = black_transparent = 0
    output_rgb_rows: list[bytes] = []

    for y, source_row in enumerate(source_rows):
        rgba = bytearray(width * 4)
        rgb_row = bytearray(width * 3)
        in_corner_row = y < extent or y >= height - extent
        for x in range(width):
            r, g, b = source_row[x * 3 : x * 3 + 3]
            if in_corner_row and (x < extent or x >= width - extent):
                alpha = corner_alpha(x, y, width, height, radius)
            else:
                alpha = 255
            p = x * 4
            rgba[p : p + 4] = bytes((r, g, b, alpha))
            rgb_row[x * 3 : x * 3 + 3] = bytes((r, g, b))
            transparent += alpha == 0
            partial += 0 < alpha < 255
            black_transparent += alpha == 0 and r == g == b == 0
        output_rows.append(bytes(rgba))
        output_rgb_rows.append(bytes(rgb_row))

    corners = [
        output_rows[y][x * 4 : x * 4 + 4]
        for x, y in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1))
    ]
    top_center_alpha = output_rows[0][(width // 2) * 4 + 3]
    if any(corner[3] != 0 for corner in corners):
        raise SystemExit(f"Rounded source has a non-transparent corner: {corners}")
    if top_center_alpha != 255:
        raise SystemExit("Squircle mask must meet the top edge without inset.")
    if not transparent or not partial:
        raise SystemExit("Rounded source requires transparent corners and antialiased edge pixels.")
    if black_transparent:
        raise SystemExit(f"Transparent exterior contains black RGB pixels: {black_transparent}")

    source_rgb_sha = hashlib.sha256(b"".join(source_rows)).hexdigest()
    output_rgb_sha = hashlib.sha256(b"".join(output_rgb_rows)).hexdigest()
    if source_rgb_sha != output_rgb_sha:
        raise SystemExit("Rounded source RGB content differs from the unmasked artwork.")

    OUTPUT.write_bytes(encode_rgba(width, height, output_rows))
    print(
        json.dumps(
            {
                "source": str(SOURCE),
                "output": str(OUTPUT),
                "dimensions": [width, height],
                "corner_ratio": CORNER_RATIO,
                "corner_curve": "rounded-square",
                "antialias_samples_per_axis": ANTIALIAS_SAMPLES,
                "transparent_pixels": transparent,
                "antialiased_pixels": partial,
                "transparent_black_pixels": black_transparent,
                "corner_rgba": [list(corner) for corner in corners],
                "rgb_sha256_original": source_rgb_sha,
                "rgb_sha256_rounded": output_rgb_sha,
                "rgb_unchanged": True,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
