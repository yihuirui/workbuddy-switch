# Workbuddy-Switch2

Workbuddy-Switch2 is a desktop app for managing WorkBuddy and CodeBuddy accounts and a local model API proxy.

## Public source status

This is the initial public source snapshot, based on the Workbuddy-Switch2 0.1.5 code. No prebuilt application binaries are published for this public fork yet. The build instructions below target macOS 15.0 or newer on Apple silicon (ARM64) and Intel (x86_64); Windows and Linux packages are not provided by this preview. The source snapshot has not been validated with real account sign-in, real model inference, streaming requests, quota use, or check-in. Builds are not Developer ID signed or Apple-notarized.

## Install and use

There is no public installer or downloadable app archive yet. To try the app, build it from this source using the instructions below. Each architecture's app bundles its matching proxy engine and WorkBuddy provider plugin. The app uses bundle identifier `com.wbcli.switch.proxyapi` and data directory `~/.wbcli-switch-proxyapi/`; do not delete that directory or change `WB_SWITCH_HOME` unless you intend to use a separate store.

After building, add only accounts you are authorized to use. On the Proxy API page, select accounts and explicitly start the local service. It listens on `127.0.0.1:8317`; its management API is disabled. The local API key is shown in the app. A model connectivity test sends a real request and may use account quota; it is not run automatically.

Automatic in-app updates are disabled. Until this public project publishes its own release, updates require rebuilding from source. The account data directory remains separate from the app bundle.

## Desktop workflow additions

The sidebar includes an **账号与签到** (account operations) console and
**效率工具** (workflow tools). The operations console brings account-pool
status and check-in results into one place. Workflow tools provide a local
searchable prompt library and user-initiated per-account exports using the
existing account export API. Account export files contain login credentials;
store them privately. Prompt text is never executed automatically.

These independently implemented features take functional inspiration from
[workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) and
[WorkDaddy](https://github.com/babygoton/WorkDaddy). They do not integrate those
projects' cloud task engines or unattended client-control mechanisms.

## Build from source

Requirements: macOS 15.0 or newer with Xcode Command Line Tools, Node.js 24.18.1, Rust 1.99.1, and Go 1.26.10. Choose the matching architecture in the build guide: [Apple silicon](docs/APPLE_SILICON_BUILD.md) or [Intel Mac](docs/INTEL_MAC_BUILD.md).

Start in a fresh source checkout or a new directory created from the public source export. Do not prepare the runtime in an existing working copy that contains ignored `runtime/` files. The fetcher leaves existing files in place and refuses mismatched architectures; every Tauri bundle build also fails unless the selected engine and plugin match the selected architecture and `runtime.manifest.json`.

The public source export omits prebuilt runtime binaries. Build the pinned runtime for the selected architecture, verify it in an empty account store, then build the app:

```bash
npm ci
export WB_RUNTIME_ARCH=arm64
python3 scripts/fetch-proxy-runtime.py
python3 scripts/build-patched-engine.py
python3 scripts/update-runtime-manifest.py
python3 scripts/smoke-proxy-runtime.py
npm run tauri -- build --target aarch64-apple-darwin --bundles app
```

The runtime downloads are pinned by SHA-256 in `runtime.lock.json`. The patched engine uses the source revision, patch hash, and macOS 15.0 minimum recorded in `docs/runtime-build.json`. Every Tauri bundle build first checks the selected engine/plugin architecture, executable mode, and manifest hashes; the bundle verifier also compares all three Mach-O minimums with the declared macOS minimum.

The push/PR checks cover frontend tests/build and the `wb-switch-core` and `wb-switch-server` Rust suites. The optional manual/preview-tag workflow prepares the pinned runtime and runs `wb-switch-rust` tests, including the moved-app runtime-path migration regressions, before packaging. It uploads workflow artifacts only; it does not create or publish a GitHub Release.

## Branding update in 0.1.4

The app name and product version now stay consistent in the sidebar title, footer, startup fallback, and settings. WorkBuddy and CodeBuddy labels continue to identify the managed clients.

## Sidebar icon update in 0.1.5

The sidebar now uses the same transparent, rounded-corner app icon as the Dock icon, at a size tuned for the compact brand row.

## Interface refinement in 0.1.3

Account status icons now have accessible names, the account action area is quieter, proxy preview explains its example address and disabled actions, and settings descriptions are easier to read. Keyboard focus and reduced-motion loading indicators retain the existing component system.

This refinement follows [Hallmark](https://github.com/Nutlope/hallmark) and [Impeccable](https://github.com/pbakaus/impeccable) design guidance. They are development tools, not bundled runtime dependencies. Seventy frontend tests and the production frontend build passed; the native ARM64 package passed architecture, minimum-system, runtime-hash, signature and archive checks. Synthetic browser previews were reviewed; the packaged app was not launched against a real account store. Automated web checks do not establish WKWebView, VoiceOver or real-account acceptance.

## Data and security

Account data stays in the user's data directory and is not part of the app bundle or public source export. The API key grants access to the local proxy and should be treated as a secret. Keep exported account backups private. See [third-party notices](THIRD_PARTY_NOTICES.md) for component licenses and [SECURITY.md](SECURITY.md) for reporting guidance.

The app is a preview, not a security certification. No real-account or real-inference test is claimed for release 0.1.5. This build validation does not sign into accounts or send model requests.

## Upstream and improvement provenance

This source descends from [`changexbc/workbuddy-switch`](https://github.com/changexbc/workbuddy-switch), using upstream `main` commit `22b318c1f44b335c2222e444abcc2d0f74e160f7` as the baseline. The Switch2 improvements were developed in the `yihuirui/Workbuddy-Switch2` source snapshot at commit `a35a180a137598e1b8600948b5c2b4c843b349d9`.

Switch2 adds the macOS preview packaging and interface refinements, and integrates a local model API proxy using pinned CLIProxyAPI and WorkBuddy provider sources. Integration details and validation limits are in [docs/INTEGRATION.md](docs/INTEGRATION.md). This project is an independent derivative; it is not an official WorkBuddy, Tencent, or CLIProxyAPI release.

The upstream project and this derivative use the MIT License. Keep [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), along with the component license files they reference, in redistributed copies.
