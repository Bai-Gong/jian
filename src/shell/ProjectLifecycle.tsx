import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { setUnsavedChangesPrompt, useProjectSession, type UnsavedChangesChoice, type UnsavedChangesContext } from "../core/project/projectSession";
import { useProjectStore } from "../core/project/store";

export function projectDisplayName(path: string | null, name: string): string {
  return path ? path.split(/[\\/]/).pop() || name : name;
}

/** One lifecycle guard for File → Exit, native close and the macOS Quit menu. */
export function ProjectLifecycle() {
  const [prompt, setPrompt] = useState<UnsavedChangesContext | null>(null);
  const resolver = useRef<((choice: UnsavedChangesChoice) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const hasProject = useProjectSession(s => s.hasProject);
  const path = useProjectSession(s => s.path);
  const dirty = useProjectSession(s => s.dirty);
  const error = useProjectSession(s => s.error);
  const name = useProjectStore(s => s.document.name);
  const choose = (choice: UnsavedChangesChoice) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPrompt(null);
    resolve?.(choice);
  };

  useEffect(() => {
    const restore = setUnsavedChangesPrompt(context => new Promise(resolve => {
      resolver.current = resolve;
      setPrompt(context);
    }));
    return () => { restore(); resolver.current?.("cancel"); resolver.current = null; };
  }, []);

  useEffect(() => {
    if (prompt && !dialog.current?.open) {
      dialog.current?.showModal();
      cancelButton.current?.focus();
    }
    else if (!prompt && dialog.current?.open) dialog.current.close();
  }, [prompt]);

  useEffect(() => {
    const title = hasProject ? `${dirty ? "● " : ""}${projectDisplayName(path, name)} — 百工·剪` : "项目选择 — 百工·剪";
    document.title = title;
    if (isTauri()) void getCurrentWindow().setTitle(title).catch(console.warn);
  }, [path, name, dirty, hasProject]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // Modal controls retain their native keyboard behavior, but editor shortcuts must not run.
      if ((event.target as HTMLElement | null)?.closest("dialog[open]")) {
        event.stopPropagation();
        return;
      }
      const session = useProjectSession.getState();
      if (session.busy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (document.documentElement.dataset.nativeMenu === "true") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (!["n", "o", "s"].includes(key) || (event.shiftKey && key !== "s")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (key === "n") void session.newProject();
      else if (key === "o") void session.openProject();
      else void session.saveProject(event.shiftKey);
    };
    window.addEventListener("keydown", keydown, true);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!isTauri() && useProjectSession.getState().dirty) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let disposed = false;
    const cleanup: (() => void)[] = [];
    const requestClose = async () => {
      if (closing.current || disposed) return;
      closing.current = true;
      try {
        await useProjectSession.getState().confirmClose(() => win.destroy());
      } catch (cause) {
        useProjectSession.setState({ error: `无法关闭窗口：${String(cause)}` });
      } finally { closing.current = false; }
    };
    const retain = (stop: () => void) => { if (disposed) stop(); else cleanup.push(stop); };
    void win.onCloseRequested(event => {
      event.preventDefault();
      void requestClose();
    }).then(retain).catch(console.warn);
    void listen("project-close-requested", () => { void requestClose(); }).then(retain).catch(console.warn);
    return () => { disposed = true; cleanup.forEach(stop => stop()); };
  }, []);

  return <>
    {error && <div className="project-error" role="alert"><span>{error}</span><button type="button" onClick={() => useProjectSession.getState().clearError()}>关闭提示</button></div>}
    <dialog ref={dialog} className="project-confirm" aria-labelledby="project-confirm-title" aria-describedby="project-confirm-description" onCancel={event => { event.preventDefault(); choose("cancel"); }}>
      <h2 id="project-confirm-title">保存项目更改？</h2>
      <p id="project-confirm-description">“{prompt ? projectDisplayName(prompt.path, prompt.name) : ""}”有未保存的更改。</p>
      <p>保存后再继续；选择“不保存”会放弃这些更改。</p>
      <div className="project-confirm__actions">
        <button type="button" className="btn" onClick={() => choose("discard")}>不保存</button>
        <span />
        <button type="button" className="btn" ref={cancelButton} onClick={() => choose("cancel")}>取消</button>
        <button type="button" className="btn btn--primary" onClick={() => choose("save")}>保存</button>
      </div>
    </dialog>
  </>;
}
