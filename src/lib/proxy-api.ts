import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "./api";
import { demoModeEnabled } from "./demo-mode";
export interface ProxySettings { binaryPath: string; pluginPath: string; port: number }
export interface ProxyStatus { lastError: string | null; running: boolean; pid: number | null; baseUrl: string; syncedAccounts: number; pool: {name: string; label: string; enabled: boolean}[]; settings: ProxySettings }
export interface ProxyAccount { id: string; name: string; realm: string; eligible: boolean; synced: boolean; reason: string | null }
export async function proxyCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (demoModeEnabled) throw new Error("演示模式下不可操作");
  if (!isDesktop()) throw new Error("请在 Workbuddy-Switch2 桌面应用中使用此功能");
  return invoke<T>(command, args);
}
