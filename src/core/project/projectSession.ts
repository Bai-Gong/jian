/** 工程文件会话。只有 document 的变化会变脏；播放、选择和导出偏好不入文件。 */
import { isTauri } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";
import { create } from "zustand";
import { createInitialDocument } from "./factory";
import { PROJECT_EXTENSION } from "./projectFile";
import { readProjectFile, writeProjectFile } from "./projectFileIO";
import { useProjectStore } from "./store";
import type { ProjectDocument } from "./types";

export type UnsavedChangesChoice = "save" | "discard" | "cancel";
export interface UnsavedChangesContext { name: string; path: string | null }
type UnsavedChangesPrompt = (context: UnsavedChangesContext) => Promise<UnsavedChangesChoice>;

export interface ProjectSessionState {
  path: string | null;
  dirty: boolean;
  busy: boolean;
  error: string | null;
  importing: number;
  exporting: boolean;
  /** 仅工程切换递增，供工作区复位组件本地状态。 */
  generation: number;
  newProject(): Promise<boolean>;
  openProject(): Promise<boolean>;
  saveProject(saveAs?: boolean): Promise<boolean>;
  /** 原生关闭回调也保持 busy，直到窗口销毁请求完成。 */
  confirmClose(onConfirmed?: () => Promise<void>): Promise<boolean>;
  clearError(): void;
}

let savedDocument = useProjectStore.getState().document;
let promptUnsaved: UnsavedChangesPrompt = async () => "cancel";
const switchHooks = new Set<() => void>();

/** UI 注入保存 / 不保存 / 取消对话框；卸载时归还之前的处理器。 */
export function setUnsavedChangesPrompt(prompt: UnsavedChangesPrompt): () => void {
  const previous = promptUnsaved;
  promptUnsaved = prompt;
  return () => { if (promptUnsaved === prompt) promptUnsaved = previous; };
}

/** 切换前释放旧工程播放资源。读取失败或用户取消不会触发。 */
export function registerProjectSwitchHook(callback: () => void): () => void {
  switchHooks.add(callback);
  return () => { switchHooks.delete(callback); };
}

/** 导入对话框与异步探测共同持有锁，避免旧素材落入新工程。 */
export function beginProjectImport(): (() => void) | null {
  const session = useProjectSession.getState();
  if (session.busy) return null;
  useProjectSession.setState({ importing: session.importing + 1 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    useProjectSession.setState((s) => ({ importing: Math.max(0, s.importing - 1) }));
  };
}

/** 从导出路径对话框开始锁住工程切换，直到导出结束或取消。 */
export function beginProjectExport(): (() => void) | null {
  const session = useProjectSession.getState();
  if (session.busy || session.exporting || useProjectStore.getState().exportState.running) return null;
  useProjectSession.setState({ exporting: true });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    useProjectSession.setState({ exporting: false });
  };
}

const extension = PROJECT_EXTENSION.replace(/^\./, "");
const filters = [{ name: "百工·剪工程", extensions: [extension] }];

function desktopRequired(): void {
  if (!isTauri()) throw new Error("请在百工·剪桌面应用中打开或保存工程");
}

function ensureIdle(): void {
  if (useProjectSession.getState().exporting || useProjectStore.getState().exportState.running) throw new Error("正在导出视频，请等待导出结束后操作工程");
  if (useProjectSession.getState().importing > 0) throw new Error("正在导入素材，请等待导入结束后操作工程");
}

