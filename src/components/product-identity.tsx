import { PRODUCT_VERSION } from "@/lib/product-version";

/** App identity in the fixed-width sidebar: split at the hyphen to avoid truncation. */
export function ProductBrandName() {
  return (
    <div
      className="min-w-0 text-[14px] leading-4 tracking-[-0.02em] text-sidebar-foreground/90"
      style={{
        fontFamily: '"Bricolage Grotesque Variable", "SF Pro Display", ui-sans-serif, sans-serif',
        fontWeight: 640,
      }}
    >
      <span className="block whitespace-nowrap">Workbuddy-</span>
      <span className="block whitespace-nowrap">Switch2</span>
    </div>
  );
}

/** Shared by formal and demo footers so neither mode can show a managed tool as the app brand. */
export function ProductFooterIdentity() {
  return (
    <>
      <span className="min-w-0 flex-1 text-[11px] font-medium leading-[1.1] text-sidebar-foreground">
        <span className="block whitespace-nowrap">Workbuddy-</span>
        <span className="block whitespace-nowrap">Switch2</span>
      </span>
      <span className="ml-auto shrink-0 tabular-nums text-sidebar-foreground/50">v{PRODUCT_VERSION}</span>
    </>
  );
}
