/**
 * buildYeExportParams 测试：接受/拒绝矩阵（it.each）。
 * 接受面（M4 首轮顺序拼接）逐项锁死——层序/音频成员/总时长全部来自
 * evaluateSequence（与 buildExportArgs 同一求值入口），任何非默认变换/
 * 非视频素材/非连续排列/独立音轨都须明确拒绝并指路 ffmpeg 引擎
 * （不静默降级——静默忽略会让用户以为导出符合预览）。
 */
import { describe, expect, it } from "vitest";
import type { Animatable, Clip, MediaAsset, Sequence, Track, TrackKind } from "../project/types";
import { createClip } from "../project/factory";
import { buildYeExportParams } from "./buildYeExportParams";

const staticOf = (value: number): Animatable<number> => ({ kind: "static", value });

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: crypto.randomUUID(),
    path: `C:/media/${overrides.kind ?? "video"}-${crypto.randomUUID()}.mp4`,
    kind: "video",
    durationUs: 10_000_000,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
    sampleRate: 48_000,
    channels: 2,
    addedAt: 0,
    ...overrides,
  };
}

function makeTrack(kind: TrackKind, id: string, clips: Clip[], overrides: Partial<Track> = {}): Track {
  return { id, kind, name: id.toUpperCase(), locked: false, muted: false, solo: false, height: 72, clips, ...overrides };
}

function makeSequence(tracks: Track[], overrides: Partial<Sequence> = {}): Sequence {
  return { id: "seq", name: "测试序列", fps: 30, width: 1920, height: 1080, tracks, ...overrides };
}

/** 相邻两块的标准接受形态（同一素材的两个源片段）。 */
function adjacentClips(assetId: string): Clip[] {
  return [
    createClip({ assetId, sourceInUs: 0, sourceOutUs: 3_000_000, timelineStartUs: 0 }),
    createClip({ assetId, sourceInUs: 5_000_000, sourceOutUs: 8_000_000, timelineStartUs: 3_000_000 }),
  ];
}

describe("buildYeExportParams：接受面", () => {
  it("两块相邻视频（自带 AAC 音频）→ 有序片段表 + 输出参数", () => {
    const asset = makeAsset();
    const built = buildYeExportParams(
      makeSequence([makeTrack("video", "t-v1", adjacentClips(asset.id))]),
      [asset],
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.segments).toEqual([
      { path: asset.path, trimInUs: 0, trimOutUs: 3_000_000 },
      { path: asset.path, trimInUs: 5_000_000, trimOutUs: 8_000_000 },
    ]);
    expect(built.width).toBe(1920);
    expect(built.height).toBe(1080);
    expect(built.fpsNum).toBe(30);
    expect(built.fpsDen).toBe(1);
    expect(built.crf).toBe(23); // 对标 ffmpeg 轨 libx264 缺省
    expect(built.stripAudio).toBe(false);
    expect(built.audioBitrateKbps).toBe(128); // 对标 -c:a aac 缺省量级
    expect(built.totalUs).toBe(6_000_000);
  });

  it("视频素材全无音频 → 剥音轨（stripAudio=true、码率 null）", () => {
    const asset = makeAsset({ hasAudio: false, audioCodec: "", sampleRate: 0, channels: 0 });
    const built = buildYeExportParams(
      makeSequence([makeTrack("video", "t-v1", adjacentClips(asset.id))]),
      [asset],
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.stripAudio).toBe(true);
    expect(built.audioBitrateKbps).toBeNull();
  });

  it("块乱序投放（时间线起点靠后的在前）→ 片段表仍按时间线排序", () => {
    const asset = makeAsset();
    const clips = [...adjacentClips(asset.id)].reverse(); // 数组序颠倒
    const built = buildYeExportParams(
      makeSequence([makeTrack("video", "t-v1", clips)]),
      [asset],
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.segments.map((s) => s.trimInUs)).toEqual([0, 5_000_000]);
  });
});

