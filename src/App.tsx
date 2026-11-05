import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";
import { BrowserRouter, HashRouter, Navigate, NavLink, Outlet, Route, Routes } from "react-router-dom";
import { Activity, Gauge, Library, Link2, MessagesSquare, Play, Plug, Settings, Sparkles, User } from "lucide-react";

import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import { ProductBrandName, ProductFooterIdentity } from "@/components/product-identity";
import ProxyPage from "@/pages/ProxyPage";
import AccountsPage from "@/pages/AccountsPage";
import SessionsPage from "@/pages/SessionsPage";
import CreditStatsPage from "@/pages/CreditStatsPage";
import TokenStatsPage from "@/pages/TokenStatsPage";
import SettingsPage from "@/pages/SettingsPage";
import OperationsPage from "@/pages/OperationsPage";
import WorkbenchPage from "@/pages/WorkbenchPage";
import { StatusDot, AppIconMark } from "@/components/product-marks";
import { CompanionDemoDialog } from "@/components/companion-demo-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import companionTrayIcon from "@/assets/agent-companion-tray.png";
import { DEMO_UNAVAILABLE_MESSAGE, demoModeEnabled, pagesDemoHostingEnabled } from "@/lib/demo-mode";
import { useSessionsNavEnabled } from "@/lib/nav-prefs";
import { changeCompanionEnabled, useCompanionEnabled } from "@/lib/use-companion-enabled";
import { useCreditAutoRefresh } from "@/lib/use-credit-auto-refresh";
import { useRotateDeferredNotice } from "@/lib/use-rotate-deferred-notice";
import { useWorkbuddyStatusRefresh } from "@/lib/use-workbuddy-status-refresh";
import { toggleUsageWidget } from "@/lib/usage-widget";
import { useAccountsStore } from "@/stores/accounts";

const UsageWidgetPage = lazy(() => import("@/pages/UsageWidgetPage"));

/**
 * 悬浮窗面板：从 footer 向上滑出，开关与设置同屏。
 *
 * footer 只保留一个「图标位」——点图标弹面板，而不是并排第二个按钮：
 * 开关与设置都在面板里，关掉悬浮窗时也不必留一个灰掉的死图标。
 * 面板关闭后进入设置的常驻路径仍是：设置页 → Agent Companion → 悬浮窗设置。
 */
const COMPANION_MENU_CONTENT = { side: "top", align: "start", sideOffset: 8, className: "w-56" } as const;

