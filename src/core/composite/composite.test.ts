/**
 * composite 求值层测试：插值、层枚举（顺序/双列/静音/独奏/锁/悬空）、帧描述半开区间。
 * 构造一律传 assets——hasAudio 只在素材上，这正是本层签名强制 assets 的原因。
 */
import { describe, expect, it } from "vitest";
import { createClip } from "../project/factory";
import type { KeyframedValue, MediaAsset, Sequence, Track, TrackKind } from "../project/types";
import { buildFrameDescription, evaluateSequence, resolveAnimatable } from "./composite";

/** 造素材：缺省 1080p30 带伴音的视频；按需覆盖字段。 */
function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: crypto.randomUUID(),
    path: `C:/media/${overrides.kind ?? "video"}-${crypto.randomUUID()}.bin`,
    kind: "video",
    durationUs: 10_000_000,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    addedAt: 0,
    ...overrides,
  };
}

function makeTrack(kind: TrackKind, id: string, clips: ReturnType<typeof createClip>[], overrides: Partial<Track> = {}): Track {
  return { id, kind, name: id.toUpperCase(), locked: false, muted: false, solo: false, height: 72, clips, ...overrides };
}

function makeSequence(tracks: Track[]): Sequence {
  return { id: "seq", name: "测试序列", fps: 30, width: 1920, height: 1080, tracks };
}

/** 关键帧轨：[tUs, value] 列表，linear。 */
function keyframed(...frames: [number, number][]): KeyframedValue<number> {
  return { kind: "keyframed", keyframes: frames.map(([tUs, value]) => ({ tUs, value, easing: "linear" })) };
}

/** 造一块放进给定时长的素材：素材区间缺省整段 [0, durationUs)。 */
function clipOf(asset: MediaAsset, startUs: number, overrides: Partial<ReturnType<typeof createClip>> = {}) {
  const span = asset.kind === "image" ? 5_000_000 : asset.durationUs;
  return createClip({
    assetId: asset.id,
    sourceInUs: 0,
    sourceOutUs: span,
    timelineStartUs: startUs,
    ...overrides,
  });
}

describe("resolveAnimatable", () => {
  it("静态值任意时刻直取", () => {
    const prop = { kind: "static" as const, value: 0.75 };
    expect(resolveAnimatable(prop, 0)).toBe(0.75);
    expect(resolveAnimatable(prop, 123_456)).toBe(0.75);
  });

  it("关键帧轨：区间内线性、区间外钳到端点值", () => {
    const prop = keyframed([0, 0], [10_000_000, 10]);
    expect(resolveAnimatable(prop, 5_000_000)).toBe(5); // 中点
    expect(resolveAnimatable(prop, 2_500_000)).toBe(2.5); // 比例
    expect(resolveAnimatable(prop, -1)).toBe(0); // ≤首帧取首值
    expect(resolveAnimatable(prop, 0)).toBe(0);
    expect(resolveAnimatable(prop, 10_000_000)).toBe(10); // ≥末帧取末值
    expect(resolveAnimatable(prop, 99_000_000)).toBe(10);
  });

  it("多段关键帧逐段插值", () => {
    const prop = keyframed([0, 0], [4_000_000, 8], [10_000_000, 10]);
    expect(resolveAnimatable(prop, 2_000_000)).toBe(4); // 第一段中点
    expect(resolveAnimatable(prop, 7_000_000)).toBe(9); // 第二段中点
  });
});

