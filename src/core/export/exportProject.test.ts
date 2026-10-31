/**
 * exportProject 测试：引擎分支路由（M4 接线轨）。
 * mock @tauri-apps/api 的 invoke/listen——ffmpeg 轨应调 run_export（argv），
 * ye 轨应调 run_export_ye（片段表参数面）；ye 翻译被拒（能力面外）应抛出
 * 拒绝文案且不触 run_export_ye；两轨共用同一 export-progress 事件监听。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// node 环境无 localStorage：先装内存版再 import store（persist 在模块加载
// 时就会碰 storage——duan preset store 测试同款手法）。
vi.hoisted(() => {
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
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage();
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
});

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const listenMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import type { Clip, MediaAsset, Sequence, Track, TrackKind } from "../project/types";
import { createClip } from "../project/factory";
import { useProjectStore } from "../project/store";
import { exportProject } from "./exportProject";

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: crypto.randomUUID(),
    path: `C:/media/ye-${crypto.randomUUID()}.mp4`,
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

function makeTrack(kind: TrackKind, id: string, clips: Clip[]): Track {
  return { id, kind, name: id.toUpperCase(), locked: false, muted: false, solo: false, height: 72, clips };
}

function makeSequence(tracks: Track[]): Sequence {
  return { id: "seq", name: "测试序列", fps: 30, width: 1920, height: 1080, tracks };
}

/** ye 可接受的序列：单块全默认视频（带 AAC 伴音）。 */
function yeFriendly(): { sequence: Sequence; assets: MediaAsset[] } {
  const asset = makeAsset();
  const sequence = makeSequence([
    makeTrack("video", "t-v1", [
      createClip({ assetId: asset.id, sourceInUs: 0, sourceOutUs: 6_000_000, timelineStartUs: 0 }),
    ]),
  ]);
  return { sequence, assets: [asset] };
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset().mockResolvedValue(vi.fn()); // listen → unlisten
  useProjectStore.setState({
    exportState: { running: false, timeUs: 0, totalUs: 0, error: null },
    exportEngine: "ffmpeg",
  });
});

describe("exportProject：引擎路由", () => {
  it("ffmpeg 轨（缺省引擎）→ invoke run_export（argv 形态）", async () => {
    const { sequence, assets } = yeFriendly();
    await exportProject(sequence, assets, "C:/out/a.mp4");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, payload] = invokeMock.mock.calls[0];
    expect(command).toBe("run_export");
    expect(Array.isArray(payload.args)).toBe(true);
    expect(payload.outPath).toBe("C:/out/a.mp4");
    expect(payload.totalUs).toBe(6_000_000);
    // 进度事件：两轨共用 export-progress
    expect(listenMock).toHaveBeenCalledWith("export-progress", expect.any(Function));
    expect(useProjectStore.getState().exportState.running).toBe(false);
    expect(useProjectStore.getState().exportState.error).toBeNull();
  });

  it("ye 轨（getEngine 注入）+ 接受面序列 → invoke run_export_ye（片段参数面）", async () => {
    const { sequence, assets } = yeFriendly();
    await exportProject(sequence, assets, "C:/out/b.mp4", undefined, {
      getEngine: () => "ye",
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, payload] = invokeMock.mock.calls[0];
    expect(command).toBe("run_export_ye");
    expect(payload.segments).toEqual([
      { path: assets[0].path, trimInUs: 0, trimOutUs: 6_000_000 },
    ]);
    expect(payload.width).toBe(1920);
    expect(payload.height).toBe(1080);
    expect(payload.fpsNum).toBe(30);
    expect(payload.fpsDen).toBe(1);
    expect(payload.crf).toBe(23);
    expect(payload.audioBitrateKbps).toBe(128);
    expect(payload.stripAudio).toBe(false);
    expect(payload.outPath).toBe("C:/out/b.mp4");
    expect(payload.totalUs).toBe(6_000_000);
  });

  it("ye 轨 + store 引擎偏好（未注入 getEngine 时读 store）", async () => {
    useProjectStore.setState({ exportEngine: "ye" });
    const { sequence, assets } = yeFriendly();
    await exportProject(sequence, assets, "C:/out/c.mp4");
    expect(invokeMock.mock.calls[0][0]).toBe("run_export_ye");
  });

  it("ye 轨 + 能力面外序列（变速）→ 抛拒绝文案、不触 run_export_ye", async () => {
    const asset = makeAsset();
    const sequence = makeSequence([
      makeTrack("video", "t-v1", [
        createClip({ assetId: asset.id, sourceInUs: 0, sourceOutUs: 6_000_000, timelineStartUs: 0, speed: 2 }),
      ]),
    ]);
    await expect(
      exportProject(sequence, [asset], "C:/out/d.mp4", undefined, { getEngine: () => "ye" }),
    ).rejects.toThrow("ffmpeg 引擎");
    expect(invokeMock).not.toHaveBeenCalled();
    // 失败留底：exportState.error 带拒绝文案、running 复位
    const state = useProjectStore.getState().exportState;
    expect(state.running).toBe(false);
    expect(state.error).toContain("变速");
  });

  it("空序列（totalUs ≤ 0）在引擎分流前拦下", async () => {
    const asset = makeAsset();
    const empty = makeSequence([makeTrack("video", "t-v1", [])]);
    await expect(
      exportProject(empty, [asset], "C:/out/e.mp4", undefined, { getEngine: () => "ye" }),
    ).rejects.toThrow("序列为空");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("Rust 侧失败 → 错误文案留底并复位 running", async () => {
    invokeMock.mockRejectedValueOnce("boom from rust");
    const { sequence, assets } = yeFriendly();
    await expect(exportProject(sequence, assets, "C:/out/f.mp4")).rejects.toBe("boom from rust");
    const state = useProjectStore.getState().exportState;
    expect(state.running).toBe(false);
    expect(state.error).toBe("boom from rust");
  });
});
