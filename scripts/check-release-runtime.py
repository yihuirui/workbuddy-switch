#!/usr/bin/env python3
"""Reject missing, stale, or wrong-architecture runtime before Tauri bundles it."""
import hashlib
import json
import os
import pathlib
import platform
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime"


def selected_architecture() -> str:
    arch = os.environ.get("WB_RUNTIME_ARCH", platform.machine())
    arch = {"aarch64": "arm64", "amd64": "x86_64"}.get(arch, arch)
    if arch not in ("arm64", "x86_64"):
        raise SystemExit("WB_RUNTIME_ARCH must be arm64 or x86_64.")
    return arch


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    if sys.platform != "darwin":
        raise SystemExit("The preview runtime requires a macOS build host.")
    arch = selected_architecture()

    try:
        manifest = json.loads((ROOT / "runtime.manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Runtime manifest is missing or invalid: {error}") from error

    for kind, filename in (
        ("engine", "cli-proxy-api-wb"),
        ("plugin", "workbuddy.dylib"),
    ):
        path = RUNTIME / filename
        if path.is_symlink() or not path.is_file():
            raise SystemExit(
                f"Missing {filename}; prepare a fresh {arch} runtime with the documented fetch/build steps."
            )
        if kind == "engine" and not path.stat().st_mode & 0o111:
            raise SystemExit(
                f"{filename} is not executable; prepare a fresh runtime instead of bundling a broken app."
            )
        result = subprocess.run(
            ["/usr/bin/lipo", "-archs", str(path)], capture_output=True, text=True
        )
        if result.returncode or result.stdout.strip() != arch:
            raise SystemExit(
                f"Refusing to bundle non-{arch} {filename}; existing runtime files were not changed."
            )
        digest = sha256(path)
        if not isinstance(manifest.get(kind), list) or digest not in manifest[kind]:
            raise SystemExit(
                f"Refusing to bundle unlisted {filename}; refresh runtime.manifest.json after the pinned build."
            )

    for filename in ("CLIProxyAPI-LICENSE", "codebuddy-intl-cpa-LICENSE"):
        path = RUNTIME / filename
        if path.is_symlink() or not path.is_file() or not path.stat().st_size:
            raise SystemExit(f"Required bundled third-party license is missing: {filename}")

    print(f"Verified pinned {arch} runtime and licenses before Tauri bundle.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