function CompanionFooter() {
  const { enabled, busy } = useCompanionEnabled();
  /** 面板打开时收起 hover tooltip——两者都朝上弹，同时出现会叠在一起。 */
  const [menuOpen, setMenuOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);

  async function onToggle() {
    if (enabled === null) return;
    try {
      const confirmed = await changeCompanionEnabled(!enabled);
      toast.success(confirmed ? "已启用 Agent Companion 悬浮窗" : "已关闭 Agent Companion 悬浮窗");
    } catch (cause) {
      toast.error("悬浮窗设置失败", { description: api.asError(cause) });
    }
  }

  async function openSettings() {
    try {
      await api.openCompanionSettings();
    } catch (cause) {
      toast.error("打开悬浮窗设置失败", { description: api.asError(cause) });
    }
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip open={tipOpen && !menuOpen} onOpenChange={setTipOpen}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-lg" aria-label="会话悬浮窗" disabled={enabled === null || busy}>
              <img src={companionTrayIcon} alt="" className={cn("size-6 object-contain transition-[filter,opacity]", !enabled && "grayscale opacity-55")} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">会话悬浮窗</TooltipContent>
      </Tooltip>
      <DropdownMenuContent {...COMPANION_MENU_CONTENT}>
        {/* 整行即开关（方向键 / Enter 同语义）；行尾 Switch 只作视觉，点击穿透到行上，避免出现两个焦点。 */}
        <DropdownMenuItem
          className="gap-3"
          disabled={enabled === null || busy}
          onSelect={(event) => {
            // 面板保持打开：切换是异步的，让用户看到开关落定。
            event.preventDefault();
            void onToggle();
          }}
        >
          <span className="min-w-0 flex-1">会话悬浮窗</span>
          <Switch checked={Boolean(enabled)} tabIndex={-1} aria-hidden className="pointer-events-none" />
        </DropdownMenuItem>
        <p className="px-2.5 pb-1 text-xs leading-4 text-muted-foreground">
          {enabled ? "关闭后悬浮栏将隐藏，并停止 wb-switch 中的会话监听。" : "开启后会显示悬浮栏，并开始监听会话状态。"}
        </p>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={enabled === null || busy || !enabled} onSelect={() => void openSettings()}>
          <Settings />悬浮窗设置
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 演示模式的悬浮窗入口：与桌面正式版同形（一个图标位 + 向上弹出的面板），
 * 但面板里的开关与设置只提示「演示不可用」，不触发任何本机命令；
 * 多一条「查看悬浮栏演示」，打开只读演示浮层。
 */
function CompanionDemoFooter() {
  const [open, setOpen] = useState(false);
  /** 面板打开时收起 hover tooltip，与正式版同一处理。 */
  const [menuOpen, setMenuOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);

  /** 演示面板里的行：保持可聚焦（键盘也能走一遍），但只说明不可用。 */
  function unavailable(event: Event) {
    event.preventDefault();
    toast.info(DEMO_UNAVAILABLE_MESSAGE);
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip open={tipOpen && !menuOpen} onOpenChange={setTipOpen}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-lg" aria-label="会话悬浮窗">
              <img src={companionTrayIcon} alt="" className="size-6 object-contain" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">会话悬浮窗</TooltipContent>
      </Tooltip>
      <DropdownMenuContent {...COMPANION_MENU_CONTENT}>
        <DropdownMenuItem className="gap-3" onSelect={unavailable}>
          <span className="min-w-0 flex-1">会话悬浮窗</span>
          <Switch checked tabIndex={-1} aria-hidden className="pointer-events-none" />
        </DropdownMenuItem>
        <p className="px-2.5 pb-1 text-xs leading-4 text-muted-foreground">关闭后悬浮栏将隐藏，并停止 wb-switch 中的会话监听。</p>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={unavailable}>
          <Settings />悬浮窗设置
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setOpen(true)}>
          <Play />查看悬浮栏演示
        </DropdownMenuItem>
      </DropdownMenuContent>
      <CompanionDemoDialog open={open} onOpenChange={setOpen} />
    </DropdownMenu>
  );
}

export function UpdateCenter({ running }: { running: boolean | undefined }) {
  const showCompanion = false;
  // 演示模式只提供只读演示浮层，不渲染正式版的悬浮窗开关。
  const showCompanionDemo = demoModeEnabled;

  return (
    <section className="mt-auto border-t border-sidebar-border px-2 pt-3 text-xs">
        <div className="flex items-center gap-2 text-[13px] text-sidebar-foreground">
          {showCompanion ? <CompanionFooter /> : showCompanionDemo ? <CompanionDemoFooter /> : (
            <StatusDot on={Boolean(running)} />
          )}
          <ProductFooterIdentity />
        </div>
        {api.isDesktop() && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !demoModeEnabled && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2 h-8 w-full justify-start gap-2 px-2 text-xs text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={async () => {
              try {
                const open = await toggleUsageWidget();
                toast.success(open ? "用量悬浮窗已打开" : "用量悬浮窗已关闭");
              } catch (cause) {
                toast.error("切换用量悬浮窗失败", { description: api.asError(cause) });
              }
            }}
          >
            <Gauge className="size-4" />用量悬浮窗
          </Button>
        )}
      </section>
  );
}

