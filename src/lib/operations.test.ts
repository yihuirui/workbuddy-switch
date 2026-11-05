import { describe, expect, it } from "vitest";

import {
  buildBatchCheckinLogs,
  batchFeedbackMessage,
  batchFeedbackTone,
  checkinOutcomeLabel,
  classifyCheckinOutcome,
  derivePoolAccountRow,
  filterCheckinLogs,
  filterPoolAccountRows,
  mergeCheckinLogs,
  normalizeLogTimestamp,
} from "./operations";
import type { AccountMeta, CheckinLog } from "./types";
import type { ProxyAccount } from "./proxy-api";

function account(id: string, patch: Partial<AccountMeta> = {}): AccountMeta {
  return {
    id,
    uid: `uid-${id}`,
    email: `${id}@example.test`,
    nickname: id,
    enterpriseName: null,
    expiresAt: null,
    refreshExpiresAt: null,
    refreshedAt: null,
    createdAt: null,
    needsRelogin: false,
    needsReloginReason: null,
    ...patch,
  };
}

function proxyAccount(id: string, patch: Partial<ProxyAccount> = {}): ProxyAccount {
  return { id, name: id, realm: "cn", eligible: true, synced: true, reason: null, ...patch };
}

function log(patch: Partial<CheckinLog> = {}): CheckinLog {
  return { ts: 1_800_000_000, accountId: "a", email: "a@example.test", result: "success", ...patch };
}

describe("operations account pool status", () => {
  it("separates known credential failures from missing or failed proxy reads", () => {
    expect(derivePoolAccountRow(account("reauth", {
      needsRelogin: true,
      needsReloginReason: "refresh token expired",
    }), null, "failed")).toMatchObject({ state: "failed", reason: "refresh token expired" });

    expect(derivePoolAccountRow(account("unknown"), null, "failed")).toMatchObject({
      state: "unknown",
      reason: "代理账号池读取失败，当前状态未知",
    });
    expect(derivePoolAccountRow(account("missing"), null, "loaded")).toMatchObject({
      state: "unknown",
      reason: "代理预览未返回此账号，当前状态未知",
    });
  });

  it("never treats cached proxy eligibility as current during loading or failed reads", () => {
    const cached = proxyAccount("cached");
    expect(derivePoolAccountRow(account("cached"), cached, "loading")).toMatchObject({
      state: "unknown",
      reason: "上次读取的代理信息已过期；正在读取代理账号池，当前状态未知",
    });
    expect(derivePoolAccountRow(account("cached"), cached, "failed")).toMatchObject({
      state: "unknown",
      reason: "上次读取的代理信息已过期；代理账号池读取失败，当前状态未知",
    });
    expect(derivePoolAccountRow(account("reauth", { needsRelogin: true }), cached, "failed").state).toBe("failed");
  });

  it("distinguishes eligible, synced, and explicitly ineligible proxy accounts", () => {
    expect(derivePoolAccountRow(account("synced"), proxyAccount("synced"), "loaded").state).toBe("synced");
    expect(derivePoolAccountRow(account("eligible"), proxyAccount("eligible", { synced: false }), "loaded").state).toBe("eligible");
    expect(derivePoolAccountRow(account("blocked"), proxyAccount("blocked", {
      eligible: false,
      reason: "凭据已失效",
    }), "loaded")).toMatchObject({ state: "failed", reason: "凭据已失效" });
  });

  it("filters rows by status and account details", () => {
    const rows = [
      derivePoolAccountRow(account("ready", { nickname: "Rin" }), proxyAccount("ready"), "loaded"),
      derivePoolAccountRow(account("pending"), proxyAccount("pending", { synced: false }), "loaded"),
      derivePoolAccountRow(account("lost", { needsRelogin: true }), null, "loaded"),
      derivePoolAccountRow(account("unknown"), null, "failed"),
    ];
    expect(filterPoolAccountRows(rows, "failed", "").map((row) => row.account.id)).toEqual(["lost"]);
    expect(filterPoolAccountRows(rows, "all", "rin").map((row) => row.account.id)).toEqual(["ready"]);
    expect(filterPoolAccountRows(rows, "unknown", "").map((row) => row.account.id)).toEqual(["unknown"]);
  });
});

