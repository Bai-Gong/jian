/**
 * 轨内剪辑块纯函数：分割/插入/移动/防重叠归一。
 * 全部微秒、全部返回新数组（不可变），store 写入层只调这里，不手搓。
 *
 * 铁律：块时长一律推导＝(sourceOutUs−sourceInUs)/speed，本层任何操作不得破坏守恒
 * （split 左右块时长之和＝原块时长；normalize 只平移不改 sourceIn/Out）。
 */
import type { Clip, Sequence } from "./types";

/** 块时间线时长（微秒）＝(sourceOut−sourceIn)/speed。 */
export function clipDurationUs(clip: Clip): number {
  return (clip.sourceOutUs - clip.sourceInUs) / clip.speed;
}

/** 块时间线终点（微秒）。 */
export function clipEndUs(clip: Clip): number {
  return clip.timelineStartUs + clipDurationUs(clip);
}

/** 序列总时长＝全轨末块终点最大值；空序列为 0。与 evaluateSequence.durationUs 同值。 */
export function sequenceDurationUs(seq: Sequence): number {
  let max = 0;
  for (const track of seq.tracks) {
    for (const clip of track.clips) {
      const end = clipEndUs(clip);
      if (end > max) max = end;
    }
  }
  return max;
}

/**
 * 在时间线时刻 tUs 分割指定块：
 * - tUs 严格落在 (start, end) 开区间内才分：左块保 id、sourceOut 收缩；
 *   右块新 id、sourceIn 接左块出点、timelineStart=tUs；speed/transform 等全部继承。
 * - 块不存在或 tUs 在区间外：原样返回（新数组，内容不变）。
 */
export function splitAt(clips: readonly Clip[], clipId: string, tUs: number): Clip[] {
  const target = clips.find((c) => c.id === clipId);
  if (!target) return [...clips];
  const start = target.timelineStartUs;
  const end = clipEndUs(target);
  if (tUs <= start || tUs >= end) return [...clips];

  // 左块：时间线时长 = tUs−start，反推素材出点（speed 换算）
  const leftOutUs = target.sourceInUs + (tUs - start) * target.speed;
  const left: Clip = { ...target, sourceOutUs: leftOutUs };
  // 右块：素材入点接左块出点，时长自然守恒
  const right: Clip = {
    ...target,
    id: crypto.randomUUID(),
    timelineStartUs: tUs,
    sourceInUs: leftOutUs,
  };
  return clips.flatMap((c) => (c.id === clipId ? [left, right] : [c]));
}

/**
 * 防重叠归一（轨不变量：块不重叠）：
 * 按起点升序排，被前块压住的块整体右移到「前块终点」，只改 timelineStartUs
 * ——时长与素材区间都不动，被推块内容无损。
 */
export function normalizeNoOverlap(clips: readonly Clip[]): Clip[] {
  const sorted = [...clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
  let prevEnd = 0;
  return sorted.map((clip) => {
    const start = Math.max(clip.timelineStartUs, prevEnd);
    prevEnd = start + clipDurationUs(clip);
    return start === clip.timelineStartUs ? clip : { ...clip, timelineStartUs: start };
  });
}

/** 追加块后归一（新块按起点参与排序，必要时推挤既有块）。 */
export function insertClip(clips: readonly Clip[], clip: Clip): Clip[] {
  return normalizeNoOverlap([...clips, clip]);
}

/** 移动块：钳 start≥0 后归一（与其他块重叠时被推到不重叠处）。 */
export function moveClip(clips: readonly Clip[], clipId: string, timelineStartUs: number): Clip[] {
  const moved = clips.map((c) =>
    c.id === clipId ? { ...c, timelineStartUs: Math.max(0, timelineStartUs) } : c,
  );
  return normalizeNoOverlap(moved);
}
