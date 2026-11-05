import { describe, expect, it } from "vitest";

import { checkinBatchFeedback, checkinFeedback, failedCreditRefreshIds } from "./checkin-feedback";

describe("checkinFeedback", () => {
  it.each([
    { result: "success", expected: { level: "success", title: "签到成功", refreshCredits: true } },
    { result: "already", expected: { level: "success", title: "今天已签到", refreshCredits: true } },
    { result: "error", expected: { level: "error", title: "签到失败", refreshCredits: false } },
    { result: "inactive", expected: { level: "info", title: "签到活动暂未开放", refreshCredits: false } },
    {
      result: "skipped",
      reason: "unsupported_variant",
      expected: { level: "info", title: "当前账号类型不支持签到", refreshCredits: false },
    },
  ])("maps $result to truthful feedback", ({ result, reason, expected }) => {
    expect(checkinFeedback({ result, reason })).toEqual(expected);
  });

  it("does not refresh credits for an unknown result", () => {
    expect(checkinFeedback({ result: "unexpected" }).refreshCredits).toBe(false);
  });
});

describe("checkinBatchFeedback", () => {
  it("keeps a successful account visible when another account fails", () => {
    expect(checkinBatchFeedback([
      { result: "success" },
      { result: "error", email: "synthetic", error: "offline" },
    ])).toEqual({
      level: "success",
      message: "签到完成：成功 1，已签 0，失败 1。synthetic（offline）",
    });
  });

  it("reports all-failed batches as errors and skipped batches as information", () => {
    expect(checkinBatchFeedback([{ result: "error" }]).level).toBe("error");
    expect(checkinBatchFeedback([{ result: "skipped", reason: "outside_checkin_window" }]).level).toBe("info");
  });

  it("reports an already-running batch without claiming a check-in result", () => {
    expect(checkinBatchFeedback([], "skipped", "already_running")).toEqual({
      level: "info",
      message: "签到任务正在进行，本次仅刷新积分",
    });
  });
});

describe("failedCreditRefreshIds", () => {
  it("returns only newly failed account refreshes", () => {
    const oldFailure = { ok: false, error: "old error" };
    expect(failedCreditRefreshIds(
      ["new-failure", "old-failure", "success"],
      { "old-failure": oldFailure },
      {
        "new-failure": { ok: false, error: "timeout" },
        "old-failure": oldFailure,
        success: { ok: true },
      },
    )).toEqual(["new-failure"]);
  });
});
