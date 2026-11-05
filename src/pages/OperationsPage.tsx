import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CircleHelp, Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as api from "@/lib/api";
import { accountIdentity, displayName } from "@/lib/account-display";
import { demoModeEnabled } from "@/lib/demo-mode";
import {
  batchFeedbackMessage,
  batchFeedbackTone,
  buildBatchCheckinLogs,
  checkinOutcomeLabel,
  checkinOutcomeTone,
  derivePoolAccountRow,
  filterCheckinLogs,
  filterPoolAccountRows,
  mergeCheckinLogs,
  normalizeLogTimestamp,
  poolStateLabel,
  poolStateTone,
  type CheckinLogFilter,
  type PoolFilter,
  type ProxyReadState,
} from "@/lib/operations";
import { accountVariant, variantLabel, variantSupportsCheckin } from "@/lib/variant";
import type { AccountMeta, CheckinConfig, CheckinLog } from "@/lib/types";
import { proxyCall, type ProxyAccount, type ProxyStatus } from "@/lib/proxy-api";
import { useAccountsStore } from "@/stores/accounts";

type ReadStatus = "loading" | "ready" | "error" | "unsupported";
type SourceState = { status: ReadStatus; error: string | null };
type Sources = {
  accounts: SourceState;
  checkinLogs: SourceState;
  checkinConfig: SourceState;
  proxyStatus: SourceState;
  proxyPreview: SourceState;
};

const INITIAL_SOURCE: SourceState = { status: "loading", error: null };
const INITIAL_SOURCES: Sources = {
  accounts: INITIAL_SOURCE,
  checkinLogs: INITIAL_SOURCE,
  checkinConfig: INITIAL_SOURCE,
  proxyStatus: INITIAL_SOURCE,
  proxyPreview: INITIAL_SOURCE,
};
const CHECKIN_TIMEOUT_MS = 60_000;

