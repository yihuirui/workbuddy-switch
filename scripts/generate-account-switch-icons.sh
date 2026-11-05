#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE="$ROOT/src-tauri/icons/account-switch/icon-source-macos-rounded-20261031.png"
OUTPUT="$ROOT/src-tauri/icons/account-switch"
TAURI="$ROOT/node_modules/.bin/tauri"
PYTHON=${PYTHON:-python3}

if [ ! -s "$ROOT/src-tauri/icons/account-switch/icon-source-20261031.png" ]; then
  echo "Missing unmasked icon source." >&2
  exit 1
fi
if [ ! -x "$TAURI" ]; then
  echo "Missing Tauri CLI. Run npm ci before generating icons." >&2
  exit 1
fi

"$PYTHON" "$ROOT/scripts/prepare-macos-icon-source.py"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/workbuddy-switch2-icons.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
mkdir -p "$STAGE/generated"
"$TAURI" icon "$SOURCE" --output "$STAGE/generated"

for name in icon.png icon.icns icon.ico 32x32.png 128x128.png 128x128@2x.png; do
  if [ ! -s "$STAGE/generated/$name" ]; then
    echo "Tauri did not generate required icon resource: $name" >&2
    exit 1
  fi
done

for name in icon.png icon.icns icon.ico 32x32.png 128x128.png 128x128@2x.png; do
  cp "$STAGE/generated/$name" "$OUTPUT/$name"
done
echo "Generated macOS app icon resources from $SOURCE"
