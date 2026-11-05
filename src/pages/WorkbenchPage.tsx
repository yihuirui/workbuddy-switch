import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Check, Copy, Download, FileUp, Pencil, Plus, RefreshCw, Search, ShieldAlert, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { displayName } from "@/lib/account-display";
import * as api from "@/lib/api";
import { backupSingleAccount } from "@/lib/workbench-account-backup";
import {
  createWorkbenchPrompt,
  mergeWorkbenchPromptImport,
  parseWorkbenchPromptImport,
  readWorkbenchPromptLibrary,
  saveWorkbenchPromptLibrary,
  searchWorkbenchPrompts,
  serializeWorkbenchPromptExport,
  WORKBENCH_PROMPT_MAX_CONTENT_LENGTH,
  WORKBENCH_PROMPT_MAX_FILE_BYTES,
  WORKBENCH_PROMPT_MAX_TAGS,
  WORKBENCH_PROMPT_MAX_TAG_LENGTH,
  WORKBENCH_PROMPT_MAX_TITLE_LENGTH,
  type PromptLibraryReadResult,
  type WorkbenchPrompt,
} from "@/lib/workbench-prompts";
import { accountVariant, variantLabel } from "@/lib/variant";
import { useAccountsStore } from "@/stores/accounts";

function fileDate(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function downloadTextFile(filename: string, text: string, mime = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function accountBackupFileName(accountId: string, accounts: { id: string }[]): string {
  const order = Math.max(0, accounts.findIndex((account) => account.id === accountId)) + 1;
  return `wb-switch-account-${order}-${fileDate()}.json`;
}

function tagValues(raw: string): string[] {
  return raw.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function promptDate(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(timestamp);
  } catch {
    return "日期未知";
  }
}

export default function WorkbenchPage() {
  const accounts = useAccountsStore((state) => state.accounts);
  const fetchAll = useAccountsStore((state) => state.fetchAll);
  const demoMode = api.isDemoMode();
  const desktop = api.isDesktop();
  const webui = api.isWebui();
  const usableAccounts = demoMode ? [] : accounts;

  const [library, setLibrary] = useState<PromptLibraryReadResult>(() => readWorkbenchPromptLibrary());
  const [query, setQuery] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [libraryMessage, setLibraryMessage] = useState<{ kind: "status" | "error"; text: string } | null>(null);
  const [deletePromptId, setDeletePromptId] = useState<string | null>(null);
  const [resetCorruptRequested, setResetCorruptRequested] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [refreshingAccounts, setRefreshingAccounts] = useState(false);
  const [accountMessage, setAccountMessage] = useState<{ kind: "status" | "error"; text: string } | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);

  const prompts = library.ok ? library.prompts : [];
  const visiblePrompts = useMemo(() => searchWorkbenchPrompts(prompts, query), [prompts, query]);
  const canEditLibrary = library.ok;
  const maxCountReached = prompts.length >= 100;

  function openNewPrompt() {
    setEditingId(null);
    setDraftTitle("");
    setDraftContent("");
    setDraftTags("");
    setLibraryMessage(null);
    setEditorOpen(true);
  }

  function openEditPrompt(prompt: WorkbenchPrompt) {
    setEditingId(prompt.id);
    setDraftTitle(prompt.title);
    setDraftContent(prompt.content);
    setDraftTags(prompt.tags.join(", "));
    setLibraryMessage(null);
    setEditorOpen(true);
  }

  function cancelEditing() {
    setEditorOpen(false);
    setEditingId(null);
    setDraftTitle("");
    setDraftContent("");
    setDraftTags("");
  }

  function savePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!library.ok) return;
    const tags = tagValues(draftTags);
    if (tags.length > WORKBENCH_PROMPT_MAX_TAGS || tags.some((tag) => tag.length > WORKBENCH_PROMPT_MAX_TAG_LENGTH)) {
      setLibraryMessage({ kind: "error", text: `标签最多 ${WORKBENCH_PROMPT_MAX_TAGS} 个，每个不超过 ${WORKBENCH_PROMPT_MAX_TAG_LENGTH} 个字符。` });
      return;
    }
    const now = Date.now();
    let next: WorkbenchPrompt[];
    if (editingId) {
      next = library.prompts.map((prompt) => prompt.id === editingId
        ? { ...prompt, title: draftTitle.trim(), content: draftContent, tags, updatedAt: now }
        : prompt);
    } else {
      if (library.prompts.length >= 100) {
        setLibraryMessage({ kind: "error", text: "提示词库已达到 100 条上限。" });
        return;
      }
      try {
        next = [createWorkbenchPrompt({ title: draftTitle, content: draftContent, tags }, now), ...library.prompts];
      } catch (error) {
        setLibraryMessage({ kind: "error", text: api.asError(error) });
        return;
      }
    }
    const saved = saveWorkbenchPromptLibrary(next);
    if (!saved.ok) {
      setLibraryMessage({ kind: "error", text: saved.error });
      return;
    }
    setLibrary(saved);
    setLibraryMessage({ kind: "status", text: editingId ? "提示词已更新并保存在此设备。" : "提示词已保存到此设备。" });
    cancelEditing();
  }

  function removePrompt(promptId: string) {
    if (!library.ok) return;
    if (deletePromptId !== promptId) {
      setDeletePromptId(promptId);
      return;
    }
    const saved = saveWorkbenchPromptLibrary(library.prompts.filter((prompt) => prompt.id !== promptId));
    if (!saved.ok) {
      setLibraryMessage({ kind: "error", text: saved.error });
      setDeletePromptId(null);
      return;
    }
    setLibrary(saved);
    setDeletePromptId(null);
    setLibraryMessage({ kind: "status", text: "提示词已删除。" });
  }

  async function copyPrompt(prompt: WorkbenchPrompt) {
    try {
      await navigator.clipboard.writeText(prompt.content);
      setLibraryMessage({ kind: "status", text: `「${prompt.title}」已复制到剪贴板；是否发送由你决定。` });
    } catch {
      setLibraryMessage({ kind: "error", text: "无法访问剪贴板，请手动选择并复制提示词正文。" });
    }
  }

  function exportPromptLibrary() {
    if (!library.ok || library.prompts.length === 0) return;
    try {
      const text = serializeWorkbenchPromptExport(library.prompts);
      downloadTextFile(`wb-switch-prompts-${fileDate()}.json`, text);
      setLibraryMessage({ kind: "status", text: `已开始下载 ${library.prompts.length} 条提示词的 JSON 备份。` });
    } catch (error) {
      setLibraryMessage({ kind: "error", text: api.asError(error) });
    }
  }

  function exportUnreadableData() {
    if (library.ok || !library.raw) return;
    downloadTextFile(`wb-switch-prompts-unreadable-${fileDate()}.json`, library.raw);
    setLibraryMessage({ kind: "status", text: "已开始下载无法解析的原始本地数据副本。" });
  }

  async function importPromptLibrary(event: FormEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setLibraryMessage(null);
    if (file.size > WORKBENCH_PROMPT_MAX_FILE_BYTES) {
      setLibraryMessage({ kind: "error", text: "导入文件超过 2 MiB 限制。原有数据未更改。" });
      return;
    }
    try {
      const parsed = parseWorkbenchPromptImport(await file.text());
      if (!parsed.ok) {
        setLibraryMessage({ kind: "error", text: `${parsed.error} 原有数据未更改。` });
        return;
      }
      const merged = library.ok
        ? mergeWorkbenchPromptImport(library.prompts, parsed.prompts)
        : { ok: true as const, prompts: parsed.prompts, added: parsed.prompts.length, skipped: 0 };
      if (!merged.ok) {
        setLibraryMessage({ kind: "error", text: `${merged.error} 原有数据未更改。` });
        return;
      }
      const saved = saveWorkbenchPromptLibrary(merged.prompts);
      if (!saved.ok) {
        setLibraryMessage({ kind: "error", text: `${saved.error} 原有数据未更改。` });
        return;
      }
      setLibrary(saved);
      setResetCorruptRequested(false);
      const recovery = library.ok ? "" : "损坏数据已由有效备份替换；";
      setLibraryMessage({ kind: "status", text: `${recovery}新增 ${merged.added} 条，跳过重复 ${merged.skipped} 条。导入内容只作为文本保存，不会执行或发送。` });
    } catch (error) {
      setLibraryMessage({ kind: "error", text: `读取文件失败：${api.asError(error)} 原有数据未更改。` });
    }
  }

  async function clearUnreadableData() {
    if (library.ok) return;
    if (!resetCorruptRequested) {
      setResetCorruptRequested(true);
      return;
    }
    const saved = saveWorkbenchPromptLibrary([]);
    if (!saved.ok) {
      setLibraryMessage({ kind: "error", text: saved.error });
      setResetCorruptRequested(false);
      return;
    }
    setLibrary(saved);
    setResetCorruptRequested(false);
    setLibraryMessage({ kind: "status", text: "已清除无法读取的提示词数据，可以开始新建提示词。" });
  }

  async function refreshAccountList() {
    if (demoMode || refreshingAccounts) return;
    setRefreshingAccounts(true);
    setAccountMessage(null);
    setSelectedAccountId("");
    try {
      await fetchAll();
      const error = useAccountsStore.getState().error;
      if (error) setAccountMessage({ kind: "error", text: error });
      else setAccountMessage({ kind: "status", text: `账号列表已刷新，共 ${useAccountsStore.getState().accounts.length} 个账号。` });
    } catch (error) {
      setAccountMessage({ kind: "error", text: api.asError(error) });
    } finally {
      setRefreshingAccounts(false);
    }
  }

  async function backupOneAccount() {
    const account = usableAccounts.find((item) => item.id === selectedAccountId);
    if (!account || backupBusy || demoMode || (!desktop && !webui)) return;
    setBackupBusy(true);
    setAccountMessage(null);
    const filename = accountBackupFileName(account.id, usableAccounts);
    try {
      const result = await backupSingleAccount(account.id, filename, desktop ? "desktop" : "browser", {
        chooseSavePath: async (suggestedFilename) => {
          const { save } = await import("@tauri-apps/plugin-dialog");
          return save({
            title: "备份单个账号",
            defaultPath: suggestedFilename,
            filters: [{ name: "JSON", extensions: ["json"] }],
          });
        },
        exportToPath: api.exportAccountsToPath,
        exportForDownload: api.exportAccounts,
        download: downloadTextFile,
      });
      if (result.kind === "saved") {
        setAccountMessage({ kind: "status", text: `已单独备份「${displayName(account)}」到：${result.path}` });
      } else if (result.kind === "downloaded") {
        setAccountMessage({ kind: "status", text: `已单独导出「${displayName(account)}」的 JSON 文件。请在浏览器下载列表中确认保存位置。` });
      } else if (result.kind === "failed") {
        setAccountMessage({ kind: "error", text: result.message });
      }
    } catch (error) {
      setAccountMessage({ kind: "error", text: `账号备份失败：${api.asError(error)}` });
    } finally {
      setBackupBusy(false);
    }
  }

  const selectedAccountExists = usableAccounts.some((account) => account.id === selectedAccountId);

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">效率工具</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">保存常用提示词，按需复制；为各个账号分别创建本地备份。所有操作都由你在本页主动发起。</p>
        </div>
      </header>

      <section className="space-y-4" aria-labelledby="prompt-library-title">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 id="prompt-library-title" className="text-base font-semibold">提示词库</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">提示词以纯文本保存在此设备。复制后由你决定是否粘贴和发送，不会自动执行。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => importInputRef.current?.click()}>
              <FileUp />导入 JSON
            </Button>
            <input ref={importInputRef} type="file" accept=".json,application/json" className="sr-only" aria-label="选择要导入的提示词 JSON 文件" onChange={(event) => void importPromptLibrary(event)} />
            <Button variant="outline" onClick={exportPromptLibrary} disabled={!library.ok || library.prompts.length === 0}>
              <Download />导出 JSON
            </Button>
            <Button onClick={openNewPrompt} disabled={!canEditLibrary || maxCountReached}>
              <Plus />新增提示词
            </Button>
          </div>
        </div>

        {!library.ok && (
          <div role="alert" className="space-y-3 rounded-lg border border-amber-700/30 bg-amber-500/5 p-4 text-sm leading-6">
            <div className="flex gap-3">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-800 dark:text-amber-300" />
              <div>
                <p className="font-medium">本地提示词数据无法读取，原始内容已保留</p>
                <p className="mt-1 text-muted-foreground">{library.error} 编辑和删除暂时停用。导入有效备份会在校验成功后替换损坏数据。</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pl-7">
              {library.raw !== null && <Button size="sm" variant="outline" onClick={exportUnreadableData}><Download />下载原始副本</Button>}
              <Button size="sm" variant={resetCorruptRequested ? "destructive" : "outline"} onClick={() => void clearUnreadableData()}>
                {resetCorruptRequested ? "确认清除并重新开始" : "清除损坏数据"}
              </Button>
              {resetCorruptRequested && <Button size="sm" variant="ghost" onClick={() => setResetCorruptRequested(false)}><X />取消</Button>}
            </div>
          </div>
        )}

        {library.ok && editorOpen && (
          <form className="space-y-4 rounded-lg border p-4" onSubmit={savePrompt}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">{editingId ? "编辑提示词" : "新增提示词"}</h3>
              <Button type="button" variant="ghost" size="icon" aria-label="关闭编辑器" onClick={cancelEditing}><X /></Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,0.45fr)]">
              <div className="space-y-2">
                <label htmlFor="prompt-title" className="text-sm font-medium">标题</label>
                <Input id="prompt-title" value={draftTitle} maxLength={WORKBENCH_PROMPT_MAX_TITLE_LENGTH} required placeholder="例如：代码审查清单" onChange={(event) => setDraftTitle(event.target.value)} />
              </div>
              <div className="space-y-2">
                <label htmlFor="prompt-tags" className="text-sm font-medium">标签 <span className="font-normal text-muted-foreground">可选，用逗号分隔</span></label>
                <Input id="prompt-tags" value={draftTags} placeholder="代码, 审查" onChange={(event) => setDraftTags(event.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="prompt-content" className="text-sm font-medium">提示词正文</label>
              <textarea
                id="prompt-content"
                className="flex min-h-40 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                value={draftContent}
                maxLength={WORKBENCH_PROMPT_MAX_CONTENT_LENGTH}
                required
                placeholder="只会保存为文本；保存不会执行或发送。"
                onChange={(event) => setDraftContent(event.target.value)}
              />
              <p className="text-right text-xs tabular-nums text-muted-foreground">{draftContent.length} / {WORKBENCH_PROMPT_MAX_CONTENT_LENGTH}</p>
            </div>
            {libraryMessage?.kind === "error" && <p role="alert" className="text-sm text-destructive">{libraryMessage.text}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={cancelEditing}>取消</Button>
              <Button type="submit"><Check />保存提示词</Button>
            </div>
          </form>
        )}

        {library.ok && (
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="prompt-search" className="sr-only">搜索提示词</label>
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="prompt-search" type="search" className="pl-9" value={query} placeholder="搜索标题、正文或标签" onChange={(event) => setQuery(event.target.value)} />
            </div>
            <p className="text-sm tabular-nums text-muted-foreground">显示 {visiblePrompts.length} / {prompts.length}</p>
          </div>
        )}

        {library.ok && prompts.length === 0 && !editorOpen && (
          <div className="rounded-lg border border-dashed px-5 py-8 text-center">
            <p className="text-sm font-medium">还没有保存的提示词</p>
            <p className="mt-1 text-sm text-muted-foreground">新增一条常用提示词，之后可以搜索并复制。</p>
            <Button className="mt-4" onClick={openNewPrompt}><Plus />新增提示词</Button>
          </div>
        )}

        {library.ok && prompts.length > 0 && visiblePrompts.length === 0 && (
          <p className="rounded-lg border border-dashed px-5 py-8 text-center text-sm text-muted-foreground">没有匹配「{query}」的提示词。</p>
        )}

        {library.ok && visiblePrompts.length > 0 && (
          <div className="divide-y rounded-lg border px-4 sm:px-5">
            {visiblePrompts.map((prompt) => (
              <article key={prompt.id} className="py-4 first:pt-5 last:pb-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-sm font-semibold">{prompt.title}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">更新于 {promptDate(prompt.updatedAt)}</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={() => void copyPrompt(prompt)}><Copy />复制</Button>
                    <Button size="sm" variant="ghost" onClick={() => openEditPrompt(prompt)} disabled={!canEditLibrary}><Pencil />编辑</Button>
                    <Button size="sm" variant={deletePromptId === prompt.id ? "destructive" : "ghost"} onClick={() => removePrompt(prompt.id)} disabled={!canEditLibrary}>
                      <Trash2 />{deletePromptId === prompt.id ? "确认删除" : "删除"}
                    </Button>
                    {deletePromptId === prompt.id && <Button size="sm" variant="ghost" onClick={() => setDeletePromptId(null)}><X />取消</Button>}
                  </div>
                </div>
                <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{prompt.content}</p>
                {prompt.tags.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{prompt.tags.map((tag) => <span key={tag} className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{tag}</span>)}</div>}
              </article>
            ))}
          </div>
        )}

        {libraryMessage && <p role={libraryMessage.kind === "error" ? "alert" : "status"} className={`text-sm leading-6 ${libraryMessage.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>{libraryMessage.text}</p>}
        {library.ok && maxCountReached && <p className="text-sm text-muted-foreground">提示词库已达到 100 条上限。导入合并前请先删除部分内容。</p>}
      </section>

      <section className="space-y-4 border-t pt-6" aria-labelledby="account-backup-title">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 id="account-backup-title" className="text-base font-semibold">单账号备份</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">每次只导出一个账号。选择账号后，再选择文件保存位置。</p>
          </div>
          <Button variant="outline" onClick={() => void refreshAccountList()} disabled={demoMode || refreshingAccounts}>
            <RefreshCw className={refreshingAccounts ? "animate-spin motion-reduce:animate-none" : ""} />刷新账号列表
          </Button>
        </div>

        <div role="note" className="flex gap-3 rounded-lg border border-amber-700/30 bg-amber-500/5 p-4 text-sm leading-6">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-800 dark:text-amber-300" />
          <p>账号备份文件包含可恢复登录状态的凭据，请像保护密码一样保存和传输，不要上传网盘或发送给他人。账号凭据只在你点击导出时读取，不会写入提示词库或 localStorage。</p>
        </div>

        {demoMode && <p role="status" className="rounded-lg border p-4 text-sm leading-6 text-muted-foreground">当前为界面演示模式，不会读取或导出真实账号。</p>}

        <div className="grid gap-3 sm:grid-cols-[minmax(220px,1fr)_auto]">
          <label htmlFor="account-backup-select" className="sr-only">选择要单独备份的账号</label>
          <select
            id="account-backup-select"
            className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            value={selectedAccountId}
            disabled={demoMode || usableAccounts.length === 0 || backupBusy}
            onChange={(event) => { setSelectedAccountId(event.target.value); setAccountMessage(null); }}
          >
            <option value="">选择一个账号</option>
            {usableAccounts.map((account) => <option key={account.id} value={account.id}>{displayName(account)} · {variantLabel(accountVariant(account))}</option>)}
          </select>
          <Button onClick={() => void backupOneAccount()} disabled={demoMode || backupBusy || !selectedAccountExists || (!desktop && !webui)}>
            {backupBusy ? "正在备份…" : "选择路径并备份此账号"}
          </Button>
        </div>

        {!demoMode && usableAccounts.length === 0 && (
          <p className="text-sm leading-6 text-muted-foreground">尚无已载入的账号。点击“刷新账号列表”后才会读取当前账号清单；本页不会自动扫描账号。</p>
        )}
        {!desktop && !webui && !demoMode && <p className="text-sm text-muted-foreground">当前宿主不支持账号文件导出。</p>}
        {accountMessage && <p role={accountMessage.kind === "error" ? "alert" : "status"} className={`break-words text-sm leading-6 ${accountMessage.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>{accountMessage.text}</p>}
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 border-t pt-6" aria-labelledby="sessions-migration-title">
        <div>
          <h2 id="sessions-migration-title" className="text-base font-semibold">跨账号会话</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">已有会话关联与迁移入口在“关联会话”页。</p>
        </div>
        <Button asChild variant="outline"><Link to="/sessions">前往关联会话</Link></Button>
      </section>
    </div>
  );
}
