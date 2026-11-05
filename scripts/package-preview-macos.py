#!/usr/bin/env python3
"""Stage, ad-hoc sign, verify, and ZIP a macOS preview app."""
import argparse
import hashlib
import json
import pathlib
import os
import platform
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
PRODUCT = "Workbuddy-Switch2"
VERSION = "0.1.5"
MINIMUM_MACOS = "15.0"


def run(argv: list[str]) -> None:
    subprocess.run(argv, check=True)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=pathlib.Path, help="built .app bundle")
    parser.add_argument("--output-dir", required=True, type=pathlib.Path)
    parser.add_argument("--architecture", choices=("arm64", "x86_64"),
                        default=os.environ.get("WB_RUNTIME_ARCH", platform.machine()))
    args = parser.parse_args()
    architecture = {"aarch64": "arm64", "amd64": "x86_64"}.get(args.architecture, args.architecture)
    if architecture not in ("arm64", "x86_64"):
        raise SystemExit("--architecture must be arm64 or x86_64.")
    if sys.platform != "darwin":
        raise SystemExit("The preview packaging step must run on macOS.")
    source = args.app.expanduser().resolve()
    output = args.output_dir.expanduser().resolve()
    if source.name != f"{PRODUCT}.app" or not source.is_dir():
        raise SystemExit(f"Expected a built {PRODUCT}.app bundle.")
    if source.parent == output:
        raise SystemExit("Output directory must be separate from the build bundle.")
    output.mkdir(parents=True, exist_ok=True)
    app = output / f"{PRODUCT}.app"
    archive = output / f"{PRODUCT}-{VERSION}-macos-{architecture}.zip"
    checksum = output / f"{PRODUCT}-{VERSION}-macos-{architecture}.zip.sha256"
    metadata = output / f"{PRODUCT}-{VERSION}-macos-{architecture}.json"
    if any(path.exists() for path in (app, archive, checksum, metadata)):
        raise SystemExit("Refusing to overwrite an existing preview artifact.")

    run(["/usr/bin/ditto", str(source), str(app)])
    # This is an ad-hoc integrity signature only. It does not identify a developer
    # and does not perform Apple notarization.
    run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", "--timestamp=none", str(app)])
    verify_env = dict(os.environ, WB_RUNTIME_ARCH=architecture)
    subprocess.run([sys.executable, str(ROOT / "scripts/verify-security-bundle.py"), str(app)],
                   env=verify_env, check=True)
    run(["/usr/bin/ditto", "-c", "-k", "--norsrc", "--keepParent", str(app), str(archive)])
    run(["/usr/bin/unzip", "-tqq", str(archive)])

    with zipfile.ZipFile(archive) as zipped:
        bad_member = zipped.testzip()
        if bad_member is not None:
            raise SystemExit(f"ZIP integrity check failed at {bad_member}")
        members = [pathlib.PurePosixPath(name) for name in zipped.namelist() if name]
        roots = {path.parts[0] for path in members}
        if roots != {app.name}:
            raise SystemExit("ZIP must contain exactly the app bundle at its root.")

    digest = sha256(archive)
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    report = {
        "product": PRODUCT,
        "version": VERSION,
        "platform": "macOS",
        "architecture": architecture,
        "minimum_macos": MINIMUM_MACOS,
        "app": app.name,
        "archive": archive.name,
        "archive_sha256": digest,
        "signature": "ad-hoc; no Developer ID identity",
        "notarization": "not performed",
    }
    metadata.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({**report, "checksum_file": checksum.name}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
