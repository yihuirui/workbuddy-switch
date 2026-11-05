import type { AccountMeta, CheckinLog, WbVariant } from "./types";
import type { ProxyAccount } from "./proxy-api";
import { accountVariant } from "./variant";

export type PoolState = "synced" | "eligible" | "failed" | "unknown";
export type PoolFilter = "all" | PoolState;
export type ProxyReadState = "loaded" | "loading" | "failed" | "unavailable";
export type CheckinLogFilter = "all" | "errors";
export type CheckinOutcome = "success" | "already" | "failed" | "inactive" | "skipped" | "unknown";

export interface PoolAccountRow {
  account: AccountMeta;
  proxyAccount: ProxyAccount | null;
  state: PoolState;
  reason: string;
}

export interface CheckinBatchEntry {
  accountId?: string | null;
  email?: string | null;
  result?: string | null;
  error?: string | null;
  inactive?: boolean;
  reason?: string | null;
}

export interface CheckinBatchResponse {
  accounts?: CheckinBatchEntry[] | null;
  status?: string;
  reason?: string;
}

const normalizeSearch = (value: string): string => value.trim().toLocaleLowerCase();

export function derivePoolAccountRow(
  account: AccountMeta,
  proxyAccount: ProxyAccount | null,
  proxyReadState: ProxyReadState,
): PoolAccountRow {
  if (account.needsRelogin) {
    return {
      account,
      proxyAccount,
      state: "failed",
      reason: account.needsReloginReason || "账号需要重新登录",
    };
  }

  if (proxyReadState !== "loaded") {
    const cacheNote = proxyAccount ? "上次读取的代理信息已过期；" : "";
    const reason = proxyReadState === "loading"
      ? `${cacheNote}正在读取代理账号池，当前状态未知`
      : proxyReadState === "failed"
        ? `${cacheNote}代理账号池读取失败，当前状态未知`
        : `${cacheNote}当前环境无法读取代理账号池，当前状态未知`;
    return { account, proxyAccount, state: "unknown", reason };
  }

  if (proxyAccount?.eligible === false) {
    return {
      account,
      proxyAccount,
      state: "failed",
      reason: proxyAccount.reason || "代理暂不允许使用此账号",
    };
  }

  if (proxyAccount?.eligible === true) {
    return {
      account,
      proxyAccount,
      state: proxyAccount.synced ? "synced" : "eligible",
      reason: proxyAccount.synced ? "已同步到 API 账号池" : "账号可用，尚未同步到 API 账号池",
    };
  }

  return {
    account,
    proxyAccount: null,
    state: "unknown",
    reason: "代理预览未返回此账号，当前状态未知",
  };
}

