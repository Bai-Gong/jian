/**
 * 工程数据模型 v2（纯数据、可 JSON 序列化，无行为）。
 *
 * 自由度原则（docs/开发方案.md 第 2 节）：模型层对标 Premiere 不封顶，UI 渐进解锁——
 * transform/speed/effects/keyframes 等字段现在就位（M1），对应交互在 M2–M4 开放。
 *
 * 约定：
 * - 时间单位一律微秒（integer 语义的 number），展示层自行换算时间码/刻度；
 * - id 由创建方生成（M1 定生成器，倾向 crypto.randomUUID）；
 * - 推导量不存储：剪辑块时间线时长＝(sourceOutUs−sourceInUs)/speed。
 */

// ===== 可动画属性 =====

/** 缓动类型。先立线性，贝塞尔随 M3 曲线编辑器扩展。 */
export type Easing = "linear";

export interface Keyframe<T> {
  /** 相对剪辑块时间线起点的微秒。 */
  tUs: number;
  value: T;
  easing: Easing;
}

export interface StaticValue<T> {
  kind: "static";
  value: T;
}

export interface KeyframedValue<T> {
  kind: "keyframed";
  keyframes: Keyframe<T>[];
}

/**
 * 可动画属性：静态值是关键帧轨的退化情形。
 * 属性从静态升级到关键帧不改结构——这是「任意属性可打帧」自由度的机制保障。
 */
export type Animatable<T> = StaticValue<T> | KeyframedValue<T>;

// ===== 素材 =====

/** 素材种类。图片按零时长素材处理（以定格时长呈现）。 */
export type AssetKind = "video" | "audio" | "image";

/** 素材池条目：一次导入一条；剪辑块按 assetId 引用。 */
export interface MediaAsset {
  id: string;
  /** 绝对路径（经 Tauri 对话框选择，跨平台由 Rust 侧规整）。 */
  path: string;
  kind: AssetKind;
  /** 以下为 ffprobe 元数据（M1 接入；image 时 durationUs 为 0）。 */
  durationUs: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  /** 导入时间戳（epoch ms），素材箱排序用。 */
  addedAt: number;
}

// ===== 剪辑块属性组 =====

/**
 * 画布变换。坐标：画布左上原点、px、素材中心锚定。
 * 缩放先为统一系数（PR 的分离宽/高缩放在推迟池，需要时拆 scale 为 scaleX/scaleY）。
 */
export interface ClipTransform {
  x: Animatable<number>;
  y: Animatable<number>;
  scale: Animatable<number>;
  /** 旋转角，度，顺时针。 */
  rotation: Animatable<number>;
  /** 不透明度 0–1。 */
  opacity: Animatable<number>;
}

export interface ClipAudio {
  /** 增益 0–2，1 为原音量。 */
  gain: Animatable<number>;
  /** 声像 −1（左）～1（右）。 */
  pan: Animatable<number>;
}

// ===== 效果与转场 =====

/**
 * 效果实例：纯数据描述（id + 参数），不含实现。
 * 实现注册表分两端：canvas 预览端 + ffmpeg 导出端，按 effectId 查找（开发方案 3.3）。
 */
export interface EffectInstance {
  id: string;
  effectId: string;
  enabled: boolean;
  /** 参数名 → 可动画值。参数 schema 由效果定义方提供。 */
  params: Record<string, Animatable<number>>;
}

/** 转场：挂接在剪辑块入点/出点，任意时长。UI 在 M4。 */
export interface Transition {
  transitionId: string;
  durationUs: number;
  params: Record<string, Animatable<number>>;
}

// ===== 剪辑块 =====

export interface Clip {
  id: string;
  assetId: string;
  /** 时间线起点（微秒）。 */
  timelineStartUs: number;
  /** 素材内入点 / 出点（微秒）。 */
  sourceInUs: number;
  sourceOutUs: number;
  /** 播放速率，>0；时间线时长由此推导。倒放（负速率）在推迟池。 */
  speed: number;
  transform: ClipTransform;
  audio: ClipAudio;
  /** 可堆叠效果链，数组顺序即应用顺序。 */
  effects: EffectInstance[];
  inTransition: Transition | null;
  outTransition: Transition | null;
}

// ===== 轨道与序列 =====

export type TrackKind = "video" | "audio";

/** 轨道：无限数组、V/A 分离、无固定槽位；块在轨内不重叠（写入层维护）。 */
export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  locked: boolean;
  muted: boolean;
  /** 音频独奏（视频轨恒为 false）。 */
  solo: boolean;
  /** UI 高度（px）用户可调——工作区自由的组成部分。 */
  height: number;
  clips: Clip[];
}

/**
 * 序列：一个独立的时间线画布（分辨率/帧率/轨道组）。
 * 视频轨渲染顺序：数组靠后的轨画在更上层（NLE 惯例）。
 */
export interface Sequence {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  tracks: Track[];
}

/** 工程文档：序列化根对象。多序列工程；嵌套序列（序列作素材）M4 落地。 */
export interface ProjectDocument {
  version: 2;
  name: string;
  assets: MediaAsset[];
  sequences: Sequence[];
  /** 当前编辑的序列。 */
  activeSequenceId: string;
}
