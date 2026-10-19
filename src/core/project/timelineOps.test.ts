/**
 * timelineOps 纯函数测试：分割守恒、归一推挤、移动钳 0、序列时长。
 * 全部微秒；构造块走 factory，不手搓字面量。
 */
import { describe, expect, it } from "vitest";
import { createClip } from "./factory";
import {
  clipDurationUs,
  clipEndUs,
  insertClip,
  moveClip,
  normalizeNoOverlap,
  sequenceDurationUs,
  splitAt,
} from "./timelineOps";
import type { Clip, Sequence } from "./types";

/** 造一块：素材区间 [sourceIn, sourceOut)，speed 可变；时长＝(out−in)/speed。 */
function block(startUs: number, sourceInUs: number, sourceOutUs: number, speed = 1): Clip {
  return createClip({
    assetId: "asset-x",
    sourceInUs,
    sourceOutUs,
    timelineStartUs: startUs,
    speed,
  });
}

describe("splitAt", () => {
  it("中点分割：左右块 sourceIn/Out 守恒、右块新 id、时长守恒", () => {
    // 10 秒块 [0, 10s)，素材区间 [1s, 11s)，在 t=5s 切
    const clip = block(0, 1_000_000, 11_000_000);
    const clips = [clip];
    const out = splitAt(clips, clip.id, 5_000_000);

    expect(out).toHaveLength(2);
    const [left, right] = out;
    // 左块保 id，出点收缩到素材 6s（时间线 5s × speed 1 + 入点 1s）
    expect(left.id).toBe(clip.id);
    expect(left.sourceInUs).toBe(1_000_000);
    expect(left.sourceOutUs).toBe(6_000_000);
    expect(left.timelineStartUs).toBe(0);
    // 右块新 id，入点接左块出点
    expect(right.id).not.toBe(clip.id);
    expect(right.sourceInUs).toBe(6_000_000);
    expect(right.sourceOutUs).toBe(11_000_000);
    expect(right.timelineStartUs).toBe(5_000_000);
    // 守恒：左右时长之和＝原时长
    expect(clipDurationUs(left) + clipDurationUs(right)).toBe(clipDurationUs(clip));
  });

  it("speed≠1：素材区间按速率换算仍守恒", () => {
    // speed 2：时间线 8s ↔ 素材 16s；素材 [2s, 18s) → 时间线 [0, 8s)，在 4s 切
    const clip = block(0, 2_000_000, 18_000_000, 2);
    const [left, right] = splitAt([clip], clip.id, 4_000_000);
    expect(left.sourceOutUs).toBe(10_000_000); // 2s + 4s×2
    expect(right.sourceInUs).toBe(10_000_000);
    expect(right.sourceOutUs).toBe(18_000_000);
    expect(clipDurationUs(left)).toBe(4_000_000);
    expect(clipDurationUs(right)).toBe(4_000_000);
  });

  it("切割点在块外（恰在端点/越界）原样返回新数组", () => {
    const clip = block(1_000_000, 0, 4_000_000); // [1s, 5s)
    for (const t of [0, 1_000_000, 5_000_000, 9_000_000]) {
      const source = [clip];
      const out = splitAt(source, clip.id, t);
      expect(out).toHaveLength(1);
      expect(out[0]).toBe(clip); // 内容未动
      expect(out).not.toBe(source); // 但返回新数组
    }
    // 找不到块同样原样
    expect(splitAt([clip], "no-such-id", 2_000_000)).toHaveLength(1);
  });
});

describe("normalizeNoOverlap / insertClip / moveClip", () => {
  it("重叠块被推到前块终点，整体右移保时长", () => {
    const a = block(0, 0, 4_000_000); // [0, 4s)
    const b = block(2_000_000, 0, 2_000_000); // 想放 [2s, 4s) → 被推到 [4s, 6s)
    const out = normalizeNoOverlap([b, a]); // 乱序进、升序出
    expect(out.map((c) => c.timelineStartUs)).toEqual([0, 4_000_000]);
    // 被推块只改 start：素材区间与时长不动
    const pushed = out[1];
    expect(pushed.sourceInUs).toBe(b.sourceInUs);
    expect(pushed.sourceOutUs).toBe(b.sourceOutUs);
    expect(clipDurationUs(pushed)).toBe(clipDurationUs(b));
    // 连环推挤：第三块撞到被推的第二块尾
    const c = block(5_000_000, 0, 1_000_000); // 想放 [5s, 6s) → 终点 [6s, 7s)
    const out2 = normalizeNoOverlap([c, b, a]);
    expect(out2.map((clip) => clipEndUs(clip))).toEqual([4_000_000, 6_000_000, 7_000_000]);
  });

  it("moveClip：起点钳 0，落点重叠时归一推挤", () => {
    const a = block(0, 0, 4_000_000); // [0, 4s)
    const b = block(10_000_000, 0, 2_000_000); // [10s, 12s)
    // 把 b 拖到 -5s → 钳 0 → 撞 a → 推到 [4s, 6s)
    const out = moveClip([a, b], b.id, -5_000_000);
    expect(out[1].timelineStartUs).toBe(4_000_000);
    // 拖到空档 20s 原位落
    const out2 = moveClip([a, b], b.id, 20_000_000);
    expect(out2[1].timelineStartUs).toBe(20_000_000);
  });

  it("insertClip：插入空轨按起点排序", () => {
    const a = block(5_000_000, 0, 1_000_000);
    const b = block(0, 0, 2_000_000);
    const out = insertClip([], a);
    expect(insertClip(out, b).map((c) => c.timelineStartUs)).toEqual([0, 5_000_000]);
  });
});

describe("sequenceDurationUs", () => {
  it("空轨与空序列为 0；取全轨末块终点最大值", () => {
    const seq: Sequence = {
      id: "seq",
      name: "s",
      fps: 30,
      width: 1920,
      height: 1080,
      tracks: [
        { id: "t1", kind: "video", name: "V1", locked: false, muted: false, solo: false, height: 72, clips: [] },
        { id: "t2", kind: "audio", name: "A1", locked: false, muted: false, solo: false, height: 56, clips: [] },
      ],
    };
    expect(sequenceDurationUs(seq)).toBe(0);

    const a = block(0, 0, 3_000_000);
    const b = block(1_000_000, 0, 9_000_000); // [1s, 10s)
    seq.tracks[0]!.clips.push(a);
    seq.tracks[1]!.clips.push(b);
    expect(sequenceDurationUs(seq)).toBe(10_000_000);
  });
});