function formatTime(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "尚未读取";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function sourceFailure(error: unknown): SourceState {
  return { status: "error", error: api.asError(error) };
}

function sourceCaption(source: SourceState, readyText: string): string {
  switch (source.status) {
    case "loading": return "读取中…";
    case "ready": return readyText;
    case "error": return `读取失败：${source.error || "原因未知"}`;
    case "unsupported": return "当前环境不支持读取";
  }
}

function accountVariantLabel(account: AccountMeta): string {
  return variantLabel(accountVariant(account));
}

function rowTextTone(state: "synced" | "eligible" | "failed" | "unknown"): string {
  if (state === "failed") return "text-destructive";
  if (state === "unknown") return "text-muted-foreground";
  return "text-foreground";
}

export default function OperationsPage() {
  const accounts = useAccountsStore((state) => state.accounts);
  const [checkinLogs, setCheckinLogs] = useState<CheckinLog[]>([]);
  const [checkinConfig, setCheckinConfig] = useState<CheckinConfig | null>(null);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null);
  const [proxyAccounts, setProxyAccounts] = useState<ProxyAccount[] | null>(null);
  const [sources, setSources] = useState<Sources>(INITIAL_SOURCES);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [poolSearch, setPoolSearch] = useState("");
  const [logFilter, setLogFilter] = useState<CheckinLogFilter>("all");
  const [logSearch, setLogSearch] = useState("");
  const [batchLogs, setBatchLogs] = useState<CheckinLog[]>([]);
  const [batchNote, setBatchNote] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchTimedOut, setBatchTimedOut] = useState(false);
  const refreshSequence = useRef(0);
  const batchSequence = useRef(0);

  async function refresh() {
    const requestId = ++refreshSequence.current;
    const proxySupported = api.isDesktop() && !demoModeEnabled;
    setRefreshing(true);
    setSources({
      accounts: { status: "loading", error: null },
      checkinLogs: { status: "loading", error: null },
      checkinConfig: { status: "loading", error: null },
      proxyStatus: { status: proxySupported ? "loading" : "unsupported", error: null },
      proxyPreview: { status: proxySupported ? "loading" : "unsupported", error: null },
    });

    const proxyStatusRequest: Promise<ProxyStatus | null> = proxySupported
      ? proxyCall<ProxyStatus>("proxy_status")
      : Promise.resolve(null);
    const proxyAccountsRequest: Promise<ProxyAccount[] | null> = proxySupported
      ? proxyCall<ProxyAccount[]>("proxy_preview")
      : Promise.resolve(null);
    const [accountsResult, logsResult, configResult, proxyStatusResult, proxyAccountsResult] = await Promise.allSettled([
      api.getAccounts(),
      api.getCheckinLogs(),
      api.getAutoCheckinConfig(),
      proxyStatusRequest,
      proxyAccountsRequest,
    ]);

    if (requestId !== refreshSequence.current) return;

    const nextSources: Sources = {
      accounts: { status: "loading", error: null },
      checkinLogs: { status: "loading", error: null },
      checkinConfig: { status: "loading", error: null },
      proxyStatus: { status: proxySupported ? "loading" : "unsupported", error: null },
      proxyPreview: { status: proxySupported ? "loading" : "unsupported", error: null },
    };

    if (accountsResult.status === "fulfilled" && Array.isArray(accountsResult.value?.accounts)) {
      useAccountsStore.setState({ accounts: accountsResult.value.accounts });
      nextSources.accounts = { status: "ready", error: null };
    } else if (accountsResult.status === "fulfilled") {
      nextSources.accounts = sourceFailure(new Error("账号列表响应为空或格式无效"));
    } else {
      nextSources.accounts = sourceFailure(accountsResult.reason);
    }

    if (logsResult.status === "fulfilled" && Array.isArray(logsResult.value?.logs)) {
      setCheckinLogs(logsResult.value.logs);
      nextSources.checkinLogs = { status: "ready", error: null };
      setBatchTimedOut(false);
    } else if (logsResult.status === "fulfilled") {
      nextSources.checkinLogs = sourceFailure(new Error("签到记录响应为空或格式无效"));
    } else {
      nextSources.checkinLogs = sourceFailure(logsResult.reason);
    }

    if (configResult.status === "fulfilled" && typeof configResult.value?.enabled === "boolean") {
      setCheckinConfig(configResult.value);
      nextSources.checkinConfig = { status: "ready", error: null };
    } else if (configResult.status === "fulfilled") {
      nextSources.checkinConfig = sourceFailure(new Error("自动签到配置响应为空或格式无效"));
    } else {
      nextSources.checkinConfig = sourceFailure(configResult.reason);
    }

    if (proxySupported && proxyStatusResult.status === "fulfilled" && proxyStatusResult.value && Array.isArray(proxyStatusResult.value.pool)) {
      setProxyStatus(proxyStatusResult.value);
      nextSources.proxyStatus = { status: "ready", error: null };
    } else if (proxySupported && proxyStatusResult.status === "rejected") {
      nextSources.proxyStatus = sourceFailure(proxyStatusResult.reason);
    } else if (proxySupported) {
      nextSources.proxyStatus = sourceFailure(new Error("代理状态响应为空或格式无效"));
    }

    if (proxySupported && proxyAccountsResult.status === "fulfilled" && proxyAccountsResult.value) {
      if (Array.isArray(proxyAccountsResult.value)) {
        setProxyAccounts(proxyAccountsResult.value);
        nextSources.proxyPreview = { status: "ready", error: null };
      } else {
        nextSources.proxyPreview = sourceFailure(new Error("代理账号预览响应格式无效"));
      }
    } else if (proxySupported && proxyAccountsResult.status === "rejected") {
      nextSources.proxyPreview = sourceFailure(proxyAccountsResult.reason);
    } else if (proxySupported) {
      nextSources.proxyPreview = sourceFailure(new Error("代理账号预览响应为空"));
    }

    setSources(nextSources);
    setLastRefreshAt(Date.now());
    setRefreshing(false);
  }

  useEffect(() => {
    void refresh();
    return () => {
      refreshSequence.current += 1;
      batchSequence.current += 1;
    };
    // The page reads on entry once; subsequent reads require the visible refresh action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const proxyReadState: ProxyReadState = sources.proxyPreview.status === "ready"
    ? "loaded"
    : sources.proxyPreview.status === "loading"
      ? "loading"
      : sources.proxyPreview.status === "unsupported"
        ? "unavailable"
        : "failed";

  const proxyAccountsById = useMemo(
    () => new Map((proxyAccounts ?? []).map((account) => [account.id, account])),
    [proxyAccounts],
  );

  const poolRows = useMemo(() => accounts.map((account) => derivePoolAccountRow(
    account,
    proxyAccountsById.get(account.id) ?? null,
    proxyReadState,
  )), [accounts, proxyAccountsById, proxyReadState]);

  const filteredPoolRows = useMemo(
    () => filterPoolAccountRows(poolRows, poolFilter, poolSearch),
    [poolRows, poolFilter, poolSearch],
  );

  const poolCounts = useMemo(() => poolRows.reduce((counts, row) => {
    counts[row.state] += 1;
    return counts;
  }, { synced: 0, eligible: 0, failed: 0, unknown: 0 }), [poolRows]);

  const allTaskLogs = useMemo(() => mergeCheckinLogs(checkinLogs, batchLogs), [checkinLogs, batchLogs]);
  const filteredTaskLogs = useMemo(
    () => filterCheckinLogs(allTaskLogs, logFilter, logSearch),
    [allTaskLogs, logFilter, logSearch],
  );

  const domesticAccounts = useMemo(
    () => accounts.filter((account) => variantSupportsCheckin(accountVariant(account))),
    [accounts],
  );
  const internationalCount = accounts.length - domesticAccounts.length;
  const excludedCount = checkinConfig?.excluded_account_ids?.length ?? 0;
  const sourceErrors = Object.values(sources).filter((source) => source.status === "error").length;

  function runBatchCheckin() {
    if (batchBusy || batchTimedOut || sources.accounts.status !== "ready" || domesticAccounts.length === 0 || demoModeEnabled) return;

    const requestId = ++batchSequence.current;
    const timestamp = Date.now();
    setBatchBusy(true);
    setBatchTimedOut(false);
    setBatchNote("正在等待国内版账号的逐账号签到结果…");
    setBatchLogs(domesticAccounts.map((account) => ({
      ts: timestamp,
      accountId: account.id,
      email: account.email || account.nickname || account.id,
      result: "pending",
      variant: "cn",
    })));

    const request = api.checkinAll("cn").then(
      (response) => {
        if (requestId !== batchSequence.current) return;
        const rows = buildBatchCheckinLogs(domesticAccounts, response, null, Date.now());
        setBatchLogs(rows);
        setBatchBusy(false);
        setBatchTimedOut(false);
        setBatchNote(`签到请求已返回 ${rows.length} 个账号结果。`);
        const tone = batchFeedbackTone(rows);
        toast[tone](batchFeedbackMessage(rows));
        void refresh();
      },
      (error: unknown) => {
        if (requestId !== batchSequence.current) return;
        const message = api.asError(error);
        const rows = buildBatchCheckinLogs(domesticAccounts, null, message, Date.now());
        setBatchLogs(rows);
        setBatchBusy(false);
        setBatchTimedOut(false);
        setBatchNote(`请求没有返回可确认的逐账号结果，状态未知。${message}`);
        toast.error("签到请求未能确认结果；请查看逐账号反馈");
      },
    );

    const timeoutId = window.setTimeout(() => {
      if (requestId !== batchSequence.current) return;
      const message = "等待响应超时；后端可能仍在处理，本次账号状态未知。刷新任务记录后再决定是否重试。";
      setBatchLogs(buildBatchCheckinLogs(domesticAccounts, null, message, Date.now()));
      setBatchBusy(false);
      setBatchTimedOut(true);
      setBatchNote(message);
      toast.error("签到响应超时，结果未知");
    }, CHECKIN_TIMEOUT_MS);

    void request.finally(() => window.clearTimeout(timeoutId));
  }

  const canRunBatch = sources.accounts.status === "ready" && domesticAccounts.length > 0 &&
    !batchBusy && !batchTimedOut && !demoModeEnabled;

  return (
    <main className="mx-auto max-w-6xl space-y-9 px-5 py-7 sm:px-7">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-left text-2xl font-semibold tracking-tight">账号与任务控制台</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            查看真实账号池接入状态和签到记录。批量签到只会在你点击时请求国内版账号，国际版不支持此任务。
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
            最近刷新尝试：{formatTime(lastRefreshAt)}{sourceErrors > 0 ? ` · ${sourceErrors} 项读取失败` : ""}
          </p>
          <Button variant="outline" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-4" />}
            {refreshing ? "正在刷新…" : "刷新数据"}
          </Button>
        </div>
      </header>

      <section aria-labelledby="pool-title" className="space-y-4 border-t pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 id="pool-title" className="text-base font-semibold">账号池状态</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              “已知问题”来自账号重登标记或代理的明确不可用判定；“状态未知”表示没有读到足够证据。
            </p>
          </div>
          <div className="text-sm text-muted-foreground" aria-live="polite">
            {sources.proxyStatus.status === "ready" && proxyStatus
              ? `本地 API ${proxyStatus.running ? "正在运行" : "已停止"} · 已同步 ${proxyStatus.syncedAccounts} 个账号`
              : sourceCaption(sources.proxyStatus, "代理状态已读取")}
          </div>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs tabular-nums text-muted-foreground">
          <span>API 已同步 {poolCounts.synced}</span>
          <span>可用未同步 {poolCounts.eligible}</span>
          <span>已知问题 {poolCounts.failed}</span>
          <span>状态未知 {poolCounts.unknown}</span>
          {sources.proxyStatus.status === "ready" && proxyStatus && <span>已启用 {proxyStatus.pool.filter((item) => item.enabled).length} 项</span>}
        </div>

        {sources.accounts.status === "error" && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            账号列表读取失败：{sources.accounts.error}。已保留页面打开前缓存的账号数据（若有）。
          </p>
        )}
        {sources.proxyPreview.status === "error" && (
          <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm leading-5">
            代理账号预览读取失败：{sources.proxyPreview.error}。未读取到资格的账号标为“状态未知”，不会当成失败。
          </p>
        )}
        {demoModeEnabled && (
          <p role="status" className="rounded-lg border p-3 text-sm leading-5 text-muted-foreground">
            当前为界面预览，页面不会读取真实账号池或提交签到请求。
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
          <label className="relative block">
            <span className="sr-only">搜索账号池</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              className="pl-9"
              value={poolSearch}
              onChange={(event) => setPoolSearch(event.target.value)}
              placeholder="搜索昵称、邮箱、备注或 ID"
              aria-label="搜索账号池"
            />
          </label>
          <label className="sr-only" htmlFor="pool-filter">筛选账号状态</label>
          <select
            id="pool-filter"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={poolFilter}
            onChange={(event) => setPoolFilter(event.target.value as PoolFilter)}
          >
            <option value="all">全部状态</option>
            <option value="synced">API 已同步</option>
            <option value="eligible">可用，尚未同步</option>
            <option value="failed">已知问题</option>
            <option value="unknown">状态未知</option>
          </select>
        </div>

        {sources.accounts.status === "loading" && accounts.length === 0 ? (
          <p role="status" className="rounded-lg border p-5 text-sm text-muted-foreground">正在读取账号列表…</p>
        ) : filteredPoolRows.length === 0 ? (
          <p className="rounded-lg border p-5 text-sm leading-6 text-muted-foreground">
            {accounts.length === 0 ? "账号库中还没有账号。" : "没有符合当前筛选条件的账号。"}
          </p>
        ) : (
          <div className="divide-y overflow-hidden rounded-xl border">
            {filteredPoolRows.map((row) => (
              <article key={row.account.id} className="flex min-w-0 flex-wrap items-start justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="truncate text-sm font-medium">{displayName(row.account)}</h3>
                    <Badge variant="outline">{accountVariantLabel(row.account)}</Badge>
                  </div>
                  <p className="mt-1 break-all text-xs text-muted-foreground">{accountIdentity(row.account)}</p>
                  {row.account.note && <p className="mt-1 break-words text-xs text-muted-foreground">备注：{row.account.note}</p>}
                </div>
                <div className="flex max-w-xl min-w-0 flex-col items-start gap-1.5 sm:items-end">
                  <Badge variant={poolStateTone(row.state)}>{poolStateLabel(row.state)}</Badge>
                  <p className={`text-xs leading-5 sm:text-right ${rowTextTone(row.state)}`}>
                    {row.reason}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="checkin-title" className="space-y-4 border-t pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 id="checkin-title" className="text-base font-semibold">签到任务</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              查看最近结果和错误。手动批量签到会提交所有已读取的国内版账号；国际版不在请求范围内。
            </p>
          </div>
          <Button onClick={runBatchCheckin} disabled={!canRunBatch}>
            {batchBusy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-4" />}
            {batchBusy ? "正在签到…" : batchTimedOut ? "先刷新任务记录" : "为国内版账号批量签到"}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span>
            自动签到配置：{sources.checkinConfig.status === "ready"
              ? checkinConfig?.enabled ? "已开启" : "已关闭"
              : sourceCaption(sources.checkinConfig, "配置已读取")}
          </span>
          {sources.checkinConfig.status === "ready" && excludedCount > 0 && <span>自动签到排除 {excludedCount} 个账号</span>}
          {internationalCount > 0 && <span>国际版 {internationalCount} 个账号不支持签到，已排除</span>}
          <span>{sourceCaption(sources.checkinLogs, `已读取 ${checkinLogs.length} 条历史记录`)}</span>
        </div>

        {sources.checkinLogs.status === "error" && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            签到记录读取失败：{sources.checkinLogs.error}。本次手动反馈仍会保留在当前页面。
          </p>
        )}
        {batchNote && (
          <p role={batchTimedOut ? "alert" : "status"} className={`rounded-lg border p-3 text-sm leading-5 ${batchTimedOut ? "border-amber-500/40 bg-amber-500/5" : "text-muted-foreground"}`}>
            {batchTimedOut && <AlertTriangle className="mr-2 inline size-4 align-[-3px]" aria-hidden="true" />}
            {batchNote}
          </p>
        )}
        {sources.accounts.status === "error" && accounts.length === 0 && (
          <p className="flex items-start gap-2 rounded-lg border p-3 text-sm leading-5 text-muted-foreground">
            <CircleHelp className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            批量签到已停用，因为没有读取到可确认的账号列表。
          </p>
        )}
        {domesticAccounts.length === 0 && sources.accounts.status === "ready" && (
          <p className="rounded-lg border p-3 text-sm leading-5 text-muted-foreground">
            当前没有支持签到的国内版账号。国际版账号可以查看，但不会收到签到请求。
          </p>
        )}
        {demoModeEnabled && (
          <p role="status" className="rounded-lg border p-3 text-sm leading-5 text-muted-foreground">
            界面预览不会向真实账号提交签到请求。
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
          <label className="relative block">
            <span className="sr-only">搜索签到记录</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              className="pl-9"
              value={logSearch}
              onChange={(event) => setLogSearch(event.target.value)}
              placeholder="搜索邮箱、账号 ID、结果或错误"
              aria-label="搜索签到记录"
            />
          </label>
          <label className="sr-only" htmlFor="checkin-log-filter">筛选签到记录</label>
          <select
            id="checkin-log-filter"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={logFilter}
            onChange={(event) => setLogFilter(event.target.value as CheckinLogFilter)}
          >
            <option value="all">全部结果</option>
            <option value="errors">失败与未知</option>
          </select>
        </div>

        {filteredTaskLogs.length === 0 ? (
          <p className="rounded-lg border p-5 text-sm leading-6 text-muted-foreground">
            {sources.checkinLogs.status === "loading" ? "正在读取签到记录…" : allTaskLogs.length === 0 ? "暂无签到任务记录。" : "没有符合当前筛选条件的记录。"}
          </p>
        ) : (
          <div className="divide-y overflow-hidden rounded-xl border">
            {filteredTaskLogs.map((log, index) => {
              const timestamp = normalizeLogTimestamp(log.ts);
              const hasValidTimestamp = Number.isFinite(timestamp) && timestamp > 0;
              return (
                <article key={`${log.accountId ?? log.email}-${log.ts}-${log.result}-${index}`} className="flex min-w-0 flex-wrap items-start justify-between gap-3 px-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="break-all text-sm font-medium">{log.email || log.accountId || "未知账号"}</h3>
                      <Badge variant={checkinOutcomeTone(log)}>{checkinOutcomeLabel(log)}</Badge>
                      {log.variant && <Badge variant="outline">{variantLabel(log.variant)}</Badge>}
                    </div>
                    {log.accountId && <p className="mt-1 break-all text-xs text-muted-foreground">账号 ID：{log.accountId}</p>}
                    {log.error && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{log.error}</p>}
                  </div>
                  <time className="shrink-0 text-xs tabular-nums text-muted-foreground" dateTime={hasValidTimestamp ? new Date(timestamp).toISOString() : undefined}>
                    {hasValidTimestamp ? formatTime(timestamp) : "时间未知"}
                  </time>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