describe("buildYeExportParams：拒绝矩阵", () => {
  /** 造一条「层属性/素材/序列被改坏的」相邻两块序列，返回 (mutation) => 翻译结果。 */
  function rejected(
    mutate: (clip: Clip, asset: MediaAsset, seq: Sequence) => void,
  ): ReturnType<typeof buildYeExportParams> {
    const asset = makeAsset();
    const clips = adjacentClips(asset.id);
    const track = makeTrack("video", "t-v1", clips);
    const seq = makeSequence([track]);
    mutate(clips[0], asset, seq);
    return buildYeExportParams(seq, [asset]);
  }

  it.each([
    {
      what: "变速（speed≠1）",
      mutate: (clip: Clip) => void (clip.speed = 2),
      expectText: "变速",
    },
    {
      what: "缩放（scale≠1）",
      mutate: (clip: Clip) => void (clip.transform.scale = staticOf(1.5)),
      expectText: "空间变换",
    },
    {
      what: "旋转（rotation≠0）",
      mutate: (clip: Clip) => void (clip.transform.rotation = staticOf(90)),
      expectText: "空间变换",
    },
    {
      what: "透明度（opacity≠1）",
      mutate: (clip: Clip) => void (clip.transform.opacity = staticOf(0.5)),
      expectText: "空间变换",
    },
    {
      what: "位移（x≠0）",
      mutate: (clip: Clip) => void (clip.transform.x = staticOf(10)),
      expectText: "空间变换",
    },
    {
      what: "效果链（启用态）",
      mutate: (clip: Clip) =>
        void (clip.effects = [{ id: "e1", effectId: "blur", enabled: true, params: {} }]),
      expectText: "效果",
    },
    {
      what: "效果链（禁用态也不放行——不翻译的属性不能假装没有）",
      mutate: (clip: Clip) =>
        void (clip.effects = [{ id: "e1", effectId: "blur", enabled: false, params: {} }]),
      expectText: "效果",
    },
    {
      what: "入点转场",
      mutate: (clip: Clip) =>
        void (clip.inTransition = { transitionId: "dissolve", durationUs: 500_000, params: {} }),
      expectText: "转场",
    },
    {
      what: "出点转场",
      mutate: (clip: Clip) =>
        void (clip.outTransition = { transitionId: "dissolve", durationUs: 500_000, params: {} }),
      expectText: "转场",
    },
    {
      what: "音频增益（gain≠1）",
      mutate: (clip: Clip) => void (clip.audio.gain = staticOf(2)),
      expectText: "增益",
    },
    {
      what: "声像（pan≠0）",
      mutate: (clip: Clip) => void (clip.audio.pan = staticOf(-0.5)),
      expectText: "声像",
    },
    {
      what: "源视频非 H.264",
      mutate: (_clip: Clip, asset: MediaAsset) => void (asset.videoCodec = "hevc"),
      expectText: "H.264",
    },
    {
      what: "源音频非 AAC",
      mutate: (_clip: Clip, asset: MediaAsset) => void (asset.audioCodec = "mp3"),
      expectText: "AAC",
    },
    {
      what: "音频声道 > 2",
      mutate: (_clip: Clip, asset: MediaAsset) => void (asset.channels = 6),
      expectText: "单/双声道",
    },
    {
      what: "素材为图片",
      mutate: (_clip: Clip, asset: MediaAsset) => void (asset.kind = "image"),
      expectText: "视频素材",
    },
  ])("拒绝：$what", ({ mutate, expectText }) => {
    const built = rejected(mutate);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain(expectText);
    expect(built.error).toContain("ffmpeg 引擎");
  });

  it("拒绝：层间空隙", () => {
    const asset = makeAsset();
    const clips = [
      createClip({ assetId: asset.id, sourceInUs: 0, sourceOutUs: 3_000_000, timelineStartUs: 0 }),
      createClip({ assetId: asset.id, sourceInUs: 0, sourceOutUs: 3_000_000, timelineStartUs: 4_000_000 }),
    ];
    const built = buildYeExportParams(makeSequence([makeTrack("video", "t-v1", clips)]), [asset]);
    expect(built).toMatchObject({ ok: false });
    if (built.ok) return;
    expect(built.error).toContain("空隙");
  });

  it("拒绝：层重叠（叠加）", () => {
    const asset = makeAsset();
    const clips = [
      createClip({ assetId: asset.id, sourceInUs: 0, sourceOutUs: 4_000_000, timelineStartUs: 0 }),
      createClip({ assetId: asset.id, sourceInUs: 0, sourceOutUs: 3_000_000, timelineStartUs: 3_000_000 }),
    ];
    const built = buildYeExportParams(makeSequence([makeTrack("video", "t-v1", clips)]), [asset]);
    expect(built).toMatchObject({ ok: false });
    if (built.ok) return;
    expect(built.error).toContain("叠加");
  });

  it("拒绝：起始空隙（首块不从 0 起）", () => {
    const asset = makeAsset();
    const clips = [
      createClip({ assetId: asset.id, sourceInUs: 0, sourceOutUs: 3_000_000, timelineStartUs: 2_000_000 }),
    ];
    const built = buildYeExportParams(makeSequence([makeTrack("video", "t-v1", clips)]), [asset]);
    expect(built).toMatchObject({ ok: false });
    if (built.ok) return;
    expect(built.error).toContain("起始空隙");
  });

  it("拒绝：尾部空隙（更长的音频层把总时长顶过视频末尾）", () => {
    const v = makeAsset();
    const a = makeAsset({ kind: "audio", videoCodec: "", width: 0, height: 0, fps: 0 });
    const tracks = [
      makeTrack("video", "t-v1", [
        createClip({ assetId: v.id, sourceInUs: 0, sourceOutUs: 3_000_000, timelineStartUs: 0 }),
      ]),
      makeTrack("audio", "t-a1", [
        createClip({ assetId: a.id, sourceInUs: 0, sourceOutUs: 5_000_000, timelineStartUs: 0 }),
      ]),
    ];
    const built = buildYeExportParams(makeSequence(tracks), [v, a]);
    expect(built).toMatchObject({ ok: false });
    if (built.ok) return;
    expect(built.error).toContain("尾部空隙");
  });

  it("拒绝：独立音频轨（音频层成员超出视频层伴音集合）", () => {
    const v = makeAsset();
    const a = makeAsset({ kind: "audio", videoCodec: "", width: 0, height: 0, fps: 0 });
    const tracks = [
      makeTrack("video", "t-v1", [
        createClip({ assetId: v.id, sourceInUs: 0, sourceOutUs: 4_000_000, timelineStartUs: 0 }),
      ]),
      makeTrack("audio", "t-a1", [
        createClip({ assetId: a.id, sourceInUs: 0, sourceOutUs: 4_000_000, timelineStartUs: 0 }),
      ]),
    ];
    const built = buildYeExportParams(makeSequence(tracks), [v, a]);
    expect(built).toMatchObject({ ok: false });
    if (built.ok) return;
    expect(built.error).toContain("ffmpeg 引擎");
  });

  it("拒绝：静音视频轨（伴音被 mute 压掉——片段级静音不可表达）", () => {
    const v = makeAsset();
    const tracks = [
      makeTrack("video", "t-v1", adjacentClips(v.id), { muted: true }),
    ];
    const built = buildYeExportParams(makeSequence(tracks), [v]);
    expect(built).toMatchObject({ ok: false });
    if (built.ok) return;
    expect(built.error).toContain("静音");
  });

  it("拒绝：跨素材音频参数不一致（采样率/声道）", () => {
    const a1 = makeAsset();
    const a2 = makeAsset({ sampleRate: 44_100, channels: 2 });
    const clips1 = adjacentClips(a1.id);
    const clips2 = adjacentClips(a2.id).map((c) => ({
      ...c,
      timelineStartUs: c.timelineStartUs + 6_000_000,
    }));
    const built = buildYeExportParams(
      makeSequence([
        makeTrack("video", "t-v1", [...clips1, ...clips2]),
      ]),
      [a1, a2],
    );
    expect(built).toMatchObject({ ok: false });
    if (built.ok) return;
    expect(built.error).toContain("一致");
  });

  it.each([
    { what: "非整数帧率", seq: { fps: 29.97 }, expectText: "非整数帧率" },
    { what: "奇数画幅", seq: { width: 1921 }, expectText: "偶数画幅" },
  ])("拒绝：$what", ({ seq, expectText }) => {
    const asset = makeAsset();
    const built = buildYeExportParams(
      makeSequence([makeTrack("video", "t-v1", adjacentClips(asset.id))], seq),
      [asset],
    );
    expect(built).toMatchObject({ ok: false });
    if (built.ok) return;
    expect(built.error).toContain(expectText);
  });

  it("拒绝：空序列（无视频层）", () => {
    const built = buildYeExportParams(makeSequence([makeTrack("video", "t-v1", [])]), [makeAsset()]);
    expect(built).toMatchObject({ ok: false, error: expect.stringContaining("视频层") });
  });
});
