export const WORKBENCH_PROMPT_STORAGE_KEY = "wb-switch.workbench-prompts.v1";
export const WORKBENCH_PROMPT_FORMAT = "wb-switch.workbench-prompts";
export const WORKBENCH_PROMPT_VERSION = 1;
export const WORKBENCH_PROMPT_MAX_COUNT = 100;
export const WORKBENCH_PROMPT_MAX_TITLE_LENGTH = 120;
export const WORKBENCH_PROMPT_MAX_CONTENT_LENGTH = 5_000;
export const WORKBENCH_PROMPT_MAX_TAGS = 10;
export const WORKBENCH_PROMPT_MAX_TAG_LENGTH = 32;
export const WORKBENCH_PROMPT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface WorkbenchPrompt {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PromptStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type PromptLibraryReadResult =
  | { ok: true; prompts: WorkbenchPrompt[] }
  | { ok: false; error: string; raw: string | null };

export type PromptOperationResult =
  | { ok: true; prompts: WorkbenchPrompt[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validatePrompt(value: unknown, index: number): WorkbenchPrompt {
  if (!isRecord(value)) throw new Error(`第 ${index + 1} 条提示词格式无效。`);
  const { id, title, content, tags, createdAt, updatedAt } = value;
  if (typeof id !== "string" || id.length === 0 || id.length > 160) {
    throw new Error(`第 ${index + 1} 条提示词缺少有效标识。`);
  }
  if (typeof title !== "string" || title.trim().length === 0 || title.length > WORKBENCH_PROMPT_MAX_TITLE_LENGTH) {
    throw new Error(`第 ${index + 1} 条提示词标题为空或超过 ${WORKBENCH_PROMPT_MAX_TITLE_LENGTH} 个字符。`);
  }
  if (typeof content !== "string" || content.trim().length === 0 || content.length > WORKBENCH_PROMPT_MAX_CONTENT_LENGTH) {
    throw new Error(`第 ${index + 1} 条提示词正文为空或超过 ${WORKBENCH_PROMPT_MAX_CONTENT_LENGTH} 个字符。`);
  }
  if (!Array.isArray(tags) || tags.length > WORKBENCH_PROMPT_MAX_TAGS || tags.some((tag) => typeof tag !== "string" || tag.trim().length === 0 || tag.length > WORKBENCH_PROMPT_MAX_TAG_LENGTH)) {
    throw new Error(`第 ${index + 1} 条提示词标签无效，最多 ${WORKBENCH_PROMPT_MAX_TAGS} 个、每个不超过 ${WORKBENCH_PROMPT_MAX_TAG_LENGTH} 个字符。`);
  }
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt < 0 || typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0) {
    throw new Error(`第 ${index + 1} 条提示词时间字段无效。`);
  }
  return {
    id,
    title: title.trim(),
    content,
    tags: tags.map((tag) => tag.trim()),
    createdAt,
    updatedAt,
  };
}

function validatePromptList(value: unknown): WorkbenchPrompt[] {
  if (!Array.isArray(value)) throw new Error("提示词列表格式无效。");
  if (value.length > WORKBENCH_PROMPT_MAX_COUNT) {
    throw new Error(`提示词数量不能超过 ${WORKBENCH_PROMPT_MAX_COUNT} 条。`);
  }
  const prompts = value.map((prompt, index) => validatePrompt(prompt, index));
  const ids = new Set<string>();
  for (const prompt of prompts) {
    if (ids.has(prompt.id)) throw new Error("提示词列表中存在重复标识。");
    ids.add(prompt.id);
  }
  return prompts;
}

function resolveStorage(storage?: PromptStorageLike): PromptStorageLike {
  if (storage) return storage;
  if (typeof window === "undefined") throw new Error("当前环境无法访问本地存储。");
  return window.localStorage;
}

export function readWorkbenchPromptLibrary(storage?: PromptStorageLike): PromptLibraryReadResult {
  let target: PromptStorageLike;
  try {
    target = resolveStorage(storage);
    const raw = target.getItem(WORKBENCH_PROMPT_STORAGE_KEY);
    if (raw === null) return { ok: true, prompts: [] };
    if (byteLength(raw) > WORKBENCH_PROMPT_MAX_FILE_BYTES) {
      return { ok: false, error: "本地提示词数据超过安全读取上限，原始数据已保留。", raw };
    }
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.format !== WORKBENCH_PROMPT_FORMAT || value.version !== WORKBENCH_PROMPT_VERSION) {
      return { ok: false, error: "本地提示词数据版本或格式无法识别，原始数据已保留。", raw };
    }
    try {
      return { ok: true, prompts: validatePromptList(value.prompts) };
    } catch (error) {
      return { ok: false, error: `${error instanceof Error ? error.message : "提示词数据无效。"} 原始数据已保留。`, raw };
    }
  } catch (error) {
    const raw = (() => {
      try { return storage?.getItem(WORKBENCH_PROMPT_STORAGE_KEY) ?? null; } catch { return null; }
    })();
    return { ok: false, error: error instanceof Error ? `无法读取本地提示词数据：${error.message}` : "无法读取本地提示词数据。", raw };
  }
}

export function saveWorkbenchPromptLibrary(prompts: WorkbenchPrompt[], storage?: PromptStorageLike): PromptOperationResult {
  try {
    const clean = validatePromptList(prompts);
    const serialized = JSON.stringify({
      format: WORKBENCH_PROMPT_FORMAT,
      version: WORKBENCH_PROMPT_VERSION,
      prompts: clean,
    }, null, 2);
    if (byteLength(serialized) > WORKBENCH_PROMPT_MAX_FILE_BYTES) {
      return { ok: false, error: "提示词库超过 2 MiB 限制，请删除较大的提示词后再保存。" };
    }
    resolveStorage(storage).setItem(WORKBENCH_PROMPT_STORAGE_KEY, serialized);
    return { ok: true, prompts: clean };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "保存提示词库失败。" };
  }
}

