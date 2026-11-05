# Intel Mac build

This guide builds the Workbuddy-Switch2 preview for Intel Macs running macOS 15.0 or newer. It produces an x86_64-only app, separate from the Apple silicon package.

## Requirements

- macOS with Xcode Command Line Tools (an Apple silicon Mac can cross-build the Rust app and Go runtime)
- Node.js 24.18.1
- Rust 1.99.1 with the `x86_64-apple-darwin` target
- Go 1.26.10

Start from a fresh source checkout with dependencies installed. The source export excludes prebuilt runtime binaries. Do not reuse an existing `runtime/` folder containing ARM64 files.

```bash
npm ci
export WB_RUNTIME_ARCH=x86_64
python3 scripts/fetch-proxy-runtime.py
python3 scripts/build-patched-engine.py
python3 scripts/update-runtime-manifest.py
python3 scripts/smoke-proxy-runtime.py
npm test
npm run tauri -- build --target x86_64-apple-darwin --bundles app
python3 scripts/package-preview-macos.py \
  --app target/x86_64-apple-darwin/release/bundle/macos/Workbuddy-Switch2.app \
  --output-dir release/x86_64 \
  --architecture x86_64
```

On Apple silicon, the patched Go runtime is cross-compiled with clang targeting x86_64. The build and package checks reject any ARM64 or universal runtime/app binary. The ZIP name ends in `macos-x86_64` and includes a SHA-256 sidecar.

Running the Intel runtime smoke check on Apple silicon requires Rosetta 2. The CI workflow runs this check on a native Intel macOS runner.

## Verification limits

The empty-store smoke test checks startup, API-key rejection, plugin registration, and concurrent account-list callbacks. It does not exercise sign-in, a real account, check-in, model inference, or Intel hardware behavior. Builds are ad-hoc signed and are not Developer ID signed or notarized.
