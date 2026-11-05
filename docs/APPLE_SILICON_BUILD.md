# Apple silicon Mac build

This guide covers the macOS 15.0 or newer ARM64 preview build. For Intel Macs, see [Intel Mac build](INTEL_MAC_BUILD.md). Windows and Linux are not supported.

## Requirements

- Apple silicon Mac running macOS 15.0 or newer with Xcode Command Line Tools
- Node.js 24.18.1
- Rust 1.99.1 with the `aarch64-apple-darwin` target
- Go 1.26.10

## Build

Start from a fresh source checkout or a new directory created from the public source export. Prebuilt runtime binaries are deliberately omitted from the source export. Do not prepare runtimes in an existing working copy with ignored `runtime/` files; the fetcher refuses to replace non-ARM64 binaries, and the Tauri pre-build gate validates selected binary architectures and manifest hashes.

```bash
npm ci
export WB_RUNTIME_ARCH=arm64
python3 scripts/fetch-proxy-runtime.py
python3 scripts/build-patched-engine.py
python3 scripts/update-runtime-manifest.py
python3 scripts/smoke-proxy-runtime.py
npm run tauri -- build --target aarch64-apple-darwin --bundles app
```

The resulting app is under `target/aarch64-apple-darwin/release/bundle/macos/`. Use `scripts/package-preview-macos.py` to verify the bundle, create a ZIP, and write a SHA-256 checksum. The helper refuses to package a bundle unless the app executable, proxy engine, and provider plugin are ARM64 and the bundled runtime hashes match the manifest.

## Limits

The preview bundle is not Developer ID signed or Apple-notarized. Build and empty-store smoke checks do not verify OAuth sign-in, real account refresh, model inference, streaming traffic, quota accounting, or check-in. Do not treat a successful build as evidence for those behaviors.