export function filterPoolAccountRows(
  rows: PoolAccountRow[],
  filter: PoolFilter,
  search: string,
): PoolAccountRow[] {
  const query = normalizeSearch(search);
  return rows.filter((row) => {
    if (filter !== "all" && row.state !== filter) return false;
    if (!query) return true;
    const searchable = [
      row.account.nickname,
      row.account.uid,
      row.account.id,
      row.account.email,
      row.account.note,
      row.proxyAccount?.name,
      row.reason,
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    return searchable.includes(query);
  });
}

export function classifyCheckinOutcome(log: Pick<CheckinLog, "result" | "error">): CheckinOutcome {
  if (log.result === "success") return "success";
  if (log.result === "already") return "already";
  if (log.result === "error") return "failed";
  if (log.result === "inactive") return "inactive";
  if (log.result === "skipped") return "skipped";
  return "unknown";
}

export function isCheckinLogIssue(log: Pick<CheckinLog, "result" | "error">): boolean {
  if (log.result === "pending") return false;
  const outcome = classifyCheckinOutcome(log);
  return outcome === "failed" || outcome === "unknown" ||
    (Boolean(log.error) && outcome !== "skipped" && outcome !== "inactive");
}

export function filterCheckinLogs(
  logs: CheckinLog[],
  filter: CheckinLogFilter,
  search: string,
): CheckinLog[] {
  const query = normalizeSearch(search);
  return logs
    .filter((log) => filter !== "errors" || isCheckinLogIssue(log))
    .filter((log) => {
      if (!query) return true;
      return [log.email, log.accountId, log.result, log.error]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
    })
    .sort((left, right) => normalizeLogTimestamp(right.ts) - normalizeLogTimestamp(left.ts));
}

export function normalizeLogTimestamp(timestamp: number): number {
  return timestamp > 0 && timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function normalizedEmail(email: string | null | undefined): string {
  return email?.trim().toLocaleLowerCase() ?? "";
}

function logForAccount(account: AccountMeta, result: string, error: string, timestamp: number): CheckinLog {
  return {
    ts: timestamp,
    accountId: account.id,
    email: account.email || account.nickname || account.uid || account.id,
    result,
    error,
    variant: accountVariant(account),
  };
}

/**
 * Convert a manual batch response to one visible row per domestic account.
 * Missing rows and transport failures are unknown because the remote operation may have completed.
 */
export function buildBatchCheckinLogs(
  accounts: AccountMeta[],
  response: CheckinBatchResponse | null,
  transportError: string | null,
  timestamp = Date.now(),
): CheckinLog[] {
  const domesticAccounts = accounts.filter((account) => accountVariant(account) === "cn");
  if (domesticAccounts.length === 0) return [];

  if (transportError || !response) {
    const message = transportError || "签到接口未返回结果；本次状态未知";
    return domesticAccounts.map((account) => logForAccount(account, "unknown", message, timestamp));
  }

  const entries = response.accounts ?? [];
  if (entries.length === 0) {
    const message = response.status === "skipped" && response.reason === "already_running"
      ? "已有签到任务正在运行；本次未返回逐账号结果"
      : "签到接口未返回逐账号结果；本次状态未知";
    return domesticAccounts.map((account) => logForAccount(account, "unknown", message, timestamp));
  }

  const rows: CheckinLog[] = [];
  const reportedIds = new Set<string>();
  const reportedEmails = new Set<string>();

  for (const entry of entries) {
    const email = normalizedEmail(entry.email);
    const matched = domesticAccounts.find((account) =>
      (entry.accountId && account.id === entry.accountId) ||
      (email && normalizedEmail(account.email) === email),
    );
    const accountId = entry.accountId || matched?.id || null;
    if (accountId) reportedIds.add(accountId);
    if (email) reportedEmails.add(email);
    const result = entry.inactive ? "inactive" : entry.result || "unknown";
    rows.push({
      ts: timestamp,
      accountId,
      email: entry.email || matched?.email || matched?.nickname || matched?.uid || accountId || "未知账号",
      result,
      error: entry.error || entry.reason || undefined,
      variant: "cn",
    });
  }

  for (const account of domesticAccounts) {
    if (reportedIds.has(account.id) || (account.email && reportedEmails.has(normalizedEmail(account.email)))) continue;
    rows.push(logForAccount(account, "unknown", "签到接口未返回此账号的结果；本次状态未知", timestamp));
  }

  return rows;
}

/** Merge immediate UI feedback with the persisted log without duplicating the same recent result. */
export function mergeCheckinLogs(historical: CheckinLog[], immediate: CheckinLog[]): CheckinLog[] {
  const uniqueHistorical = historical.filter((log) => !immediate.some((recent) => {
    const sameAccount = (recent.accountId && log.accountId === recent.accountId) ||
      (!recent.accountId && normalizedEmail(log.email) === normalizedEmail(recent.email));
    return sameAccount && recent.result === log.result &&
      Math.abs(normalizeLogTimestamp(recent.ts) - normalizeLogTimestamp(log.ts)) <= 120_000;
  }));
  return [...immediate, ...uniqueHistorical]
    .sort((left, right) => normalizeLogTimestamp(right.ts) - normalizeLogTimestamp(left.ts));
}

export type BatchToastTone = "success" | "info" | "error";

export function batchFeedbackTone(logs: CheckinLog[]): BatchToastTone {
  const hasConfirmedSuccess = logs.some((log) => log.result === "success" || log.result === "already");
  const hasKnownFailure = logs.some((log) => log.result === "error");
  const hasUnresolved = logs.some((log) => log.result === "unknown");
  const hasSkipped = logs.some((log) => log.result === "skipped" || log.result === "inactive");

  if (!hasConfirmedSuccess && hasKnownFailure) return "error";
  if (!hasConfirmedSuccess) return "info";
  if (hasKnownFailure || hasUnresolved || hasSkipped) return "info";
  return "success";
}

export function batchFeedbackMessage(logs: CheckinLog[]): string {
  const success = logs.filter((log) => log.result === "success").length;
  const already = logs.filter((log) => log.result === "already").length;
  const failed = logs.filter((log) => log.result === "error").length;
  const inactive = logs.filter((log) => log.result === "inactive").length;
  const skipped = logs.filter((log) => log.result === "skipped").length;
  const unknown = logs.filter((log) => log.result === "unknown").length;
  return `批量签到结果：成功 ${success}，已签 ${already}，失败 ${failed}，未开放 ${inactive}，未执行 ${skipped}，未知 ${unknown}`;
}

export function checkinOutcomeLabel(log: Pick<CheckinLog, "result" | "error">): string {
  switch (classifyCheckinOutcome(log)) {
    case "success": return "签到成功";
    case "already": return "今天已签到";
    case "failed": return "已知失败";
    case "inactive": return "活动未开放";
    case "skipped": return "未执行";
    case "unknown": return log.result === "pending" ? "执行中" : log.result === "unknown" ? "结果未知" : `未识别：${log.result || "空结果"}`;
  }
}

export function poolStateLabel(state: PoolState): string {
  switch (state) {
    case "synced": return "API 已同步";
    case "eligible": return "可用，尚未同步";
    case "failed": return "已知问题";
    case "unknown": return "状态未知";
  }
}

export function poolStateTone(state: PoolState): "success" | "warning" | "destructive" | "outline" {
  switch (state) {
    case "synced": return "success";
    case "eligible": return "warning";
    case "failed": return "destructive";
    case "unknown": return "outline";
  }
}

export function checkinOutcomeTone(log: Pick<CheckinLog, "result" | "error">): "success" | "warning" | "destructive" | "outline" {
  switch (classifyCheckinOutcome(log)) {
    case "success":
    case "already": return "success";
    case "failed": return "destructive";
    case "inactive":
    case "skipped": return "warning";
    case "unknown": return "outline";
  }
}

export function variantForPoolAccount(account: AccountMeta): WbVariant {
  return accountVariant(account);
}
