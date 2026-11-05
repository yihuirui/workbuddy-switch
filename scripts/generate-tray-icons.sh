#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

swift scripts/generate-tray-template.swift
python3 scripts/gen-tray-icon.py --mono white --size 36 --out src-tauri/icons/tray-icon-template.rgba
python3 scripts/gen-tray-icon.py --size 36 --out src-tauri/icons/tray-icon-macos-color.rgba
python3 scripts/gen-tray-icon.py --mono black --size 32
python3 scripts/gen-tray-icon.py --mono white --size 32
python3 scripts/gen-tray-icon.py --size 32
python3 scripts/validate-tray-icons.py
