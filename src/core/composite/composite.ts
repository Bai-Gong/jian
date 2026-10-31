/**
 * 合成求值层（开发方案 §3.3）：预览与导出共用的唯一真相。
 * 「预览得到、导不出」在本仓库算 bug——两端只许消费本层产物，不许各自枚举轨道。
 *
 * M1 边界：Animatable 一律按块内 t=0 取样（静态形态），关键帧插值入口（resolveAnimatable）
 * 已就位但序列级枚举不按时刻取样；M2 起 buildFrameDescription 换成按帧时刻取样，数据结构不动。
 */
import { clipEndUs } from "../project/timelineOps";
import type { Animatable, Clip, MediaAsset, Sequence, Track } from "../project/types";

/**
 * 可动画属性求值：静态直取；关键帧轨假设升序——
 * ≤首帧取首值、≥末帧取末值、区间内相邻两帧线性（easing 目前只有 "linear"）。
 */
export function resolveAnimatable(prop: Animatable<number>, tUs: number): number {
  if (prop.kind === "static") return prop.value;
  const kfs = prop.keyframes;
  if (kfs.length === 0) return 0; // 空关键帧轨属数据异常，取 0 不炸
  const first = kfs[0];
  const last = kfs[kfs.length - 1];
  if (tUs <= first.tUs) return first.value;
  if (tUs >= last.tUs) return last.value;
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1];
    const b = kfs[i];
    if (tUs <= b.tUs) {
      const span = b.tUs - a.tUs;
      if (span <= 0) return b.value; // 同刻多帧：取后者
      const r = (tUs - a.tUs) / span;
      return a.value + (b.value - a.value) * r;
    }
  }
  return last.value; // 上面已按末帧钳制，这里只是收尾
}

/**
 * 已解算效果实例：保链序、params 静态取样成数值。enabled 原样保留，跳不跳过由渲染端定。
 * 效果实现按 effectId 在双端注册表查找（开发方案 §3.3）；M1 预览/导出暂不翻译滤镜，
 * 但数据必须在求值层流通——M4 接效果时只注册实现，不改这里结构。
 */
export interface ResolvedEffect {
  effectId: string;
  enabled: boolean;
  params: Record<string, number>;
}

/** 合成层描述：一个块在时间线上的一次「出场」，属性已解算成数值。 */
export interface LayerDesc {
  sourceStreamIndex?: number;
  clipId: string;
  trackId: string;
  assetId: string;
  /** 时间线窗口 [timelineStartUs, timelineEndUs)。 */
  timelineStartUs: number;
  timelineEndUs: number;
  /** 素材内区间 [sourceInUs, sourceOutUs)（源时间，未除 speed）。 */
  sourceInUs: number;
  sourceOutUs: number;
  speed: number;
  /** 以下为 t=0 取样的静态解算值（M2 起按帧时刻插值）。 */
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  gain: number;
  /** 声像 −1（左）～1（右）。 */
  pan: number;
  /** 效果链（按应用顺序），params 已解算。 */
  effects: ResolvedEffect[];
  /** 素材是否带音频流（只在 MediaAsset 上，Clip/Track 无此信息——所以 assets 必传）。 */
  hasAudio: boolean;
}

/** 序列级静态枚举：全部视频层/音频层＋总时长。 */
export interface SequenceEval {
  /** 视频轨全块，按轨道序（靠后＝更上层，NLE 惯例）。 */
  videoLayers: LayerDesc[];
  /**
   * 音频层成员（写死）：音频轨全块＋视频轨上 asset.hasAudio 的块（同块可双列）。
   * 已应用 mute/solo；lock 不参与求值。
   */
  audioLayers: LayerDesc[];
  /** max(块终点, 0)；悬空 assetId 的块不计数。 */
  durationUs: number;
}

