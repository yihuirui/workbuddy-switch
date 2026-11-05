#!/usr/bin/env python3
"""Export the public source view of one committed Git tree, with a hash manifest."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSION = "0.1.5"
EXCLUDED_DIRS = {
    ".agents", ".codex", ".codex-adaptive-agents", ".codebuddy", ".cursor",
    ".git", ".grok", ".idea", ".playwright-cli", ".playwright-mcp",
    ".pnpm-store", ".trellis", ".vscode", ".workbuddy", "backups", "dist",
    "logs", "node_modules", "outputs", "runtime", "target", "video",
}
EXCLUDED_FILES = {
    ".DS_Store", "AGENTS.md", "accounts.json", "generation-prompts.json",
    "SECURITY_AUDIT_2026-10-23.md", "SECURITY_FIX_STATUS.md",
    "UPSTREAM_README.md", "vite.svg", "tauri.svg",
}
EXCLUDED_PREFIXES = (
    "docs/images/",
    "npm/",
    "src-tauri/icons/account-switch/ios/",
    "src-tauri/icons/android/",
    "src-tauri/icons/generated/",
    "src-tauri/icons/ios/",
    "src-tauri/icons/wbcli/",
    "vendor/agent-companion/.github/",
    "vendor/agent-companion/docs/",
)
EXCLUDED_EXACT = {
    "scripts/bump-version.sh", "scripts/dmgbuild-settings.py",
    "scripts/fix-app.sh", "scripts/gen-platform-packages.sh",
    "scripts/gen-update-json.sh", "scripts/make-dmg.sh",
    "scripts/merge-update-manifests.py", "src-tauri/Cargo.lock",
}
EXCLUDED_SUFFIXES = {".key", ".pem", ".p12", ".pfx", ".mobileprovision"}
INCLUDED_ICONS = {
    "src-tauri/icons/account-switch/128x128.png",
    "src-tauri/icons/account-switch/128x128@2x.png",
    "src-tauri/icons/account-switch/32x32.png",
    "src-tauri/icons/account-switch/icon.icns",
    "src-tauri/icons/account-switch/icon.ico",
    "src-tauri/icons/account-switch/icon.png",
    "src-tauri/icons/account-switch/icon-source-macos-rounded-20261031.png",
    "src-tauri/icons/account-switch/icon-source-20261031.png",
    "src-tauri/icons/tray-icon-color.rgba",
    "src-tauri/icons/tray-icon-macos-color.rgba",
    "src-tauri/icons/tray-icon-mono-black.rgba",
    "src-tauri/icons/tray-icon-mono-white.rgba",
    "src-tauri/icons/tray-icon-template.rgba",
    "src-tauri/icons/tray-icon-template.png",
}
REQUIRED = {
    "Cargo.lock", "Cargo.toml", "LICENSE", "README.md", "rust-toolchain.toml",
    "SECURITY.md", "THIRD_PARTY_NOTICES.md", "licenses/CLIProxyAPI-LICENSE",
    "licenses/codebuddy-intl-cpa-LICENSE", "runtime.lock.json", "runtime.manifest.json",
    "scripts/build-patched-engine.py", "scripts/check-release-runtime.py",
    "scripts/fetch-proxy-runtime.py", "scripts/generate-tray-icons.sh",
    "scripts/generate-tray-template.swift", "scripts/generate-account-switch-icons.sh",
    "scripts/prepare-macos-icon-source.py", "scripts/package-preview-macos.py",
    "scripts/public-source-manifest.py", "scripts/smoke-proxy-runtime.py",
    "scripts/update-runtime-manifest.py", "scripts/validate-tray-icons.py",
    "scripts/verify-menu-bar-icon-bundle.py", "scripts/verify-security-bundle.py",
    "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json",
    "src-tauri/icons/account-switch/128x128.png",
    "src-tauri/icons/account-switch/128x128@2x.png",
    "src-tauri/icons/account-switch/32x32.png", "src-tauri/icons/account-switch/icon.icns",
    "src-tauri/icons/account-switch/icon.ico", "src-tauri/icons/account-switch/icon.png",
    "src-tauri/icons/account-switch/icon-source-macos-rounded-20261031.png",
    "src-tauri/icons/account-switch/icon-source-20261031.png",
    "src/assets/workbuddy-switch2-app-icon.png", "src-tauri/icons/tray-icon-color.rgba",
    "src-tauri/icons/tray-icon-macos-color.rgba", "src-tauri/icons/tray-icon-mono-black.rgba",
    "src-tauri/icons/tray-icon-mono-white.rgba", "src-tauri/icons/tray-icon-template.rgba",
    "src-tauri/icons/tray-icon-template.png", "docs/runtime-build.json",
    "docs/INTEL_MAC_BUILD.md", "patches/cliproxyapi-darwin-native-threads.patch",
    ".github/workflows/build.yml", ".github/workflows/test.yml",
    "vendor/agent-companion/LICENSE", "vendor-patched/indexmap/LICENSE-APACHE",
    "vendor-patched/indexmap/LICENSE-MIT",
}


def excluded(relative: str, parts: tuple[str, ...]) -> bool:
    if any(part in EXCLUDED_DIRS for part in parts[:-1]):
        return True
    if parts[-1] in EXCLUDED_DIRS or parts[-1] in EXCLUDED_FILES:
        return True
    if relative in EXCLUDED_EXACT or relative.startswith(EXCLUDED_PREFIXES):
        return True
    name = parts[-1]
    if name.startswith(".env") or name.endswith((".local", ".log")):
        return True
    if pathlib.PurePosixPath(name).suffix.lower() in EXCLUDED_SUFFIXES:
        return True
    if relative.startswith("src-tauri/icons/") and relative not in INCLUDED_ICONS and not any(
        item.startswith(relative.rstrip("/") + "/") for item in INCLUDED_ICONS
    ):
        return True
    return False


def file_digest(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_value(repo: pathlib.Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export-dir", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path, help="manifest JSON path")
    parser.add_argument("--git-repo", type=pathlib.Path, default=ROOT,
                        help="Git checkout that contains the committed source")
    parser.add_argument("--commit", default="HEAD", help="commit to export; defaults to HEAD")
    args = parser.parse_args()
    repo = args.git_repo.expanduser().resolve()
    repo_root = pathlib.Path(git_value(repo, "rev-parse", "--show-toplevel")).resolve()
    commit = git_value(repo, "rev-parse", "--verify", f"{args.commit}^{{commit}}")
    tree = git_value(repo, "rev-parse", "--verify", f"{commit}^{{tree}}")
    export_dir = args.export_dir.expanduser().resolve()
    manifest_path = args.output.expanduser().resolve()
    if export_dir == repo_root or export_dir in repo_root.parents:
        raise SystemExit("Refusing to replace or contain the Git checkout with the source export.")
    for generated_path in (export_dir, manifest_path):
        try:
            relative = generated_path.relative_to(repo_root)
        except ValueError:
            continue
        if not relative.parts or relative.parts[0] != "outputs":
            raise SystemExit(f"Generated files inside the Git checkout must be below outputs/: {generated_path}")
    if manifest_path.is_relative_to(export_dir):
        raise SystemExit("Place the manifest outside the source export directory.")
    if export_dir.exists():
        raise SystemExit(f"Refusing to overwrite source export: {export_dir}")
    if manifest_path.exists():
        raise SystemExit(f"Refusing to overwrite manifest: {manifest_path}")
    export_dir.mkdir(parents=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    records = []
    total_bytes = 0
    try:
        tracked_modes = {}
        raw_tree = subprocess.check_output(
            ["git", "-C", str(repo_root), "ls-tree", "-rz", "-r", "--full-tree", commit]
        )
        for entry in raw_tree.split(b"\0"):
            if not entry:
                continue
            metadata, raw_path = entry.split(b"\t", 1)
            mode, kind, _oid = metadata.decode("ascii").split(" ")
            if kind == "blob":
                tracked_modes[raw_path.decode("utf-8")] = mode
        with tempfile.TemporaryFile() as archive_file:
            subprocess.run(["git", "-C", str(repo_root), "archive", "--format=tar", commit],
                           check=True, stdout=archive_file)
            archive_file.seek(0)
            with tarfile.open(fileobj=archive_file, mode="r:") as archive:
                for member in archive:
                    rel = pathlib.PurePosixPath(member.name)
                    if rel.is_absolute() or any(part in ("", ".", "..") for part in rel.parts):
                        raise SystemExit(f"Unsafe path in Git archive: {member.name!r}")
                    relative = rel.as_posix()
                    parts = tuple(rel.parts)
                    if excluded(relative, parts):
                        continue
                    if member.isdir():
                        continue
                    if not member.isfile():
                        raise SystemExit(f"Unsupported non-regular tracked source file: {relative}")
                    git_mode = tracked_modes.get(relative)
                    if git_mode not in {"100644", "100755"}:
                        raise SystemExit(f"Unsupported committed file mode for export: {relative}")
                    source = archive.extractfile(member)
                    if source is None:
                        raise SystemExit(f"Could not read committed source file: {relative}")
                    destination = export_dir.joinpath(*parts)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with destination.open("xb") as target:
                        shutil.copyfileobj(source, target)
                    mode = int(git_mode[-3:], 8)
                    os.chmod(destination, mode)
                    size = destination.stat().st_size
                    total_bytes += size
                    records.append({"path": relative, "mode": f"{mode:04o}",
                                    "sha256": file_digest(destination), "size": size})

        included_paths = {item["path"] for item in records}
        missing = sorted(REQUIRED - included_paths)
        if missing:
            raise SystemExit("Required public source files are missing: " + ", ".join(missing))
        forbidden_prefixes = ("outputs/", "runtime/", ".codex-adaptive-agents/", ".git/")
        if any(item["path"].startswith(forbidden_prefixes) for item in records):
            raise SystemExit("Private output, runtime binary, or local state entered the export.")

        document = {
            "product": "Workbuddy-Switch2", "version": VERSION,
            "source_commit": commit, "source_tree": tree,
            "scope": "macOS ARM64 and Intel x86_64 desktop source",
            "file_count": len(records), "total_bytes": total_bytes,
            "files": sorted(records, key=lambda item: item["path"]),
        }
        manifest_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"export_dir": str(export_dir), "manifest": str(manifest_path),
                          "source_commit": commit, "source_tree": tree,
                          "file_count": len(records), "total_bytes": total_bytes}, indent=2))
        return 0
    except BaseException:
        shutil.rmtree(export_dir, ignore_errors=True)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
