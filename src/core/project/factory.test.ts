/**
 * factory 默认值测试：新建对象的「白纸」形状不许漂移。
 */
import { describe, expect, it } from "vitest";
import {
  createClip,
  createInitialDocument,
  createProject,
  createSequence,
  createTrack,
  DEFAULT_IMAGE_CLIP_US,
  nextTrackName,
} from "./factory";

describe("createClip", () => {
  it("缺省形状：transform 全静态、gain=1、pan=0、speed=1、效果与转场空", () => {
    const clip = createClip({
      assetId: "a1",
      sourceInUs: 0,
      sourceOutUs: 4_000_000,
      timelineStartUs: 1_000_000,
    });
    expect(clip.speed).toBe(1);
    expect(clip.effects).toEqual([]);
    expect(clip.inTransition).toBeNull();
    expect(clip.outTransition).toBeNull();
    // transform 五项全静态
    const t = clip.transform;
    expect(t.x).toEqual({ kind: "static", value: 0 });
    expect(t.y).toEqual({ kind: "static", value: 0 });
    expect(t.scale).toEqual({ kind: "static", value: 1 });
    expect(t.rotation).toEqual({ kind: "static", value: 0 });
    expect(t.opacity).toEqual({ kind: "static", value: 1 });
    // 音频缺省
    expect(clip.audio.gain).toEqual({ kind: "static", value: 1 });
    expect(clip.audio.pan).toEqual({ kind: "static", value: 0 });
    // id 是 uuid 形状
    expect(clip.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("图片块出点用 DEFAULT_IMAGE_CLIP_US（素材本身零时长）", () => {
    expect(DEFAULT_IMAGE_CLIP_US).toBe(5_000_000);
    const clip = createClip({
      assetId: "img",
      sourceInUs: 0,
      sourceOutUs: DEFAULT_IMAGE_CLIP_US,
      timelineStartUs: 0,
    });
    expect(clip.sourceOutUs - clip.sourceInUs).toBe(5_000_000);
  });

  it("speed 可指定（时长推导交 timelineOps，工厂不预乘）", () => {
    const clip = createClip({
      assetId: "a1",
      sourceInUs: 0,
      sourceOutUs: 8_000_000,
      timelineStartUs: 0,
      speed: 2,
    });
    expect(clip.speed).toBe(2);
  });
});

describe("createTrack 命名", () => {
  it("缺省名自增（V1/V2…、A1/A2…）", () => {
    const v1 = createTrack("video");
    const v2 = createTrack("video");
    expect(v2.name).not.toBe(v1.name);
    expect(v1.kind).toBe("video");
    expect(v2.kind).toBe("video");
    const a1 = createTrack("audio");
    expect(a1.kind).toBe("audio");
    // 缺省开关全关、无块
    expect(v1.locked).toBe(false);
    expect(v1.muted).toBe(false);
    expect(v1.solo).toBe(false);
    expect(v1.clips).toEqual([]);
  });

  it("nextTrackName 按现有轨取最大编号 +1（删轨不复用）", () => {
    const v1 = createTrack("video", "V1");
    const v3 = createTrack("video", "V3");
    expect(nextTrackName([v1, v3], "video")).toBe("V4");
    expect(nextTrackName([v1, v3], "audio")).toBe("A1"); // 无音频轨从 1 起
    expect(nextTrackName([createTrack("video", "V2"), v1], "video")).toBe("V3");
  });
});

describe("createSequence / createInitialDocument", () => {
  it("序列缺省 1080p30 空轨", () => {
    const seq = createSequence("测试");
    expect(seq.fps).toBe(30);
    expect(seq.width).toBe(1920);
    expect(seq.height).toBe(1080);
    expect(seq.tracks).toEqual([]);
  });

  it("初始工程：version 2、1V+1A、activeSequenceId 有效、无素材", () => {
    const doc = createInitialDocument();
    expect(doc.version).toBe(2);
    expect(doc.assets).toEqual([]);
    expect(doc.sequences).toHaveLength(1);
    const seq = doc.sequences[0]!;
    expect(seq.tracks.map((t) => t.kind)).toEqual(["video", "audio"]);
    expect(seq.tracks.map((t) => t.name)).toEqual(["V1", "A1"]);
    expect(doc.activeSequenceId).toBe(seq.id);
    // 任务书别名：createProject 与 createInitialDocument 同物
    expect(createProject).toBe(createInitialDocument);
  });
});
