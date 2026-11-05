import { describe, expect, it } from "vitest";

import {
  createWorkbenchPrompt,
  mergeWorkbenchPromptImport,
  parseWorkbenchPromptImport,
  readWorkbenchPromptLibrary,
  saveWorkbenchPromptLibrary,
  searchWorkbenchPrompts,
  serializeWorkbenchPromptExport,
  WORKBENCH_PROMPT_FORMAT,
  WORKBENCH_PROMPT_MAX_FILE_BYTES,
  WORKBENCH_PROMPT_STORAGE_KEY,
  WORKBENCH_PROMPT_VERSION,
  type PromptStorageLike,
} from "./workbench-prompts";

function memoryStorage(initial: Record<string, string> = {}): PromptStorageLike & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

function prompt(id: string, title = `提示词 ${id}`) {
  return { id, title, content: `正文 ${id}`, tags: ["代码"], createdAt: 10, updatedAt: 20 };
}

describe("workbench prompt library", () => {
  it("starts empty when no local library exists and round-trips a saved library", () => {
    const storage = memoryStorage();
    expect(readWorkbenchPromptLibrary(storage)).toEqual({ ok: true, prompts: [] });

    const first = createWorkbenchPrompt({ title: "  代码审查  ", content: "检查边界情况", tags: ["代码"] }, 42);
    const saved = saveWorkbenchPromptLibrary([first], storage);
    expect(saved).toEqual({ ok: true, prompts: [{ ...first, title: "代码审查" }] });
    expect(readWorkbenchPromptLibrary(storage)).toEqual(saved);
    expect(storage.values.get(WORKBENCH_PROMPT_STORAGE_KEY)).toContain(WORKBENCH_PROMPT_FORMAT);
  });

  it("keeps malformed local data intact and reports a recoverable error", () => {
    const damaged = "{not-json";
    const storage = memoryStorage({ [WORKBENCH_PROMPT_STORAGE_KEY]: damaged });
    const result = readWorkbenchPromptLibrary(storage);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected local data to be rejected");
    expect(result.raw).toBe(damaged);
    expect(storage.values.get(WORKBENCH_PROMPT_STORAGE_KEY)).toBe(damaged);
  });

  it("does not report success when local storage refuses a write", () => {
    const storage: PromptStorageLike = {
      getItem: () => null,
      setItem: () => { throw new Error("quota exceeded"); },
    };
    const result = saveWorkbenchPromptLibrary([prompt("one")], storage);
    expect(result).toMatchObject({ ok: false, error: "quota exceeded" });
  });

  it("exports and validates a versioned JSON file without executing prompt text", () => {
    const text = serializeWorkbenchPromptExport([prompt("one")], "2026-11-06T00:00:00.000Z");
    expect(parseWorkbenchPromptImport(text)).toEqual({ ok: true, prompts: [prompt("one")] });
    expect(JSON.parse(text)).toMatchObject({ format: WORKBENCH_PROMPT_FORMAT, version: WORKBENCH_PROMPT_VERSION });
  });

  it("rejects malformed, oversized and schema-invalid import files", () => {
    expect(parseWorkbenchPromptImport("not json").ok).toBe(false);
    expect(parseWorkbenchPromptImport(" ".repeat(WORKBENCH_PROMPT_MAX_FILE_BYTES + 1))).toMatchObject({ ok: false, error: expect.stringContaining("2 MiB") });
    expect(parseWorkbenchPromptImport(JSON.stringify({ format: "other", version: 1, prompts: [] }))).toMatchObject({ ok: false, error: expect.stringContaining("不受支持") });
    expect(parseWorkbenchPromptImport(JSON.stringify({ format: WORKBENCH_PROMPT_FORMAT, version: 1, prompts: [{ ...prompt("x"), content: "" }] }))).toMatchObject({ ok: false, error: expect.stringContaining("正文为空") });
  });

  it("merges imports without replacing same-id prompts and searches titles, content and tags", () => {
    const existing = [prompt("one", "现有版本")];
    const merged = mergeWorkbenchPromptImport(existing, [prompt("one", "备份版本"), prompt("two", "新提示词")]);
    expect(merged).toMatchObject({ ok: true, added: 1, skipped: 1 });
    if (!merged.ok) throw new Error(merged.error);
    expect(merged.prompts.map(({ id, title }) => [id, title])).toEqual([["one", "现有版本"], ["two", "新提示词"]]);
    expect(searchWorkbenchPrompts(merged.prompts, "备份")).toEqual([]);
    expect(searchWorkbenchPrompts(merged.prompts, "新提示")).toEqual([merged.prompts[1]]);
    expect(searchWorkbenchPrompts(merged.prompts, "代码")).toEqual(merged.prompts);
  });
});
