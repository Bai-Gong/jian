/**
 * store 行为测试：locked/类型兼容的写入门禁、selection 联动、
 * subscribeWithSelector 契约、不可变更新、导出引擎偏好的持久化往返。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// node 环境无 localStorage：先装内存版再 import store（persist 在模块加载
// 时就会碰 storage——duan preset store 测试同款手法）。partialize 只落
// exportEngine（document 保存/加载归 M3，勿混进持久层）。
const testStorage = vi.hoisted(() => {
  class MemoryStorage implements Storage {
    private map = new Map<string, string>();
    get length(): number {
      return this.map.size;
    }
    clear(): void {
      this.map.clear();
    }
    getItem(key: string): string | null {
      return this.map.has(key) ? this.map.get(key)! : null;
    }
    key(index: number): string | null {
      return [...this.map.keys()][index] ?? null;
    }
    removeItem(key: string): void {
      this.map.delete(key);
    }
    setItem(key: string, value: string): void {
      this.map.set(key, String(value));
    }
  }
  const storage = new MemoryStorage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage;
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
  return storage;
});

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
    videoCodec: kind === "video" ? "h264" : "",
    audioCodec: kind !== "image" ? "aac" : "",
    sampleRate: kind !== "image" ? 48_000 : 0,
    channels: kind !== "image" ? 2 : 0,
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

it("static edits respect locked tracks and preserve animated properties",()=>{
  const asset=makeAsset("video");state().addAssets([asset]);
  const track=videoTrack(),id=state().insertClip({assetId:asset.id,trackId:track.id,timelineStartUs:0})!;
  state().setClipProperty(id,"transform","x",42);expect(clipsOf(track.id)[0].transform.x).toEqual({kind:"static",value:42});
  state().toggleTrackLock(track.id);state().setClipProperty(id,"audio","gain",2);expect(clipsOf(track.id)[0].audio.gain).toEqual({kind:"static",value:1});
  state().toggleTrackLock(track.id);
  const doc=structuredClone(state().document);doc.sequences[0].tracks.find((t)=>t.id===track.id)!.clips[0].transform.x={kind:"keyframed",keyframes:[{tUs:0,value:10,easing:"linear"}]};
  useProjectStore.setState({document:doc});state().setClipProperty(id,"transform","x",99);expect(clipsOf(track.id)[0].transform.x.kind).toBe("keyframed");
  state().setClipProperty(id,"audio","gain",3);expect(clipsOf(track.id)[0].audio.gain).toEqual({kind:"static",value:1});
});

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

describe("导出引擎偏好（persist）", () => {
  it("setExportEngine 写入且 partialize 只落 exportEngine（往返）", () => {
    useProjectStore.getState().setExportEngine("ye");
    expect(useProjectStore.getState().exportEngine).toBe("ye");
    // 持久层只含引擎偏好：document/selection 等不进 localStorage
    const raw = testStorage.getItem("jian.project");
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(persisted.state).toEqual({ exportEngine: "ye" });
    // 复位回 ffmpeg
    useProjectStore.getState().setExportEngine("ffmpeg");
    expect(useProjectStore.getState().exportEngine).toBe("ffmpeg");
  });
});

it("retains the prior engine choice when migrating to the pure runtime",async()=>{
  testStorage.setItem("jian.project",JSON.stringify({version:1,state:{exportEngine:"ffmpeg"}}));
  await useProjectStore.persist.rehydrate();
  expect(state().exportEngine).toBe("ye");expect(state().legacyEngine).toBe("ffmpeg");
});



describe("按源音轨拆分并自动建轨",()=>{
  function multitrack(n=5){const asset=makeAsset("video");asset.audioStreams=Array.from({length:n},(_,i)=>({index:i+1,name:`音轨 ${i+1}`,codec:"aac",sampleRate:48000,channels:2,startUs:0,endUs:asset.durationUs}));state().addAssets([asset]);return asset;}
  it("五条立体声音轨只建五个音频轨，起点和区间与视频相同",()=>{
    const asset=multitrack();state().insertMedia(asset.id,1250000);
    const seq=selectActiveSequence(state()),video=seq.tracks.find(t=>t.kind==="video")!.clips[0],audio=seq.tracks.filter(t=>t.kind==="audio");
    expect(audio).toHaveLength(5);expect(audio.map(t=>t.clips[0].sourceStreamIndex)).toEqual([1,2,3,4,5]);expect(video.audioDetached).toBe(true);
    for(const t of audio){expect(t.clips[0].timelineStartUs).toBe(video.timelineStartUs);expect(t.clips[0].sourceOutUs).toBe(video.sourceOutUs);}
  });
  it("连续片段复用空闲音轨，重叠插入新增轨且不推移已存在的片段",()=>{
    const asset=multitrack(2);state().insertMedia(asset.id,0);state().insertMedia(asset.id,asset.durationUs);
    let seq=selectActiveSequence(state());expect(seq.tracks.filter(t=>t.kind==="audio")).toHaveLength(2);expect(seq.tracks.filter(t=>t.kind==="video")).toHaveLength(1);
    state().insertMedia(asset.id,0);seq=selectActiveSequence(state());expect(seq.tracks.filter(t=>t.kind==="audio")).toHaveLength(4);expect(seq.tracks.filter(t=>t.kind==="video")).toHaveLength(2);
    expect(seq.tracks[0].clips.map(c=>c.timelineStartUs)).toEqual([0,asset.durationUs]);
  });
  it("锁定轨不被写入；音频静音不会隐藏视频，视频也不重复产出伴音",async()=>{
    const asset=multitrack(1);const originalAudio=selectActiveSequence(state()).tracks.find(t=>t.kind==="audio")!;state().toggleTrackLock(originalAudio.id);state().insertMedia(asset.id,0);
    const seq=selectActiveSequence(state());expect(seq.tracks.find(t=>t.id===originalAudio.id)!.clips).toHaveLength(0);
    const {evaluateSequence}=await import("../composite/composite");const ev=evaluateSequence(seq,state().document.assets);expect(ev.videoLayers).toHaveLength(1);expect(ev.audioLayers).toHaveLength(1);expect(ev.audioLayers[0].sourceStreamIndex).toBe(1);
    const track=seq.tracks.find(t=>t.clips.some(c=>c.sourceStreamIndex===1))!;state().toggleTrackMute(track.id);
    const muted=evaluateSequence(selectActiveSequence(state()),state().document.assets);expect(muted.videoLayers).toHaveLength(1);expect(muted.audioLayers).toHaveLength(0);
  });
  it("无声视频不制造音频片段，单音轨音频素材正常复用音频轨",()=>{
    const silent=makeAsset("video");silent.hasAudio=false;silent.audioStreams=[];state().addAssets([silent]);state().insertMedia(silent.id,0);expect(selectActiveSequence(state()).tracks.filter(t=>t.kind==="audio").flatMap(t=>t.clips)).toHaveLength(0);
    const audio=makeAsset("audio");audio.audioStreams=[{index:0,name:"音轨 1",codec:"aac",sampleRate:48000,channels:2,startUs:0,endUs:audio.durationUs}];state().addAssets([audio]);state().insertMedia(audio.id,0);expect(selectActiveSequence(state()).tracks.find(t=>t.kind==="audio")!.clips[0].sourceStreamIndex).toBe(0);
  });
});
