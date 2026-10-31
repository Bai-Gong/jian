/**
 * probeMedia 测试：TS 门面只透传、不改写。
 * 锁三点：① 缺省调用负载与 M1 完全一致（importAssets 行为零改动）；
 * ② engine 显式给定时原样传 Rust；③ 结果（含 usedEngine）与失败原样透传，
 * kind/引擎决策都不在前端发生。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({
    durationUs: 3_000_000,
    width: 320,
    height: 240,
    fps: 30,
    hasAudio: false,
    kind: "video",
    usedEngine: "ye",
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { probeMedia } from "./probe";

describe("probeMedia", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("缺省参数负载只有 path——importAssets 等既有调用零改动", async () => {
    await probeMedia("C:/media/demo.mp4");
    // engine: undefined 序列化时被丢弃，线上负载与 M1 完全一致（仅 path）
    expect(invoke).toHaveBeenCalledWith("probe_media", { path: "C:/media/demo.mp4" });
  });

  it("engine 显式给定时原样透传，前端不做引擎决策", async () => {
    await probeMedia("C:/media/demo.mp4", "ffmpeg");
    expect(invoke).toHaveBeenCalledWith("probe_media", {
      path: "C:/media/demo.mp4",
      engine: "ffmpeg",
    });
    await probeMedia("C:/media/demo.mp4", "ye");
    expect(invoke).toHaveBeenLastCalledWith("probe_media", {
      path: "C:/media/demo.mp4",
      engine: "ye",
    });
    await probeMedia("C:/media/demo.mp4", "auto");
    expect(invoke).toHaveBeenLastCalledWith("probe_media", {
      path: "C:/media/demo.mp4",
      engine: "auto",
    });
  });

  it("结果原样透传不改写（含 usedEngine；旧后端无该字段也可用）", async () => {
    const yeResult = {
      durationUs: 3_000_000,
      width: 320,
      height: 240,
      fps: 30,
      hasAudio: false,
      kind: "video",
      usedEngine: "ye",
    } as const;
    vi.mocked(invoke).mockResolvedValueOnce(yeResult);
    expect(await probeMedia("C:/media/demo.mp4")).toEqual(yeResult);

    // 旧后端（无 usedEngine）结果同样原样透传，可选字段不挡调用方
    const legacy = {
      durationUs: 0,
      width: 800,
      height: 600,
      fps: 0,
      hasAudio: false,
      kind: "image",
    } as const;
    vi.mocked(invoke).mockResolvedValueOnce(legacy);
    const r = await probeMedia("C:/media/pic.png");
    expect(r).toEqual(legacy);
    expect(r.usedEngine).toBeUndefined();
  });

  it("失败原样抛出（Rust Err 文案不改写）", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("无法识别的媒体: C:/media/x.txt");
    await expect(probeMedia("C:/media/x.txt")).rejects.toBe("无法识别的媒体: C:/media/x.txt");
  });
});
