/**
 * 时间线几何纯函数：缩放、刻度档、吸附、时间码标注。
 * 无 DOM、无 store 依赖——组件层只做 px↔us 换算与事件接线，可全量单测。
 *
 * 换算式：px = us × pxPerUs。默认 1e-4 = 100px/s（M1 契约基准）。
 */
import type { MediaAsset } from "../../core/project/types";


/** 默认横向缩放：100px/s。 */
export const DEFAULT_PX_PER_US = 1e-4;
/** 缩放下限：1.5px/s（1 小时约 5400px；再低分档只剩分钟级，没有编辑意义）。 */
export const MIN_PX_PER_US = 1.5e-6;
/** 缩放上限：2500px/s（30fps 单帧约 83px，帧级微调够用）。 */
export const MAX_PX_PER_US = 2.5e-3;

/** 刻度尺高度（px）。轨头列的角落占位与播放头手柄同高。 */
export const RULER_HEIGHT_PX = 30;

/** 吸附判定阈值（px）：拖动中屏显距离小于此值才吸。 */
export const SNAP_THRESHOLD_PX = 8;

const SECOND_US = 1_000_000;
const MINUTE_US = 60 * SECOND_US;

/** 缩放步进倍率（Ctrl+滚轮一格）。 */
const ZOOM_STEP = 1.2;

export function clampPxPerUs(pxPerUs: number): number {
  if (Number.isNaN(pxPerUs)) return DEFAULT_PX_PER_US;
  return Math.min(MAX_PX_PER_US, Math.max(MIN_PX_PER_US, pxPerUs));
}

