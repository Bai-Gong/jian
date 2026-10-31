/**
 * 导出编排：引擎分支（M4 接线轨）→ 生成参数 → invoke 执行 → 监听 export-progress 事件。
 * - ffmpeg 轨：buildExportArgs 生成 argv → run_export 子进程；
 * - ye 轨：buildYeExportParams 翻译（能力面外明确拒绝，不静默降级）→
 *   run_export_ye 进程内合成。两轨共用同一 export-progress 事件契约
 * （Rust 侧 ye 轨复用 ffmpeg.rs 的 ExportProgress 负载，导出一次一个、
 * 两轨不可能并发——见 src-tauri/src/export_ye.rs 模块文档）。
 * 进度走双通道：onProgress 回调给直接调用方（TopBar 显示百分比），
 * store.exportState 给全局订阅者（任务书要求的导出进度状态字段，M1 同时至多一个任务）。
 *
 * 引擎来源：options.getEngine 注入（duan runner 的注入模式——编排层不反向
 * 依赖 store 的内部 API）；缺省读 store.exportEngine（AppTitleBar 的切换控件写入）。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { evaluateSequence } from "../composite/composite";
import { useProjectStore, type ExportEngine } from "../project/store";
import type { MediaAsset, Sequence } from "../project/types";
import { buildExportArgs } from "./buildExportArgs";
import { buildYeTimelineParams } from "./buildYeTimelineParams";

/** Rust 侧 ExportProgress 事件负载（src-tauri/src/ffmpeg.rs，serde camelCase；
 * ye 轨同一形态复用，见 export_ye.rs）。 */
interface ExportProgressEvent {
  timeUs: number;
  totalUs: number;
}

/** 导出编排的注入面（duan runner 的 StartQueueOptions 同款风格）。 */
export interface ExportOptions {
  /** 当前引擎选择（接线层注入，避免编排层反向依赖 store）；缺省读 store。 */
  getEngine?(): ExportEngine;
}

export class ExportCancelled extends Error { constructor(){super("已取消导出");this.name="ExportCancelled";} }
let activeExport:{engine:ExportEngine;canceled:boolean;started:boolean;cancelPending:boolean}|null=null;
async function signalCancel():Promise<void> {
  const active=activeExport;
  if(!active || !active.started || active.engine!=="ye" || active.cancelPending)return;
  active.cancelPending=true;
  try {await invoke<boolean>("cancel_export_ye");} finally {active.cancelPending=false;}
}
export async function cancelExport():Promise<void> {
  if(!activeExport)return;activeExport.canceled=true;await signalCancel();
}

/**
 * 导出当前序列到 outPath（MP4）。失败抛出（含 Rust 侧回传的 stderr 尾或
 * ye 翻译层的拒绝文案），store.exportState.error 同步留底；成功/失败都会
 * 把 running 复位。ye 轨翻译被拒（变速/叠加/独立音轨等能力面外）即在此
 * 抛出——用户应切回 ffmpeg 引擎（文案自带指路）。
 */
export async function exportProject(
  sequence: Sequence,
  assets: readonly MediaAsset[],
  outPath: string,
  onProgress?: (p: { timeUs: number; totalUs: number }) => void,
  options?: ExportOptions,
): Promise<void> {
  if(useProjectStore.getState().exportState.running)throw new Error("已有导出任务正在执行");
  const totalUs = Math.round(evaluateSequence(sequence, assets).durationUs);
  if (totalUs <= 0) {
    // 空序列只会导出 0 秒黑场（ffmpeg 会报错或空转），门口拦下
    const message = "序列为空，没有可导出的内容";
    useProjectStore.getState().setExportState({ running: false, error: message });
    throw new Error(message);
  }
  const engine: ExportEngine = options?.getEngine?.() ?? useProjectStore.getState().exportEngine;
  useProjectStore.getState().setExportState({ running: true, timeUs: 0, totalUs, error: null });
  const active={engine,canceled:false,started:false,cancelPending:false};activeExport=active;
  let unlisten:()=>void=()=>{};
  try {
    unlisten = await listen<ExportProgressEvent>("export-progress", (event) => {
    const p = event.payload;
    onProgress?.(p);
    useProjectStore.getState().setExportState({ timeUs: Math.max(0, p.timeUs) });
    if(active.canceled)void signalCancel().catch(()=>{});
  });
    if (engine === "ye") {
      const request = buildYeTimelineParams(sequence, assets);
      const issues = await invoke<string[]>("check_timeline_ye", { request });
      if (issues.length) throw new Error(`导出受阻：\n${issues.join("\n")}`);
      if(active.canceled)throw new ExportCancelled();
      active.started=true;
      await invoke<null>("run_timeline_ye", { request, outPath });
    } else {
      await invoke<null>("run_export", {
        args: buildExportArgs(sequence, assets, outPath),
        outPath,
        totalUs,
      });
    }
    useProjectStore.getState().setExportState({ running: false, error: null });
  } catch (err) {
    if(active.canceled) {
      useProjectStore.getState().setExportState({running:false,error:null});
      throw new ExportCancelled();
    }
    const message = err instanceof Error ? err.message : String(err);
    useProjectStore.getState().setExportState({ running: false, error: message });
    throw err;
  } finally {
    unlisten();
    if(activeExport===active)activeExport=null;
  }
}
