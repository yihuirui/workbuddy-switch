import { useEffect, useState } from "react";
import { Check, Copy, FolderOpen, Loader2, Play, RefreshCw, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { isDesktop, asError } from "@/lib/api";
import { demoModeEnabled } from "@/lib/demo-mode";
import { proxyCall, type ProxyAccount, type ProxySettings, type ProxyStatus } from "@/lib/proxy-api";

export default function ProxyPage() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [settings, setSettings] = useState<ProxySettings>({ binaryPath: "", pluginPath: "", port: 8317 });
  const [accounts, setAccounts] = useState<ProxyAccount[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [models, setModels] = useState<string[] | null>(null);
  const [testModel, setTestModel] = useState("");
  const [testResult, setTestResult] = useState<{ model: string; reply?: string; elapsedMs?: number; error?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState("");
  const [dirty, setDirty] = useState(false);
  const enabled = isDesktop() && !demoModeEnabled;

  async function refresh(initial = false) {
    const [s, a] = await Promise.all([
      proxyCall<ProxyStatus>("proxy_status"), proxyCall<ProxyAccount[]>("proxy_preview"),
    ]);
    setStatus(s); setAccounts(a);
    if (initial) setSettings(s.settings);
    if (!s.running) setModels(null);
    setError(s.lastError ?? "");
  }
  useEffect(() => {
    if (!enabled) return;
    void refresh(true).catch(e => setError(asError(e)));
    const timer = setInterval(() => { void refresh().catch(e => setError(asError(e))); }, 5000);
    return () => clearInterval(timer);
  }, [enabled]);
  useEffect(() => {
    if (!secret) return;
    const timer = setTimeout(() => setSecret(""), 30000);
    return () => clearTimeout(timer);
  }, [secret]);
  async function action(name: string, task: () => Promise<void>) {
    setBusy(name); setError("");
    try { await task(); await refresh(); }
    catch (e) { setError(asError(e)); }
    finally { setBusy(null); }
  }
  async function choose(field: "binaryPath" | "pluginPath") {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const chosen = await open({ multiple: false, directory: false, title: field === "binaryPath" ? "选择 CLIProxyAPI 引擎" : "选择 WorkBuddy 插件" });
      if (typeof chosen === "string") { setSettings(s => ({ ...s, [field]: chosen })); setDirty(true); }
    } catch (e) { setError(asError(e)); }
  }
  const unavailable = !enabled || Boolean(busy);
  const running = Boolean(status?.running);
  useEffect(() => { if (!running) setTestResult(null); }, [running]);
  const base = status?.baseUrl ?? "http://127.0.0.1:8317/v1";
  const model = models?.[0];
  const sample = `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer $WB_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ model: model ?? "从模型列表选择", messages: [{ role: "user", content: "你好" }], stream: true })}'`;
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast.success("已复制"); }
    catch { setError("无法访问剪贴板，请手动复制"); }
  }
  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-2xl font-semibold tracking-tight">Proxy API</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">把已授权账号接入本地模型 API。桌面账号切换与 API 账号池分别管理。</p></div>
        <Badge variant="outline" className="gap-2 py-1.5"><span className={`size-2 rounded-full ${running ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />{running ? (models !== null ? "API 已响应" : "进程运行，待检查 API") : "已停止"}</Badge>
      </header>
      {!enabled && <p role="status" className="rounded-lg border p-4 text-sm leading-6">{demoModeEnabled ? "当前为界面预览。http://127.0.0.1:8317/v1 是示例地址；预览不会读取本机账号，也不会启动代理。下方操作均已禁用。" : "代理服务控制仅在桌面应用中可用。"}</p>}
      {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>}
      <section aria-labelledby="connection" className="rounded-xl border bg-muted/20 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><h2 id="connection" className="text-sm font-medium">本地接入地址</h2><p className="mt-2 break-all font-mono text-lg">{base}</p></div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void copy(base)} disabled={!enabled}><Copy className="size-4" />复制地址</Button>
            {running ? <Button variant="outline" disabled={unavailable} onClick={() => void action("stop", async () => { await proxyCall("proxy_stop"); setSecret(""); })}><Square className="size-4" />停止服务</Button> :
              <Button disabled={unavailable || dirty || !status?.settings.binaryPath || !status?.settings.pluginPath} onClick={() => void action("start", async () => { await proxyCall("proxy_start"); toast.success("启动请求已提交，请检查模型列表"); })}><Play className="size-4" />启动服务</Button>}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t pt-4">
          <span className="text-sm text-muted-foreground">API 密钥</span>
          <code className="min-w-0 flex-1 break-all text-sm">{secret || "••••••••••••••••••••••••"}</code>
          <Button size="sm" variant="ghost" disabled={unavailable} onClick={() => void action("key", async () => { if (secret) setSecret(""); else setSecret(await proxyCall<string>("proxy_client_key")); })}>{secret ? "隐藏密钥" : "显示密钥"}</Button>
          <Button size="sm" variant="outline" disabled={unavailable} onClick={() => void action("copy-key", async () => copy(await proxyCall<string>("proxy_client_key")))}>复制密钥</Button>
          <Button size="sm" variant="outline" disabled={unavailable || running} onClick={async () => {
            const { confirm } = await import("@tauri-apps/plugin-dialog");
            if (await confirm("旧密钥会立即失效，所有客户端需要更新。继续轮换？", { title: "轮换 API 密钥", kind: "warning" })) {
              void action("rotate-key", async () => { await proxyCall("proxy_rotate_key"); setSecret(""); toast.success("密钥已轮换，请更新客户端"); });
            }
          }}>轮换密钥</Button>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">仅监听本机。密钥用于连接本地 API，不是 WorkBuddy 登录 Token。停止服务会中断正在生成的回复。</p>
      </section>
      <section aria-labelledby="engine" className="space-y-4">
        <div><h2 id="engine" className="text-base font-semibold">引擎配置</h2><p className="mt-1 text-sm text-muted-foreground">仅允许本版本已校验的 CLIProxyAPI 引擎和 WorkBuddy 插件，保存后启动。</p></div>
        {([['binaryPath', 'CLIProxyAPI 引擎'], ['pluginPath', 'WorkBuddy 插件']] as const).map(([field, label]) => (
          <div key={field} className="grid items-center gap-2 sm:grid-cols-[150px_1fr_auto]">
            <label htmlFor={field} className="text-sm">{label}</label>
            <Input id={field} value={settings[field]} placeholder="选择本地文件" disabled={unavailable || running} onChange={e => { setSettings(s => ({ ...s, [field]: e.target.value })); setDirty(true); }} />
            <Button variant="outline" aria-label={`选择${label}`} disabled={unavailable || running} onClick={() => void choose(field)}><FolderOpen className="size-4" /></Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="proxy-port" className="text-sm sm:w-[138px]">端口</label>
          <Input id="proxy-port" type="number" min={1024} max={65535} className="w-28" value={settings.port} disabled={unavailable || running} onChange={e => { setSettings(s => ({ ...s, port: Number(e.target.value) })); setDirty(true); }} />
          <Button variant="outline" disabled={unavailable || running || !dirty} onClick={() => void action("save", async () => { await proxyCall("proxy_save_settings", { settings }); setDirty(false); toast.success("代理配置已保存"); })}>保存配置</Button>
        </div>
      </section>
      <section aria-labelledby="pool" className="space-y-4 border-t pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="pool" className="text-base font-semibold">API 账号池 <span className="ml-2 text-sm font-normal text-muted-foreground">已同步 {status?.syncedAccounts ?? 0} 个</span></h2><p className="mt-1 text-sm text-muted-foreground">选择允许通过 API 使用的账号，停止服务后同步。</p></div>
          <Button variant="outline" disabled={unavailable || running || selected.length === 0} onClick={() => void action("sync", async () => { const result = await proxyCall<{added:number; updated:number; skipped:number}>("proxy_sync", { ids: selected }); setSelected([]); toast.success(`新增 ${result.added} 个，更新 ${result.updated} 个，保留 ${result.skipped} 个`); })}><RefreshCw className="size-4" />同步所选账号</Button></div>
        <Button size="sm" variant="outline" disabled={unavailable || running || selected.length === 0} onClick={async () => {
          const { confirm } = await import("@tauri-apps/plugin-dialog");
          if (!await confirm("将所选 API 账号的凭据替换为桌面账号库中的凭据。建议仅在重新 OAuth 登录后使用；停用状态会保留。继续？", { title: "替换代理凭据", kind: "warning" })) return;
          void action("replace", async () => { await proxyCall("proxy_sync", { ids: selected, replace: true }); setSelected([]); toast.success("所选凭据已替换"); });
        }}>重新授权后替换所选凭据</Button>
        <div className="overflow-hidden rounded-lg border">
          {accounts.length === 0 ? <div className="p-6 text-sm leading-6 text-muted-foreground">{demoModeEnabled ? "预览不会读取本机账号。桌面应用中，请先在「账号管理」添加账号，再回到这里选择。" : "暂无账号。先在「账号管理」中 OAuth 登录，或导入已有账号备份。"}</div> : accounts.map(a => (
            <label key={a.id} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
              <input type="checkbox" className="size-4 accent-current" disabled={unavailable || running || !a.eligible} checked={selected.includes(a.id)} onChange={e => setSelected(s => e.target.checked ? [...s,a.id] : s.filter(id => id !== a.id))} />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{a.name || a.id}</span>{a.reason && <span className="text-xs text-muted-foreground">{a.reason}</span>}</span>
              <span className="text-xs text-muted-foreground">{a.realm === "ai" ? "国际版" : "国内版"}</span>
              {a.synced && <Badge variant="secondary"><Check className="mr-1 size-3" />已同步</Badge>}
            </label>
          ))}
        </div>
        {Boolean(status?.pool.length) && <div className="space-y-2"><h3 className="text-sm font-medium">已接入账号</h3>{status?.pool.map(a => <div key={a.name} className="flex items-center justify-between gap-3 rounded-lg border px-4 py-2"><span className="truncate text-sm">{a.label}<span className="ml-2 text-xs text-muted-foreground">{a.enabled ? "已启用" : "已停用"}</span></span><Button size="sm" variant="outline" disabled={unavailable || running} onClick={() => void action("toggle", async () => { await proxyCall("proxy_set_enabled", { name: a.name, enabled: !a.enabled }); })}>{a.enabled ? "停用 API" : "启用 API"}</Button></div>)}</div>}
        <p className="text-xs leading-5 text-muted-foreground">普通同步保留已接入凭据。重新 OAuth 登录后，可选中账号并使用「替换所选凭据」。代理运行期间统一管理刷新；从桌面账号库移除账号不会自动移除 API 凭据。积分与签到仍在原页面管理，实际奖励以平台返回为准。</p>
      </section>
      <section aria-labelledby="models" className="space-y-4 border-t pt-6">
        <div className="flex items-center justify-between gap-3"><h2 id="models" className="text-base font-semibold">模型与连接检查</h2><Button variant="outline" disabled={unavailable || !running} onClick={() => void action("models", async () => { const result = await proxyCall<{data:string[]}>("proxy_models"); setModels(result.data); setTestModel(current => result.data.includes(current) ? current : result.data[0] ?? ""); setTestResult(null); })}>{busy === "models" ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-4" />}检查模型</Button></div>
        <p className="text-sm text-muted-foreground">{models === null ? "启动后读取实际模型列表。进程运行不代表模型调用已验证。" : models.length === 0 ? "引擎已连接，但没有可用模型。请检查插件是否加载、账号是否已同步。" : `已连接，发现 ${models.length} 个模型。列表可见性不保证每个模型都可调用。`}</p>
        {models && <div className="flex max-h-48 flex-wrap gap-2 overflow-auto">{models.map(m => <Badge key={m} variant="outline">{m}</Badge>)}</div>}
        <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
          <label htmlFor="test-model" className="block text-sm font-medium">测试模型连通性</label>
          <div className="flex flex-wrap gap-3">
            <select id="test-model" className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={testModel} disabled={unavailable || !running || !models?.length} onChange={e => { setTestModel(e.target.value); setTestResult(null); }}>
              <option value="" disabled>请先点击「检查模型」，再选择模型</option>
              {models?.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <Button disabled={unavailable || !running || !testModel} onClick={() => {
              setBusy("test"); setTestResult(null);
              void proxyCall<{model:string; reply:string; elapsedMs:number}>("proxy_test_model", { model: testModel })
                .then(setTestResult)
                .catch(e => setTestResult({model:testModel,error:asError(e)}))
                .finally(() => setBusy(null));
            }}>{busy === "test" ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Play className="size-4" />}{busy === "test" ? "测试中…" : "测试连通性"}</Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">发送一条简短真实请求，会使用少量账号额度，最多等待 60 秒。通过仅代表该模型本次文本调用成功，不代表全部模型或流式能力都可用。</p>
          {busy === "test" && <p role="status" className="text-sm">正在等待模型回复…</p>}
          {testResult && <div role={testResult.error ? "alert" : "status"} className={`rounded-lg border p-3 text-sm ${testResult.error ? "border-destructive/40 text-destructive" : "border-primary/40"}`}>
            <p className="font-medium">{testResult.error ? "测试未通过" : "模型调用成功"} · {testResult.model}</p>
            {testResult.error ? <p className="mt-2">{testResult.error}</p> : <><p className="mt-1 text-muted-foreground">耗时 {((testResult.elapsedMs ?? 0) / 1000).toFixed(2)} 秒</p><p className="mt-2 whitespace-pre-wrap break-words">{testResult.reply}</p></>}
          </div>}
        </div>
        <p className="text-xs text-muted-foreground">将密钥设为 WB_API_KEY，替换模型名称后测试。此请求会使用账号额度。</p>
        <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs leading-6"><code>{sample}</code></pre>
      </section>
    </div>
  );
}