function Layout() {
  const running = useAccountsStore((s) => s.status?.running);
  const hasUnifiedTitleBar =
    api.isDesktop() && typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
  const sessionsNavEnabled = useSessionsNavEnabled();
  useCreditAutoRefresh();
  useWorkbuddyStatusRefresh();
  useRotateDeferredNotice();

  return (
    <div className="flex h-screen min-h-0 overflow-hidden bg-background">
      {hasUnifiedTitleBar ? (
        <div
          data-tauri-drag-region
          className="fixed inset-x-0 top-0 z-50 h-8"
          aria-hidden="true"
        />
      ) : null}
      <aside
        className={cn(
          "flex min-h-0 w-[220px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 pb-4",
          hasUnifiedTitleBar ? "pt-20" : "pt-4",
        )}
      >
        <div className="flex items-center gap-2.5 px-1 pb-5">
          <AppIconMark size={36} className="drop-shadow-sm" />
          <div className="min-w-0">
            <ProductBrandName />
            {demoModeEnabled && (
              <Badge variant="secondary" className="mt-1 h-5 border-0 px-1.5 text-[10px] text-sidebar-foreground/60 shadow-none">
                演示模式
              </Badge>
            )}
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5" aria-label="主导航">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive
                  ? "bg-foreground/[0.06] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )
            }
          >
            <User className="size-4" />
            账号管理
          </NavLink>
          <NavLink to="/operations" className={({ isActive }) => cn("flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50", isActive ? "bg-foreground/[0.06] font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground")}><Activity className="size-4" />账号与签到</NavLink>
          <NavLink to="/workbench" className={({ isActive }) => cn("flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50", isActive ? "bg-foreground/[0.06] font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground")}><Library className="size-4" />效率工具</NavLink>
          {sessionsNavEnabled && (
            <NavLink
              to="/sessions"
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                  isActive
                    ? "bg-foreground/[0.06] font-medium text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                )
              }
            >
              <Link2 className="size-4" />
              关联会话
            </NavLink>
          )}
          <NavLink to="/proxy" className={({ isActive }) => cn("flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50", isActive ? "bg-foreground/[0.06] font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground")}><Plug className="size-4" />Proxy API</NavLink>
          <NavLink to="/token-stats" className={({ isActive }) => cn("flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50", isActive ? "bg-foreground/[0.06] font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground")}><MessagesSquare className="size-4" />Token 统计</NavLink>
          <NavLink
            to="/credit-stats"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive
                  ? "bg-foreground/[0.06] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )
            }
          >
            <Sparkles className="size-4" />
            积分统计
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive
                  ? "bg-foreground/[0.06] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )
            }
          >
            <Settings className="size-4" />
            设置
          </NavLink>
        </nav>
        {api.isWebui() && !demoModeEnabled ? null : <UpdateCenter running={running} />}
      </aside>
      <main
        className={cn(
          "min-w-0 flex-1 overflow-y-auto bg-background overscroll-contain",
          hasUnifiedTitleBar && "pt-16 [&>div]:pt-4",
        )}
      >
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  const isUsageWidgetWindow = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("usage_widget") === "1";
  if (isUsageWidgetWindow && api.isDesktop() && !demoModeEnabled) {
    return <Suspense fallback={<main className="grid h-screen place-items-center bg-background text-sm text-muted-foreground">正在加载用量…</main>}><UsageWidgetPage /></Suspense>;
  }
  const Router = pagesDemoHostingEnabled ? HashRouter : BrowserRouter;

  return (
    <TooltipProvider delayDuration={250}>
      <Router>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<AccountsPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/operations" element={<OperationsPage />} />
            <Route path="/workbench" element={<WorkbenchPage />} />
            <Route path="/credit-stats" element={<CreditStatsPage />} />
            <Route path="/token-stats" element={<TokenStatsPage />} />
            <Route path="/proxy" element={<ProxyPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <Toaster />
      </Router>
    </TooltipProvider>
  );
}
