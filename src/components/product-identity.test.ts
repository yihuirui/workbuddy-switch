import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { UpdateCenter } from "@/App";
import { ProductBrandName } from "@/components/product-identity";
import { AppIconMark } from "@/components/product-marks";
import { PRODUCT_VERSION } from "@/lib/product-version";
import { useAccountsStore } from "@/stores/accounts";
import type { AppStatus } from "@/lib/types";

function textContent(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}

describe("Workbuddy-Switch2 product identity", () => {
  afterEach(() => useAccountsStore.setState({ status: null }));

  it("uses the current rounded app icon in the sidebar brand mark", () => {
    const mark = renderToStaticMarkup(createElement(AppIconMark, { size: 36 }));

    expect(mark).toContain("workbuddy-switch2-app-icon");
    expect(mark).not.toContain("wbcli-account-switch");
  });

  it("renders the complete app brand and package version in the formal sidebar", () => {
    const staleRuntimeStatus: AppStatus = {
      running: true,
      authFile: "/tmp/demo/auth.json",
      current: null,
      appPath: "/tmp/demo/WorkBuddy.app",
      version: "0.1.4",
      variant: "cn",
    };
    useAccountsStore.setState({ status: staleRuntimeStatus });

    const title = renderToStaticMarkup(createElement(ProductBrandName));
    const footer = renderToStaticMarkup(createElement(UpdateCenter, { running: true }));

    expect(textContent(title)).toBe("Workbuddy-Switch2");
    expect(title).not.toContain("truncate");
    expect(textContent(footer)).toBe(`Workbuddy-Switch2v${PRODUCT_VERSION}`);
    expect(textContent(footer)).not.toContain("WorkBuddy");
    expect(footer).not.toContain("v0.1.4");
  });
});
