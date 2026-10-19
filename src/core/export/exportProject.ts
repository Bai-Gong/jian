/**
 * 导出编排：buildExportArgs 生成参数 → invoke run_export 执行 → 监听 export-progress 事件。
 * 进度走双通道：onProgress 回调给直接调用方（TopBar 显示百分比），
 * store.exportState 给全局订阅者（任务书要求的导出进度状态字段，M1 同时至多一个任务）。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { evaluateSequence } from "../composite/composite";
import { useProjectStore } from "../project/store";
import type { MediaAsset, Sequence } from "../project/types";
import { buildExportArgs } from "./buildExportArgs";

/** Rust 侧 ExportProgress 事件负载（src-tauri/src/ffmpeg.rs，serde camelCase）。 */
interface ExportProgressEvent {
  timeUs: number;
  totalUs: number;
}

/**
 * 导出当前序列到 outPath（MP4）。失败抛出（含 Rust 侧回传的 stderr 尾），
 * store.exportState.error 同步留底；成功/失败都会把 running 复位。
 */
export async function exportProject(
  sequence: Sequence,
  assets: readonly MediaAsset[],
  outPath: string,
  onProgress?: (p: { timeUs: number; totalUs: number }) => void,
): Promise<void> {
  const totalUs = Math.round(evaluateSequence(sequence, assets).durationUs);
  if (totalUs <= 0) {
    // 空序列只会导出 0 秒黑场（ffmpeg 会报错或空转），门口拦下
    const message = "序列为空，没有可导出的内容";
    useProjectStore.getState().setExportState({ running: false, error: message });
    throw new Error(message);
  }
  useProjectStore.getState().setExportState({ running: true, timeUs: 0, totalUs, error: null });

  const unlisten = await listen<ExportProgressEvent>("export-progress", (event) => {
    const p = event.payload;
    onProgress?.(p);
    useProjectStore.getState().setExportState({ timeUs: Math.max(0, p.timeUs) });
  });
  try {
    await invoke<null>("run_export", {
      args: buildExportArgs(sequence, assets, outPath),
      outPath,
      totalUs,
    });
    useProjectStore.getState().setExportState({ running: false, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useProjectStore.getState().setExportState({ running: false, error: message });
    throw err;
  } finally {
    unlisten();
  }
}
