# Third-party notices

Workbuddy-Switch2 is derived from [`changexbc/workbuddy-switch`](https://github.com/changexbc/workbuddy-switch), distributed under the MIT License. The project's MIT license is in [LICENSE](LICENSE).

The application also includes source or runtime components under these licenses:

- [Agent Companion](vendor/agent-companion/LICENSE), MIT; vendored source is under `vendor/agent-companion/`.
- [indexmap](vendor-patched/indexmap/LICENSE-MIT) (MIT) and `LICENSE-APACHE` (Apache-2.0); the patched source is under `vendor-patched/indexmap/`.
- [CLIProxyAPI](licenses/CLIProxyAPI-LICENSE), MIT; the runtime is fetched from the pinned release in `runtime.lock.json`.
- [codebuddy-intl-cpa](licenses/codebuddy-intl-cpa-LICENSE), MIT; the runtime is fetched from the pinned release in `runtime.lock.json`.

The bundled Darwin engine is built from the pinned CLIProxyAPI source revision using `patches/cliproxyapi-darwin-native-threads.patch`. The patch and build metadata are provided for review. This integration is independent and is not an official Tencent, CLIProxyAPI, or WorkBuddy release.

## Feature design references

The account operations console draws functional inspiration from
[workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) (MIT).
The local prompt library and per-account export workflow draw functional
inspiration from [WorkDaddy](https://github.com/babygoton/WorkDaddy)
(AGPL-3.0-or-later). These features are independently implemented using this
project's existing interfaces. No source code or visual assets from either
reference project are incorporated by this integration.