/** 块 → 层描述。纯查表＋静态取样，无副作用。 */
function describeLayer(clip: Clip, track: Track, asset: MediaAsset): LayerDesc {
  const t = clip.transform;
  return {
    clipId: clip.id,
    ...(clip.sourceStreamIndex === undefined ? {} : {sourceStreamIndex:clip.sourceStreamIndex}),
    trackId: track.id,
    assetId: clip.assetId,
    timelineStartUs: clip.timelineStartUs,
    timelineEndUs: clipEndUs(clip),
    sourceInUs: clip.sourceInUs,
    sourceOutUs: clip.sourceOutUs,
    speed: clip.speed,
    // 静态枚举：一律按块内 t=0 取样
    x: resolveAnimatable(t.x, 0),
    y: resolveAnimatable(t.y, 0),
    scale: resolveAnimatable(t.scale, 0),
    rotation: resolveAnimatable(t.rotation, 0),
    opacity: resolveAnimatable(t.opacity, 0),
    gain: resolveAnimatable(clip.audio.gain, 0),
    pan: resolveAnimatable(clip.audio.pan, 0),
    // 效果链保序解算：enabled/disabled 都保留（跳过与否是渲染端的事）
    effects: clip.effects.map((e) => ({
      effectId: e.effectId,
      enabled: e.enabled,
      params: Object.fromEntries(
        Object.entries(e.params).map(([name, value]) => [name, resolveAnimatable(value, 0)]),
      ),
    })),
    hasAudio: asset.hasAudio,
  };
}

/**
 * 求值整个序列（预览与导出的共同入口）。
 * - assets 必传：hasAudio 只在素材上；assetId 悬空的块跳过（数据不完整不参与合成）；
 * - muted 轨不产音频层（视频层照留——mute 只关声音）；
 * - 存在 solo 轨时仅留 solo 轨的音频（压过其他一切音频，含视频块伴音）；
 * - lock 不影响求值（锁是编辑门禁，不是渲染开关）。
 */
export function evaluateSequence(sequence: Sequence, assets: readonly MediaAsset[]): SequenceEval {
  const assetById = new Map(assets.map((a) => [a.id, a] as const));
  const videoLayers: LayerDesc[] = [];
  const audioLayers: LayerDesc[] = [];
  let durationUs = 0;

  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      const asset = assetById.get(clip.assetId);
      if (!asset) continue; // 悬空引用：跳过
      const layer = describeLayer(clip, track, asset);
      if (layer.timelineEndUs > durationUs) durationUs = layer.timelineEndUs;
      if (track.kind === "video") videoLayers.push(layer);
      else audioLayers.push(layer);
    }
  }
  // 视频轨上自带音频的块双列进音频层（同一块既上画面也出声）
  for (const track of sequence.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      const asset = assetById.get(clip.assetId);
      if (!asset || !asset.hasAudio || clip.audioDetached) continue;
      audioLayers.push(describeLayer(clip, track, asset));
    }
  }

  let audible = audioLayers;
  const mutedIds = new Set(sequence.tracks.filter((t) => t.muted).map((t) => t.id));
  if (mutedIds.size > 0) audible = audible.filter((l) => !mutedIds.has(l.trackId));
  if (sequence.tracks.some((t) => t.solo)) {
    const soloIds = new Set(sequence.tracks.filter((t) => t.solo).map((t) => t.id));
    audible = audible.filter((l) => soloIds.has(l.trackId));
  }
  return { videoLayers, audioLayers: audible, durationUs };
}

/** 任意时刻的帧描述：序列求值后按 [start, end) 半开区间过滤。 */
export interface FrameDescription {
  tUs: number;
  videoLayers: LayerDesc[];
  audioLayers: LayerDesc[];
}

/**
 * 求值 tUs 时刻应上屏/出声的层。M1 复用序列级静态枚举再过滤；
 * M2 时刻插值（按 tUs−start 逐属性取样）在这里换实现，调用方不动。
 */
export function buildFrameDescription(
  sequence: Sequence,
  tUs: number,
  assets: readonly MediaAsset[],
): FrameDescription {
  const ev = evaluateSequence(sequence, assets);
  const active = (l: LayerDesc) => l.timelineStartUs <= tUs && tUs < l.timelineEndUs;
  return {
    tUs,
    videoLayers: ev.videoLayers.filter(active),
    audioLayers: ev.audioLayers.filter(active),
  };
}
