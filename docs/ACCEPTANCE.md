# Preview release acceptance

The Workbuddy-Switch2 macOS preview produces separate ARM64 and Intel x86_64 `.app` bundles for macOS 15.0 or newer. Before publishing artifacts, the release pipeline must check the following:

- Minimum macOS is 15.0, matching the bundled Go engine's Mach-O deployment target.

- The push/PR checks run `npm test`, the frontend build, and the core/server Rust suites. The manual preview build prepares the pinned runtime first, then runs `npm test`, the frontend build, `cargo test -p wb-switch-rust --locked` (including the moved-app runtime-path migration regressions), and the Rust workspace tests before packaging.
- Each build uses the architecture-matched runtime assets pinned by SHA-256 in `runtime.lock.json` and the pinned Darwin engine patch.
- The runtime smoke test uses an empty temporary account store, a random local port, and random test keys. It does not make model requests.
- The app executable, proxy engine, and plugin all contain exactly the requested architecture (ARM64 or x86_64); the bundled proxy engine is executable; the bundle contains no other architecture, accounts, logs, or caches.
- Bundle identity remains `com.wbcli.switch.proxyapi`; account data stays in `~/.wbcli-switch-proxyapi/`.
- ZIP integrity and SHA-256 output are checked by the packaging helper.

The current local outputs have passed architecture, signature, checksum, archive, and empty-store runtime checks. The x86_64 artifact was cross-built on Apple silicon and its runtime smoke ran under Rosetta; it has not yet been launched on physical Intel hardware. Neither build is Developer ID signed or Apple-notarized. Neither has been tested with real account sign-in, real model inference, streaming requests, quota use, or check-in. Windows and Linux are not covered.

Per-run command output and machine-specific evidence are kept under `outputs/` and are excluded from the public source export. The release workflow artifact and checksum should be reviewed before being attached to a GitHub Release.
