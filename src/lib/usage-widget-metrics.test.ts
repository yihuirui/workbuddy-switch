import { describe, expect, it } from "vitest";

import {
  creditWidgetSnapshot,
  formatBytes,
  formatRateWindow,
  localDateKey,
  todayTokenSnapshot,
  tokenConsumptionRate,
} from "./usage-widget-metrics";
import type { CreditStatistics, TokenStatistics, TokenStatsSource } from "./types";

function source(name: TokenStatsSource["source"], filesScanned: number, daily: TokenStatsSource["daily"], parseErrors = 0): TokenStatsSource {
  const empty = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, uncachedInput: 0, records: 0, cacheHitRate: null };
  return {
    source: name,
    summary: { ...empty },
    models: [],
    projects: [],
    sessions: [],
    daily,
    hours: [],
    filesScanned,
    parseErrors,
  };
}

function dayGroup(key: string, total: number) {
  return { key, total, input: total, output: 0, cacheRead: 0, cacheWrite: 0, uncachedInput: 0, records: 1, cacheHitRate: null };
}

function tokenStats(generatedAt: number, sources: TokenStatsSource[]): TokenStatistics {
  return { generatedAt, rangeDays: null, sources };
}

function creditStats(overrides: Partial<CreditStatistics> = {}): CreditStatistics {
  return {
    generatedAt: 1_800_000_000_000,
    retentionDays: 30,
    coverageStartAt: null,
    summary: {
      currentRemaining: 400,
      currentCapacity: 500,
      usageToday: 12,
      usage7Days: 20,
      usageThisMonth: 30,
      todayCheckedInAccounts: 0,
      todaySuccess: 0,
      todayAlready: 0,
      todayFailed: 0,
    },
    daily: [],
    accounts: [{
      accountId: "synthetic-account",
      accountName: "synthetic",
      isCurrent: true,
      currentRemaining: 400,
      totalCapacity: 500,
      lastSnapshotAt: null,
      usageToday: 12,
      usage7Days: 20,
      usageThisMonth: 30,
      checkedInToday: null,
      checkinStatusToday: null,
      lastCheckinAt: null,
      lastCheckinResult: null,
    }],
    events: [],
    ...overrides,
  };
}

describe("usage widget token metrics", () => {
  it("aggregates today's local-day groups and notes parse errors", () => {
    const at = new Date(2026, 10, 6, 10, 0, 0).getTime();
    const day = localDateKey(at);
    const stats = tokenStats(at, [
      source("workbuddy", 2, [dayGroup(day, 120)]),
      source("codebuddy-cli", 1, [dayGroup(day, 30)], 1),
      source("workbuddy-ai", 0, []),
      source("codebuddy-ide", 0, []),
    ]);
    expect(todayTokenSnapshot(stats)).toEqual({ dateKey: day, total: 150, generatedAt: at, partial: true });
  });

  it("returns unknown when no source files were scanned instead of showing a fabricated zero", () => {
    const at = new Date(2026, 10, 6, 10, 0, 0).getTime();
    expect(todayTokenSnapshot(tokenStats(at, [source("workbuddy", 0, [])]))).toBeNull();
    expect(todayTokenSnapshot(tokenStats(Number.NaN, [source("workbuddy", 1, [])]))).toBeNull();
  });

  it("computes an explicitly windowed local-log consumption rate only for increasing same-day snapshots", () => {
    const previous = { dateKey: "2026-11-06", total: 1_000, generatedAt: 1_800_000_000_000, partial: false };
    const current = { dateKey: "2026-11-06", total: 1_060, generatedAt: 1_800_000_120_000, partial: false };
    expect(tokenConsumptionRate(previous, current)).toEqual({
      tokens: 60,
      elapsedMs: 120_000,
      tokensPerMinute: 30,
      windowStartAt: previous.generatedAt,
      windowEndAt: current.generatedAt,
    });
    expect(tokenConsumptionRate(previous, { ...current, total: 900 })).toBeNull();
    expect(tokenConsumptionRate(previous, { ...current, dateKey: "2026-11-07" })).toBeNull();
    expect(tokenConsumptionRate({ ...previous, partial: true }, current)).toBeNull();
    expect(tokenConsumptionRate(previous, { ...current, partial: true })).toBeNull();
  });
});

describe("usage widget credit/system formatting", () => {
  it("uses cached official usage when available and local observations otherwise", () => {
    const official = creditWidgetSnapshot(creditStats({
      officialUsage: {
        status: "partial",
        rangeStart: "2026-11-06",
        rangeEnd: "2026-11-07",
        collectedAt: 1_800_000_000_000,
        summary: { usageToday: 18, usage7Days: 25, usageThisMonth: 35 },
        daily: [],
        accounts: [],
        requests: [],
        errors: [],
        detailLimitPerAccount: 20,
      },
    }));
    expect(official).toMatchObject({ remaining: 400, todayUsage: 18, todayUsageSource: "official-cache" });

    const local = creditWidgetSnapshot(creditStats());
    expect(local).toMatchObject({ remaining: 400, todayUsage: 12, todayUsageSource: "local-observation" });
    expect(creditWidgetSnapshot(creditStats({ accounts: [] })).remaining).toBeNull();
  });

  it("formats system memory and explicitly sized rate windows", () => {
    expect(formatBytes(1_073_741_824)).toBe("1 GB");
    expect(formatRateWindow(120_000)).toBe("最近 2 分钟");
  });
});
