export const GITHUB_OWNER = "yihuirui";
export const GITHUB_REPO = "workbuddy-switch";
export const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
export const GITHUB_RELEASE_URL = `${GITHUB_REPOSITORY_URL}/releases`;

/** 在桌面端通过 Tauri opener 打开，在 webui 端打开新标签页。 */
export async function openReleaseUrl(url = GITHUB_RELEASE_URL): Promise<void> {
  const releasesPath = `${GITHUB_REPOSITORY_URL}/releases`;
  if (url !== releasesPath && !url.startsWith(`${releasesPath}/`)) {
    throw new Error("无效的 Workbuddy-Switch Release 地址");
  }
  const isWebui = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  if (isWebui) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
