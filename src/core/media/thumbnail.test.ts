/**
 * getThumbnail 双引擎测试：ye 轨优先，失败（能力面外等任何 Err）console.warn
 * 后回退 ffmpeg 轨 extract_frame。锁三点：① ye 成功直取（不碰 ffmpeg 轨，
 * 结果缓存命中不重复抽帧）；② ye 失败回退（同参落 ffmpeg 轨，warn 留现场）；
 * ③ 两轨均失败整体抛错不吞。invoke 全程 mock，不依赖真后端。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 素材池桩：findAsset 只读 id/path（真实 MediaAsset 字段更多，桩按需给）。
const stubAssets = vi.hoisted(() => [
  { id: "a-ye", path: "C:/media/baseline.mp4" },
  { id: "a-fallback", path: "C:/media/high.mp4" },
  { id: "a-both-fail", path: "C:/media/broken.mp4" },
]);

vi.mock("../project/store", () => ({
  useProjectStore: { getState: () => ({ document: { assets: stubAssets } }) },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset-url://${path}`,
}));

import { invoke } from "@tauri-apps/api/core";
import { getThumbnail } from "./thumbnail";

describe("getThumbnail（ye 优先双引擎）", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("ye 成功直取：不碰 ffmpeg 轨，结果经 assetUrl 返回且缓存命中不重复抽帧", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("C:/Temp/jian-frame-111-0.png");

    const url = await getThumbnail("a-ye", 1_500_000);

    expect(url).toBe("asset-url://C:/Temp/jian-frame-111-0.png");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("extract_frame_ye", {
      path: "C:/media/baseline.mp4",
      timeUs: 1_500_000,
    });

    // 同 (assetId, timeUs) 二次调用走缓存：不再发起任何抽帧
    await getThumbnail("a-ye", 1_500_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ye 失败（能力面外等）回退 ffmpeg 轨：同参重发、warn 留现场、取回退轨结果", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(
        "ye 抽帧失败（C:/media/high.mp4）: codec error: profile not supported",
      )
      .mockResolvedValueOnce("C:/Temp/jian-frame-222-1.png");

    const url = await getThumbnail("a-fallback");

    expect(url).toBe("asset-url://C:/Temp/jian-frame-222-1.png");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, "extract_frame_ye", {
      path: "C:/media/high.mp4",
      timeUs: 0,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "extract_frame", {
      path: "C:/media/high.mp4",
      timeUs: 0,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "ye 抽帧失败，回退 ffmpeg 轨:",
      "ye 抽帧失败（C:/media/high.mp4）: codec error: profile not supported",
    );
  });

  it("两轨均失败：整体抛 ffmpeg 轨错误（不吞错），失败不占缓存位", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce("ye 抽帧失败（C:/media/broken.mp4）: container error: bad box")
      .mockRejectedValueOnce("抽帧失败（C:/media/broken.mp4）: Invalid data");

    await expect(getThumbnail("a-both-fail")).rejects.toBe(
      "抽帧失败（C:/media/broken.mp4）: Invalid data",
    );

    // 失败不占缓存位：重试再次从 ye 轨发起（而非缓存旧失败）
    vi.mocked(invoke).mockRejectedValueOnce("ye 抽帧失败（C:/media/broken.mp4）: container error: bad box");
    vi.mocked(invoke).mockResolvedValueOnce("C:/Temp/jian-frame-333-0.png");
    await expect(getThumbnail("a-both-fail")).resolves.toBe(
      "asset-url://C:/Temp/jian-frame-333-0.png",
    );
  });
});