/** Ctrl+滚轮缩放一档：deltaY<0 放大、>0 缩小（触控板惯性由倍率自然衰减）。 */
export function zoomPxPerUs(current: number, deltaY: number): number {
  return clampPxPerUs(current * (deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
}

// ===== 刻度尺 =====

/** 刻度标注粒度档：帧 / 秒 / 分，随缩放自适应。 */
export type RulerTier = "frame" | "second" | "minute";

export interface RulerStep {
  /** 主刻度间距（微秒）。 */
  stepUs: number;
  tier: RulerTier;
  /** 次刻度间距；等于 stepUs 表示不画次刻度。 */
  minorUs: number;
}

/** 主刻度标注最小间距（px），不足则升档。 */
const LABEL_MIN_PX = 64;
/** 次刻度最小可辨间距（px）。 */
const MINOR_MIN_PX = 9;

interface StepCandidate {
  stepUs: number;
  tier: RulerTier;
  divide: number;
}

/** 档位候选：帧（1/5/10 帧）→ 秒 → 分，从细到粗；帧档的倍数运行时乘以帧长换算。 */
const STEP_CANDIDATES: readonly StepCandidate[] = [
  { stepUs: 1, tier: "frame", divide: 5 },
  { stepUs: 5, tier: "frame", divide: 5 },
  { stepUs: 10, tier: "frame", divide: 5 },
  { stepUs: 1 * SECOND_US, tier: "second", divide: 5 },
  { stepUs: 2 * SECOND_US, tier: "second", divide: 4 },
  { stepUs: 5 * SECOND_US, tier: "second", divide: 5 },
  { stepUs: 10 * SECOND_US, tier: "second", divide: 5 },
  { stepUs: 15 * SECOND_US, tier: "second", divide: 3 },
  { stepUs: 30 * SECOND_US, tier: "second", divide: 3 },
  { stepUs: 1 * MINUTE_US, tier: "minute", divide: 5 },
  { stepUs: 2 * MINUTE_US, tier: "minute", divide: 4 },
  { stepUs: 5 * MINUTE_US, tier: "minute", divide: 5 },
  { stepUs: 10 * MINUTE_US, tier: "minute", divide: 5 },
  { stepUs: 30 * MINUTE_US, tier: "minute", divide: 3 },
  { stepUs: 60 * MINUTE_US, tier: "minute", divide: 4 },
];

/** 取当前缩放下合适的刻度档：帧×帧数的档位乘 fps 换算成微秒参与比较。 */
export function pickRulerStep(pxPerUs: number, fps: number): RulerStep {
  const safeFps = fps > 0 ? fps : 30;
  const frameUs = SECOND_US / safeFps;
  const candidates = STEP_CANDIDATES.map((c) =>
    c.tier === "frame" ? { ...c, stepUs: c.stepUs * frameUs } : c,
  );
  let picked = candidates[candidates.length - 1]!;
  for (const c of candidates) {
    if (c.stepUs * pxPerUs >= LABEL_MIN_PX) {
      picked = c;
      break;
    }
  }
  // 次刻度：先按均分，太密就减半，再密就不画
  let minorUs = picked.stepUs / picked.divide;
  if (minorUs * pxPerUs < MINOR_MIN_PX) minorUs = picked.stepUs / 2;
  if (minorUs * pxPerUs < MINOR_MIN_PX) minorUs = picked.stepUs;
  return { stepUs: picked.stepUs, tier: picked.tier, minorUs };
}

/** 可视窗口（含两侧余量 px）换算成微秒区间，并钳到 [0, contentUs]。 */
export function visibleRangeUs(
  viewLeftPx: number,
  viewWidthPx: number,
  pxPerUs: number,
  contentUs: number,
  marginPx: number,
): { leftUs: number; rightUs: number } {
  const leftUs = Math.max(0, (viewLeftPx - marginPx) / pxPerUs);
  const rightUs = Math.min(contentUs, (viewLeftPx + viewWidthPx + marginPx) / pxPerUs);
  return { leftUs, rightUs };
}

/** 区间内的主/次刻度位置（微秒）；次刻度与主刻度重合时跳过。 */
export function rulerTicks(
  leftUs: number,
  rightUs: number,
  stepUs: number,
  minorUs: number,
): { majors: number[]; minors: number[] } {
  const majors: number[] = [];
  for (let i = Math.floor(leftUs / stepUs); i * stepUs <= rightUs; i++) {
    if (i < 0) continue;
    majors.push(i * stepUs);
  }
  const minors: number[] = [];
  if (minorUs < stepUs) {
    for (let i = Math.floor(leftUs / minorUs); i * minorUs <= rightUs; i++) {
      if (i < 0) continue;
      const us = i * minorUs;
      // 与主刻度重合的跳过（除不尽判定走整数下标）
      if (Math.abs(us / stepUs - Math.round(us / stepUs)) > 1e-6) minors.push(us);
    }
  }
  return { majors, minors };
}

/** 两位补零。 */
const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 素材显示名：MediaAsset 无 name 字段（types.ts 定稿只增不推翻），从 path 取文件名。
 * Windows 反斜杠与 POSIX 斜杠都认；空路径兜底占位文本。
 */
export function assetDisplayName(asset: MediaAsset | undefined): string {
  if (!asset || asset.path === "") return "未知素材";
  const parts = asset.path.split(/[\\/]/);
  return parts[parts.length - 1] || "未知素材";
}

/**
 * 刻度标注文本：
 * - 帧档 `MM:SS:FF`（满 1 小时加 `H:` 前缀）；
 * - 秒/分档 `MM:SS`（同样带小时前缀）。
 * 帧数按四舍五入 fps 取整（M1 序列 fps=30；29.97 这类非整帧率 M2 再精算）。
 */
export function formatRulerLabel(us: number, tier: RulerTier, fps: number): string {
  const totalSeconds = us / SECOND_US;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const head = h > 0 ? `${h}:` : "";
  if (tier === "frame") {
    const fpsInt = Math.max(1, Math.round(fps));
    const frame = Math.round(totalSeconds * fpsInt) % fpsInt;
    return `${head}${pad2(m)}:${pad2(s)}:${pad2(frame)}`;
  }
  return `${head}${pad2(m)}:${pad2(s)}`;
}

// ===== 吸附 =====

export interface SnapResult {
  /** 吸附后的块起点（微秒）；无命中时即原值。 */
  startUs: number;
  /** 吸附命中的边缘（微秒）；null 表示未吸附。 */
  snappedEdgeUs: number | null;
}

/**
 * 拖动吸附：块的起点或终点对齐候选边缘（其他块边缘 / 播放头 / 0）。
 * 阈值按屏显 px 给（任务契约 8px），起点与终点都在阈值内时取距离更近者。
 */
export function findSnapOffset(
  startUs: number,
  durationUs: number,
  edges: readonly number[],
  pxPerUs: number,
  thresholdPx: number,
): SnapResult {
  const thresholdUs = thresholdPx / pxPerUs;
  const endUs = startUs + durationUs;
  let bestAbs = thresholdUs;
  let snappedStart: number | null = null;
  let snappedEdge: number | null = null;
  for (const edge of edges) {
    const dStart = Math.abs(startUs - edge);
    if (dStart < bestAbs) {
      bestAbs = dStart;
      snappedStart = edge;
      snappedEdge = edge;
    }
    const dEnd = Math.abs(endUs - edge);
    if (dEnd < bestAbs) {
      bestAbs = dEnd;
      snappedStart = edge - durationUs;
      snappedEdge = edge;
    }
  }
  return { startUs: snappedStart ?? startUs, snappedEdgeUs: snappedEdge };
}
