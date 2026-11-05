# Usage floating window

The **用量悬浮窗** button in the desktop sidebar opens or closes a small always-on-top window. It is created only after the user clicks the button; it is not launched at startup and does not depend on Agent Companion. The title area can be dragged, and the window can return to the main app or close itself.

## Metrics and their sources

- **Today's Tokens** sums the current local date bucket from the existing Token statistics API. It is a local log observation, not a server-side billing total.
- **Token consumption rate** compares two successful cumulative local-log snapshots. It shows the observed Token increase divided by the exact `generatedAt` interval in tokens per minute. The first read, a day boundary, missing data, or a decreasing/corrected total leaves the rate uncollected.
- **AI generation tokens/s** remains uncollected. Current request logs do not provide reliable per-request generation duration; aggregate Token changes are not treated as generation speed.
- **Credits** reads the existing statistics projection without forcing an official usage refresh. It prefers cached official usage when available and labels local observations separately.
- **Proxy status** reads only whether the local proxy is running and its account-pool counts. The widget does not send a model request.
- **Computer CPU** uses macOS Mach host CPU tick deltas over the most recent visible sampling interval. The percentage is non-idle ticks divided by total ticks across the whole machine.
- **Computer memory** uses macOS VM counts for active, wired, and compressed pages. Physical total comes from `hw.memsize`; free and inactive/reclaimable pages are excluded from the displayed used amount. This is a defined host-memory calculation, not process RSS.

CPU and memory sampling runs every five seconds while the window is visible. Token, credit, and proxy statistics refresh every two minutes while visible; closing the window clears its timers and sampling baseline. Other platforms show system sampling as unavailable until a native read-only source is implemented for them.

Metric visibility preferences are stored in the webview's local storage as booleans only. They contain no account identifiers, credentials, request content, or measured values. The window does not sign in, check in, refresh official usage, or start the proxy.
