/**
 * getWaveformPeaks 测试：TS 门面只透传、不改写。锁三点：
 * ① 调用负载只有 path/buckets 且命令名为 waveform（Rust 侧 waveform 命令
 *    的入参契约）；② 结果（含 usedEngine 与峰值矩阵）原样透传；
 * ③ 失败（桶数越界中文报错等）原样抛出。桶数域校验在 Rust 侧，前端
 * 不做引擎决策、不重复校验。invoke 全程 mock，不依赖真后端。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({
    usedEngine: "ye",
    sampleRate: 48000,
    channels: 2,
    bucketSamples: 964,
    buckets: 100,
    peaks: [
      [
        { min: -0.98, max: 0.98, rms: 0.71 },
        { min: 0.0, max: 0.0, rms: 0.0 },
      ],
      [
        { min: -0.97, max: 0.99, rms: 0.7 },
        { min: 0.0, max: 0.0, rms: 0.0 },
      ],
    ],
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { getWaveformPeaks } from "./waveform";

describe("getWaveformPeaks", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("调用负载只有 path/buckets，命令名 waveform——门面零改写", async () => {
    await getWaveformPeaks("C:/media/demo.m4a", 100);
    expect(invoke).toHaveBeenCalledWith("waveform", {
      path: "C:/media/demo.m4a",
      buckets: 100,
    });
  });

  it("结果原样透传（含 usedEngine 与峰值矩阵；camelCase 字段与 Rust 侧对齐）", async () => {
    const rustResult = {
      usedEngine: "ffmpeg",
      sampleRate: 44100,
      channels: 1,
      bucketSamples: 441,
      buckets: 200,
      peaks: [[{ min: -1, max: 0.99, rms: 0.7 }]],
    } as const;
    vi.mocked(invoke).mockResolvedValueOnce(rustResult);
    expect(await getWaveformPeaks("C:/media/fallback.wav", 200)).toEqual(rustResult);
  });

  it("失败原样抛出（桶数越界中文报错不改写；前端不重复校验）", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("波形桶数须在 16..=8192，收到 0");
    await expect(getWaveformPeaks("C:/media/demo.mp4", 0)).rejects.toBe(
      "波形桶数须在 16..=8192，收到 0",
    );
  });
});
