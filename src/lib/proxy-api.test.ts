import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./api", () => ({ isDesktop: () => true }));
vi.mock("./demo-mode", () => ({ demoModeEnabled: true }));

import { proxyCall } from "./proxy-api";

describe("proxyCall 演示模式保护", () => {
  beforeEach(() => invoke.mockClear());

  it("即使运行在桌面主机，演示模式也不会调用代理命令", async () => {
    await expect(proxyCall("proxy_start")).rejects.toThrow("演示模式下不可操作");
    expect(invoke).not.toHaveBeenCalled();
  });
});
