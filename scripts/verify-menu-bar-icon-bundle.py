#!/usr/bin/env python3
"""Verify the compiled macOS menu-bar executable embeds the new color icon."""
import argparse
import pathlib
import plistlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ICON = ROOT / "src-tauri/icons/tray-icon-macos-color.rgba"
OLD_TEMPLATE = ROOT / "src-tauri/icons/tray-icon-template.rgba"
APP_ICON = ROOT / "src-tauri/icons/account-switch/icon.icns"


def run(args: list[str]) -> str:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(result.stderr.strip() or f"command failed: {args[0]}")
    return result.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=pathlib.Path)
    parser.add_argument("--architecture", required=True, choices=("arm64", "x86_64"))
    args = parser.parse_args()
    app = args.app.expanduser().resolve()
    if app.name != "Workbuddy-Switch2.app" or not app.is_dir():
        raise SystemExit("expected a Workbuddy-Switch2.app bundle")
    with (app / "Contents/Info.plist").open("rb") as source:
        info = plistlib.load(source)
    bundled_icon = app / "Contents/Resources/icon.icns"
    if not bundled_icon.is_file() or bundled_icon.read_bytes() != APP_ICON.read_bytes():
        raise SystemExit("bundle app icon does not match the retained current main icon")
    executable = info.get("CFBundleExecutable")
    if not isinstance(executable, str) or not executable:
        raise SystemExit("CFBundleExecutable missing from Info.plist")
    binary = app / "Contents/MacOS" / executable
    if run(["/usr/bin/lipo", "-archs", str(binary)]) != args.architecture:
        raise SystemExit(f"application executable is not {args.architecture}-only")
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)])
    data = binary.read_bytes()
    color_count = data.count(ICON.read_bytes())
    template_count = data.count(OLD_TEMPLATE.read_bytes())
    if color_count != 1:
        raise SystemExit(f"expected one embedded new color menu icon, found {color_count}")
    if template_count:
        raise SystemExit(f"old monochrome macOS template remains embedded ({template_count} copies)")
    print(
        f"OK {app}: architecture={args.architecture}, ad-hoc signature valid, "
        "new color icon embedded once, old macOS template absent"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
