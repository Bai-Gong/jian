/**
 * 工程数据模型（纯数据、可 JSON 序列化，无行为）。
 *
 * 约定：
 * - 时间单位一律微秒（integer 语义的 number），避免浮点秒在长工程里累积误差；
 *   展示层（时间码、刻度）自行换算。
 * - id 由创建方生成（M1 定生成器，倾向 crypto.randomUUID）。
 * - 设计取舍见 docs/开发方案.md 第 4 节。
 */

/** 素材种类。图片按零时长素材处理（后续以定格时长呈现）。 */
export type AssetKind = "video" | "audio" | "image";

/** 素材池条目：一次导入对应一条；轨道上的剪辑块按 assetId 引用。 */
export interface MediaAsset {
  id: string;
  /** 绝对路径（经 Tauri 对话框选择，跨平台由 Rust 侧规整）。 */
  path: string;
  kind: AssetKind;
  /** 以下为 ffprobe 元数据（M1 接入；image 时 width/height 有效，durationUs 为 0）。 */
  durationUs: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  /** 导入时间戳（epoch ms），素材箱排序用。 */
  addedAt: number;
}

/** 剪辑块：素材在轨道上的一段引用（源入点 + 时间线占位）。 */
export interface Clip {
  id: string;
  assetId: string;
  /** 时间线起点（微秒）。 */
  timelineStartUs: number;
  /** 时间线时长（微秒）＝源片段 out − in。 */
  durationUs: number;
  /** 素材内入点（微秒）。 */
  sourceInUs: number;
  /** 音量增益（0–2，1 为原音量）。视频块同样可调（素材自带音轨）。 */
  gain: number;
}

export type TrackKind = "video" | "audio";

/** 轨道。视频轨渲染顺序：数组靠后的轨画在更上层（NLE 惯例）。 */
export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** 音频轨为静音，视频轨为隐藏。 */
  muted: boolean;
  /** 起始毫秒不必有序，约束由写入层（M1 store）维护。 */
  clips: Clip[];
}

/** 工程文档：序列化根对象。version 供未来迁移判断。 */
export interface ProjectDocument {
  version: 1;
  name: string;
  /** 工程帧率（导出与逐帧步进基准）。 */
  fps: number;
  /** 画布分辨率（导出目标）。 */
  width: number;
  height: number;
  assets: MediaAsset[];
  tracks: Track[];
}
