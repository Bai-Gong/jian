/**
 * 素材导入全流程：对话框多选 → 并发 probe → 造 MediaAsset 入池（store.addAssets）。
 * 单个文件探测失败只跳过（warn），不拖垮整批；用户取消返回空数组。
 */
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "../project/store";
import type { MediaAsset } from "../project/types";
import { probeMedia } from "./probe";

/** 与 Rust classify_media_kind 的图片扩展名集合对齐（gif 走视频支，有真实 fps）。 */
const MEDIA_FILTER_EXTENSIONS = [
  "mp4", "mov", "mkv", "webm", "avi", "m4v", "gif", // 视频（含 gif）
  "mp3", "wav", "aac", "flac", "ogg", "m4a", "wma", // 音频
  "png", "jpg", "jpeg", "webp", "bmp", // 图片
];

/** 弹出导入对话框并完成探测入池；返回本轮成功导入的素材（取消/全失败为空数组）。 */
export async function importAssets(): Promise<MediaAsset[]> {
  const selected = await openFileDialog({
    multiple: true,
    directory: false,
    filters: [{ name: "媒体文件", extensions: MEDIA_FILTER_EXTENSIONS }],
  });
  // plugin-dialog 多选返回 string[] | null（null＝取消）
  const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
  if (paths.length === 0) return [];

  // 并发探测，单个失败跳过整批照常
  const probed = await Promise.allSettled(paths.map((path) => probeMedia(path)));
  const assets: MediaAsset[] = [];
  probed.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(`素材导入失败，已跳过：${paths[index]}`, result.reason);
      return;
    }
    const info = result.value;
    assets.push({
      id: crypto.randomUUID(),
      path: paths[index],
      kind: info.kind, // kind 由 Rust 判定，前端不改写
      durationUs: info.durationUs,
      width: info.width,
      height: info.height,
      fps: info.fps,
      hasAudio: info.hasAudio,
      videoCodec: info.videoCodec ?? "",
      audioCodec: info.audioCodec ?? "",
      sampleRate: info.sampleRate ?? 0,
      channels: info.channels ?? 0,
      addedAt: Date.now(),
    });
  });
  if (assets.length > 0) useProjectStore.getState().addAssets(assets);
  return assets;
}
