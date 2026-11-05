#!/usr/bin/env python3
"""Verify a Workbuddy-Switch2 macOS preview bundle without launching it."""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import plistlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSION = "0.1.5"
IDENTIFIER = "com.wbcli.switch.proxyapi"
PRODUCT_NAME = "Workbuddy-Switch2"
MINIMUM_MACOS = "15.0"
RUNTIME_FILES = {
    "cli-proxy-api-wb",
    "workbuddy.dylib",
    "CLIProxyAPI-LICENSE",
    "codebuddy-intl-cpa-LICENSE",
}


def fail(message: str) -> None:
    raise SystemExit(f"release bundle check failed: {message}")


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def binary_arch(path: pathlib.Path) -> str:
    result = subprocess.run(
        ["/usr/bin/lipo", "-archs", str(path)], capture_output=True, text=True
    )
    if result.returncode:
        fail(f"cannot inspect architecture of {path.name}")
    return result.stdout.strip()


def version_tuple(value: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in value.split("."))
    except ValueError:
        fail(f"invalid macOS version: {value}")


def deployment_target(path: pathlib.Path) -> str:
    result = subprocess.run(["/usr/bin/otool", "-l", str(path)], capture_output=True, text=True)
    if result.returncode:
        fail(f"cannot inspect minimum macOS version of {path.name}")
    lines = result.stdout.splitlines()
    for index, line in enumerate(lines):
        if line.strip() == "cmd LC_BUILD_VERSION":
            for candidate in lines[index + 1 : index + 8]:
                if candidate.strip().startswith("minos "):
                    return candidate.split()[1]
        if line.strip() == "cmd LC_VERSION_MIN_MACOSX":
            for candidate in lines[index + 1 : index + 8]:
                if candidate.strip().startswith("version "):
                    return candidate.split()[1]
    fail(f"Mach-O deployment target missing: {path.name}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "app",
        nargs="?",
        type=pathlib.Path,
        default=ROOT
        / "target/aarch64-apple-darwin/release/bundle/macos/Workbuddy-Switch2.app",
    )
    args = parser.parse_args()
    expected_arch = os.environ.get("WB_RUNTIME_ARCH", platform.machine())
    expected_arch = {"aarch64": "arm64", "amd64": "x86_64"}.get(expected_arch, expected_arch)
    if expected_arch not in ("arm64", "x86_64"):
        fail("WB_RUNTIME_ARCH must be arm64 or x86_64")
    app = args.app.expanduser().resolve()
    if app.name != f"{PRODUCT_NAME}.app" or not app.is_dir():
        fail(f"expected {PRODUCT_NAME}.app directory")
    plist_path = app / "Contents/Info.plist"
    try:
        with plist_path.open("rb") as source:
            info = plistlib.load(source)
    except (OSError, plistlib.InvalidFileException) as error:
        fail(f"invalid Info.plist: {error}")
    if info.get("CFBundleIdentifier") != IDENTIFIER:
        fail("bundle identifier changed; account-store compatibility would be at risk")
    if info.get("CFBundleShortVersionString") != VERSION:
        fail(f"expected version {VERSION}")
    if info.get("CFBundleName") != PRODUCT_NAME:
        fail("bundle name does not match product name")
    declared_minimum = info.get("LSMinimumSystemVersion")
    if not isinstance(declared_minimum, str) or version_tuple(declared_minimum) < version_tuple(
        MINIMUM_MACOS
    ):
        fail(f"bundle minimum macOS must be {MINIMUM_MACOS} or newer")

    executable = info.get("CFBundleExecutable")
    if not isinstance(executable, str) or not executable:
        fail("CFBundleExecutable is missing")
    main_binary = app / "Contents/MacOS" / executable
    if not main_binary.is_file():
        fail("app executable is missing")
    if binary_arch(main_binary) != expected_arch:
        fail(f"app executable is not {expected_arch}-only")
    deployment_targets = {"application": deployment_target(main_binary)}
    if version_tuple(deployment_targets["application"]) > version_tuple(declared_minimum):
        fail("application Mach-O deployment target exceeds the bundle minimum")
    runtime = app / "Contents/Resources/runtime"
    if not runtime.is_dir() or {item.name for item in runtime.iterdir()} != RUNTIME_FILES:
        fail("runtime folder has missing, extra, or unsupported files")

    manifest_path = ROOT / "runtime.manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid runtime manifest: {error}")
    hashes: dict[str, str] = {}
    for kind, filename in (
        ("engine", "cli-proxy-api-wb"),
        ("plugin", "workbuddy.dylib"),
    ):
        binary = runtime / filename
        if binary.is_symlink() or not binary.is_file():
            fail(f"missing regular runtime {kind}")
        if kind == "engine" and not binary.stat().st_mode & 0o111:
            fail("bundled proxy engine is not executable")
        arch = binary_arch(binary)
        if arch != expected_arch:
            fail(f"{filename} must contain only {expected_arch}; found {arch or 'unknown'}")
        minimum = deployment_target(binary)
        if version_tuple(minimum) > version_tuple(declared_minimum):
            fail(f"{filename} requires macOS {minimum}, above the bundle minimum {declared_minimum}")
        deployment_targets[kind] = minimum
        digest = sha256(binary)
        expected = manifest.get(kind)
        if not isinstance(expected, list) or digest not in expected:
            fail(f"untrusted bundled {kind} hash")
        hashes[filename] = digest

    hashes["application"] = sha256(main_binary)

    forbidden_names = {"accounts.json", "auths", "browser", "cookies", ".codex"}
    for path in app.rglob("*"):
        relative_parts = {part.lower() for part in path.relative_to(app).parts}
        name = path.name.lower()
        if relative_parts & forbidden_names:
            fail(f"private-data path found in bundle: {path.relative_to(app)}")
        if name.endswith((".log", ".sqlite", ".sqlite3", ".db")):
            fail(f"runtime log or database found in bundle: {path.relative_to(app)}")

    verified = subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)],
        capture_output=True,
        text=True,
    )
    if verified.returncode:
        fail(f"code signature verification failed: {verified.stderr.strip()}")
    signature = subprocess.run(
        ["/usr/bin/codesign", "-dv", "--verbose=2", str(app)],
        capture_output=True,
        text=True,
    )
    signature_text = signature.stderr + signature.stdout
    signature_kind = "ad-hoc" if "Signature=adhoc" in signature_text else "other"
    report = {
        "product": PRODUCT_NAME,
        "version": VERSION,
        "bundle_id": IDENTIFIER,
        "architecture": expected_arch,
        "minimum_macos": declared_minimum,
        "mach_o_minimums": deployment_targets,
        "signature": signature_kind,
        "notarization": "not performed",
        "codesign_verify": "passed",
        "sha256": hashes,
    }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
