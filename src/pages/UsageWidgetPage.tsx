import { useEffect, useRef, useState } from "react";
import { Activity, ArrowLeftToLine, RefreshCw, Settings2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/api";
import {
  creditWidgetSnapshot,
  formatBytes,
  formatCompactNumber,
  formatCredits,
  formatRateWindow,
  todayTokenSnapshot,
  tokenConsumptionRate,
  type CreditWidgetSnapshot,
  type TodayTokenSnapshot,
  type TokenConsumptionRate,
} from "@/lib/usage-widget-metrics";
import {
  readUsageWidgetPreferences,
  setUsageWidgetMetric,
  writeUsageWidgetPreferences,
  type UsageWidgetMetricKey,
  type UsageWidgetPreferences,
} from "@/lib/usage-widget-preferences";
import {
  closeUsageWidget,
  getUsageWidgetSystemMetrics,
  resetUsageWidgetSystemMetrics,
  returnToMain,
  type SystemUsageSample,
} from "@/lib/usage-widget";
import { proxyCall, type ProxyStatus } from "@/lib/proxy-api";

type MetricLoadState = "loading" | "ready" | "error";
type TokenState = { status: MetricLoadState; value: TodayTokenSnapshot | null; rate: TokenConsumptionRate | null; error: string | null };
type CreditState = { status: MetricLoadState; value: CreditWidgetSnapshot | null; error: string | null };
type ProxyState = { status: MetricLoadState; value: ProxyStatus | null; error: string | null };
type SystemState = { loading: boolean; value: SystemUsageSample | null; error: string | null };

const TOKEN_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const SYSTEM_REFRESH_INTERVAL_MS = 5 * 1000;

const METRIC_OPTIONS: { key: UsageWidgetMetricKey; label: string }[] = [
  { key: "todayTokens", label: "今日累计 Token" },
  { key: "tokenConsumptionRate", label: "Token 消耗速率" },
  { key: "aiGenerationRate", label: "AI 生成 tokens/s" },
  { key: "credits", label: "积分" },
  { key: "proxy", label: "代理状态" },
  { key: "cpu", label: "电脑 CPU" },
  { key: "memory", label: "电脑内存" },
];

function errorText(error: unknown): string {
  return api.asError(error);
}

function timeLabel(timestamp: number | null | undefined): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function cpuWindowLabel(milliseconds: number | null): string {
  if (!milliseconds || milliseconds <= 0) return "正在采样";
  const seconds = milliseconds / 1000;
  return `最近 ${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(seconds)} 秒`;
}

function ErrorNote({ children }: { children: string }) {
  return <p className="col-span-2 mt-1 text-xs leading-4 text-destructive">{children}</p>;
}

function MetricRow({
  label,
  value,
  detail,
  status,
  error,
}: {
  label: string;
  value: string;
  detail?: string;
  status?: string;
  error?: string | null;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-3 py-3">
      <h2 className="min-w-0 text-[13px] font-medium leading-5">{label}</h2>
      <p className="max-w-[180px] break-words text-right text-sm font-semibold tabular-nums leading-5">{value}</p>
      {detail && <p className="col-span-2 text-xs leading-4 text-muted-foreground">{detail}</p>}
      {status && <p className="col-span-2 text-[11px] leading-4 text-muted-foreground">{status}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

export default function UsageWidgetPage() {
  const [preferences, setPreferences] = useState<UsageWidgetPreferences>(() => readUsageWidgetPreferences());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tokenState, setTokenState] = useState<TokenState>({ status: "loading", value: null, rate: null, error: null });
  const [creditState, setCreditState] = useState<CreditState>({ status: "loading", value: null, error: null });
  const [proxyState, setProxyState] = useState<ProxyState>({ status: "loading", value: null, error: null });
  const [systemState, setSystemState] = useState<SystemState>({ loading: true, value: null, error: null });
  const [lastReadAt, setLastReadAt] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const tokenSequence = useRef(0);
  const systemSequence = useRef(0);
  const tokenBusy = useRef(false);
  const systemBusy = useRef(false);
  const previousTokenSnapshot = useRef<TodayTokenSnapshot | null>(null);

  const metrics = preferences.metrics;
  const tokensEnabled = metrics.todayTokens || metrics.tokenConsumptionRate;
  const creditsEnabled = metrics.credits;
  const proxyEnabled = metrics.proxy;
  const systemEnabled = metrics.cpu || metrics.memory;

  useEffect(() => {
    writeUsageWidgetPreferences(preferences);
  }, [preferences]);

  async function refreshData() {
    if (tokenBusy.current) return;
    tokenBusy.current = true;
    const sequence = ++tokenSequence.current;
    setRefreshing(true);
    const requests = await Promise.allSettled([
      tokensEnabled ? api.getTokenStatistics() : Promise.resolve(null),
      creditsEnabled ? api.getCreditStatistics(false) : Promise.resolve(null),
      proxyEnabled ? proxyCall<ProxyStatus>("proxy_status") : Promise.resolve(null),
    ] as const);
    if (sequence !== tokenSequence.current) {
      return;
    }

    const [tokenResult, creditResult, proxyResult] = requests;
    if (tokensEnabled) {
      if (tokenResult.status === "fulfilled" && tokenResult.value) {
        const current = todayTokenSnapshot(tokenResult.value);
        setTokenState({
          status: "ready",
          value: current,
          rate: tokenConsumptionRate(previousTokenSnapshot.current, current),
          error: null,
        });
        previousTokenSnapshot.current = current;
      } else if (tokenResult.status === "rejected") {
        setTokenState((current) => ({ ...current, status: "error", rate: null, error: errorText(tokenResult.reason) }));
        previousTokenSnapshot.current = null;
      } else {
        setTokenState({ status: "ready", value: null, rate: null, error: null });
        previousTokenSnapshot.current = null;
      }
    }

    if (creditsEnabled) {
      if (creditResult.status === "fulfilled" && creditResult.value) {
        setCreditState({ status: "ready", value: creditWidgetSnapshot(creditResult.value), error: null });
      } else if (creditResult.status === "rejected") {
        setCreditState((current) => ({ ...current, status: "error", error: errorText(creditResult.reason) }));
      } else {
        setCreditState({ status: "ready", value: null, error: null });
      }
    }

    if (proxyEnabled) {
      if (proxyResult.status === "fulfilled" && proxyResult.value) {
        setProxyState({ status: "ready", value: proxyResult.value, error: null });
      } else if (proxyResult.status === "rejected") {
        setProxyState((current) => ({ ...current, status: "error", error: errorText(proxyResult.reason) }));
      } else {
        setProxyState({ status: "ready", value: null, error: null });
      }
    }

    setLastReadAt(Date.now());
    setRefreshing(false);
    tokenBusy.current = false;
  }

  async function sampleSystem() {
    if (!systemEnabled || systemBusy.current || document.visibilityState !== "visible") return;
    systemBusy.current = true;
    const sequence = ++systemSequence.current;
    try {
      const value = await getUsageWidgetSystemMetrics();
      if (sequence === systemSequence.current) setSystemState({ loading: false, value, error: null });
    } catch (error) {
      if (sequence === systemSequence.current) setSystemState({ loading: false, value: null, error: errorText(error) });
    } finally {
      systemBusy.current = false;
    }
  }

  useEffect(() => {
    if (tokensEnabled || creditsEnabled || proxyEnabled) {
      void refreshData();
      const timer = window.setInterval(() => {
        if (document.visibilityState === "visible") void refreshData();
      }, TOKEN_REFRESH_INTERVAL_MS);
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          void refreshData();
        } else {
          previousTokenSnapshot.current = null;
          setTokenState((current) => ({ ...current, rate: null }));
        }
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        window.clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        tokenSequence.current += 1;
        tokenBusy.current = false;
        previousTokenSnapshot.current = null;
      };
    }
    previousTokenSnapshot.current = null;
    setTokenState({ status: "ready", value: null, rate: null, error: null });
    setCreditState({ status: "ready", value: null, error: null });
    setProxyState({ status: "ready", value: null, error: null });
    setRefreshing(false);
  }, [tokensEnabled, creditsEnabled, proxyEnabled]);

  useEffect(() => {
    if (!systemEnabled) {
      systemSequence.current += 1;
      setSystemState({ loading: false, value: null, error: null });
      void resetUsageWidgetSystemMetrics().catch(() => undefined);
      return;
    }

    void sampleSystem();
    const timer = window.setInterval(() => void sampleSystem(), SYSTEM_REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void sampleSystem();
      } else {
        systemSequence.current += 1;
        setSystemState({ loading: true, value: null, error: null });
        void resetUsageWidgetSystemMetrics().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      systemSequence.current += 1;
      void resetUsageWidgetSystemMetrics().catch(() => undefined);
    };
  }, [systemEnabled]);

  function updateMetric(key: UsageWidgetMetricKey, checked: boolean) {
    setPreferences((current) => setUsageWidgetMetric(current, key, checked));
  }

  async function close() {
    setActionError(null);
    try {
      await closeUsageWidget();
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function backToMain() {
    setActionError(null);
    try {
      await returnToMain();
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  const tokenValue = tokenState.value;
  const tokenRate = tokenState.rate;
  const credits = creditState.value;
  const proxy = proxyState.value;
  const system = systemState.value;
  const anyVisibleMetric = Object.values(metrics).some(Boolean);

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2.5">
        <div data-tauri-drag-region className="min-w-0 flex-1 cursor-grab select-none active:cursor-grabbing">
          <h1 data-tauri-drag-region className="text-sm font-semibold tracking-tight">本机用量</h1>
          <p data-tauri-drag-region className="mt-0.5 text-[11px] leading-4 text-muted-foreground">Token 日志、积分缓存与系统只读采样</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="刷新用量" title="刷新用量" disabled={refreshing} onClick={() => { void refreshData(); void sampleSystem(); }}>
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`} />
          </Button>
          <Button type="button" variant={settingsOpen ? "secondary" : "ghost"} size="icon" className="size-8" aria-label="配置显示指标" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
            <Settings2 className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="返回主界面" title="返回主界面" onClick={() => void backToMain()}>
            <ArrowLeftToLine className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="关闭用量悬浮窗" title="关闭" onClick={() => void close()}>
            <X className="size-4" />
          </Button>
        </div>
      </header>

      {settingsOpen && (
        <section aria-labelledby="widget-settings" className="shrink-0 border-b bg-muted/20 px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id="widget-settings" className="text-xs font-semibold">显示指标</h2>
            <Badge variant="outline" className="text-[10px]">仅保存显示选项</Badge>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {METRIC_OPTIONS.map((option) => (
              <label key={option.key} className="flex min-w-0 items-start gap-2 py-1 text-xs leading-4">
                <input
                  type="checkbox"
                  className="mt-0.5 size-3.5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  checked={metrics[option.key]}
                  onChange={(event) => updateMetric(option.key, event.target.checked)}
                />
                <span className="min-w-0">{option.label}</span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">AI 生成速度仅在可验证单次生成时长时显示；当前数据源没有该信息。</p>
        </section>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!anyVisibleMetric ? (
          <p className="px-4 py-6 text-sm leading-5 text-muted-foreground">所有指标都已隐藏。打开设置选择要显示的内容。</p>
        ) : (
          <div className="divide-y">
            {metrics.todayTokens && (
              <MetricRow
                label="今日累计 Token"
                value={tokenState.status === "error" ? "读取失败" : tokenValue ? `${formatCompactNumber(tokenValue.total)} tokens` : tokenState.status === "loading" ? "读取中…" : "未采集"}
                detail="本机会话日志的当日累计值"
                status={tokenValue ? `${tokenState.status === "error" ? "上次成功统计于" : "统计于"} ${timeLabel(tokenValue.generatedAt)}${tokenValue.partial ? " · 部分日志解析失败" : ""}` : undefined}
                error={tokenState.status === "error" ? tokenState.error : null}
              />
            )}

            {metrics.tokenConsumptionRate && (
              <MetricRow
                label="Token 消耗速率"
                value={tokenRate ? `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(tokenRate.tokensPerMinute)} tokens/min` : "未采集"}
                detail={tokenRate
                  ? `${formatRateWindow(tokenRate.elapsedMs)}日志累计增加 ${formatCompactNumber(tokenRate.tokens)} tokens`
                  : "等待下一次本地日志快照；速率是两个采样时刻之间的平均消耗"}
                status={tokenRate ? `${timeLabel(tokenRate.windowStartAt)}–${timeLabel(tokenRate.windowEndAt)}` : undefined}
                error={tokenState.status === "error" ? tokenState.error : null}
              />
            )}

            {metrics.aiGenerationRate && (
              <MetricRow
                label="AI 生成速度"
                value="未采集"
                detail="当前日志没有单次流式生成的持续时长，不能可靠计算 tokens/s。"
              />
            )}

            {metrics.credits && (
              <MetricRow
                label="积分"
                value={creditState.status === "error" ? "读取失败" : credits?.remaining == null ? creditState.status === "loading" ? "读取中…" : "未采集" : `${formatCredits(credits.remaining)} 剩余`}
                detail={credits?.todayUsage == null ? "今日消耗未采集" : `今日消耗 ${formatCredits(credits.todayUsage)} · ${credits.todayUsageSource === "official-cache" ? "官方缓存" : "本地观察"}`}
                status={credits?.collectedAt ? `采集于 ${timeLabel(credits.collectedAt)}` : undefined}
                error={creditState.status === "error" ? creditState.error : null}
              />
            )}

            {metrics.proxy && (
              <MetricRow
                label="本地代理"
                value={proxyState.status === "error" ? "读取失败" : proxy ? proxy.running ? "运行中" : "已停止" : proxyState.status === "loading" ? "读取中…" : "未采集"}
                detail={proxyState.status === "error" ? "上次读取失败；不会发起模型请求" : proxy ? `已同步 ${proxy.syncedAccounts} 个账号 · 已启用 ${proxy.pool.filter((item) => item.enabled).length} 项` : "只读取代理服务状态，不发起模型请求"}
                error={proxyState.status === "error" ? proxyState.error : null}
              />
            )}

            {metrics.cpu && (
              <MetricRow
                label="电脑 CPU"
                value={system?.supported
                  ? system.cpuPercent == null ? "采集中" : `${system.cpuPercent.toFixed(1)}%`
                  : system?.supported === false ? "未采集" : systemState.loading ? "读取中…" : "未采集"}
                detail={system?.supported && system.cpuPercent != null ? `整机非空闲 tick 比例 · ${cpuWindowLabel(system.cpuWindowMs)}` : "整机 CPU 采样窗口建立后显示"}
                error={system?.cpuError || systemState.error || (system?.supported === false ? "当前只实现 macOS 系统采样" : null)}
              />
            )}

            {metrics.memory && (
              <MetricRow
                label="电脑内存"
                value={system?.memoryUsedBytes != null && system.memoryTotalBytes != null
                  ? `${formatBytes(system.memoryUsedBytes)} / ${formatBytes(system.memoryTotalBytes)}`
                  : system?.supported === false ? "未采集" : systemState.loading ? "读取中…" : "未采集"}
                detail={system?.memoryBasis ? `占用口径：${system.memoryBasis}（不含可回收闲置/空闲页）· 物理内存来自 hw.memsize` : "等待 macOS VM 统计"}
                status={system?.sampledAt ? `采样于 ${timeLabel(system.sampledAt)}` : undefined}
                error={system?.memoryError || systemState.error || (system?.supported === false ? "当前只实现 macOS 系统采样" : null)}
              />
            )}
          </div>
        )}

        {actionError && <p role="alert" className="mx-3 my-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">{actionError}</p>}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2 text-[10px] leading-4 text-muted-foreground">
        <span>{lastReadAt ? `刷新于 ${timeLabel(lastReadAt)}` : <><Activity className="mr-1 inline size-3" />等待数据</>}</span>
        <span>关闭后停止采样</span>
      </footer>
    </main>
  );
}
