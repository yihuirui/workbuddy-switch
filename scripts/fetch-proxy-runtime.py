#!/usr/bin/env python3
"""Fetch pinned macOS runtimes for one architecture; verify hashes before extraction."""
import hashlib
import io
import json
import os
import platform
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
if platform.system() != "Darwin":
    raise SystemExit("This preview runtime is built for macOS only.")
arch = os.environ.get("WB_RUNTIME_ARCH", platform.machine())
arch = {"aarch64": "arm64", "amd64": "x86_64"}.get(arch, arch)
if arch not in ("arm64", "x86_64"):
    raise SystemExit("WB_RUNTIME_ARCH must be arm64 or x86_64.")

all_items = json.loads((root / "runtime.lock.json").read_text(encoding="utf-8"))
items = [item for item in all_items if item.get("architecture") == arch]
if len(items) != 2:
    raise SystemExit(f"runtime.lock.json must contain exactly two {arch} runtime assets.")
destination = root / "runtime"
destination.mkdir(exist_ok=True)
expected_lipo_arch = arch

for existing_name in ("cli-proxy-api-wb", "cli-proxy-api", "workbuddy.dylib"):
    existing = destination / existing_name
    if existing.exists():
        result = subprocess.run(
            ["/usr/bin/lipo", "-archs", str(existing)], capture_output=True, text=True
        )
        if result.returncode or result.stdout.strip() != expected_lipo_arch:
            raise SystemExit(
                f"Refusing to use or replace existing non-{arch} {existing_name}; "
                "use a fresh source checkout. The existing runtime was left unchanged."
            )

for item in items:
    asset_arch = (
        "aarch64" if item["repository"].endswith("CLIProxyAPI") else "arm64"
    ) if arch == "arm64" else "amd64"
    if item.get("architecture") != arch or f"_darwin_{asset_arch}." not in item["asset"]:
        raise SystemExit(f"Unexpected {arch} runtime asset: {item['asset']}")

    with tempfile.TemporaryDirectory(prefix="wb-runtime-") as tmp:
        archive = Path(tmp) / item["asset"]
        subprocess.run(
            [
                "curl",
                "--fail",
                "--location",
                "--retry",
                "2",
                "--max-time",
                "180",
                "--silent",
                "--show-error",
                item["url"],
                "--output",
                str(archive),
            ],
            check=True,
        )
        data = archive.read_bytes()
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise SystemExit("Release checksum mismatch")

        files = {}
        if item["asset"].endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(data)) as zipped:
                for name in zipped.namelist():
                    if Path(name).name in ("workbuddy.so", "workbuddy.dylib", "LICENSE"):
                        files[Path(name).name] = zipped.read(name)
        else:
            with tarfile.open(fileobj=io.BytesIO(data)) as tarball:
                for member in tarball.getmembers():
                    if member.isfile() and Path(member.name).name in ("cli-proxy-api", "LICENSE"):
                        extracted = tarball.extractfile(member)
                        if extracted is not None:
                            files[Path(member.name).name] = extracted.read()

        license_path = root / "licenses" / f"{item['repository'].split('/')[-1]}-LICENSE"
        if not license_path.is_file():
            raise SystemExit(f"Vendored third-party license missing: {license_path.name}")
        license_bytes = license_path.read_bytes()
        if "LICENSE" in files and hashlib.sha256(files["LICENSE"]).digest() != hashlib.sha256(
            license_bytes
        ).digest():
            raise SystemExit(f"Archive license does not match the reviewed license: {item['asset']}")
        files["LICENSE"] = license_bytes
        binary = next((name for name in files if name != "LICENSE"), None)
        if not binary or "LICENSE" not in files:
            raise SystemExit(f"Runtime binary or license absent from {item['asset']}.")
        for name, contents in files.items():
            target = destination / (
                f"{item['repository'].split('/')[-1]}-LICENSE" if name == "LICENSE" else name
            )
            if target.exists():
                if target.read_bytes() != contents:
                    raise SystemExit(f"Refusing to replace different runtime: {target}")
            else:
                with target.open("xb") as output:
                    output.write(contents)
            if name != "LICENSE":
                target.chmod(0o755)
        print(f"Verified {item['asset']}: {binary}")