describe("evaluateSequence", () => {
  it("层序按轨道序（靠后=上层）；视频块双列、音轨块只进音频层；durationUs 取块终点最大值", () => {
    const v1 = makeAsset(); // 带伴音
    const v2 = makeAsset({ hasAudio: false }); // 无伴音
    const a1 = makeAsset({ kind: "audio" });
    const c1 = clipOf(v1, 0);
    const c2 = clipOf(v2, 1_000_000);
    const c3 = clipOf(a1, 2_000_000);
    const seq = makeSequence([
      makeTrack("video", "t-v1", [c1]),
      makeTrack("video", "t-v2", [c2]),
      makeTrack("audio", "t-a1", [c3]),
    ]);
    const ev = evaluateSequence(seq, [v1, v2, a1]);

    expect(ev.videoLayers.map((l) => l.clipId)).toEqual([c1.id, c2.id]); // 轨道序＝层序
    // 音频层：音频轨块在前，视频轨带伴音的块随后（c2 无伴音不进）
    expect(ev.audioLayers.map((l) => l.clipId)).toEqual([c3.id, c1.id]);
    expect(ev.durationUs).toBe(12_000_000); // c3 终点最晚：2s + 10s
  });

  it("LayerDesc 字段：推导终点按 speed、静态属性 t=0 取样", () => {
    const asset = makeAsset();
    // speed 2：素材 [2s, 18s) → 时间线 [0, 8s)
    const clip = createClip({
      assetId: asset.id,
      sourceInUs: 2_000_000,
      sourceOutUs: 18_000_000,
      timelineStartUs: 3_000_000,
      speed: 2,
    });
    clip.transform.scale = keyframed([0, 1], [4_000_000, 5]);
    const seq = makeSequence([makeTrack("video", "t-v1", [clip])]);
    const [layer] = evaluateSequence(seq, [asset]).videoLayers;
    expect(layer.timelineStartUs).toBe(3_000_000);
    expect(layer.timelineEndUs).toBe(11_000_000); // 3s + 16s/2
    expect(layer.sourceInUs).toBe(2_000_000);
    expect(layer.sourceOutUs).toBe(18_000_000);
    expect(layer.speed).toBe(2);
    expect(layer.scale).toBe(1); // 静态枚举：t=0 取首帧值
    expect(layer.gain).toBe(1);
    expect(layer.pan).toBe(0); // factory 缺省
    expect(layer.effects).toEqual([]); // factory 缺省：空链也在求值里流通
    expect(layer.x).toBe(0);
    expect(layer.hasAudio).toBe(true);
  });

  it("效果链与声像进求值：保链序、params/pan 一律 t=0 取样、disabled 原样保留", () => {
    const asset = makeAsset();
    const clip = clipOf(asset, 0);
    clip.effects = [
      { id: "e1", effectId: "builtin.blur", enabled: true, params: { amount: { kind: "static", value: 3 } } },
      { id: "e2", effectId: "builtin.grayscale", enabled: false, params: { mix: keyframed([0, 0], [4_000_000, 1]) } },
    ];
    clip.audio.pan = keyframed([0, -0.5], [10_000_000, 0.5]);
    const seq = makeSequence([makeTrack("video", "t-v1", [clip])]);
    const [layer] = evaluateSequence(seq, [asset]).videoLayers;

    // 声像：静态枚举取首帧值
    expect(layer.pan).toBe(-0.5);
    // 效果链保序、enabled/disabled 都保留（跳过与否是渲染端的事）
    expect(layer.effects.map((e) => e.effectId)).toEqual(["builtin.blur", "builtin.grayscale"]);
    expect(layer.effects[0].enabled).toBe(true);
    expect(layer.effects[0].params.amount).toBe(3); // 静态参数直取
    expect(layer.effects[1].enabled).toBe(false);
    expect(layer.effects[1].params.mix).toBe(0); // 关键帧参数 t=0 取首值
    // 帧描述同样携带（开发方案 §3.3：帧描述含效果链参数）
    const desc = buildFrameDescription(seq, 1_000_000, [asset]);
    expect(desc.videoLayers[0].effects).toHaveLength(2);
    expect(desc.videoLayers[0].pan).toBe(-0.5);
  });

  it("muted 音轨只除音频层；muted 视频轨的块仍上画面但不出声", () => {
    const v = makeAsset(); // 带伴音的视频块
    const a = makeAsset({ kind: "audio" });
    const cv = clipOf(v, 0);
    const ca = clipOf(a, 0);
    const seq = makeSequence([
      makeTrack("video", "t-v1", [cv], { muted: true }),
      makeTrack("audio", "t-a1", [ca], { muted: true }),
    ]);
    const ev = evaluateSequence(seq, [v, a]);
    expect(ev.videoLayers.map((l) => l.clipId)).toEqual([cv.id]); // 画面照留
    expect(ev.audioLayers).toHaveLength(0); // 两轨都静音：一个音频层都不剩
  });

  it("存在 solo 音轨时仅留 solo 轨的音频（视频块伴音也被压掉）", () => {
    const v = makeAsset();
    const a1 = makeAsset({ kind: "audio" });
    const a2 = makeAsset({ kind: "audio" });
    const cv = clipOf(v, 0);
    const c1 = clipOf(a1, 0);
    const c2 = clipOf(a2, 0);
    const seq = makeSequence([
      makeTrack("video", "t-v1", [cv]),
      makeTrack("audio", "t-a1", [c1]),
      makeTrack("audio", "t-a2", [c2], { solo: true }),
    ]);
    const ev = evaluateSequence(seq, [v, a1, a2]);
    expect(ev.audioLayers.map((l) => l.clipId)).toEqual([c2.id]);
    expect(ev.videoLayers.map((l) => l.clipId)).toEqual([cv.id]); // solo 不影响画面
  });

  it("locked 轨不影响求值（锁是编辑门禁，不是渲染开关）", () => {
    const a = makeAsset({ kind: "audio" });
    const c = clipOf(a, 0);
    const seq = makeSequence([makeTrack("audio", "t-a1", [c], { locked: true })]);
    const ev = evaluateSequence(seq, [a]);
    expect(ev.audioLayers.map((l) => l.clipId)).toEqual([c.id]);
  });

  it("悬空 assetId 的块整体跳过（不进层、不计时长）", () => {
    const a = makeAsset();
    const good = clipOf(a, 0);
    const orphan = clipOf({ ...a, id: "不存在的素材" }, 100_000_000);
    const seq = makeSequence([makeTrack("video", "t-v1", [good, orphan])]);
    const ev = evaluateSequence(seq, [a]);
    expect(ev.videoLayers.map((l) => l.clipId)).toEqual([good.id]);
    expect(ev.durationUs).toBe(10_000_000); // 孤儿块的 110s 不计入
  });
});

describe("buildFrameDescription", () => {
  it("半开区间 [start, end)：起点当帧在、终点当帧不在", () => {
    const v = makeAsset();
    const c = clipOf(v, 1_000_000); // [1s, 11s)
    const seq = makeSequence([makeTrack("video", "t-v1", [c])]);

    const at = (tUs: number) => buildFrameDescription(seq, tUs, [v]).videoLayers.map((l) => l.clipId);
    expect(at(999_999)).toEqual([]);
    expect(at(1_000_000)).toEqual([c.id]); // 起点包含
    expect(at(10_999_999)).toEqual([c.id]);
    expect(at(11_000_000)).toEqual([]); // 终点不包含
  });

  it("音频层同样按窗口过滤，tUs 原样带回", () => {
    const a = makeAsset({ kind: "audio" });
    const c = clipOf(a, 0);
    const seq = makeSequence([makeTrack("audio", "t-a1", [c])]);
    const desc = buildFrameDescription(seq, 1_000_000, [a]);
    expect(desc.tUs).toBe(1_000_000);
    expect(desc.audioLayers.map((l) => l.clipId)).toEqual([c.id]);
    expect(buildFrameDescription(seq, 10_000_000, [a]).audioLayers).toHaveLength(0);
  });
});
