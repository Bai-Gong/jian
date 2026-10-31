/**
 * 波形峰值 TS 门面：Rust 侧 waveform 命令（src-tauri/src/waveform.rs）的
 * 透传封装。本模块只做数据层，不渲染 UI——时间线波形显示组件后续接入时
 * 从这里取数。
 *
 * 返回结构与 Rust 侧 WaveformPeaks / PeakBucket 逐字段对齐（serde
 * camelCase 序列化；Rust 侧结构体注释同样互指本文件——改字段须两侧同步）。
 * 桶数合法域 16..=8192 与「返回桶数恒等于请求值（静默零值桶补齐）」的
 * 契约都在 Rust 侧实现并校验（中文报错原样抛给调用方），前端不重复校验、
 * 不改写——与 probe.ts 门面同口径。
 */
import { invoke } from "@tauri-apps/api/core";

/** 单桶单声道峰值统计——Rust 侧 src-tauri/src/waveform.rs 的 PeakBucket 镜像。 */
export interface PeakBucket {
  /** 桶内最小样本值。 */
  min: number;
  /** 桶内最大样本值。 */
  max: number;
  /** 桶内均方根 sqrt(mean(x²))。 */
  rms: number;
}

/** 波形峰值结果——Rust 侧 src-tauri/src/waveform.rs 的 WaveformPeaks 镜像。 */
export interface WaveformPeaks {
  /** 实际产出结果的引擎（"ye" | "ffmpeg"；auto 回退后即回退轨名）。 */
  usedEngine: string;
  /** 采样率（Hz）。 */
  sampleRate: number;
  /** 声道数。 */
  channels: number;
  /** 桶长（名义帧数 = ceil(每声道样本数/桶数)；桶间可有 ±1 帧差）。 */
  bucketSamples: number;
  /** 桶数（恒等于请求值——实桶不足时尾部以静默零值桶补齐）。 */
  buckets: number;
  /** 峰值矩阵 [声道][桶]（渲染层按声道分行、按桶画竖线）。 */
  peaks: PeakBucket[][];
}

/** 取素材音频轨的波形峰值。失败（桶数越界/无音频轨/两轨均失败等）由
 * Rust 侧返回中文 Err，此处原样抛出；桶数合法域 16..=8192。 */
export function getWaveformPeaks(path: string, buckets: number): Promise<WaveformPeaks> {
  return invoke<WaveformPeaks>("waveform", { path, buckets });
}

export function getStreamWaveformPeaks(path:string,buckets:number,streamIndex:number):Promise<WaveformPeaks>{
 return invoke<WaveformPeaks>("waveform_stream",{path,buckets,streamIndex});
}
