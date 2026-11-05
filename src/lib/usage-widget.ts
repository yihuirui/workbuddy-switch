import { invoke } from "@tauri-apps/api/core";

export interface SystemUsageSample {
  supported: boolean;
  sampledAt: number;
  cpuPercent: number | null;
  cpuWindowMs: number | null;
  cpuError: string | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  memoryBasis: string | null;
  memoryError: string | null;
}

export function toggleUsageWidget(): Promise<boolean> {
  return invoke("toggle_usage_widget");
}

export function closeUsageWidget(): Promise<void> {
  return invoke("close_usage_widget");
}

export function returnToMain(): Promise<void> {
  return invoke("return_to_main");
}

export function getUsageWidgetSystemMetrics(): Promise<SystemUsageSample> {
  return invoke("get_usage_widget_system_metrics");
}

export function resetUsageWidgetSystemMetrics(): Promise<void> {
  return invoke("reset_usage_widget_system_metrics");
}
