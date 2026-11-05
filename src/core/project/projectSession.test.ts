import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.assign(globalThis, { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  return { desktop: vi.fn(() => true), open: vi.fn(), save: vi.fn(), confirm: vi.fn(), exists: vi.fn(), read: vi.fn(), write: vi.fn() };
});

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.desktop }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save, confirm: mocks.confirm }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: mocks.exists }));
vi.mock("./projectFileIO", () => ({ readProjectFile: mocks.read, writeProjectFile: mocks.write }));

import { createInitialDocument } from "./factory";
import {
  beginProjectExport, beginProjectImport, registerProjectSwitchHook,
  setUnsavedChangesPrompt, useProjectSession,
} from "./projectSession";
import { useProjectStore } from "./store";

const session = () => useProjectSession.getState();
const project = () => useProjectStore.getState();
function edit() { project().addTrack("video"); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.desktop.mockReturnValue(true);
  mocks.open.mockResolvedValue("/projects/loaded.jian");
  mocks.save.mockResolvedValue("/projects/saved.jian");
  mocks.exists.mockResolvedValue(false);
  mocks.confirm.mockResolvedValue(true);
  mocks.read.mockImplementation(async () => createInitialDocument());
  mocks.write.mockResolvedValue(undefined);
  useProjectSession.setState({ busy: false, importing: 0, exporting: false });
  project().setExportState({ running: false });
  setUnsavedChangesPrompt(async () => "discard");
  await session().newProject();
});

