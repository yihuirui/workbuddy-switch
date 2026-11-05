#!/usr/bin/env python3
"""Write the trusted hashes for the ARM64 engine and plugin in runtime/."""
import hashlib
import json
import os
import pathlib
import platform
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime"
EXPECTED = {"engine": RUNTIME / "cli-proxy-api-wb", "plugin": RUNTIME / "workbuddy.dylib"}


def selected_architecture() -> str:
    arch = os.environ.get("WB_RUNTIME_ARCH", platform.machine())
    arch = {"aarch64": "arm64", "amd64": "x86_64"}.get(arch, arch)
    if arch not in ("arm64", "x86_64"):
        raise SystemExit("WB_RUNTIME_ARCH must be arm64 or x86_64.")
    return arch


def architecture(path: pathlib.Path) -> str:
    result = subprocess.run(["/usr/bin/lipo", "-archs", str(path)], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    if sys.platform != "darwin":
        raise SystemExit("Runtime manifests for this preview must be created on macOS.")
    expected_arch = selected_architecture()
    for kind, path in EXPECTED.items():
        if path.is_symlink() or not path.is_file():
            raise SystemExit(f"Missing regular runtime file: {path.name}")
        arch = architecture(path)
        if arch != expected_arch:
            raise SystemExit(f"{path.name} must contain only {expected_arch}; found {arch or 'unknown'}")
    manifest = {kind: [sha256(path)] for kind, path in EXPECTED.items()}
    destination = ROOT / "runtime.manifest.json"
    fd, temporary = tempfile.mkstemp(prefix="runtime.manifest.", dir=ROOT)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
            json.dump(manifest, output, indent=2)
            output.write("\n")
        os.replace(temporary, destination)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
