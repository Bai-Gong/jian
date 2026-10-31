import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
export interface RuntimeInfo { engine: string; version: string; compatFfmpeg: boolean; capabilities: string[] }
export const useRuntimeStore = create<{info: RuntimeInfo | null; error: string | null}>(() => ({info:null,error:null}));
let loading: Promise<void> | undefined;
export function loadRuntime(): Promise<void> {
  return loading ??= invoke<RuntimeInfo>("media_runtime_info").then((info) => { useRuntimeStore.setState({info,error:null}); }).catch((error:unknown) => {
    useRuntimeStore.setState({error:`冶启动自检失败：${String(error)}`});
  });
}
