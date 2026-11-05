#!/usr/bin/env python3
"""Verify checked-in tray icon sources and raw RGBA resources are reproducible."""
from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gen_tray_icon", ROOT / "scripts/gen-tray-icon.py")
assert spec and spec.loader
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def validate_rgba(path: Path, size: int, expected_rgb: tuple[int, int, int] | None = None) -> bytes:
    data = path.read_bytes()
    require(len(data) == size * size * 4, f"{path.relative_to(ROOT)}: expected {size}×{size} RGBA")
    alphas = data[3::4]
    require(any(a == 0 for a in alphas), f"{path.relative_to(ROOT)}: no transparent pixels")
    require(any(a == 255 for a in alphas), f"{path.relative_to(ROOT)}: no opaque pixels")
    require(any(0 < a < 255 for a in alphas), f"{path.relative_to(ROOT)}: no antialiased edge pixels")
    require(alphas[0] == 0 and alphas[size - 1] == 0 and alphas[-size] == 0 and alphas[-1] == 0,
            f"{path.relative_to(ROOT)}: corners must be transparent")
    if expected_rgb is not None:
        for i in range(0, len(data), 4):
            if data[i + 3]:
                require(tuple(data[i:i + 3]) == expected_rgb,
                        f"{path.relative_to(ROOT)}: non-mask color found at pixel {i // 4}")
    return data


def expected(size: int, mono: str | None) -> bytes:
    source_name = generator.MONO_TEMPLATE if mono else generator.COLOR_SRC
    width, height, pixels = generator.decode_png(ROOT / source_name)
    if mono:
        rgb = generator.MONO_RGB[mono]
        return generator.downscale_mono(width, height, pixels, size, rgb)
    return generator.downscale_premultiplied(width, height, pixels, size)


template_png = ROOT / generator.MONO_TEMPLATE
width, height, pixels = generator.decode_png(template_png)
require((width, height) == (144, 144), "tray template PNG must be the 144×144 generator output")
require(pixels[3] == 0 and pixels[(width - 1) * 4 + 3] == 0,
        "tray template PNG top corners must be transparent")
require(any(0 < pixels[i] < 255 for i in range(3, len(pixels), 4)),
        "tray template PNG must have antialiased edges")

resources = (
    ("src-tauri/icons/tray-icon-template.rgba", 36, "white"),
    ("src-tauri/icons/tray-icon-macos-color.rgba", 36, None),
    ("src-tauri/icons/tray-icon-mono-black.rgba", 32, "black"),
    ("src-tauri/icons/tray-icon-mono-white.rgba", 32, "white"),
    ("src-tauri/icons/tray-icon-color.rgba", 32, None),
)
for relative, size, mono in resources:
    path = ROOT / relative
    expected_rgb = generator.MONO_RGB[mono] if mono else None
    content = validate_rgba(path, size, expected_rgb)
    require(content == expected(size, mono), f"{relative}: does not match generated PNG source")
    if relative.endswith("tray-icon-macos-color.rgba"):
        pixels = [content[i:i + 4] for i in range(0, len(content), 4)]
        require(any(p[3] > 200 and (max(p[:3]) - min(p[:3])) > 24 for p in pixels),
                "macOS menu icon lost the source app's orange/pink color identity")
        for background in (0, 255):
            visible = 0
            for red, green, blue, alpha in pixels:
                if alpha == 0:
                    continue
                channels = [((c * alpha) + (background * (255 - alpha))) // 255 for c in (red, green, blue)]
                luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
                if abs(luminance - background) >= 24:
                    visible += 1
            require(visible >= 120,
                    f"macOS menu icon has insufficient contrast on {'dark' if background == 0 else 'light'} background: {visible} pixels")
            print(f"OK {relative}: {visible} contrast pixels on {'dark' if background == 0 else 'light'} menu bar")
    print(f"OK {relative}: {size}×{size}, transparent corners, antialiased edges, reproducible")

