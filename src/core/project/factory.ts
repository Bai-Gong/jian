/**
 * 工厂函数：模型对象的唯一出生地。
 * types.ts 已定稿（只增不推翻），这里只负责缺省值拼装——
 * 新建块/轨的「白纸」形态固定在此，业务代码不得手搓字面量。
 */
import type {
  Animatable,
  Clip,
  ClipAudio,
  ClipTransform,
  ProjectDocument,
  Sequence,
  Track,
  TrackKind,
} from "./types";

/** 图片素材零时长，上屏块给固定 5 秒定格（M1 常量，M2 开放为可编辑）。 */
export const DEFAULT_IMAGE_CLIP_US = 5_000_000;

/** 静态可动画值：块的默认形态。静态是关键帧轨的退化情形，升级不改结构。 */
function staticOf(value: number): Animatable<number> {
  return { kind: "static", value };
}

/** 轨道缺省 UI 高度（px）。视频轨略高是 NLE 惯例，用户可调（M2）。 */
const TRACK_DEFAULT_HEIGHT: Record<TrackKind, number> = { video: 72, audio: 56 };

/**
 * 无上下文时的轨道命名计数器（模块级、只增不减）。
 * 工程内命名走 {@link nextTrackName}（按现有轨扫描），不走这里——
 * 计数器只为 createTrack 裸调缺省服务，删轨不复用编号、杜绝重名。
 */
const trackCounters: Record<TrackKind, number> = { video: 0, audio: 0 };

/** 按序列现有轨名算下一个 Vn/An（取最大编号 +1，轨名被删后不复用）。 */
export function nextTrackName(tracks: readonly Track[], kind: TrackKind): string {
  const prefix = kind === "video" ? "V" : "A";
  let max = 0;
  for (const track of tracks) {
    if (track.kind !== kind) continue;
    const m = /^([VA])(\d+)$/.exec(track.name);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return `${prefix}${max + 1}`;
}

/**
 * 新建剪辑块：transform 全静态（居中、原尺寸、不透明），
 * gain=1、pan=0，效果链空、无转场。speed 缺省 1。
 */
export function createClip(i: {
  assetId: string;
  sourceInUs: number;
  sourceOutUs: number;
  timelineStartUs: number;
  speed?: number;
}): Clip {
  const transform: ClipTransform = {
    x: staticOf(0),
    y: staticOf(0),
    scale: staticOf(1),
    rotation: staticOf(0),
    opacity: staticOf(1),
  };
  const audio: ClipAudio = { gain: staticOf(1), pan: staticOf(0) };
  return {
    id: crypto.randomUUID(),
    assetId: i.assetId,
    timelineStartUs: i.timelineStartUs,
    sourceInUs: i.sourceInUs,
    sourceOutUs: i.sourceOutUs,
    speed: i.speed ?? 1,
    transform,
    audio,
    effects: [],
    inTransition: null,
    outTransition: null,
  };
}

/** 新建轨道：未锁、未静音、无独奏。name 缺省用内部计数器自增（V1/V2…、A1/A2…）。 */
export function createTrack(kind: TrackKind, name?: string): Track {
  trackCounters[kind] += 1;
  return {
    id: crypto.randomUUID(),
    kind,
    name: name ?? `${kind === "video" ? "V" : "A"}${trackCounters[kind]}`,
    locked: false,
    muted: false,
    solo: false,
    height: TRACK_DEFAULT_HEIGHT[kind],
    clips: [],
  };
}

/** 新建序列：1080p30 空轨（开发方案 M1 导出目标）。 */
export function createSequence(name: string): Sequence {
  return {
    id: crypto.randomUUID(),
    name,
    fps: 30,
    width: 1920,
    height: 1080,
    tracks: [],
  };
}

/** 初始工程：1V + 1A，无素材。轨名显式 V1/A1（不经计数器，工程间各自从 1 起）。 */
export function createInitialDocument(): ProjectDocument {
  const sequence = createSequence("主序列");
  sequence.tracks = [createTrack("video", "V1"), createTrack("audio", "A1")];
  return {
    version: 2,
    name: "未命名工程",
    assets: [],
    sequences: [sequence],
    activeSequenceId: sequence.id,
  };
}

/** 任务书别名：createProject = createInitialDocument（契约定名后者，同一物）。 */
export const createProject = createInitialDocument;
