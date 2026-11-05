import { describe, expect, it, vi } from "vitest";

import { backupSingleAccount } from "./workbench-account-backup";

function mockPorts() {
  return {
    chooseSavePath: vi.fn(async (_filename: string): Promise<string | null> => "/backups/account.json"),
    exportToPath: vi.fn(async (_accountIds: string[], _path: string) => ({ ok: true, path: "/backups/account.json" })),
    exportForDownload: vi.fn(async (_accountIds: string[]) => ({ ok: true, accounts: [{ id: "mock-account" }] })),
    download: vi.fn((_filename: string, _text: string) => undefined),
  };
}

describe("single account backup", () => {
  it("saves exactly the selected desktop account to the chosen path when confirmed", async () => {
    const ports = mockPorts();
    const result = await backupSingleAccount("mock-account", "account.json", "desktop", ports);

    expect(result).toEqual({ kind: "saved", path: "/backups/account.json" });
    expect(ports.chooseSavePath).toHaveBeenCalledWith("account.json");
    expect(ports.exportToPath).toHaveBeenCalledWith(["mock-account"], "/backups/account.json");
    expect(ports.exportForDownload).not.toHaveBeenCalled();
  });

  it("does not treat an explicit desktop ok=false response as success", async () => {
    const ports = mockPorts();
    ports.exportToPath.mockResolvedValue({ ok: false, path: "/backups/account.json" });

    const result = await backupSingleAccount("mock-account", "account.json", "desktop", ports);

    expect(result).toMatchObject({ kind: "failed", message: expect.stringContaining("未确认") });
  });

  it("does not export when the user cancels the save dialog", async () => {
    const ports = mockPorts();
    ports.chooseSavePath.mockResolvedValue(null);

    const result = await backupSingleAccount("mock-account", "account.json", "desktop", ports);

    expect(result).toEqual({ kind: "cancelled" });
    expect(ports.exportToPath).not.toHaveBeenCalled();
    expect(ports.exportForDownload).not.toHaveBeenCalled();
    expect(ports.download).not.toHaveBeenCalled();
  });

  it("downloads a browser export only after an explicit ok=true single-account response", async () => {
    const ports = mockPorts();
    const records = [{ id: "mock-account", access_token: "mock-only" }];
    ports.exportForDownload.mockResolvedValue({ ok: true, accounts: records });

    const result = await backupSingleAccount("mock-account", "account.json", "browser", ports);

    expect(result).toEqual({ kind: "downloaded", filename: "account.json" });
    expect(ports.exportForDownload).toHaveBeenCalledWith(["mock-account"]);
    expect(ports.download).toHaveBeenCalledWith("account.json", JSON.stringify(records, null, 2));
    expect(ports.exportToPath).not.toHaveBeenCalled();
  });

  it("does not create a browser download when ok=false or the result is not one account", async () => {
    const ports = mockPorts();
    ports.exportForDownload.mockResolvedValueOnce({ ok: false, accounts: [{ id: "mock-account" }] });
    const failed = await backupSingleAccount("mock-account", "account.json", "browser", ports);
    expect(failed).toMatchObject({ kind: "failed", message: expect.stringContaining("未确认") });
    expect(ports.download).not.toHaveBeenCalled();

    ports.exportForDownload.mockResolvedValueOnce({ ok: true, accounts: [] });
    const invalid = await backupSingleAccount("mock-account", "account.json", "browser", ports);
    expect(invalid).toMatchObject({ kind: "failed", message: expect.stringContaining("单账号") });
    expect(ports.download).not.toHaveBeenCalled();
  });

  it("reports a thrown export error as a failure", async () => {
    const ports = mockPorts();
    ports.exportToPath.mockRejectedValue(new Error("write failed"));

    const result = await backupSingleAccount("mock-account", "account.json", "desktop", ports);

    expect(result).toEqual({ kind: "failed", message: "账号备份失败：write failed" });
  });
});