async function perform(operation: () => Promise<boolean>): Promise<boolean> {
  if (useProjectSession.getState().busy) return false;
  useProjectSession.setState({ busy: true, error: null });
  try {
    ensureIdle();
    return await operation();
  } catch (error) {
    useProjectSession.setState({ error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    useProjectSession.setState({ busy: false });
  }
}

async function saveCurrent(saveAs = false): Promise<boolean> {
  desktopRequired();
  let path = useProjectSession.getState().path;
  if (saveAs || path === null) {
    const defaultPath = path ?? `${useProjectStore.getState().document.name}.${extension}`;
    const selected = await save({ title: saveAs ? "工程另存为" : "保存工程", defaultPath, filters });
    if (selected === null) return false;
    path = selected.toLowerCase().endsWith(`.${extension.toLowerCase()}`) ? selected : `${selected}.${extension}`;
    // 原生对话框只确认 selected；补后缀后的实际目标要单独确认覆盖。
    if (path !== selected && await exists(path)) {
      const overwrite = await confirm(`工程文件已存在：\n${path}\n是否替换？`, {
        title: "替换工程文件", kind: "warning", okLabel: "替换", cancelLabel: "取消",
      });
      if (!overwrite) return false;
    }
  }
  ensureIdle();
  // 不可变 document 引用即保存快照；写盘期间出现的新编辑仍然标脏。
  const source = useProjectStore.getState().document;
  const filename = path.split(/[\\/]/).pop() ?? "";
  const name = filename.slice(0, -(extension.length + 1)) || source.name;
  const snapshot = source.name === name ? source : { ...source, name };
  await writeProjectFile(path, snapshot);
  savedDocument = snapshot;
  // 只有没有新编辑时才同步文件名；保存失败完全不改变工程。
  if (useProjectStore.getState().document === source && snapshot !== source) {
    useProjectStore.setState({ document: snapshot });
  }
  useProjectSession.setState({ path, dirty: useProjectStore.getState().document !== snapshot });
  return true;
}

async function approveLeaving(): Promise<ProjectDocument | null> {
  const document = useProjectStore.getState().document;
  if (!useProjectSession.getState().dirty) return document;
  const choice = await promptUnsaved({ name: document.name, path: useProjectSession.getState().path });
  if (choice === "cancel") return null;
  if (choice === "save") {
    if (!await saveCurrent()) return null;
    if (useProjectSession.getState().dirty) throw new Error("保存期间工程有新的修改，请再次保存后重试");
    return useProjectStore.getState().document;
  }
  // 对话框期间如果仍有异步写入，不把用户未见过的修改一并丢弃。
  if (useProjectStore.getState().document !== document) throw new Error("工程有新的修改，请重新确认是否保存");
  return document;
}

function replaceProject(document: ProjectDocument, path: string | null, approved: ProjectDocument): void {
  ensureIdle();
  if (useProjectStore.getState().document !== approved) throw new Error("工程有新的修改，已取消切换，请重试");
  for (const hook of switchHooks) hook();
  savedDocument = document;
  useProjectStore.getState().replaceDocument(document);
  useProjectSession.setState((s) => ({ path, dirty: false, generation: s.generation + 1 }));
}

export const useProjectSession = create<ProjectSessionState>(() => ({
  path: null,
  dirty: false,
  busy: false,
  error: null,
  importing: 0,
  exporting: false,
  generation: 0,
  clearError: () => useProjectSession.setState({ error: null }),
  saveProject: (saveAs = false) => perform(() => saveCurrent(saveAs)),
  newProject: () => perform(async () => {
    const approved = await approveLeaving();
    if (approved === null) return false;
    replaceProject(createInitialDocument(), null, approved);
    return true;
  }),
  openProject: () => perform(async () => {
    desktopRequired();
    const selected = await open({ title: "打开工程", multiple: false, directory: false, filters });
    if (typeof selected !== "string") return false;
    // 先读取并校验，坏文件不会要求用户放弃当前工作。
    const beforeRead = useProjectStore.getState().document;
    const document = await readProjectFile(selected);
    if (useProjectStore.getState().document !== beforeRead) throw new Error("工程有新的修改，已取消打开，请重试");
    const approved = await approveLeaving();
    if (approved === null) return false;
    replaceProject(document, selected, approved);
    return true;
  }),
  confirmClose: (onConfirmed) => perform(async () => {
    const approved = await approveLeaving();
    if (approved === null) return false;
    ensureIdle();
    if (useProjectStore.getState().document !== approved) return false;
    await onConfirmed?.();
    return true;
  }),
}));

useProjectStore.subscribe((state) => state.document, (document) => {
  useProjectSession.setState({ dirty: document !== savedDocument });
});
