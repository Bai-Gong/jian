/**
 * store 行为测试：locked/类型兼容的写入门禁、selection 联动、
 * subscribeWithSelector 契约、不可变更新。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createInitialDocument } from "./factory";
import { selectActiveSequence, useProjectStore } from "./store";
import type { AssetKind, MediaAsset, Track } from "./types";

/** 造素材：video/image 缺省 10s，audio 也给 10s；图片语义上 durationUs=0（types 约定）。 */
function makeAsset(kind: AssetKind, durationUs = 10_000_000): MediaAsset {
  return {
    id: crypto.randomUUID(),
    path: `C:/media/${kind}-${durationUs}.bin`,
    kind,
    durationUs: kind === "image" ? 0 : durationUs,
    width: 1920,
    height: 1080,
    fps: kind === "audio" ? 0 : 30,
    hasAudio: kind !== "image",
    addedAt: 0,
  };
}

function state() {
  return useProjectStore.getState();
}

function videoTrack(): Track {
  return selectActiveSequence(state()).tracks.find((t) => t.kind === "video")!;
}

function audioTrack(): Track {
  return selectActiveSequence(state()).tracks.find((t) => t.kind === "audio")!;
}

function clipsOf(trackId: string) {
  return selectActiveSequence(state()).tracks.find((t) => t.id === trackId)!.clips;
}

/** 每个用例从干净工程出发（store 是模块级单例）。 */
function resetStore() {
  useProjectStore.setState({
    document: createInitialDocument(),
    selection: [],
    playheadUs: 0,
    isPlaying: false,
  });
}

beforeEach(resetStore);

describe("insertClip", () => {
  it("正常插入：返回新 id、块落在指定轨指定起点", () => {
    const asset = makeAsset("video");
    state().addAssets([asset]);
    const id = state().insertClip({ assetId: asset.id, trackId: videoTrack().id, timelineStartUs: 2_000_000 });
    expect(id).toBeTypeOf("string");
    const clips = clipsOf(videoTrack().id);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.timelineStartUs).toBe(2_000_000);
    expect(clips[0]!.sourceInUs).toBe(0);
    expect(clips[0]!.sourceOutUs).toBe(10_000_000); // 整段素材
  });

  it("图片素材：出点＝DEFAULT_IMAGE_CLIP_US（5 秒定格）", () => {
    const asset = makeAsset("image"); // durationUs=0
    state().addAssets([asset]);
    const id = state().insertClip({ assetId: asset.id, trackId: videoTrack().id, timelineStartUs: 0 });
    expect(clipsOf(videoTrack().id)[0]!.sourceOutUs).toBe(5_000_000);
    expect(id).not.toBeNull();
  });

  it("locked 轨 → null；类型不符（audio↔视频轨、video↔音频轨）→ null", () => {
    const video = makeAsset("video");
    const audio = makeAsset("audio");
    state().addAssets([video, audio]);

    state().toggleTrackLock(videoTrack().id);
    expect(state().insertClip({ assetId: video.id, trackId: videoTrack().id, timelineStartUs: 0 })).toBeNull();
    expect(clipsOf(videoTrack().id)).toHaveLength(0);

    resetStore(); // 解锁
    state().addAssets([video, audio]);
    expect(state().insertClip({ assetId: audio.id, trackId: videoTrack().id, timelineStartUs: 0 })).toBeNull();
    expect(state().insertClip({ assetId: video.id, trackId: audioTrack().id, timelineStartUs: 0 })).toBeNull();
    // audio → 音频轨则合法
    expect(state().insertClip({ assetId: audio.id, trackId: audioTrack().id, timelineStartUs: 0 })).not.toBeNull();
  });
});

describe("moveClip", () => {
  it("同轨移动归一（落点重叠被推）、钳 0", () => {
    const asset = makeAsset("video", 2_000_000);
    state().addAssets([asset]);
    const a = state().insertClip({ assetId: asset.id, trackId: videoTrack().id, timelineStartUs: 0 })!;
    const b = state().insertClip({ assetId: asset.id, trackId: videoTrack().id, timelineStartUs: 10_000_000 })!;
    // b 拖到 -1s → 钳 0 → 撞 a → 推到 a 终点
    state().moveClip({ clipId: b, trackId: videoTrack().id, timelineStartUs: -1_000_000 });
    expect(clipsOf(videoTrack().id).map((c) => c.timelineStartUs)).toEqual([0, 2_000_000]);
    expect(a).toBeTruthy();
  });

  it("跨轨移动（同类型）成功；跨类型 no-op", () => {
    const asset = makeAsset("video", 1_000_000);
    state().addAssets([asset]);
    const id = state().insertClip({ assetId: asset.id, trackId: videoTrack().id, timelineStartUs: 0 })!;
    const v2 = state().addTrack("video"); // [V1, V2, A1]
    state().moveClip({ clipId: id, trackId: v2, timelineStartUs: 5_000_000 });
    expect(clipsOf(videoTrack().id)).toHaveLength(0);
    expect(clipsOf(v2).map((c) => c.timelineStartUs)).toEqual([5_000_000]);
    // 跨类型：V2 → A1 no-op
    state().moveClip({ clipId: id, trackId: audioTrack().id, timelineStartUs: 0 });
    expect(clipsOf(v2)).toHaveLength(1);
    expect(clipsOf(audioTrack().id)).toHaveLength(0);
  });

  it("源轨 locked 或目标轨 locked 均 no-op", () => {
    const asset = makeAsset("video", 1_000_000);
    state().addAssets([asset]);
    const id = state().insertClip({ assetId: asset.id, trackId: videoTrack().id, timelineStartUs: 0 })!;
    const v2 = state().addTrack("video");

    state().toggleTrackLock(videoTrack().id); // 源轨锁
    state().moveClip({ clipId: id, trackId: v2, timelineStartUs: 5_000_000 });
    expect(clipsOf(videoTrack().id)).toHaveLength(1);
    expect(clipsOf(v2)).toHaveLength(0);

    state().toggleTrackLock(videoTrack().id); // 解源轨
    state().toggleTrackLock(v2); // 锁目标轨
    state().moveClip({ clipId: id, trackId: v2, timelineStartUs: 5_000_000 });
    expect(clipsOf(videoTrack().id)).toHaveLength(1);
    expect(clipsOf(v2)).toHaveLength(0);
  });
});

