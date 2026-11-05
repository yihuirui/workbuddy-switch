import type { CheckinResult, CreditExpiry } from "./types";

export interface CheckinFeedback {
  level: "success" | "error" | "info";
  title: string;
  refreshCredits: boolean;
}

export interface CheckinBatchFeedback {
  level: "success" | "error" | "info";
  message: string;
}

export interface CheckinBatchEntry {
  result: string;
  email?: string;
  error?: string;
  inactive?: boolean;
  reason?: string;
}

/** Map backend results to truthful UI feedback; only confirmed check-ins refresh credits. */
export function checkinFeedback(result: Pick<CheckinResult, "result" | "reason">): CheckinFeedback {
  switch (result.result) {
    case "success":
      return { level: "success", title: "签到成功", refreshCredits: true };
    case "already":
      return { level: "success", title: "今天已签到", refreshCredits: true };
    case "error":
      return { level: "error", title: "签到失败", refreshCredits: false };
    case "inactive":
      return { level: "info", title: "签到活动暂未开放", refreshCredits: false };
    case "skipped":
      return {
        level: "info",
        title: result.reason === "unsupported_variant"
          ? "当前账号类型不支持签到"
          : result.reason === "auto_checkin_disabled"
            ? "该账号已关闭自动签到"
            : "本次未执行签到",
        refreshCredits: false,
      };
    default:
      return { level: "error", title: "签到未完成", refreshCredits: false };
  }
}

/** Summarize batch results and keep partial success visible even when other accounts fail. */
export function checkinBatchFeedback(
  entries: CheckinBatchEntry[],
  status?: string,
  reason?: string,
): CheckinBatchFeedback {
  if (status === "skipped" && reason === "already_running") {
    return { level: "info", message: "签到任务正在进行，本次仅刷新积分" };
  }

  const success = entries.filter((entry) => entry.result === "success").length;
  const already = entries.filter((entry) => entry.result === "already").length;
  const failedEntries = entries.filter((entry) => entry.result === "error");
  const inactive = entries.filter((entry) => entry.inactive === true || entry.result === "inactive").length;
  const skipped = entries.filter(
    (entry) => entry.result === "skipped" && entry.reason === "auto_checkin_disabled",
  ).length;
  const outsideWindow = entries.filter(
    (entry) => entry.result === "skipped" && entry.reason === "outside_checkin_window",
  ).length;
  const parts = [`签到完成：成功 ${success}，已签 ${already}，失败 ${failedEntries.length}`];
  if (inactive > 0) parts.push(`未开放 ${inactive}`);
  if (skipped > 0) parts.push(`已忽略 ${skipped} 个关闭自动签到的账号`);
  if (outsideWindow > 0) parts.push(`${outsideWindow} 个未到签到时间段`);
  const details = failedEntries
    .map((entry) => `${entry.email ?? "账号"}${entry.error ? `（${entry.error}）` : ""}`)
    .join("；");
  const message = `${parts.join("，")}${details ? `。${details}` : ""}`;
  const level = success + already > 0 ? "success" : failedEntries.length > 0 ? "error" : "info";
  return { level, message };
}

/** Select failures produced by this refresh, excluding stale errors already in the store. */
export function failedCreditRefreshIds(
  accountIds: string[],
  previous: Record<string, CreditExpiry>,
  current: Record<string, CreditExpiry>,
): string[] {
  return accountIds.filter(
    (id) => current[id]?.ok === false && current[id] !== previous[id],
  );
}
