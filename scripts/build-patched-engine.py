#!/usr/bin/env python3
"""Build the pinned Darwin engine for the selected Mac architecture."""
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REVISION = "3f0cef010e4ad20279500e6b0f18060b6f3f37cc"
if platform.system() != "Darwin":
    raise SystemExit("This patch is currently validated on macOS only.")
arch = os.environ.get("WB_RUNTIME_ARCH", platform.machine())
arch = {"aarch64": "arm64", "amd64": "x86_64"}.get(arch, arch)
if arch not in ("arm64", "x86_64"):
    raise SystemExit("WB_RUNTIME_ARCH must be arm64 or x86_64.")
go = os.environ.get("WB_GO_BINARY") or shutil.which("go")
if not go:
    raise SystemExit("Install Go 1.26.10 or set WB_GO_BINARY.")
version = subprocess.check_output([go, "version"], text=True)
if " go1.26.10 " not in version:
    raise SystemExit("Reproducible build requires Go 1.26.10.")
go_arch = "arm64" if arch == "arm64" else "amd64"
env = dict(
    os.environ,
    CGO_ENABLED="1",
    GOARCH=go_arch,
    GOOS="darwin",
    GOTOOLCHAIN="local",
    MACOSX_DEPLOYMENT_TARGET="15.0",
)
if arch == "x86_64" and platform.machine() in ("arm64", "aarch64"):
    # Go's cgo compiler must produce Intel objects when cross-building on Apple silicon.
    env["CC"] = "clang -arch x86_64 -mmacosx-version-min=15.0"
    env["CGO_CFLAGS"] = "-arch x86_64 -mmacosx-version-min=15.0"
    env["CGO_LDFLAGS"] = "-arch x86_64 -mmacosx-version-min=15.0"
target = ROOT / "runtime/cli-proxy-api-wb"
if target.exists():
    raise SystemExit(f"Output already exists; preserve it before rebuilding: {target}")
with tempfile.TemporaryDirectory(prefix="wb-engine-build-") as tmp:
    src = Path(tmp) / "source"
    subprocess.run(["git", "clone", "--no-checkout",
                    "https://github.com/router-for-me/CLIProxyAPI.git", str(src)], check=True)
    subprocess.run(["git", "checkout", "--detach", REVISION], cwd=src, check=True)
    patch = ROOT / "patches/cliproxyapi-darwin-native-threads.patch"
    subprocess.run(["git", "apply", "--check", str(patch)], cwd=src, check=True)
    subprocess.run(["git", "apply", str(patch)], cwd=src, check=True)
    subprocess.run([go, "build", "-o", str(Path(tmp) / "engine"), "./cmd/server"],
                   cwd=src, env=env, check=True)
    architecture = subprocess.run(
        ["/usr/bin/lipo", "-archs", str(Path(tmp) / "engine")],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    if architecture != arch:
        raise SystemExit(f"Built engine has architecture {architecture}; expected {arch}.")
    target.parent.mkdir(exist_ok=True)
    with target.open("xb") as output, (Path(tmp) / "engine").open("rb") as source:
        shutil.copyfileobj(source, output)
    target.chmod(0o755)
print(f"Built {target}; run scripts/smoke-proxy-runtime.py before packaging.")
