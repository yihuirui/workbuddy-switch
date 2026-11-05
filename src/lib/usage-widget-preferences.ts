export const USAGE_WIDGET_METRIC_KEYS = [
  "todayTokens",
  "tokenConsumptionRate",
  "aiGenerationRate",
  "credits",
  "proxy",
  "cpu",
  "memory",
] as const;

export type UsageWidgetMetricKey = (typeof USAGE_WIDGET_METRIC_KEYS)[number];

export interface UsageWidgetPreferences {
  metrics: Record<UsageWidgetMetricKey, boolean>;
}

export const USAGE_WIDGET_PREFERENCES_KEY = "wb-switch:usage-widget:preferences:v1";

export const DEFAULT_USAGE_WIDGET_PREFERENCES: UsageWidgetPreferences = {
  metrics: {
    todayTokens: true,
    tokenConsumptionRate: true,
    aiGenerationRate: true,
    credits: true,
    proxy: true,
    cpu: true,
    memory: true,
  },
};

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function copyDefaults(): UsageWidgetPreferences {
  return { metrics: { ...DEFAULT_USAGE_WIDGET_PREFERENCES.metrics } };
}

function resolveStorage(storage?: KeyValueStorage | null): KeyValueStorage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readUsageWidgetPreferences(storage?: KeyValueStorage | null): UsageWidgetPreferences {
  const target = resolveStorage(storage);
  if (!target) return copyDefaults();

  try {
    const raw = target.getItem(USAGE_WIDGET_PREFERENCES_KEY);
    if (!raw) return copyDefaults();
    const parsed = JSON.parse(raw) as { metrics?: Record<string, unknown> };
    const metrics = copyDefaults().metrics;
    for (const key of USAGE_WIDGET_METRIC_KEYS) {
      if (typeof parsed.metrics?.[key] === "boolean") metrics[key] = parsed.metrics[key] as boolean;
    }
    return { metrics };
  } catch {
    return copyDefaults();
  }
}

export function writeUsageWidgetPreferences(
  value: UsageWidgetPreferences,
  storage?: KeyValueStorage | null,
): void {
  const target = resolveStorage(storage);
  if (!target) return;

  const metrics = copyDefaults().metrics;
  for (const key of USAGE_WIDGET_METRIC_KEYS) metrics[key] = value.metrics[key] === true;
  try {
    target.setItem(USAGE_WIDGET_PREFERENCES_KEY, JSON.stringify({ metrics } satisfies UsageWidgetPreferences));
  } catch {
    // Storage can be unavailable in restricted webviews; visible settings remain usable in memory.
  }
}

export function setUsageWidgetMetric(
  preferences: UsageWidgetPreferences,
  key: UsageWidgetMetricKey,
  checked: boolean,
): UsageWidgetPreferences {
  return { metrics: { ...preferences.metrics, [key]: checked } };
}