describe("project document lifecycle", () => {
  it("tracks only document edits, saves a named project, and reuses its path", async () => {
    project().setSelection(["some-clip"]);
    project().setPlayhead(100);
    project().setPlaying(true);
    project().setExportState({ error: "previous export" });
    project().setExportEngine("ffmpeg");
    expect(session().dirty).toBe(false);
    edit();
    expect(session().dirty).toBe(true);
    expect(await session().saveProject()).toBe(true);
    expect(session()).toMatchObject({ path: "/projects/saved.jian", dirty: false, busy: false, error: null });
    expect(project().document.name).toBe("saved");
    expect(mocks.write).toHaveBeenCalledWith("/projects/saved.jian", project().document);
    edit();
    expect(await session().saveProject()).toBe(true);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenCalledTimes(2);
  });

  it("save as appends the project extension and cancellation preserves path and edits", async () => {
    await session().saveProject();
    edit();
    const current = project().document;
    mocks.save.mockResolvedValueOnce(null);
    expect(await session().saveProject(true)).toBe(false);
    expect(session()).toMatchObject({ path: "/projects/saved.jian", dirty: true, error: null });
    expect(project().document).toBe(current);
    mocks.save.mockResolvedValueOnce("C:\\projects\\second");
    expect(await session().saveProject(true)).toBe(true);
    expect(session().path).toBe("C:\\projects\\second.jian");
    expect(project().document.name).toBe("second");
    expect(session().dirty).toBe(false);
  });

  it("does not rename or mark clean when a write fails", async () => {
    await session().saveProject();
    edit();
    const current = project().document;
    mocks.save.mockResolvedValueOnce("/projects/new-name.jian");
    mocks.write.mockRejectedValueOnce(new Error("磁盘已满"));
    expect(await session().saveProject(true)).toBe(false);
    expect(project().document).toBe(current);
    expect(session()).toMatchObject({ path: "/projects/saved.jian", dirty: true, busy: false, error: "磁盘已满" });
  });

  it("confirms collisions on an appended extension and preserves work when declined", async () => {
    edit();
    const current = project().document;
    mocks.save.mockResolvedValue("/projects/existing");
    mocks.exists.mockResolvedValue(true);
    mocks.confirm.mockResolvedValueOnce(false);
    expect(await session().saveProject()).toBe(false);
    expect(mocks.exists).toHaveBeenCalledWith("/projects/existing.jian");
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(project().document).toBe(current);
    expect(session()).toMatchObject({ path: null, dirty: true, error: null });
    expect(await session().saveProject()).toBe(true);
    expect(mocks.write).toHaveBeenCalledWith("/projects/existing.jian", project().document);
  });

  it("successful open resets session state and calls switch hooks after validation", async () => {
    const loaded = { ...createInitialDocument(), name: "loaded" };
    mocks.read.mockResolvedValueOnce(loaded);
    project().setSelection(["old"]);
    project().setPlayhead(999);
    project().setPlaying(true);
    project().setExportState({ error: "old error", timeUs: 42, totalUs: 100 });
    const generation = session().generation;
    const hook = vi.fn(() => expect(project().document).not.toBe(loaded));
    const release = registerProjectSwitchHook(hook);
    expect(await session().openProject()).toBe(true);
    release();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(project()).toMatchObject({ document: loaded, selection: [], playheadUs: 0, isPlaying: false,
      exportState: { error: null, running: false, timeUs: 0, totalUs: 0 } });
    expect(session()).toMatchObject({ path: "/projects/loaded.jian", dirty: false, generation: generation + 1 });
  });

  it("bad or canceled open preserves current work without prompting for unsaved changes", async () => {
    edit();
    const current = project().document;
    const prompt = vi.fn(async () => "discard" as const);
    setUnsavedChangesPrompt(prompt);
    mocks.read.mockRejectedValueOnce(new Error("工程格式损坏"));
    expect(await session().openProject()).toBe(false);
    expect(session().error).toBe("工程格式损坏");
    expect(project().document).toBe(current);
    expect(prompt).not.toHaveBeenCalled();
    mocks.open.mockResolvedValueOnce(null);
    expect(await session().openProject()).toBe(false);
    expect(session()).toMatchObject({ dirty: true, error: null });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("new and close honor save, discard, cancel, and failed save", async () => {
    edit();
    const current = project().document;
    setUnsavedChangesPrompt(async () => "cancel");
    expect(await session().newProject()).toBe(false);
    expect(await session().confirmClose()).toBe(false);
    expect(project().document).toBe(current);
    setUnsavedChangesPrompt(async () => "save");
    mocks.write.mockRejectedValueOnce(new Error("只读目录"));
    expect(await session().newProject()).toBe(false);
    expect(project().document).toBe(current);
    expect(session().dirty).toBe(true);
    expect(await session().confirmClose()).toBe(true);
    expect(session().dirty).toBe(false);
    edit();
    setUnsavedChangesPrompt(async () => "discard");
    expect(await session().newProject()).toBe(true);
    expect(session()).toMatchObject({ path: null, dirty: false });
    expect(project().document.assets).toEqual([]);
  });
});

describe("async operation protection", () => {
  it("leaves edits made during a snapshot write dirty", async () => {
    await session().saveProject();
    edit();
    const snapshot = project().document;
    const pending = deferred<void>();
    mocks.write.mockReturnValueOnce(pending.promise);
    const saving = session().saveProject();
    expect(session().busy).toBe(true);
    expect(mocks.write).toHaveBeenLastCalledWith("/projects/saved.jian", snapshot);
    edit();
    const newest = project().document;
    pending.resolve();
    expect(await saving).toBe(true);
    expect(project().document).toBe(newest);
    expect(session()).toMatchObject({ dirty: true, busy: false });
  });

  it("does not leave after saving when a newer edit was not written", async () => {
    await session().saveProject();
    edit();
    setUnsavedChangesPrompt(async () => "save");
    const pending = deferred<void>();
    mocks.write.mockReturnValueOnce(pending.promise);
    const closing = session().confirmClose();
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
    edit();
    pending.resolve();
    expect(await closing).toBe(false);
    expect(session().dirty).toBe(true);
    expect(session().error).toContain("新的修改");
  });

  it("protects edits arriving while an open file is being read", async () => {
    const pending = deferred<ReturnType<typeof createInitialDocument>>();
    mocks.read.mockReturnValueOnce(pending.promise);
    const opening = session().openProject();
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    edit();
    const newest = project().document;
    pending.resolve(createInitialDocument());
    expect(await opening).toBe(false);
    expect(project().document).toBe(newest);
    expect(session()).toMatchObject({ path: null, dirty: true });
    expect(session().error).toContain("新的修改");
  });

  it("protects edits arriving while the unsaved prompt is open", async () => {
    edit();
    const pending = deferred<"discard">();
    setUnsavedChangesPrompt(() => pending.promise);
    const creating = session().newProject();
    edit();
    const newest = project().document;
    pending.resolve("discard");
    expect(await creating).toBe(false);
    expect(project().document).toBe(newest);
    expect(session().dirty).toBe(true);
  });

  it("serializes project actions and refuses imports/exports during dialogs", async () => {
    const pending = deferred<string | null>();
    mocks.save.mockReturnValueOnce(pending.promise);
    const saving = session().saveProject();
    expect(await session().openProject()).toBe(false);
    expect(await session().confirmClose()).toBe(false);
    expect(beginProjectImport()).toBeNull();
    expect(beginProjectExport()).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    pending.resolve(null);
    expect(await saving).toBe(false);
    expect(session().busy).toBe(false);
  });

  it("keeps close busy until native destruction completes and reports native failures", async () => {
    const current = project().document;
    const pending = deferred<void>();
    const destroy = vi.fn(() => pending.promise);
    const closing = session().confirmClose(destroy);
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(session().busy).toBe(true);
    expect(beginProjectImport()).toBeNull();
    expect(await session().newProject()).toBe(false);
    pending.reject(new Error("窗口关闭失败"));
    expect(await closing).toBe(false);
    expect(project().document).toBe(current);
    expect(session()).toMatchObject({ busy: false, error: "窗口关闭失败" });
  });

  it("blocks switching and closing across import and export dialogs; releases are idempotent", async () => {
    const releaseImport = beginProjectImport()!;
    expect(session().importing).toBe(1);
    expect(await session().newProject()).toBe(false);
    expect(await session().confirmClose()).toBe(false);
    expect(session().error).toContain("导入");
    releaseImport();
    releaseImport();
    expect(session().importing).toBe(0);
    const releaseExport = beginProjectExport()!;
    expect(await session().openProject()).toBe(false);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(session().error).toContain("导出");
    releaseExport();
    releaseExport();
    project().setExportState({ running: true });
    expect(await session().newProject()).toBe(false);
    project().setExportState({ running: false });
    expect(await session().newProject()).toBe(true);
  });

  it("browser preview supports new projects and reports native file operations clearly", async () => {
    mocks.desktop.mockReturnValue(false);
    expect(await session().newProject()).toBe(true);
    expect(await session().openProject()).toBe(false);
    expect(await session().saveProject()).toBe(false);
    expect(session().error).toContain("桌面应用");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
