import { describe, expect, it } from "vitest";

import {
  DEFAULT_USAGE_WIDGET_PREFERENCES,
  USAGE_WIDGET_PREFERENCES_KEY,
  readUsageWidgetPreferences,
  setUsageWidgetMetric,
  writeUsageWidgetPreferences,
  type KeyValueStorage,
} from "./usage-widget-preferences";

class MemoryStorage implements KeyValueStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("usage widget preferences", () => {
  it("defaults to visible metrics and recovers from invalid stored JSON", () => {
    const storage = new MemoryStorage();
    expect(readUsageWidgetPreferences(storage)).toEqual(DEFAULT_USAGE_WIDGET_PREFERENCES);
    storage.setItem(USAGE_WIDGET_PREFERENCES_KEY, "{");
    expect(readUsageWidgetPreferences(storage)).toEqual(DEFAULT_USAGE_WIDGET_PREFERENCES);
  });

  it("persists only metric visibility booleans and restores partial settings", () => {
    const storage = new MemoryStorage();
    const preferences = setUsageWidgetMetric(DEFAULT_USAGE_WIDGET_PREFERENCES, "cpu", false);
    writeUsageWidgetPreferences(preferences, storage);

    const persisted = JSON.parse(storage.getItem(USAGE_WIDGET_PREFERENCES_KEY) ?? "null");
    expect(Object.keys(persisted)).toEqual(["metrics"]);
    expect(persisted).toEqual({ metrics: { ...DEFAULT_USAGE_WIDGET_PREFERENCES.metrics, cpu: false } });
    expect(readUsageWidgetPreferences(storage)).toEqual(preferences);
  });

  it("ignores non-boolean and unknown stored fields", () => {
    const storage = new MemoryStorage();
    storage.setItem(USAGE_WIDGET_PREFERENCES_KEY, JSON.stringify({
      metrics: { todayTokens: false, proxy: "off", privateToken: "secret" },
      accountId: "synthetic",
    }));
    const result = readUsageWidgetPreferences(storage);
    expect(result.metrics.todayTokens).toBe(false);
    expect(result.metrics.proxy).toBe(true);
    expect(Object.keys(result)).toEqual(["metrics"]);
    expect(Object.keys(result.metrics)).not.toContain("privateToken");
  });

  it("falls back safely when a restricted webview throws while resolving localStorage", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage() {
          throw new DOMException("storage is blocked", "SecurityError");
        },
      },
    });
    try {
      expect(readUsageWidgetPreferences()).toEqual(DEFAULT_USAGE_WIDGET_PREFERENCES);
      expect(() => writeUsageWidgetPreferences(DEFAULT_USAGE_WIDGET_PREFERENCES)).not.toThrow();
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
