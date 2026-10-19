/**
 * ffprobe 封装：Rust 侧 probe_media 命令的 TS 门面。
 * kind 判定次序（扩展名图片优先 → 视频流 → 音频流）在 Rust 纯函数里写死并单测，
 * 前端只透传、不改写——两端口径必须一致。
 */
import { invoke } from "@tauri-apps/api/core";
import type { AssetKind } from "../project/types";

/** 与 src-tauri ProbeResult 对齐（serde camelCase）。 */
export interface ProbeResult {
  durationUs: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  kind: AssetKind;
}

/** 探测单个媒体文件；失败（无法识别/文件损坏）由 Rust 侧返回 Err，此处原样抛出。 */
export function probeMedia(path: string): Promise<ProbeResult> {
  return invoke<ProbeResult>("probe_media", { path });
}
