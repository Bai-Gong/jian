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
import { RECENT_PROJECTS_STORAGE_KEY, useRecentProjects } from "./recentProjects";

const session = () => useProjectSession.getState();
const project = () => useProjectStore.getState();
const startupSession = { hasProject: session().hasProject, path: session().path, dirty: session().dirty };
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
  useRecentProjects.setState({ recentProjects: [] });
  localStorage.removeItem(RECENT_PROJECTS_STORAGE_KEY);
  project().setExportState({ running: false });
  setUnsavedChangesPrompt(async () => "discard");
  await session().newProject();
});

describe("project launcher lifecycle", () => {
  it("always starts on the launcher with no active project", () => {
    expect(startupSession).toEqual({ hasProject: false, path: null, dirty: false });
  });

  it("keeps the launcher open after canceled or failed open and rejects project-only operations", async () => {
    await session().returnToProjects();
    expect(session()).toMatchObject({ hasProject: false, path: null, dirty: false });
    const prompt = vi.fn(async () => "cancel" as const);
    setUnsavedChangesPrompt(prompt);
    edit();
    const placeholder = project().document;
    expect(session().dirty).toBe(false);
    expect(beginProjectImport()).toBeNull();
    expect(beginProjectExport()).toBeNull();
    expect(await session().saveProject()).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(await session().confirmClose()).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    mocks.open.mockResolvedValueOnce(null);
    expect(await session().openProject()).toBe(false);
    expect(session().hasProject).toBe(false);
    mocks.read.mockRejectedValueOnce(new Error("文件不存在"));
    expect(await session().openProject("/missing.jian")).toBe(false);
    expect(session()).toMatchObject({ hasProject: false, error: "文件不存在" });
    expect(project().document).toBe(placeholder);
    expect(useRecentProjects.getState().recentProjects).toEqual([]);
  });

  it("enters a named empty project without adding an unsaved entry to recent projects", async () => {
    await session().returnToProjects();
    expect(await session().newProject("  新片  ")).toBe(true);
    expect(session()).toMatchObject({ hasProject: true, dirty: false, path: null });
    expect(project().document).toMatchObject({ name: "新片", assets: [] });
    expect(useRecentProjects.getState().recentProjects).toEqual([]);
    expect(await session().saveProject()).toBe(true);
    expect(useRecentProjects.getState().recentProjects).toEqual([
      { path: "/projects/saved.jian", name: "saved", lastOpenedAt: expect.any(Number) },
    ]);
  });

  it("keeps the browser launcher visible when native open is unavailable", async () => {
    await session().returnToProjects();
    mocks.desktop.mockReturnValue(false);
    expect(await session().openProject()).toBe(false);
    expect(session()).toMatchObject({ hasProject: false, path: null, dirty: false });
    expect(session().error).toContain("桌面应用");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("records a filename fallback when a valid opened document has no name", async () => {
    await session().returnToProjects();
    mocks.read.mockResolvedValueOnce({ ...createInitialDocument(), name: "" });
    expect(await session().openProject("/projects/unnamed.jian")).toBe(true);
    expect(useRecentProjects.getState().recentProjects[0]).toMatchObject({ path: "/projects/unnamed.jian", name: "unnamed" });
  });

  it("returns to the launcher only after approval and resets workspace playback state", async () => {
    edit();
    project().setSelection(["old"]);
    project().setPlayhead(999);
    project().setPlaying(true);
    const current = project().document;
    const hook = vi.fn();
    const release = registerProjectSwitchHook(hook);
    setUnsavedChangesPrompt(async () => "cancel");
    expect(await session().returnToProjects()).toBe(false);
    expect(session().hasProject).toBe(true);
    expect(project().document).toBe(current);
    expect(hook).not.toHaveBeenCalled();
    setUnsavedChangesPrompt(async () => "save");
    mocks.write.mockRejectedValueOnce(new Error("保存失败"));
    expect(await session().returnToProjects()).toBe(false);
    expect(session().hasProject).toBe(true);
    expect(hook).not.toHaveBeenCalled();
    setUnsavedChangesPrompt(async () => "discard");
    const generation = session().generation;
    expect(await session().returnToProjects()).toBe(true);
    release();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(session()).toMatchObject({ hasProject: false, path: null, dirty: false, generation: generation + 1 });
    expect(project()).toMatchObject({ selection: [], playheadUs: 0, isPlaying: false });
    expect(project().document).not.toBe(current);
  });

  it("opens recent paths without a dialog, records only successful open/save, and never deletes files", async () => {
    await session().returnToProjects();
    const loaded = { ...createInitialDocument(), name: "以前的项目" };
    mocks.read.mockResolvedValueOnce(loaded);
    expect(await session().openProject("/projects/recent.jian")).toBe(true);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenLastCalledWith("/projects/recent.jian");
    expect(session()).toMatchObject({ hasProject: true, path: "/projects/recent.jian" });
    expect(useRecentProjects.getState().recentProjects[0]).toMatchObject({ path: "/projects/recent.jian", name: "以前的项目" });
    const recent = useRecentProjects.getState().recentProjects;
    edit();
    setUnsavedChangesPrompt(async () => "cancel");
    expect(await session().openProject("/projects/canceled.jian")).toBe(false);
    expect(useRecentProjects.getState().recentProjects).toBe(recent);
    mocks.write.mockRejectedValueOnce(new Error("保存失败"));
    expect(await session().saveProject()).toBe(false);
    expect(useRecentProjects.getState().recentProjects).toBe(recent);
    useRecentProjects.getState().removeRecent("/projects/recent.jian");
    expect(useRecentProjects.getState().recentProjects).toEqual([]);
    expect(session().path).toBe("/projects/recent.jian");
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
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
