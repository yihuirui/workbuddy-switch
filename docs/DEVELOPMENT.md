# Development and release

## Supported macOS builds

The preview build targets macOS 15.0 or newer on Apple silicon (ARM64) and Intel (x86_64). Install Node.js 24.18.1, Rust 1.99.1 with the target for the chosen architecture, Go 1.26.10, and Xcode Command Line Tools. Use a fresh source checkout; it intentionally does not include prebuilt runtime binaries. Do not prepare a runtime inside an existing working copy that already has ignored `runtime/` files. The fetcher refuses to replace binaries of a different architecture, and Tauri's pre-build gate checks the selected binary architectures and manifest hashes.

```bash
npm ci
WB_RUNTIME_ARCH=arm64 python3 scripts/fetch-proxy-runtime.py
WB_RUNTIME_ARCH=arm64 python3 scripts/build-patched-engine.py
WB_RUNTIME_ARCH=arm64 python3 scripts/update-runtime-manifest.py
WB_RUNTIME_ARCH=arm64 python3 scripts/smoke-proxy-runtime.py
npm test
npm run tauri -- build --target aarch64-apple-darwin --bundles app
```

For Intel, set `WB_RUNTIME_ARCH=x86_64` on each runtime command and build with `--target x86_64-apple-darwin`. On Apple silicon, the Go runtime builder configures clang for x86_64 cgo output; use an x86_64 Rust target. See [Intel Mac build](INTEL_MAC_BUILD.md). `runtime.lock.json` pins both architectures' upstream engine and plugin archives by SHA-256. The smoke test uses an empty temporary account store and does not send model requests.

## App icon resources

The untouched high-resolution artwork is `src-tauri/icons/account-switch/icon-source-20261031.png`. `scripts/prepare-macos-icon-source.py` applies a macOS-style 22.37% rounded-square alpha mask with 4× edge supersampling, adds transparent corners, and preserves every original RGB pixel. Regenerate the rounded source and Tauri PNG, ICO, and ICNS resources with `scripts/generate-account-switch-icons.sh` after installing npm dependencies. The resulting ICNS includes transparent corners and antialiased edges; do not apply another mask to the rounded source.

## Preview packaging

The manual GitHub Actions workflow builds ARM64 and x86_64 apps separately and uploads architecture-specific workflow artifacts. It does not publish npm packages or create a GitHub Release. The local packaging helper verifies the `.app`, creates a ZIP, and writes a SHA-256 file. A maintainer can then review and upload those artifacts to the repository's Releases page.

Preview builds are not Developer ID signed or Apple-notarized. Do not describe the build as notarized or as supporting untested platforms.

## Source export

Generate the public source file list with:

Pass separate destinations outside the checkout so the export cannot include itself:

```bash
python3 scripts/public-source-manifest.py \
  --export-dir ../workbuddy-switch2-source \
  --output ../workbuddy-switch2-source-manifest.json
```

The exporter excludes local outputs, prebuilt runtime binaries, build caches, adaptive-agent state, personal reports, and non-required icon drafts. It includes the project license, third-party notices, and required vendored source and licenses.
