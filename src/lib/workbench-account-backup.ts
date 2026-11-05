export interface SingleAccountExportResult {
  ok: unknown;
  path?: unknown;
  accounts?: unknown;
}

export interface SingleAccountBackupPorts {
  chooseSavePath: (filename: string) => Promise<string | null>;
  exportToPath: (accountIds: string[], path: string) => Promise<SingleAccountExportResult>;
  exportForDownload: (accountIds: string[]) => Promise<SingleAccountExportResult>;
  download: (filename: string, text: string) => void;
}

export type SingleAccountBackupResult =
  | { kind: "saved"; path: string }
  | { kind: "downloaded"; filename: string }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

/**
 * Runs one explicitly requested account export. Each host adapter is injected so
 * tests can verify response handling without touching real account data.
 */
export async function backupSingleAccount(
  accountId: string,
  filename: string,
  host: "desktop" | "browser",
  ports: SingleAccountBackupPorts,
): Promise<SingleAccountBackupResult> {
  try {
    if (!accountId) return { kind: "failed", message: "请先选择一个账号。" };
    if (host === "desktop") {
      const path = await ports.chooseSavePath(filename);
      if (!path) return { kind: "cancelled" };
      const result = await ports.exportToPath([accountId], path);
      if (result.ok !== true) return { kind: "failed", message: "后端未确认账号备份成功。请检查保存位置后重试。" };
      return {
        kind: "saved",
        path: typeof result.path === "string" && result.path.trim() ? result.path : path,
      };
    }

    const result = await ports.exportForDownload([accountId]);
    if (result.ok !== true) return { kind: "failed", message: "后端未确认账号导出成功，未生成下载文件。" };
    if (!Array.isArray(result.accounts) || result.accounts.length !== 1) {
      return { kind: "failed", message: "导出结果不是单账号文件，未生成下载文件。" };
    }
    ports.download(filename, JSON.stringify(result.accounts, null, 2));
    return { kind: "downloaded", filename };
  } catch (error) {
    return { kind: "failed", message: `账号备份失败：${errorMessage(error)}` };
  }
}
