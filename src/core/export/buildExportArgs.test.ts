/**
 * buildExportArgs 测试：锁住「预览＝导出」的关键翻译点。
 * 重点防回归（均对应 M1 施工契约实证过的坑）：
 * - setpts 的秒偏移必须 /TB、音频 adelay 必须在 atempo 之后；
 * - 分割右块用 -ss 而非 trim（防双重裁剪）；
 * - 层序/mute/solo 全部来自 evaluateSequence，不许自作枚举。
 */
import { describe, expect, it } from "vitest";
import { evaluateSequence } from "../composite/composite";
import { createClip } from "../project/factory";
import type { MediaAsset, Sequence, Track, TrackKind } from "../project/types";
import { buildExportArgs } from "./buildExportArgs";

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
    videoCodec: "h264",
    audioCodec: "aac",
    sampleRate: 48_000,
    channels: 2,
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

/** 取 args 里 -filter_complex 的那一段。 */
function filterComplexOf(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1];
}

describe("buildExportArgs", () => {
  it("起始偏移块：setpts 带 +{startUs}/1000000/TB，音频 adelay 在 atempo 之后", () => {
    const v = makeAsset(); // 带伴音
    const c = createClip({ assetId: v.id, sourceInUs: 0, sourceOutUs: 3_000_000, timelineStartUs: 2_000_000 });
    const args = buildExportArgs(makeSequence([makeTrack("video", "t-v1", [c])]), [v], "C:/out/x.mp4");
    const fc = filterComplexOf(args);

    // 坑 1：秒偏移必须 /TB（写成 +2 在 r=10 下只偏 0.2s 且画面全黑）
    expect(fc).toContain("+2000000/1000000/TB");
    // 坑 2：无 adelay 时 amix 会截短到首块长；毫秒 + all=1 覆盖全部声道
    expect(fc).toContain("adelay=2000:all=1");
    // 坑 3：adelay 必须在 atempo 之后（防静音段被变速吃掉）
    expect(fc.indexOf("atempo=")).toBeLessThan(fc.indexOf("adelay=2000:all=1"));
    // 显示窗口与输出段
    expect(fc).toContain("enable='between(t,2.000000,5.000000)'");
    expect(args.join(" ")).toContain("-y -progress pipe:1 -nostats C:/out/x.mp4");
  });

  it("sourceIn>0 的块（分割右块）：-ss 入点裁剪、无 trim=", () => {
    const v = makeAsset();
    const c = createClip({ assetId: v.id, sourceInUs: 4_000_000, sourceOutUs: 7_000_000, timelineStartUs: 0 });
    const joined = buildExportArgs(makeSequence([makeTrack("video", "t-v1", [c])]), [v], "C:/out/x.mp4").join(" ");
    expect(joined).toContain("-ss 4.000000 -t 3.000000 -i");
    expect(joined).not.toContain("trim=");
  });

  it("双轨叠加：底板打底、前轨先叠、后轨后叠（靠后＝上层）", () => {
    const v1 = makeAsset();
    const v2 = makeAsset({ hasAudio: false });
    const c1 = createClip({ assetId: v1.id, sourceInUs: 0, sourceOutUs: 4_000_000, timelineStartUs: 0 });
    const c2 = createClip({ assetId: v2.id, sourceInUs: 0, sourceOutUs: 4_000_000, timelineStartUs: 1_000_000 });
    const fc = filterComplexOf(
      buildExportArgs(makeSequence([makeTrack("video", "t-v1", [c1]), makeTrack("video", "t-v2", [c2])]), [v1, v2], "o.mp4"),
    );
    // 层滤镜按输入号：c1=0、c2=1
    expect(fc).toContain("[base][l0]overlay=");
    expect(fc).toContain("[ov0][l1]overlay=");
    expect(fc).toContain("[vout]");
    // 后轨的后叠（字符串顺序即链序）
    expect(fc.indexOf("[ov0][l1]overlay=")).toBeGreaterThan(fc.indexOf("[base][l0]overlay="));
  });

  it("muted 音轨不入混音；muted 视频轨仍入 overlay 且伴音被去", () => {
    const v = makeAsset(); // 带伴音的视频块
    const a1 = makeAsset({ kind: "audio" });
    const a2 = makeAsset({ kind: "audio" });
    const cv = createClip({ assetId: v.id, sourceInUs: 0, sourceOutUs: 4_000_000, timelineStartUs: 0 });
    const c1 = createClip({ assetId: a1.id, sourceInUs: 0, sourceOutUs: 4_000_000, timelineStartUs: 0 });
    const c2 = createClip({ assetId: a2.id, sourceInUs: 0, sourceOutUs: 4_000_000, timelineStartUs: 0 });
    const args = buildExportArgs(
      makeSequence([
        makeTrack("video", "t-v1", [cv], { muted: true }), // 静音视频轨：画面照上
        makeTrack("audio", "t-a1", [c1], { muted: true }), // 静音音轨：不出声
        makeTrack("audio", "t-a2", [c2]),
      ]),
      [v, a1, a2],
      "o.mp4",
    );
    const fc = filterComplexOf(args);
    // 只剩 c2 一路音频：不进 amix、直接当 aout；视频块伴音与 c1 都不在
    expect(fc).not.toContain("amix");
    expect(fc.match(/\[1:a\]/g)).toHaveLength(1); // 输入 1＝c2（cv=0；c1 被 mute 不占输入号）
    expect(fc).toContain("[0:v]"); // 静音视频轨的块仍进 overlay 链
    expect(fc).toContain("[aout]");
  });

  it("speed≠1：setpts 除以 speed，音频只 atempo（无 asetpts）", () => {
    const v = makeAsset();
    const c = createClip({ assetId: v.id, sourceInUs: 2_000_000, sourceOutUs: 18_000_000, timelineStartUs: 0, speed: 2 });
    const fc = filterComplexOf(buildExportArgs(makeSequence([makeTrack("video", "t-v1", [c])]), [v], "o.mp4"));
    expect(fc).toContain("(PTS-STARTPTS)/2+");
    expect(fc).toContain("atempo=2");
    expect(fc).not.toContain("asetpts");
  });

  it("底板时长＝求值总时长（evaluateSequence.durationUs）", () => {
    const v = makeAsset();
    const c = createClip({ assetId: v.id, sourceInUs: 0, sourceOutUs: 7_000_000, timelineStartUs: 3_000_000 });
    const seq = makeSequence([makeTrack("video", "t-v1", [c])]);
    expect(filterComplexOf(buildExportArgs(seq, [v], "o.mp4"))).toContain("d=10.000000");
    expect(evaluateSequence(seq, [v]).durationUs).toBe(10_000_000);
  });

  it("图片块：-loop 1 -framerate 序列 fps -t 推导时长", () => {
    const img = makeAsset({ kind: "image", durationUs: 0, hasAudio: false, fps: 0 });
    const c = createClip({ assetId: img.id, sourceInUs: 0, sourceOutUs: 5_000_000, timelineStartUs: 0 });
    const joined = buildExportArgs(makeSequence([makeTrack("video", "t-v1", [c])]), [img], "o.mp4").join(" ");
    expect(joined).toContain(`-loop 1 -framerate 30 -t 5.000000 -i ${img.path}`);
    expect(joined).not.toContain("-ss");
  });

  it("无音频层：输出段 -an、无 [aout]/-c:a", () => {
    const v = makeAsset({ hasAudio: false });
    const c = createClip({ assetId: v.id, sourceInUs: 0, sourceOutUs: 2_000_000, timelineStartUs: 0 });
    const args = buildExportArgs(makeSequence([makeTrack("video", "t-v1", [c])]), [v], "o.mp4");
    const joined = args.join(" ");
    expect(args).toContain("-an");
    expect(joined).not.toContain("[aout]");
    expect(joined).not.toContain("-c:a");
    expect(joined).toContain("-c:v libx264 -pix_fmt yuv420p -r 30");
  });

  it("多路音频：amix inputs=N normalize=0，输出段带 aac", () => {
    const v = makeAsset();
    const a1 = makeAsset({ kind: "audio" });
    const a2 = makeAsset({ kind: "audio" });
    const cv = createClip({ assetId: v.id, sourceInUs: 0, sourceOutUs: 4_000_000, timelineStartUs: 0 });
    const c1 = createClip({ assetId: a1.id, sourceInUs: 0, sourceOutUs: 4_000_000, timelineStartUs: 0 });
    const c2 = createClip({ assetId: a2.id, sourceInUs: 0, sourceOutUs: 4_000_000, timelineStartUs: 1_000_000 });
    const args = buildExportArgs(
      makeSequence([makeTrack("video", "t-v1", [cv]), makeTrack("audio", "t-a1", [c1, c2])]),
      [v, a1, a2],
      "o.mp4",
    );
    const fc = filterComplexOf(args);
    // 三路：视频块伴音（输入0）+ c1/c2（同素材 a1 的两块共用元素不同输入号——每块一个 -i）
    expect(fc).toContain("amix=inputs=3:normalize=0:dropout_transition=0[aout]");
    expect(args.join(" ")).toContain("-map [aout] -c:a aac");
  });
});