describe("selection / removeTrack / deleteSelected", () => {
  it("setSelection / toggleClipSelection", () => {
    state().setSelection(["a", "b"]);
    expect(state().selection).toEqual(["a", "b"]);
    state().toggleClipSelection("a");
    expect(state().selection).toEqual(["b"]);
    state().toggleClipSelection("c");
    expect(state().selection).toEqual(["b", "c"]);
  });

  it("removeTrack 清掉 selection 中该轨的块", () => {
    const asset = makeAsset("video", 1_000_000);
    state().addAssets([asset]);
    const id = state().insertClip({ assetId: asset.id, trackId: videoTrack().id, timelineStartUs: 0 })!;
    state().setSelection([id, "别的块"]);
    state().removeTrack(videoTrack().id);
    expect(state().selection).toEqual(["别的块"]);
    expect(selectActiveSequence(state()).tracks.map((t) => t.kind)).toEqual(["audio"]);
  });

  it("deleteSelected：locked 轨的块不删，删后清空 selection", () => {
    const asset = makeAsset("video", 1_000_000);
    state().addAssets([asset]);
    const a = state().insertClip({ assetId: asset.id, trackId: videoTrack().id, timelineStartUs: 0 })!;
    const v2 = state().addTrack("video");
    const b = state().insertClip({ assetId: asset.id, trackId: v2, timelineStartUs: 0 })!;

    state().toggleTrackLock(videoTrack().id); // V1 锁定
    state().setSelection([a, b]);
    state().deleteSelected();
    expect(clipsOf(videoTrack().id)).toHaveLength(1); // a 保留
    expect(clipsOf(v2)).toHaveLength(0); // b 已删
    expect(state().selection).toEqual([]);
  });
});

describe("splitAtPlayhead", () => {
  it("缺省只分选中块所在轨；locked 轨跳过；显式传轨全分", () => {
    const asset = makeAsset("video", 10_000_000);
    state().addAssets([asset]);
    const onV1 = state().insertClip({ assetId: asset.id, trackId: videoTrack().id, timelineStartUs: 0 })!;
    const v2 = state().addTrack("video");
    state().insertClip({ assetId: asset.id, trackId: v2, timelineStartUs: 0 });

    state().setSelection([onV1]);
    state().setPlayhead(5_000_000);
    state().splitAtPlayhead();
    // V1 的块裂成两块，V2 的块不动
    expect(clipsOf(videoTrack().id)).toHaveLength(2);
    expect(clipsOf(v2)).toHaveLength(1);

    // locked 轨显式传入也跳过
    resetStore();
    state().addAssets([asset]);
    state().insertClip({ assetId: asset.id, trackId: videoTrack().id, timelineStartUs: 0 });
    state().toggleTrackLock(videoTrack().id); // 先进块、后锁轨
    state().setPlayhead(5_000_000);
    state().splitAtPlayhead([videoTrack().id]);
    expect(clipsOf(videoTrack().id)).toHaveLength(1);
  });

  it("setPlayhead 钳 ≥0", () => {
    state().setPlayhead(-100);
    expect(state().playheadUs).toBe(0);
  });
});

describe("subscribeWithSelector 契约", () => {
  it("subscribe(s=>s.playheadUs, cb) 可编译且只在 playhead 变化时命中", () => {
    const seen: number[] = [];
    const unsub = useProjectStore.subscribe((s) => s.playheadUs, (us) => seen.push(us));
    state().setPlayhead(1_500_000);
    state().setPlaying(true); // 无关字段不触发
    state().setSelection(["x"]); // 无关字段不触发
    expect(seen).toEqual([1_500_000]);
    unsub();
  });
});

describe("不可变更新", () => {
  it("写入 action 后旧 document 引用未被改动（内容快照不变、引用被替换）", () => {
    const asset = makeAsset("video", 4_000_000);
    state().addAssets([asset]);
    const before = state().document;
    const snapshot = structuredClone(before);

    state().insertClip({ assetId: asset.id, trackId: videoTrack().id, timelineStartUs: 1_000_000 });
    state().addTrack("video");
    state().toggleTrackMute(audioTrack().id);
    state().toggleTrackLock(audioTrack().id);
    state().setPlayhead(3_000_000);
    state().setPlaying(true);

    expect(before).toEqual(snapshot); // 旧对象树内容原封不动
    expect(state().document).not.toBe(before); // 换了新引用
    expect(state().document.version).toBe(2);
  });
});