describe("operations check-in feedback", () => {
  it("returns one result per domestic account and marks omitted results unknown", () => {
    const rows = buildBatchCheckinLogs(
      [account("a"), account("b"), account("intl", { variant: "ai" })],
      { accounts: [{ accountId: "a", email: "a@example.test", result: "success" }] },
      null,
      1_800_000_000_000,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.accountId, row.result])).toEqual([
      ["a", "success"],
      ["b", "unknown"],
    ]);
    expect(rows[1].error).toContain("未返回此账号");
    expect(rows.every((row) => row.variant === "cn")).toBe(true);
  });

  it("marks empty responses and transport timeouts as unknown instead of claiming failure", () => {
    const accounts = [account("a"), account("b")];
    const empty = buildBatchCheckinLogs(accounts, { accounts: [] }, null, 1_800_000_000_000);
    const timeout = buildBatchCheckinLogs(accounts, null, "等待签到响应超时", 1_800_000_000_000);
    expect(empty.map((row) => row.result)).toEqual(["unknown", "unknown"]);
    expect(timeout.map((row) => row.result)).toEqual(["unknown", "unknown"]);
    expect(timeout[0].error).toContain("超时");
  });

  it("keeps recognized outcomes and treats unrecognized response values as unknown", () => {
    const rows = buildBatchCheckinLogs([account("a")], {
      accounts: [{ accountId: "a", result: "new-backend-status" }],
    }, null);
    expect(classifyCheckinOutcome(rows[0])).toBe("unknown");
    expect(checkinOutcomeLabel(rows[0])).toBe("未识别：new-backend-status");
  });

  it("filters failures and unknown results while keeping successful log rows out", () => {
    const rows = [
      log({ accountId: "ok", result: "success", email: "ok@example.test" }),
      log({ accountId: "bad", result: "error", error: "offline", email: "bad@example.test" }),
      log({ accountId: "maybe", result: "unknown", error: "timeout", email: "maybe@example.test" }),
      log({ accountId: "skip", result: "skipped", error: "auto_checkin_disabled", email: "skip@example.test" }),
      log({ accountId: "pending", result: "pending", email: "pending@example.test" }),
    ];
    expect(filterCheckinLogs(rows, "errors", "").map((row) => row.accountId)).toEqual(["bad", "maybe"]);
    expect(filterCheckinLogs(rows, "all", "OFFLINE").map((row) => row.accountId)).toEqual(["bad"]);
  });

  it("normalizes second timestamps and avoids duplicating a fresh persisted result", () => {
    expect(normalizeLogTimestamp(1_800_000_000)).toBe(1_800_000_000_000);
    const immediate = log({ ts: 1_800_000_000_000, accountId: "a", result: "success" });
    const persisted = log({ ts: 1_800_000_001, accountId: "a", result: "success" });
    expect(mergeCheckinLogs([persisted], [immediate])).toEqual([immediate]);
  });

  it("uses neutral or error toast tones unless a result confirms success", () => {
    const skipped = buildBatchCheckinLogs([account("skip")], {
      accounts: [{ accountId: "skip", result: "skipped", reason: "auto_checkin_disabled" }],
    }, null);
    const inactive = buildBatchCheckinLogs([account("inactive")], {
      accounts: [{ accountId: "inactive", result: "inactive" }],
    }, null);
    const unknown = buildBatchCheckinLogs([account("unknown")], { accounts: [] }, null);
    const failed = buildBatchCheckinLogs([account("failed")], {
      accounts: [{ accountId: "failed", result: "error", error: "offline" }],
    }, null);
    const success = buildBatchCheckinLogs([account("success")], {
      accounts: [{ accountId: "success", result: "success" }],
    }, null);

    expect(batchFeedbackTone(skipped)).toBe("info");
    expect(batchFeedbackTone(inactive)).toBe("info");
    expect(batchFeedbackTone(unknown)).toBe("info");
    expect(batchFeedbackTone(failed)).toBe("error");
    expect(batchFeedbackTone(success)).toBe("success");
    expect(batchFeedbackMessage(skipped)).toContain("未执行 1");
  });
});
