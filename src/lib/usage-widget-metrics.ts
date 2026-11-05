import type { CreditStatistics, TokenStatistics } from "./types";

export interface TodayTokenSnapshot {
  dateKey: string;
  total: number;
  generatedAt: number;
  partial: boolean;
}

export interface TokenConsumptionRate {
  tokens: number;
  elapsedMs: number;
  tokensPerMinute: number;
  windowStartAt: number;
  windowEndAt: number;
}

export interface CreditWidgetSnapshot {
  remaining: number | null;
  todayUsage: number | null;
  todayUsageSource: "official-cache" | "local-observation" | null;
  collectedAt: number | null;
}

export function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Sum today's locally observed request totals; no scanned source means the value is unknown. */
export function todayTokenSnapshot(stats: TokenStatistics): TodayTokenSnapshot | null {
  if (!Array.isArray(stats.sources) || stats.sources.length === 0) return null;
  const generatedAt = Number.isFinite(stats.generatedAt) ? stats.generatedAt : null;
  if (generatedAt === null) return null;
  const dateKey = localDateKey(generatedAt);
  if (!dateKey) return null;
  const scannedSources = stats.sources.filter((source) => source.filesScanned > 0);
  if (scannedSources.length === 0) return null;

  let total = 0;
  for (const source of scannedSources) {
    const today = source.daily.find((group) => group.key === dateKey);
    if (today && Number.isFinite(today.total)) total += today.total;
  }
  return {
    dateKey,
    total,
    generatedAt,
    partial: stats.sources.some((source) => source.parseErrors > 0),
  };
}

/** Calculate an observed average from local-log totals over an explicit snapshot interval. */
export function tokenConsumptionRate(
  previous: TodayTokenSnapshot | null,
  current: TodayTokenSnapshot | null,
): TokenConsumptionRate | null {
  if (!previous || !current || previous.partial || current.partial || previous.dateKey !== current.dateKey) return null;
  const elapsedMs = current.generatedAt - previous.generatedAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || current.total < previous.total) return null;
  const tokens = current.total - previous.total;
  return {
    tokens,
    elapsedMs,
    tokensPerMinute: tokens / (elapsedMs / 60_000),
    windowStartAt: previous.generatedAt,
    windowEndAt: current.generatedAt,
  };
}

export function creditWidgetSnapshot(stats: CreditStatistics): CreditWidgetSnapshot {
  const hasBalance = stats.accounts.some((account) => account.currentRemaining !== null);
  const official = stats.officialUsage;
  if (official && official.status !== "unavailable") {
    return {
      remaining: hasBalance ? stats.summary.currentRemaining : null,
      todayUsage: official.summary.usageToday,
      todayUsageSource: "official-cache",
      collectedAt: official.collectedAt ?? null,
    };
  }
  return {
    remaining: hasBalance ? stats.summary.currentRemaining : null,
    todayUsage: stats.accounts.length > 0 ? stats.summary.usageToday : null,
    todayUsageSource: stats.accounts.length > 0 ? "local-observation" : null,
    collectedAt: stats.generatedAt,
  };
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

export function formatCredits(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "未采集";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: unit < 2 ? 0 : 1 }).format(size)} ${units[unit]}`;
}

export function formatRateWindow(elapsedMs: number): string {
  const minutes = elapsedMs / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0) return "窗口未知";
  return minutes < 1
    ? `最近 ${Math.max(1, Math.round(minutes * 60))} 秒`
    : `最近 ${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(minutes)} 分钟`;
}
