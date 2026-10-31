/**
 * ffprobe/ye 双引擎封装：Rust 侧 probe_media 命令的 TS 门面。
 * kind 判定次序（扩展名图片优先 → 视频流 → 音频流）在 Rust 纯函数里写死并单测，
 * 前端只透传、不改写——两端口径必须一致。
 * 引擎选择同样归 Rust（缺省 auto：ye 优先、Err/疑似封面整体回退 ffprobe），
 * 前端不做引擎决策，只把调用方的显式选择原样传过去。
 */
import { invoke } from "@tauri-apps/api/core";
import type { AssetKind } from "../project/types";

/** 探测引擎（与 Rust probe_media 的 engine 参数取值对齐）。 */
export type ProbeEngine = "auto" | "ye" | "ffmpeg";

/** 与 src-tauri ProbeResult 对齐（serde camelCase）。usedEngine 可选：旧后端不带该字段。 */
export interface ProbeResult {
  durationUs: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  kind: AssetKind;
  /** 第一条内容视频流的 codec 名（如 "h264"；无视频流为空串）。M4 导出
   *  双引擎：ye 轨翻译层的接受面校验用。 */
  videoCodec: string;
  /** 第一条音频流的 codec 名（如 "aac"；无音轨为空串）。 */
  audioCodec: string;
  /** 第一条音频流采样率 Hz（无音轨为 0）。 */
  sampleRate: number;
  /** 第一条音频流声道数（无音轨为 0）。 */
  channels: number;
  /** 实际产出结果的引擎（"ye" | "ffmpeg"）；auto 回退后即回退轨名。可选兼容旧后端。 */
  usedEngine?: ProbeEngine;
}

/** 探测单个媒体文件；失败（无法识别/文件损坏）由 Rust 侧返回 Err，此处原样抛出。
 * engine 缺省不传（Rust 按 auto 处理）——importAssets 等既有调用的行为零改动。 */
export function probeMedia(path: string, engine: ProbeEngine = "ye"): Promise<ProbeResult> {
  return invoke<ProbeResult>("probe_media", { path, engine });
}
