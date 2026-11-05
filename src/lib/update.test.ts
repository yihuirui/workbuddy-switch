import { describe, expect, it } from "vitest";

import {
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_RELEASE_URL,
  GITHUB_REPOSITORY_URL,
} from "./update";

describe("public update links", () => {
  it("uses the public fork for future release checks", () => {
    expect(GITHUB_OWNER).toBe("yihuirui");
    expect(GITHUB_REPO).toBe("workbuddy-switch");
    expect(GITHUB_REPOSITORY_URL).toBe("https://github.com/yihuirui/workbuddy-switch");
    expect(GITHUB_RELEASE_URL).toBe("https://github.com/yihuirui/workbuddy-switch/releases");
  });
});