export function createWorkbenchPrompt(input: {
  title: string;
  content: string;
  tags: string[];
}, now = Date.now()): WorkbenchPrompt {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `prompt-${now}-${Math.random().toString(36).slice(2, 10)}`;
  return validatePrompt({ ...input, id, createdAt: now, updatedAt: now }, 0);
}

export function parseWorkbenchPromptImport(text: string): PromptOperationResult {
  if (byteLength(text) > WORKBENCH_PROMPT_MAX_FILE_BYTES) {
    return { ok: false, error: "导入文件超过 2 MiB 限制。" };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.format !== WORKBENCH_PROMPT_FORMAT || value.version !== WORKBENCH_PROMPT_VERSION) {
      return { ok: false, error: "文件格式不受支持。请选择从效率工具导出的提示词 JSON。" };
    }
    return { ok: true, prompts: validatePromptList(value.prompts) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "JSON 文件无法解析。" };
  }
}

export function serializeWorkbenchPromptExport(prompts: WorkbenchPrompt[], exportedAt = new Date().toISOString()): string {
  const clean = validatePromptList(prompts);
  return JSON.stringify({
    format: WORKBENCH_PROMPT_FORMAT,
    version: WORKBENCH_PROMPT_VERSION,
    exportedAt,
    prompts: clean,
  }, null, 2);
}

export function mergeWorkbenchPromptImport(
  existing: WorkbenchPrompt[],
  imported: WorkbenchPrompt[],
): { ok: true; prompts: WorkbenchPrompt[]; added: number; skipped: number } | { ok: false; error: string } {
  try {
    const current = validatePromptList(existing);
    const incoming = validatePromptList(imported);
    const ids = new Set(current.map((prompt) => prompt.id));
    const additions = incoming.filter((prompt) => !ids.has(prompt.id));
    if (current.length + additions.length > WORKBENCH_PROMPT_MAX_COUNT) {
      return { ok: false, error: `合并后会超过 ${WORKBENCH_PROMPT_MAX_COUNT} 条上限，请先删除部分提示词。` };
    }
    return { ok: true, prompts: [...current, ...additions], added: additions.length, skipped: incoming.length - additions.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "无法合并导入内容。" };
  }
}

export function searchWorkbenchPrompts(prompts: WorkbenchPrompt[], query: string): WorkbenchPrompt[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return prompts;
  return prompts.filter((prompt) => [prompt.title, prompt.content, ...prompt.tags].some((value) => value.toLocaleLowerCase().includes(needle)));
}
